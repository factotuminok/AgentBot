import type { Priority } from "./surface";

/**
 * The one outbound Discord queue (DSC-32), shared by every run of a connection. Backend-agnostic: each task carries the
 * call that performs it, so the discord.js adapter and the test fake run the same queue.
 *
 * - **Priorities:** high > state > activity; FIFO within a priority.
 * - **Buckets:** a task names its rate-limit bucket (the channel id for channel writes). At most one task per bucket runs
 *   at a time, so writes to one channel keep their order; different buckets run concurrently up to `concurrency`.
 * - **Coalescing:** at most one pending task per `coalesce` key (one message's edits). A newer task replaces the unsent
 *   one, keeps its place in line, takes the higher of both priorities, and the replaced promise resolves `undefined`.
 * - **Rate limits:** a task that fails with a rate limit (`rateLimitOf`) blocks its bucket, or every bucket when global,
 *   for the retry-after and is retried then. `limited()` reports limits seen elsewhere. While a bucket is limited,
 *   activity tasks for it are dropped (resolve `undefined`) instead of queued, and queued ones are dropped too.
 */

export interface RateLimitInfo {
	retryAfterMs: number;
	global: boolean;
}

export interface QueueClock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface QueueTask<T> {
	priority: Priority;
	/** Rate-limit bucket and ordering lane: the channel id for channel writes, `guild:<id>` for guild writes. */
	bucket: string;
	/** Coalescing key (e.g. `edit:<messageId>`): at most one pending task per key. Only for tasks whose result is not needed. */
	coalesce?: string;
	run(): Promise<T>;
}

export interface QueueStats {
	/** Queued and in-flight writes. */
	length: number;
	oldestAgeMs: number | null;
}

export interface OutboundQueue {
	/** Resolves with the task's result, or `undefined` when it was superseded or skipped; rejects when the task fails. */
	push<T>(task: QueueTask<T>): Promise<T | undefined>;
	/** A rate limit observed outside the queue's own tasks; `bucket` null = global. */
	limited(bucket: string | null, retryAfterMs: number): void;
	isLimited(bucket: string): boolean;
	stats(): QueueStats;
	/** Stops starting tasks (in-flight ones finish) until `resume`. */
	pause(): void;
	resume(): void;
	/** Resolves once nothing is queued or in flight. */
	idle(): Promise<void>;
	/** Rejects every queued task and every later push with `error`. */
	close(error: Error): void;
}

export interface QueueOptions {
	/** Tasks of different buckets running at once. Default 4. */
	concurrency?: number;
	/** Recognises a rate-limit failure of a task. */
	rateLimitOf?(err: unknown): RateLimitInfo | undefined;
	clock?: QueueClock;
}

const RANK: Record<Priority, number> = { high: 0, state: 1, activity: 2 };

interface Entry {
	seq: number;
	enqueuedAt: number;
	priority: Priority;
	bucket: string;
	coalesce?: string;
	run(): Promise<unknown>;
	resolve(value: unknown): void;
	reject(err: unknown): void;
}

const systemClock: QueueClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createOutboundQueue(opts: QueueOptions = {}): OutboundQueue {
	const clock = opts.clock ?? systemClock;
	const concurrency = Math.max(1, opts.concurrency ?? 4);
	const pending: Entry[] = [];
	const byKey = new Map<string, Entry>();
	const inFlight = new Set<Entry>();
	const busyBuckets = new Set<string>();
	const blockedUntil = new Map<string, number>();
	let globalUntil = 0;
	let seq = 0;
	let paused = false;
	let closed: Error | undefined;
	let pumpScheduled = false;
	let wake: { at: number; handle: unknown } | undefined;
	let idleWaiters: (() => void)[] = [];

	const limitedAt = (bucket: string, now: number) => globalUntil > now || (blockedUntil.get(bucket) ?? 0) > now;

	function remove(entry: Entry): void {
		const index = pending.indexOf(entry);
		if (index >= 0) pending.splice(index, 1);
		if (entry.coalesce && byKey.get(entry.coalesce) === entry) byKey.delete(entry.coalesce);
	}

	function enqueue(entry: Entry): void {
		pending.push(entry);
		if (entry.coalesce) byKey.set(entry.coalesce, entry);
	}

	function checkIdle(): void {
		if (pending.length > 0 || inFlight.size > 0) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** Drops queued activity tasks of a limited bucket (or of every bucket). */
	function dropActivity(bucket: string | null): void {
		for (const entry of [...pending]) {
			if (entry.priority !== "activity" || (bucket !== null && entry.bucket !== bucket)) continue;
			remove(entry);
			entry.resolve(undefined);
		}
	}

	function limit(bucket: string | null, retryAfterMs: number): void {
		const until = clock.now() + Math.max(0, retryAfterMs);
		if (bucket === null) globalUntil = Math.max(globalUntil, until);
		else blockedUntil.set(bucket, Math.max(blockedUntil.get(bucket) ?? 0, until));
		dropActivity(bucket);
		checkIdle();
		schedulePump();
	}

	function scheduleWake(at: number): void {
		if (wake && wake.at <= at) return;
		if (wake) clock.clearTimeout(wake.handle);
		const handle = clock.setTimeout(
			() => {
				wake = undefined;
				pump();
			},
			Math.max(0, at - clock.now()),
		);
		wake = { at, handle };
	}

	function schedulePump(): void {
		if (pumpScheduled) return;
		pumpScheduled = true;
		queueMicrotask(() => {
			pumpScheduled = false;
			pump();
		});
	}

	function pump(): void {
		if (paused || closed) return;
		const now = clock.now();
		for (const [bucket, until] of blockedUntil) if (until <= now) blockedUntil.delete(bucket);
		if (globalUntil > now) {
			if (pending.length > 0) scheduleWake(globalUntil);
			return;
		}
		while (inFlight.size < concurrency) {
			let best: Entry | undefined;
			for (const entry of pending) {
				if (busyBuckets.has(entry.bucket) || limitedAt(entry.bucket, now)) continue;
				if (!best || RANK[entry.priority] < RANK[best.priority] || (RANK[entry.priority] === RANK[best.priority] && entry.seq < best.seq)) best = entry;
			}
			if (!best) break;
			remove(best);
			start(best);
		}
		let next = Number.POSITIVE_INFINITY;
		for (const entry of pending) {
			const until = blockedUntil.get(entry.bucket);
			if (until !== undefined && until > now && !busyBuckets.has(entry.bucket)) next = Math.min(next, until);
		}
		if (next !== Number.POSITIVE_INFINITY) scheduleWake(next);
	}

	function start(entry: Entry): void {
		inFlight.add(entry);
		busyBuckets.add(entry.bucket);
		let result: Promise<unknown>;
		try {
			result = entry.run();
		} catch (err) {
			result = Promise.reject(err);
		}
		result.then(
			value => {
				finish(entry);
				entry.resolve(value);
			},
			err => {
				finish(entry);
				const info = opts.rateLimitOf?.(err);
				if (!info || closed) {
					entry.reject(err);
				} else if (entry.coalesce && byKey.has(entry.coalesce)) {
					// A newer edit of the same message is already queued; it carries the latest state.
					entry.resolve(undefined);
				} else if (entry.priority === "activity") {
					entry.resolve(undefined);
				} else {
					enqueue(entry);
				}
				if (info) limit(info.global ? null : entry.bucket, info.retryAfterMs);
			},
		)
			.finally(() => {
				checkIdle();
				schedulePump();
			});
	}

	function finish(entry: Entry): void {
		inFlight.delete(entry);
		busyBuckets.delete(entry.bucket);
	}

	return {
		push<T>(task: QueueTask<T>): Promise<T | undefined> {
			if (closed) return Promise.reject(closed);
			const existing = task.coalesce ? byKey.get(task.coalesce) : undefined;
			if (existing) {
				const replaced = existing.resolve;
				const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
				existing.run = task.run;
				if (RANK[task.priority] < RANK[existing.priority]) existing.priority = task.priority;
				existing.resolve = resolve as (value: unknown) => void;
				existing.reject = reject;
				replaced(undefined);
				return promise;
			}
			if (task.priority === "activity" && limitedAt(task.bucket, clock.now())) return Promise.resolve(undefined);
			const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
			enqueue({
				seq: seq++,
				enqueuedAt: clock.now(),
				priority: task.priority,
				bucket: task.bucket,
				coalesce: task.coalesce,
				run: task.run,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			schedulePump();
			return promise;
		},
		limited: limit,
		isLimited: bucket => limitedAt(bucket, clock.now()),
		stats() {
			let oldest = Number.POSITIVE_INFINITY;
			for (const entry of pending) oldest = Math.min(oldest, entry.enqueuedAt);
			for (const entry of inFlight) oldest = Math.min(oldest, entry.enqueuedAt);
			return {
				length: pending.length + inFlight.size,
				oldestAgeMs: oldest === Number.POSITIVE_INFINITY ? null : Math.max(0, clock.now() - oldest),
			};
		},
		pause() {
			paused = true;
		},
		resume() {
			paused = false;
			schedulePump();
		},
		idle() {
			if (pending.length === 0 && inFlight.size === 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			idleWaiters.push(resolve);
			return promise;
		},
		close(error) {
			closed = error;
			if (wake) clock.clearTimeout(wake.handle);
			wake = undefined;
			for (const entry of pending.splice(0)) entry.reject(error);
			byKey.clear();
			checkIdle();
		},
	};
}
