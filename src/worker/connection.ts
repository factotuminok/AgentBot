import { errorMessage, log } from "../shared/log";
import type { ChildMessage } from "../shared/protocol";
import { LOG_LINE_LIMIT, truncate } from "../shared/transcript";
import { type DownMessage, MAX_WS_MESSAGE_BYTES, type OrchestratorControl, type RelayDown, type RelayUp, WORKER_WS_PATH, type WorkerControl } from "../shared/wire";

/**
 * The worker's side of the run protocol WebSocket (architecture §4.2, §4.3): `hello`, `claim`, control messages,
 * and the relay with per-run, per-direction sequence numbers and acks (RUN-06). The connection reconnects with
 * backoff for as long as the worker lives, re-announcing its lease, so a dropped connection never stops the run.
 */

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;
/**
 * Ping interval on an open connection; a connection silent for `KEEPALIVE_DEAD_PINGS` intervals, or an attempt not
 * open within one, is dropped and retried. Without this a connection whose orchestrator vanished without closing it
 * (container restarted with a new address, node gone) stays half-open, and an attempt to the old address hangs,
 * until TCP gives up, minutes after the re-attach grace and the lease ran out.
 */
export const KEEPALIVE_MS = 10_000;
const KEEPALIVE_DEAD_PINGS = 3;
/** Relay buffer bounds while the orchestrator has not acknowledged (RUN-06). */
export const OUTBOX_MAX_MESSAGES = 10_000;
export const OUTBOX_MAX_BYTES = 16 * 1024 * 1024;

/** Messages the buffer may drop, oldest first, when it is full. */
const DROPPABLE: Partial<Record<ChildMessage["t"], true>> = { progress: true, transcript: true, log: true };

export interface OutboxEntry {
	seq: number;
	type: ChildMessage["t"];
	/** The encoded `RelayUp`. */
	text: string;
	bytes: number;
}

/**
 * Unacknowledged relay messages in sequence order. When full (count or bytes), it drops the oldest `progress`,
 * `transcript` and `log` messages first, then every `todos` but the newest; it never drops anything else, so it
 * may stay over its bounds when only such messages are left.
 */
export class RelayOutbox {
	#entries: OutboxEntry[] = [];
	#bytes = 0;

	constructor(
		readonly maxMessages: number = OUTBOX_MAX_MESSAGES,
		readonly maxBytes: number = OUTBOX_MAX_BYTES,
	) {}

	get length(): number {
		return this.#entries.length;
	}

	get bytes(): number {
		return this.#bytes;
	}

	entries(): readonly OutboxEntry[] {
		return this.#entries;
	}

	/** Appends `entry` and returns the sequence numbers dropped to make room (possibly including its own). */
	push(entry: OutboxEntry): number[] {
		this.#entries.push(entry);
		this.#bytes += entry.bytes;
		const dropped: number[] = [];
		while (this.#entries.length > this.maxMessages || this.#bytes > this.maxBytes) {
			let index = this.#entries.findIndex(e => DROPPABLE[e.type]);
			if (index < 0) {
				const newestTodos = this.#entries.findLastIndex(e => e.type === "todos");
				index = this.#entries.findIndex((e, i) => e.type === "todos" && i !== newestTodos);
			}
			if (index < 0) break;
			const [removed] = this.#entries.splice(index, 1);
			this.#bytes -= removed!.bytes;
			dropped.push(removed!.seq);
		}
		return dropped;
	}

	/** Removes every entry up to and including `seq`. */
	ack(seq: number): void {
		let count = 0;
		while (count < this.#entries.length && this.#entries[count]!.seq <= seq) this.#bytes -= this.#entries[count++]!.bytes;
		if (count > 0) this.#entries.splice(0, count);
	}
}

/**
 * The 8 KiB cut for `log` lines before sending (RUN-16). `transcript` events already carry the OBS-03 field limits:
 * the host applies them as it emits each event, and cutting again would stack a second truncation marker.
 */
export function limitChildMessage(msg: ChildMessage): ChildMessage {
	return msg.t === "log" && msg.line.length > LOG_LINE_LIMIT ? { ...msg, line: truncate(msg.line, LOG_LINE_LIMIT) } : msg;
}

export interface Lease {
	runId: string;
	token: string;
}

export interface ConnectionOptions {
	/** `AGENTBOT_ORCHESTRATOR_URL` (http or https). */
	orchestratorUrl: string;
	workerToken: string;
	workerId: string;
	identity: { version: string; hash: string };
	ompVersion: string;
	reconnectMinMs?: number;
	reconnectMaxMs?: number;
	/** Ping interval (`KEEPALIVE_MS`); the connection is dropped and reopened after three intervals without a word. */
	keepaliveMs?: number;
	outbox?: RelayOutbox;
	/** Every control message except `scratch-input`; `assign` has already set the lease. */
	onControl(msg: OrchestratorControl): void;
	/** Relay messages from the orchestrator, in order, one at a time; acknowledged when the promise settles. */
	onRelay(msg: RelayDown["msg"]): Promise<void>;
	/** `scratch-input`, ordered with the relay messages so the steer that follows finds the file (CHAT-08). */
	onScratchInput(name: string): Promise<void>;
	onConnectedChange?(connected: boolean): void;
}

export function workerSocketUrl(orchestratorUrl: string): string {
	const url = new URL(WORKER_WS_PATH, `${orchestratorUrl}/`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export class WorkerConnection {
	readonly #opts: ConnectionOptions;
	readonly #outbox: RelayOutbox;
	#ws: WebSocket | undefined;
	#open = false;
	#stopped = false;
	#attempt = 0;
	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	#lease: Lease | undefined;
	#wantClaim = false;
	#claimAnswered = false;
	/** Control messages waiting for a connection. */
	#controls: WorkerControl[] = [];
	#flushWaiters: (() => void)[] = [];
	#nextSeq = 1;
	#acked = 0;
	#ackWaiters: { seq: number; resolve(): void }[] = [];
	#dropped = 0;
	/** Highest relay seq from the orchestrator taken into the queue, and the highest delivered (and acknowledged). */
	#downSeen = 0;
	#downDelivered = 0;
	#chain: Promise<void> = Promise.resolve();

	constructor(opts: ConnectionOptions) {
		this.#opts = opts;
		this.#outbox = opts.outbox ?? new RelayOutbox();
	}

	get connected(): boolean {
		return this.#open;
	}

	get lease(): Lease | undefined {
		return this.#lease;
	}

	/** Unacknowledged relay messages (tests and diagnostics). */
	get pending(): number {
		return this.#outbox.length;
	}

	start(): void {
		this.#connect();
	}

	/** Asks for one run, now or as soon as connected, until `assign` or `nothing` answers it. */
	claim(): void {
		this.#wantClaim = true;
		if (this.#open && !this.#lease) this.#write({ t: "claim" });
	}

	/** Sends a control message now, or after the next `hello` when disconnected. */
	send(msg: WorkerControl): void {
		if (this.#open) this.#write(msg);
		else this.#controls.push(msg);
	}

	/** Sends only when connected (heartbeats: a stale one is worthless). */
	sendIfConnected(msg: WorkerControl): boolean {
		if (!this.#open) return false;
		this.#write(msg);
		return true;
	}

	/** Resolves once every queued control message has been handed to an open socket. */
	flushed(): Promise<void> {
		if (this.#open && this.#controls.length === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#flushWaiters.push(resolve);
		return promise;
	}

	/**
	 * Relays a host message up with the next sequence number. Returns the sequence number, or `undefined` when the
	 * message is larger than 4 MiB even after the RUN-16 limits and is never sent.
	 */
	relay(msg: ChildMessage): number | undefined {
		const lease = this.#lease;
		if (!lease) throw new Error("relay without a lease");
		const limited = limitChildMessage(msg);
		const seq = this.#nextSeq;
		const up: RelayUp = { t: "relay", runId: lease.runId, seq, msg: limited };
		const text = JSON.stringify(up);
		const bytes = Buffer.byteLength(text);
		if (bytes > MAX_WS_MESSAGE_BYTES) {
			log("warn", "relay message larger than 4 MiB not sent", { run: lease.runId, type: limited.t, bytes });
			return undefined;
		}
		this.#nextSeq++;
		const dropped = this.#outbox.push({ seq, type: limited.t, text, bytes });
		this.#dropped += dropped.length;
		if (this.#open && !dropped.includes(seq)) this.#ws?.send(text);
		return seq;
	}

	/** Resolves when the orchestrator has acknowledged relay `seq`. */
	waitAck(seq: number): Promise<void> {
		if (this.#acked >= seq) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ackWaiters.push({ seq, resolve });
		return promise;
	}

	/** Closes the socket (waiting up to `waitMs` for buffered data to go out) and stops reconnecting. */
	async stop(waitMs = 2_000): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#reconnectTimer);
		const ws = this.#ws;
		this.#ws = undefined;
		this.#setOpen(false);
		if (!ws || ws.readyState === WebSocket.CLOSED) return;
		const closed = Promise.withResolvers<void>();
		ws.addEventListener("close", () => closed.resolve(), { once: true });
		ws.close(1000, "worker exiting");
		await Promise.race([closed.promise, Bun.sleep(waitMs)]);
	}

	#connect(): void {
		if (this.#stopped) return;
		let ws: WebSocket;
		try {
			// The worker token authenticates the upgrade (SEC-14). Bun's client takes `Bun.WebSocketOptions`; the DOM lib's
			// constructor signature shadows that overload, hence the cast.
			const options: Bun.WebSocketOptions = { headers: { Authorization: `Bearer ${this.#opts.workerToken}` } };
			ws = new WebSocket(workerSocketUrl(this.#opts.orchestratorUrl), options as unknown as string[]);
		} catch (err) {
			log("warn", "worker connection failed", { error: errorMessage(err) });
			this.#scheduleReconnect();
			return;
		}
		this.#ws = ws;
		// Ping, pong and terminate are Bun's; the DOM lib's WebSocket type shadows them.
		const client = ws as unknown as Bun.WebSocket;
		const intervalMs = this.#opts.keepaliveMs ?? KEEPALIVE_MS;
		const deadMs = KEEPALIVE_DEAD_PINGS * intervalMs;
		let heard = Date.now();
		const dropped = (code: number, reason: string) => {
			clearInterval(watchdog);
			if (this.#ws !== ws) return;
			this.#ws = undefined;
			if (this.#open) log("warn", "worker connection lost", { code, reason: reason || undefined, run: this.#lease?.runId });
			else log("info", "worker connection attempt failed", { code, reason: reason || undefined, attempt: this.#attempt, run: this.#lease?.runId });
			this.#setOpen(false);
			this.#scheduleReconnect();
		};
		// Covers the connection attempt too, within one interval: an attempt to an address that no longer answers hangs
		// until TCP gives up, and the next one may get a fresh address (Bun caches DNS answers for up to 30 s).
		const watchdog = setInterval(() => {
			const open = ws.readyState === WebSocket.OPEN;
			if (open && Date.now() - heard <= deadMs) return client.ping();
			if (open || ws.readyState === WebSocket.CONNECTING) client.terminate();
			dropped(1006, open ? `no answer for ${deadMs} ms` : `not connected after ${intervalMs} ms`);
		}, intervalMs);
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			heard = Date.now();
			this.#onOpen();
		};
		client.addEventListener("pong", () => {
			heard = Date.now();
		});
		ws.onmessage = event => {
			heard = Date.now();
			if (this.#ws !== ws) return;
			this.#onMessage(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8"));
		};
		ws.onclose = event => dropped(event.code, event.reason);
		ws.onerror = () => {
			// `close` follows and schedules the reconnect.
		};
	}

	#scheduleReconnect(): void {
		if (this.#stopped) return;
		const min = this.#opts.reconnectMinMs ?? RECONNECT_MIN_MS;
		const max = this.#opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
		const delay = Math.min(max, min * 2 ** this.#attempt);
		this.#attempt++;
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
	}

	#setOpen(open: boolean): void {
		if (this.#open === open) return;
		this.#open = open;
		this.#opts.onConnectedChange?.(open);
	}

	#write(msg: WorkerControl | RelayUp | { t: "ack"; runId: string; seq: number }): void {
		try {
			this.#ws?.send(JSON.stringify(msg));
		} catch (err) {
			log("warn", "worker connection send failed", { type: msg.t, error: errorMessage(err) });
		}
	}

	#onOpen(): void {
		const lease = this.#lease;
		this.#setOpen(true);
		this.#write({
			t: "hello",
			workerId: this.#opts.workerId,
			identity: this.#opts.identity,
			ompVersion: this.#opts.ompVersion,
			...(lease ? { lease: { runId: lease.runId, token: lease.token } } : {}),
		});
		if (lease && this.#downDelivered > 0) this.#write({ t: "ack", runId: lease.runId, seq: this.#downDelivered });
		for (const msg of this.#controls.splice(0)) this.#write(msg);
		if (lease) {
			if (this.#dropped > 0) {
				log("warn", "relay buffer was full while disconnected; dropped progress and transcript messages", { run: lease.runId, dropped: this.#dropped });
				this.#dropped = 0;
			}
			for (const entry of this.#outbox.entries()) this.#ws?.send(entry.text);
		} else if (this.#wantClaim && !this.#claimAnswered) {
			this.#write({ t: "claim" });
		}
		for (const resolve of this.#flushWaiters.splice(0)) resolve();
	}

	#onMessage(text: string): void {
		let msg: DownMessage;
		try {
			msg = JSON.parse(text) as DownMessage;
		} catch {
			log("warn", "worker connection: unparsable message dropped");
			return;
		}
		switch (msg.t) {
			case "ack": {
				if (msg.runId !== this.#lease?.runId || msg.seq <= this.#acked) return;
				this.#acked = msg.seq;
				this.#outbox.ack(msg.seq);
				const ready = this.#ackWaiters.filter(w => w.seq <= msg.seq);
				this.#ackWaiters = this.#ackWaiters.filter(w => w.seq > msg.seq);
				for (const waiter of ready) waiter.resolve();
				return;
			}
			case "relay":
				this.#onRelay(msg);
				return;
			case "assign":
				if (this.#lease) {
					log("warn", "second assign ignored", { run: msg.runId });
					return;
				}
				this.#lease = { runId: msg.runId, token: msg.token };
				this.#claimAnswered = true;
				break;
			case "nothing":
				this.#claimAnswered = true;
				break;
			case "scratch-input":
				if (msg.runId !== this.#lease?.runId) return;
				this.#enqueue(() => this.#opts.onScratchInput(msg.name));
				return;
		}
		this.#opts.onControl(msg);
	}

	#onRelay(msg: RelayDown): void {
		const lease = this.#lease;
		if (!lease || msg.runId !== lease.runId) return;
		if (msg.seq <= this.#downSeen) {
			// A resend after a reconnect: drop it and repeat the ack (RUN-06).
			if (this.#downDelivered > 0 && this.#open) this.#write({ t: "ack", runId: lease.runId, seq: this.#downDelivered });
			return;
		}
		this.#downSeen = msg.seq;
		this.#enqueue(async () => {
			try {
				await this.#opts.onRelay(msg.msg);
			} finally {
				this.#downDelivered = Math.max(this.#downDelivered, msg.seq);
				if (this.#open) this.#write({ t: "ack", runId: lease.runId, seq: this.#downDelivered });
			}
		});
	}

	#enqueue(task: () => Promise<void>): void {
		this.#chain = this.#chain.then(task).catch(err => log("warn", "worker: handling an orchestrator message failed", { run: this.#lease?.runId, error: errorMessage(err) }));
	}
}
