import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TodoItem } from "../../shared/agent";
import type { RunUsage, TranscriptEvent } from "../../shared/transcript";
import {
	type AbortReason,
	type Dispatcher,
	ownerKey,
	RunDetached,
	type RunHandle,
	type RunHooks,
	RunLost,
	type RunOwner,
	type RunProgress,
	type RunRequest,
	type RunResult,
	type RunUi,
	type SteerOptions,
	UI_CALL_CONTEXT,
	type UiCallContext,
} from "./dispatcher";

/**
 * In-memory `Dispatcher` (implementation.md phase 2), the one tests drive. It follows the `Dispatcher` contract — start
 * or attach per owner, results kept until an attached caller received them, detaching via the caller's signal leaves the
 * run going, one-shot `abort`, steers settled as `delivered` or `ended` (RUN-15), a `UiCallContext` on every question,
 * usage reported once per run (OBS-05) — and runs a scriptable sequence of steps instead of an agent. Without a script, a
 * run yields a canned output for its kind, so the engine can run end to end.
 */

/** One thing a fake run does, in order. */
export type FakeStep =
	| { progress: Partial<RunProgress> }
	| { todos: TodoItem[] }
	| { transcript: TranscriptEvent }
	/**
	 * A question through the attached caller's `hooks.ui`; the answer is recorded in `FakeRun.answers`. The `ui` passed in
	 * adds a `UiCallContext` to the dialog options of every call.
	 */
	| { ui(ui: RunUi, signal: AbortSignal): Promise<unknown> }
	| { delayMs: number }
	/** Waits until the promise settles (a test-controlled gate). */
	| { until: Promise<unknown> };

export interface FakeRunScript {
	/** Before starting: reports `onWaitingForWorker`, then waits this long (ms) or until the promise settles. */
	pending?: number | Promise<unknown>;
	/** Step index before which the run registers its handle; default 0 (before the first step); `null` never registers. */
	registerAt?: number | null;
	steps?: FakeStep[];
	/** After the steps, wait until the test calls `finish`, `fail` or `lose` on the run. */
	hold?: boolean;
	/** The `yield` output; defaults to the canned output for the run's kind. */
	output?: unknown;
	/** The run ended at a limit (or was aborted) without being asked to. */
	aborted?: AbortReason;
	/** The run fails with this error (`NoStructuredOutput`, a crash, …). */
	error?: Error | string;
	/** The worker is lost at the end of the steps (RUN-04): the caller gets `RunLost`. */
	lost?: boolean;
	usage?: Partial<RunUsage>;
	oomKills?: number;
	/** Default true. */
	hasSession?: boolean;
	/**
	 * How steering settles. Default: `delivered` once registered; before that `onQueued` is called and the steer settles
	 * when the run registers (`delivered`) or ends (`ended`). `queued`: `onQueued`, then pending until the run ends or the
	 * test calls `deliverSteers()`. `ended`: always `ended`.
	 */
	steerResult?: "delivered" | "queued" | "ended";
	/** Ask runs: files written to `<req.scratchDir>/outputs/<name>` when the run ends; their names become `result.outputs`. */
	outputFiles?: Record<string, string>;
}

/** Which runs a script applies to; every given field must match. A function decides itself. */
export type FakeMatch =
	| { owner?: RunOwner; kind?: RunRequest["kind"]; profile?: RunRequest["profile"] }
	| ((req: RunRequest) => boolean);

export type FakeOutcome = { type: "result"; result: RunResult } | { type: "error"; error: Error };

/** A run the fake knows about (unfinished, or finished and not yet delivered). */
export interface FakeRun {
	readonly id: number;
	readonly req: RunRequest;
	readonly state: "pending" | "running" | "finished";
	readonly registered: boolean;
	/** The first abort reason, if any (AGT-07). */
	readonly aborted: AbortReason | undefined;
	readonly steers: { text: string; from: string; scratchInputs?: string[] }[];
	readonly answers: unknown[];
	/** `onPosted` calls of the run's questions, by `UiCallContext.key`. */
	readonly posted: ReadonlyMap<string, { channelId: string; messageIds: string[] }>;
	/** How many `runAgent` calls attached to this run, the starting call included. */
	readonly attachCount: number;
	/** True while a caller is attached. */
	readonly attached: boolean;
	/** Ends a held (or any live) run with a result; `output` defaults to the script's or the canned output. */
	finish(result?: Partial<RunResult>): void;
	fail(error: Error | string): void;
	/** The worker is lost: the attached caller (or the next one) gets `RunLost`. */
	lose(): void;
	/** Settles every steer still waiting as `delivered`. */
	deliverSteers(): void;
	/** Settles when the run has finished. */
	readonly done: Promise<void>;
}

export interface FakeDispatcherOptions {
	/** Scripts applied before any added with `script()`. */
	scripts?: { match: FakeMatch; script: FakeRunScript; times?: number }[];
	/** Replaces the canned outputs. */
	cannedOutput?(req: RunRequest): unknown;
	/** Answers `mcpTest`; default `{ ok: true, tools: [] }`. */
	mcpTest?(spec: { name: string; server: unknown }): Promise<{ ok: boolean; tools: string[]; error?: string }>;
}

export interface FakeDispatcher extends Dispatcher {
	/** Use `script` for runs matching `match`, at most `times` runs (default: every run). First added match wins. */
	script(match: FakeMatch, script: FakeRunScript, times?: number): void;
	/** `script(match, script, 1)`. */
	once(match: FakeMatch, script: FakeRunScript): void;
	/** The next `runAgent` for `owner` that finds no run throws `RunLost` (a run lost while no orchestrator was attached). */
	markLost(owner: RunOwner): void;
	/** The live or undelivered run of `owner`. */
	run(owner: RunOwner): FakeRun | undefined;
	/** Every run started so far, oldest first. */
	readonly runs: readonly FakeRun[];
	/** Every `runAgent` request, attaches included, in call order. */
	readonly calls: readonly { req: RunRequest; attached: boolean }[];
	/** Every `mcpTest` request, in call order. */
	readonly mcpTests: readonly { name: string; server: unknown }[];
	/** Settles once no run is unfinished. */
	idle(): Promise<void>;
}

const DEFAULT_USAGE: RunUsage = { costUsd: 0.01, input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };

/** The canned `yield` output of a run of `req.kind` (AGT-12 shapes). */
export function cannedOutput(req: RunRequest): unknown {
	switch (req.kind) {
		case "plan": {
			const plan = {
				summary: "Canned plan from the fake dispatcher.",
				planMarkdown: "## Plan\n1. Make the change.\n2. Test it.",
				complexity: "small",
			};
			return req.owner.kind === "plan" ? { title: "Canned request plan", ...plan } : plan;
		}
		case "implement":
			return { prTitle: "Canned change", prBody: "Made by the fake dispatcher.", testing: "Nothing was run." };
		case "revise":
		case "fix_ci":
			return { summary: "Canned follow-up from the fake dispatcher." };
		case "chat":
		case "ask":
			return { answer: "Canned answer from the fake dispatcher." };
		case "draft":
			return {
				title: "Canned issue",
				body: "## Summary\nCanned.\n\n## Context\nNone.\n\n## Acceptance criteria\n- [ ] Done",
			};
	}
}

function matches(match: FakeMatch, req: RunRequest): boolean {
	if (typeof match === "function") return match(req);
	if (match.owner && ownerKey(match.owner) !== ownerKey(req.owner)) return false;
	if (match.kind && match.kind !== req.kind) return false;
	if (match.profile && match.profile !== req.profile) return false;
	return true;
}

/** Index of the dialog options argument per `RunUi` method. */
const DIALOG_ARG: Record<Exclude<keyof RunUi, "notify">, number> = { askDialog: 1, select: 2, input: 2, editor: 2, confirm: 2 };

interface Caller {
	hooks: RunHooks;
	resolve(result: RunResult): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface QueuedSteer {
	resolve(result: "delivered" | "ended"): void;
}

interface RunImpl extends FakeRun {
	state: FakeRun["state"];
	registered: boolean;
	aborted: AbortReason | undefined;
	attachCount: number;
	key: string;
	script: FakeRunScript;
	caller: Caller | undefined;
	outcome: FakeOutcome | undefined;
	handle: RunHandle;
	pendingSince: number | undefined;
	/** Usage computed at the end, waiting for a caller when none was attached (OBS-05: reported exactly once). */
	usageOwed: RunUsage | undefined;
	posted: Map<string, { channelId: string; messageIds: string[] }>;
	/** Steers not yet settled. */
	queued: QueuedSteer[];
	/** Delivery promises of questions not yet answered, settled false when the run ends. */
	openQuestions: Set<(delivered: boolean) => void>;
}

export function createFakeDispatcher(opts: FakeDispatcherOptions = {}): FakeDispatcher {
	const scripts: { match: FakeMatch; script: FakeRunScript; left: number }[] = (opts.scripts ?? []).map(s => ({
		match: s.match,
		script: s.script,
		left: s.times ?? Number.POSITIVE_INFINITY,
	}));
	const canned = opts.cannedOutput ?? cannedOutput;
	const byOwner = new Map<string, RunImpl>();
	const lostOwners = new Set<string>();
	const runs: RunImpl[] = [];
	const calls: { req: RunRequest; attached: boolean }[] = [];
	const mcpTests: { name: string; server: unknown }[] = [];
	let nextId = 1;
	let idleWaiters: (() => void)[] = [];

	function pickScript(req: RunRequest): FakeRunScript {
		for (const entry of scripts) {
			if (entry.left > 0 && matches(entry.match, req)) {
				entry.left--;
				return entry.script;
			}
		}
		return {};
	}

	function unfinished(): number {
		let n = 0;
		for (const run of byOwner.values()) if (run.state !== "finished") n++;
		return n;
	}

	function checkIdle(): void {
		if (unfinished() > 0) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const w of waiters) w();
	}

	/** Hands the finished run's outcome (and any owed usage) to the attached caller, then forgets the run. */
	function deliver(run: RunImpl): void {
		const caller = run.caller;
		if (!caller || !run.outcome) return;
		if (run.usageOwed) {
			const usage = run.usageOwed;
			run.usageOwed = undefined;
			caller.hooks.onUsage?.(usage);
		}
		run.caller = undefined;
		caller.cleanup();
		if (byOwner.get(run.key) === run) byOwner.delete(run.key);
		if (run.outcome.type === "result") caller.resolve(run.outcome.result);
		else caller.reject(run.outcome.error);
	}

	function attach(run: RunImpl, req: RunRequest, hooks: RunHooks, signal: AbortSignal | undefined): Promise<RunResult> {
		const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
		if (signal?.aborted) {
			reject(new RunDetached());
			return promise;
		}
		// A newer caller replaces an older one (only one engine instance is attached at a time).
		const previous = run.caller;
		if (previous) {
			previous.cleanup();
			previous.reject(new RunDetached());
		}
		const onAbort = () => {
			if (run.caller !== caller) return;
			run.caller = undefined;
			caller.cleanup();
			reject(new RunDetached());
		};
		const caller: Caller = {
			hooks,
			resolve,
			reject,
			cleanup: () => signal?.removeEventListener("abort", onAbort),
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		run.caller = caller;
		run.attachCount++;
		calls.push({ req, attached: run.attachCount > 1 });
		if (run.outcome) {
			deliver(run);
			return promise;
		}
		if (run.registered) hooks.register(run.handle);
		return promise;
	}

	/** `ui` with a `UiCallContext` added to the dialog options of every question (RUN-08, RUN-15). */
	function contextUi(run: RunImpl, ui: RunUi): RunUi {
		let n = 0;
		const call = (method: keyof typeof DIALOG_ARG) =>
			((...args: unknown[]) => {
				const key = `${run.id}:${++n}`;
				const delivered = Promise.withResolvers<boolean>();
				run.openQuestions.add(delivered.resolve);
				const context: UiCallContext = {
					key,
					onPosted: posted => void run.posted.set(key, posted),
					delivered: delivered.promise,
				};
				const index = DIALOG_ARG[method];
				const full = [...args];
				while (full.length < index) full.push(undefined);
				full[index] = { ...(full[index] as object | undefined), [UI_CALL_CONTEXT]: context };
				const fn = ui[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
				if (!fn) return Promise.reject(new Error(`${method} unsupported`));
				return fn.apply(ui, full).then(
					value => {
						run.openQuestions.delete(delivered.resolve);
						delivered.resolve(true);
						return value;
					},
					err => {
						run.openQuestions.delete(delivered.resolve);
						delivered.resolve(false);
						throw err;
					},
				);
			}) as never;
		return {
			askDialog: call("askDialog"),
			select: call("select"),
			input: call("input"),
			editor: call("editor"),
			confirm: call("confirm"),
			notify: (message, type) => ui.notify(message, type),
		};
	}

	function start(req: RunRequest, hooks: RunHooks, signal: AbortSignal | undefined): Promise<RunResult> {
		const script = pickScript(req);
		const aborter = new AbortController();
		const { promise: done, resolve: markDone } = Promise.withResolvers<void>();
		const settleSteers = (result: "delivered" | "ended") => {
			const queued = run.queued;
			run.queued = [];
			for (const steer of queued) steer.resolve(result);
		};
		const run: RunImpl = {
			id: nextId++,
			key: ownerKey(req.owner),
			req,
			script,
			state: "pending",
			registered: false,
			aborted: undefined,
			steers: [],
			answers: [],
			posted: new Map(),
			queued: [],
			openQuestions: new Set(),
			attachCount: 0,
			get attached() {
				return run.caller !== undefined;
			},
			caller: undefined,
			outcome: undefined,
			pendingSince: Date.now(),
			usageOwed: undefined,
			done,
			handle: {
				async steer(text: string, from: string, steerOpts?: SteerOptions) {
					if (run.state === "finished" || script.steerResult === "ended") return "ended";
					run.steers.push({ text, from, ...(steerOpts?.scratchInputs ? { scratchInputs: steerOpts.scratchInputs } : {}) });
					run.caller?.hooks.onTranscript?.({ type: "steer", text: `[Discord @${from}]: ${text}` });
					if (run.registered && script.steerResult !== "queued") return "delivered";
					steerOpts?.onQueued?.();
					const { promise, resolve } = Promise.withResolvers<"delivered" | "ended">();
					run.queued.push({ resolve });
					return promise;
				},
				async abort(reason) {
					if (run.state === "finished" || run.aborted) return;
					run.aborted = reason;
					aborter.abort();
				},
			},
			finish(result) {
				end({ type: "result", result: { ...baseResult(), ...result } });
			},
			fail(error) {
				end({ type: "error", error: typeof error === "string" ? new Error(error) : error });
			},
			lose() {
				end("lose");
			},
			deliverSteers() {
				settleSteers("delivered");
			},
		};
		const usage = (): RunUsage => ({ ...DEFAULT_USAGE, ...script.usage });
		const baseResult = (): RunResult => ({
			output: script.output ?? canned(req),
			usage: usage(),
			oomKills: script.oomKills ?? 0,
			hasSession: script.hasSession ?? true,
		});
		const hooksNow = () => run.caller?.hooks;
		const register = () => {
			if (run.registered) return;
			run.registered = true;
			hooksNow()?.register(run.handle);
			if (script.steerResult !== "queued") settleSteers("delivered");
		};
		/** Resolves at `ms`/`gate`, or rejects with `aborted` once the run is aborted. */
		const waitFor = (what: number | Promise<unknown>): Promise<void> => {
			if (aborter.signal.aborted) return Promise.reject(new Error("aborted"));
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const onAbort = () => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			};
			aborter.signal.addEventListener("abort", onAbort, { once: true });
			const settle = () => {
				aborter.signal.removeEventListener("abort", onAbort);
				clearTimeout(timer);
				resolve();
			};
			const timer = typeof what === "number" ? setTimeout(settle, what) : undefined;
			if (typeof what !== "number") what.then(settle, settle);
			return promise;
		};

		async function drive(): Promise<FakeOutcome | "lose"> {
			if (script.pending !== undefined) {
				hooksNow()?.onWaitingForWorker?.();
				await waitFor(script.pending);
			}
			run.state = "running";
			run.pendingSince = undefined;
			hooksNow()?.onTranscript?.({ type: "prompt", text: req.prompt });
			const steps = script.steps ?? [];
			const registerAt = script.registerAt === undefined ? 0 : script.registerAt;
			for (let i = 0; i < steps.length; i++) {
				if (registerAt === i) register();
				const step = steps[i]!;
				const hooks = hooksNow();
				if ("progress" in step) hooks?.onProgress?.({ usage: usage(), elapsedMs: 0, ...step.progress });
				else if ("todos" in step) hooks?.onTodos?.(step.todos);
				else if ("transcript" in step) hooks?.onTranscript?.(step.transcript);
				else if ("ui" in step) {
					if (!hooks) throw new Error("fake run asked a question while no caller was attached");
					run.answers.push(await step.ui(contextUi(run, hooks.ui), aborter.signal));
				} else if ("delayMs" in step) await waitFor(step.delayMs);
				else await waitFor(step.until);
				if (aborter.signal.aborted) throw new Error("aborted");
			}
			if (registerAt !== null && registerAt >= steps.length) register();
			if (script.hold) {
				// Held until `finish`, `fail` or `lose` end the run (which aborts the waiters), or until it is aborted.
				const { promise, resolve } = Promise.withResolvers<FakeOutcome | "lose">();
				const onAbort = () => resolve({ type: "result", result: { ...baseResult(), output: undefined, aborted: run.aborted } });
				if (aborter.signal.aborted) onAbort();
				else aborter.signal.addEventListener("abort", onAbort, { once: true });
				return promise;
			}
			if (script.lost) return "lose";
			if (script.error) return { type: "error", error: typeof script.error === "string" ? new Error(script.error) : script.error };
			if (script.aborted) return { type: "result", result: { ...baseResult(), output: undefined, aborted: script.aborted } };
			return { type: "result", result: baseResult() };
		}

		/** Writes the script's output files into the scratch directory; returns their names (CHAT-10). */
		async function writeOutputs(): Promise<string[] | undefined> {
			if (!script.outputFiles || !req.scratchDir) return undefined;
			const dir = join(req.scratchDir, "outputs");
			await mkdir(dir, { recursive: true });
			for (const [name, content] of Object.entries(script.outputFiles)) await Bun.write(join(dir, name), content);
			return Object.keys(script.outputFiles);
		}

		function end(outcome: FakeOutcome | "lose"): void {
			if (run.state === "finished") return;
			// Stops any step still waiting (a run finished from outside).
			aborter.abort();
			const final: FakeOutcome = outcome === "lose" ? { type: "error", error: new RunLost() } : outcome;
			run.state = "finished";
			run.outcome = final;
			settleSteers("ended");
			for (const settle of run.openQuestions) settle(false);
			run.openQuestions.clear();
			const used = final.type === "result" ? final.result.usage : usage();
			hooksNow()?.onTranscript?.({
				type: "run_end",
				usage: used,
				aborted: final.type === "result" ? final.result.aborted : undefined,
				error: final.type === "error" ? final.error.message : undefined,
			});
			const hooks = hooksNow();
			if (hooks) hooks.onUsage?.(used);
			else run.usageOwed = used;
			markDone();
			deliver(run);
			checkIdle();
		}

		/** Ends the run once its output files are written (the real dispatcher writes them before the run settles). */
		function endWithOutputs(outcome: FakeOutcome | "lose"): void {
			if (run.state === "finished") return;
			if (!script.outputFiles || outcome === "lose") return end(outcome);
			void writeOutputs().then(
				outputs => end(outcome.type === "result" ? { type: "result", result: { ...outcome.result, outputs } } : outcome),
				err => end({ type: "error", error: err instanceof Error ? err : new Error(String(err)) }),
			);
		}

		byOwner.set(run.key, run);
		runs.push(run);
		const result = attach(run, req, hooks, signal);
		// Ended runs ignore the outcome; `finish`, `fail` and `lose` may have ended it first.
		void drive().then(
			outcome => endWithOutputs(outcome),
			err => {
				if (run.aborted) endWithOutputs({ type: "result", result: { ...baseResult(), output: undefined, aborted: run.aborted } });
				else end({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
			},
		);
		return result;
	}

	return {
		runAgent(req, hooks, signal) {
			const key = ownerKey(req.owner);
			const existing = byOwner.get(key);
			if (existing) return attach(existing, req, hooks, signal);
			if (lostOwners.delete(key)) {
				calls.push({ req, attached: true });
				return Promise.reject(new RunLost());
			}
			if (signal?.aborted) return Promise.reject(new RunDetached());
			return start(req, hooks, signal);
		},
		hasUnfinishedRun(owner) {
			const run = byOwner.get(ownerKey(owner));
			return run !== undefined && run.state !== "finished";
		},
		workers: () => [],
		counts() {
			let pending = 0;
			let running = 0;
			let oldest: number | undefined;
			for (const run of byOwner.values()) {
				if (run.state === "pending") {
					pending++;
					if (run.pendingSince !== undefined && (oldest === undefined || run.pendingSince < oldest)) oldest = run.pendingSince;
				} else if (run.state === "running") running++;
			}
			return { pending, running, oldestPendingMs: oldest === undefined ? null : Date.now() - oldest };
		},
		async mcpTest(spec) {
			mcpTests.push(spec);
			return opts.mcpTest ? opts.mcpTest(spec) : { ok: true, tools: [] };
		},
		script(match, script, times) {
			scripts.push({ match, script, left: times ?? Number.POSITIVE_INFINITY });
		},
		once(match, script) {
			scripts.push({ match, script, left: 1 });
		},
		markLost(owner) {
			lostOwners.add(ownerKey(owner));
		},
		run: owner => byOwner.get(ownerKey(owner)),
		get runs() {
			return runs;
		},
		get calls() {
			return calls;
		},
		get mcpTests() {
			return mcpTests;
		},
		idle() {
			if (unfinished() === 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			idleWaiters.push(resolve);
			return promise;
		},
	};
}
