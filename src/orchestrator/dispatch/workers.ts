import type { RunStatus, WorkerStatus } from "../../shared/adminApi";
import type { Loadout } from "../../shared/agent";
import { existsSync } from "node:fs";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { addLogSecret, errorMessage, log, removeLogSecret, writeRelayedLogLine } from "../../shared/log";
import { MCP_TEST_TIMEOUT_MS, type McpServer, parseOmpConfig } from "../../shared/ompconfig";
import type { ChildMessage, Reply, UiMethod } from "../../shared/protocol";
import type { RunUsage } from "../../shared/transcript";
import { callUi } from "../../shared/ui";
import {
	type DownMessage,
	LEASE_MS,
	MAX_WS_MESSAGE_BYTES,
	type RelayDown,
	type RunSpec,
	type UpMessage,
	type WorkerControl,
	type WorkerPhase,
} from "../../shared/wire";
import { type ClaimedRun, type Db, parseJson, type RunOutcome, type RunOwnerColumn, type RunRow } from "../store/db";
import type { Config } from "../../shared/config";
import { sessionPath } from "../store/sessions";
import { createGitEndpoint } from "../git/endpoint";
import type { Repos } from "../git/repos";
import type { OmpRuntimeSource } from "../omp/updates";
import { changedOutputs, createArtifactHandler, MAX_BUNDLE_BYTES, STATE_FREE_FLOOR_BYTES } from "./artifacts";
import { createRunRefs, type PreparedCheckout, prepareCheckout, readRepoConfig } from "./checkouts";
import {
	type AbortReason,
	type Dispatcher,
	NoStructuredOutput,
	ownerKey,
	RunDetached,
	type RunHandle,
	type RunHooks,
	RunLost,
	type RunOwner,
	type RunRequest,
	type RunResult,
	type SteerOptions,
	UI_CALL_CONTEXT,
	type UiCallContext,
	writesCode,
} from "./dispatcher";
import { claimNextRun, holdsLease, newLeaseToken, sameToken } from "./leases";
import { type RunRelay, runRelay } from "./relay";
import { buildRunSpec, type SpecSources, sessionDir, unrunnableReason } from "./spec";
import type { CredentialAnswer, CredentialRequest } from "../store/signins";

/**
 * The real `Dispatcher` (architecture §4.1 to §4.5): runs live in the `runs` table, each on its own worker. Workers
 * connect over the `/internal/worker` WebSocket, claim one run each, and relay the agent host's IPC; bulk data goes over
 * the run artifact endpoints. Process-wide: engine restarts only detach from runs, and an orchestrator restart re-attaches
 * to the workers that re-announce their leases (RUN-07, RUN-09).
 */

/** RUN-01 caps; `maxConcurrentRuns` already defaults to the worker capacity. */
export interface DispatchLimits {
	maxConcurrentJobs: number;
	maxChatSessions: number;
	maxConcurrentRuns: number;
}

/**
 * The caps for the saved settings' `config`. Without it (settings unsaved, invalid or locked) no job or chat can start,
 * but MCP connection tests (AGT-21) still run, up to the worker capacity: an admin can test servers before the first save.
 */
export function dispatchLimits(config: Pick<Config, "limits" | "workers"> | undefined, workerCapacity: number): DispatchLimits {
	if (!config) return { maxConcurrentJobs: 0, maxChatSessions: 0, maxConcurrentRuns: workerCapacity };
	const { maxConcurrentJobs, maxChatSessions } = config.limits;
	return { maxConcurrentJobs, maxChatSessions, maxConcurrentRuns: config.workers.maxConcurrentRuns ?? workerCapacity };
}

export interface WorkerDispatcherOptions {
	db: Db;
	stateDir: string;
	/** RUN-01 caps, read whenever a slot may have opened (`dispatchLimits`); undefined: nothing new becomes pending. */
	limits(): DispatchLimits | undefined;
	/** `workers.reattachGraceSeconds` in ms, applied once at start to runs left `assigned` or `running` (RUN-07). */
	reattachGraceMs: number;
	/** Where the run spec's parts come from (read at claim time). */
	spec: SpecSources;
	/** The skills and agents bundle served to workers (AGT-24). */
	skills(): Promise<{ hash: string; tar: Uint8Array }>;
	/** Answers a worker's `credential-request` (CRED-03); must not throw. */
	credentialRequest(req: CredentialRequest): Promise<CredentialAnswer>;
	/** How long a `claim` waits for a pending run before `nothing`; default 10 s. */
	claimWaitMs?: number;
	/** Lease length (default `LEASE_MS`) and how often expired leases are swept (default 1 s); shorter in tests. */
	leaseMs?: number;
	sweepMs?: number;
	/** Mirrors and runs repos (WS-01, RUN-17 to RUN-20). */
	repos: Repos;
	/** In-place omp updates (UPD-07, UPD-08): the copy runs are given, its archive, canary failures; none outside the image. */
	ompRuntime?: OmpRuntimeSource;
	/**
	 * Architecture §6, `AGENTBOT_WORKER_ADDRESS_BINDING`: a worker id stays bound to the network address it first said
	 * hello from, and an address holds one claim at a time (none for 60 s after its last one ended). Off only where
	 * workers share a source address (a service mesh, or local worker processes in tests).
	 */
	bindWorkerAddresses: boolean;
	/** `AGENTBOT_WORKER_DISK` (STO-06): checkpoint and result bundles above it are refused; default `MAX_BUNDLE_BYTES`. */
	workerDiskBytes?: number;
	/** Free space the state volume keeps: uploads that would go below it are refused; default `STATE_FREE_FLOOR_BYTES`. */
	stateFreeFloorBytes?: number;
}

/** `ws.data` of a worker WebSocket; `server.ts` creates it with `socketData` when it upgrades (after the worker-token check). */
export interface WorkerSocketData {
	address: string;
}

export interface WorkerDispatcher extends Dispatcher {
	/** `GET /internal/scale` (architecture §4.4): runs a new worker could claim. */
	pendingRuns(): number;
	socketData(address: string): WorkerSocketData;
	/** The `/internal/worker` WebSocket handlers. */
	readonly websocket: WebSocketHandler<WorkerSocketData>;
	/** `/internal/runs/<id>/…`, lease-token authorised. */
	artifact(req: Request): Promise<Response>;
	/** `/internal/git/<owner>/<name>.git/…`: read-only git from the mirror of the lease's repo (RUN-17). */
	git(req: Request): Promise<Response>;
	/** Settles when the start-up pass is done: refs of finished runs not kept for Retry pruned, unused mirrors deleted (WS-07, WS-01). */
	maintenance(): Promise<void>;
	/** Stops timers (RUN-09: never aborts runs). */
	close(): void;
}

/** omp refreshes within 10 s; the answer must arrive before that (CRED-03). */
const CREDENTIAL_ANSWER_MS = 9_500;
/** After `assign`, an mcp-test result must arrive within its timeout plus this (worker start, transfer). */
const MCP_TEST_SLACK_MS = 10_000;
const ACTIVE_STATES = ["pending", "assigned", "running", "finishing", "lost"] as const;
/** WS-01: how often unused mirrors are looked for after the one pass at start. */
const MIRROR_EXPIRY_MS = 24 * 3_600_000;
/** Architecture §6: how long an address can't claim after a claim from it ended (its worker may still be exiting). */
const ADDRESS_QUIET_MS = 60_000;

type StoredOutcome = { ok: true; result: RunResult } | { ok: false; error: { name: string; message: string }; usage: RunUsage };

interface Caller {
	hooks: RunHooks;
	resolve(result: RunResult): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface Steer {
	text: string;
	opts: SteerOptions | undefined;
	resolve(result: "delivered" | "ended"): void;
	queuedReported: boolean;
}

interface Question {
	caller: Caller;
	controller: AbortController;
	settle(delivered: boolean): void;
	/** Superseded by a newer caller's invocation: its outcome is ignored. */
	stale: boolean;
	/** The host withdrew it (`ui_cancel`): no reply is sent. */
	cancelled: boolean;
}

interface Conn {
	ws: ServerWebSocket<WorkerSocketData>;
	address: string;
	connectedAt: string;
	workerId?: string;
	version?: string;
	ompVersion?: string;
	runOmpVersion?: string;
	/** The run or mcp-test task this connection holds the lease of. */
	runId?: string;
	phase?: WorkerPhase;
	claimTimer?: ReturnType<typeof setTimeout>;
	/** Messages are handled one at a time, in order. */
	queue: Promise<void>;
	/** False once the socket closed: nothing more is sent. */
	open: boolean;
	/** Close handled: unbound from its run and claims. */
	closed: boolean;
}

interface Run {
	type: "run";
	key: string;
	owner: RunOwner;
	category: "job" | "chat";
	/** Set once the run is admitted (a `runs` row exists). */
	id: string | undefined;
	/** Unknown for a run found in the database after a restart until a caller attaches. */
	req: RunRequest | undefined;
	caller: Caller | undefined;
	handle: RunHandle;
	registered: boolean;
	conn: Conn | undefined;
	usage: RunUsage;
	/** Tool of the latest progress report and the reported loadout, for the status page (§9.3); lost on restart. */
	lastTool: string | undefined;
	loadout: Loadout | undefined;
	aborted: AbortReason | undefined;
	/** Steers waiting for `registered`. */
	queued: Steer[];
	/** Steers sent, by request id, waiting for the host's reply. */
	sent: Map<number, Steer>;
	questions: Map<number, Question>;
	/** Answers sent, settled when the worker acknowledges their sequence number (RUN-15). */
	deliveries: { seq: number; settle(delivered: boolean): void }[];
	/** `scratch-input` names to send before the relay message with this sequence number (CHAT-08). */
	scratchBefore: Map<number, string[]>;
	/** `tool_call`s that arrived while no caller was attached (after a restart). */
	deferredTools: Extract<ChildMessage, { t: "tool_call" }>[];
	outcome: StoredOutcome | undefined;
}

interface McpTask {
	type: "mcp";
	id: string;
	name: string;
	server: McpServer;
	createdAt: number;
	state: "waiting" | "pending" | "assigned" | "done";
	token?: string;
	workerId?: string;
	conn?: Conn;
	leaseExpiresAt?: number;
	timer?: ReturnType<typeof setTimeout>;
	resolve(result: { ok: boolean; tools: string[]; error?: string }): void;
	/** A worker picked the test up: its timeout starts now. */
	onStarted?(): void;
}

const ZERO_USAGE: RunUsage = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function ownerColumn(owner: RunOwner): [RunOwnerColumn, string] {
	switch (owner.kind) {
		case "job":
			return ["job_id", owner.jobId];
		case "chat":
			return ["chat_thread_id", owner.threadId];
		case "plan":
			return ["plan_thread_id", owner.threadId];
		case "draft":
			return ["draft_id", owner.draftId];
	}
}

function rowOwner(row: RunRow): RunOwner {
	if (row.job_id) return { kind: "job", jobId: row.job_id };
	if (row.chat_thread_id) return { kind: "chat", threadId: row.chat_thread_id };
	if (row.plan_thread_id) return { kind: "plan", threadId: row.plan_thread_id };
	return { kind: "draft", draftId: row.draft_id ?? "" };
}

/** The part of a run request that defines the turn and survives in the `runs` row; the rest are the live engine's closures. */
type RunTurn = Pick<RunRequest, "profile" | "prompt" | "outputSchema" | "model" | "thinking" | "limits" | "session" | "resume" | "threadId" | "scratchDir">;

function turnOf(req: RunRequest): RunTurn {
	const { profile, prompt, outputSchema, model, thinking, limits, session, resume, threadId, scratchDir } = req;
	return { profile, prompt, outputSchema, model, thinking, limits, session, resume, threadId, scratchDir };
}

function toError(error: { name: string; message: string }): Error {
	if (error.name === "RunLost") return new RunLost();
	if (error.name === "NoStructuredOutput") return new NoStructuredOutput();
	return new Error(error.message);
}

function guard(what: string, fn: () => void, fields: Record<string, unknown> = {}): void {
	try {
		fn();
	} catch (err) {
		log("warn", `${what} failed`, { ...fields, error: errorMessage(err) });
	}
}

/** The outer type and run id of an oversized message, read from its start without parsing it (RUN-16 logging). */
function sniff(text: string): { type?: string; run?: string } {
	const head = text.slice(0, 4096);
	const inner = /"msg"\s*:\s*\{\s*"t"\s*:\s*"([^"]{1,40})"/.exec(head)?.[1];
	const outer = /"t"\s*:\s*"([^"]{1,40})"/.exec(head)?.[1];
	return { type: inner ? `${outer}/${inner}` : outer, run: /"runId"\s*:\s*"([^"]{1,100})"/.exec(head)?.[1] };
}

export function createWorkerDispatcher(opts: WorkerDispatcherOptions): WorkerDispatcher {
	const { db } = opts;
	const leaseMs = opts.leaseMs ?? LEASE_MS;
	const claimWaitMs = opts.claimWaitMs ?? 10_000;
	/** Runs by owner key: waiting for a slot, active, or finished and not yet delivered. */
	const runs = new Map<string, Run>();
	const byId = new Map<string, Run>();
	/** Runs and mcp tests above their caps, oldest first (RUN-01): in memory only, not `pending`. */
	const waiting: (Run | McpTask)[] = [];
	const tasks = new Map<string, McpTask>();
	const conns = new Map<WorkerSocketData, Conn>();
	const claimers: Conn[] = [];
	const relays = new Map<string, RunRelay>();
	/** Runs admitted past their caps whose checkout is being prepared (RUN-17): they count as active, not yet `pending`. */
	const preparing = new Set<Run>();
	/** When a connection holding a run or mcp test last closed, by address (architecture §6 quiet period). */
	const released = new Map<string, number>();
	/** Live lease tokens by run or mcp-test id: masked in every log line while they open anything (F9). */
	const liveLeases = new Map<string, string>();
	const leaseLive = (id: string, token: string): void => {
		liveLeases.set(id, token);
		addLogSecret(token);
	};
	const leaseEnded = (id: string): void => {
		removeLogSecret(liveLeases.get(id));
		liveLeases.delete(id);
	};
	const refs = createRunRefs(db, opts.repos);
	const artifacts = createArtifactHandler({
		db,
		stateDir: opts.stateDir,
		skills: opts.skills,
		repos: opts.repos,
		refs,
		ompRuntime: opts.ompRuntime,
		bundleLimitBytes: Math.min(MAX_BUNDLE_BYTES, opts.workerDiskBytes ?? MAX_BUNDLE_BYTES),
		freeFloorBytes: opts.stateFreeFloorBytes ?? STATE_FREE_FLOOR_BYTES,
	});
	const gitEndpoint = createGitEndpoint({ repos: opts.repos, authorize: token => db.runForLease(token)?.repo ?? undefined });

	const relayOf = (id: string): RunRelay => {
		let relay = relays.get(id);
		if (!relay) {
			relay = runRelay(db, id);
			relays.set(id, relay);
		}
		return relay;
	};

	function send(conn: Conn | undefined, msg: DownMessage): void {
		if (!conn?.open) return;
		try {
			conn.ws.send(JSON.stringify(msg));
		} catch (err) {
			log("warn", "worker send failed", { worker: conn.workerId, error: errorMessage(err) });
		}
	}

	function sessionExists(run: Run): boolean {
		const key = run.req?.session ?? (run.id ? db.getRun(run.id)?.session_key : undefined);
		if (!key) return false;
		try {
			return existsSync(sessionPath(sessionDir(opts.stateDir), key));
		} catch {
			return false;
		}
	}

	// ── Runs in memory ──────────────────────────────────────────────────────────────────────────

	function newRun(owner: RunOwner, req: RunRequest | undefined): Run {
		const run: Run = {
			type: "run",
			key: ownerKey(owner),
			owner,
			category: owner.kind === "job" ? "job" : "chat",
			id: undefined,
			req,
			caller: undefined,
			registered: false,
			conn: undefined,
			usage: ZERO_USAGE,
			lastTool: undefined,
			loadout: undefined,
			aborted: undefined,
			queued: [],
			sent: new Map(),
			questions: new Map(),
			deliveries: [],
			scratchBefore: new Map(),
			deferredTools: [],
			outcome: undefined,
			handle: {
				steer: (text, from, steerOpts) => steer(run, `[Discord @${from}]: ${text}`, steerOpts),
				abort: async reason => abort(run, reason),
			},
		};
		return run;
	}

	/** The in-memory run of a `runs` row, created from the row after a restart. */
	function ensureRun(row: RunRow): Run {
		const known = byId.get(row.id);
		if (known) return known;
		const run = newRun(rowOwner(row), undefined);
		run.id = row.id;
		run.registered = row.state === "running";
		if (row.state === "finished" && row.result) run.outcome = JSON.parse(row.result) as StoredOutcome;
		runs.set(run.key, run);
		byId.set(row.id, run);
		return run;
	}

	function forget(run: Run): void {
		if (runs.get(run.key) === run) runs.delete(run.key);
		if (run.id) {
			byId.delete(run.id);
			relays.delete(run.id);
		}
	}

	function rowState(run: Run): RunRow["state"] | undefined {
		return run.id ? db.getRun(run.id)?.state : undefined;
	}

	// ── Outcomes ───────────────────────────────────────────────────────────────────────────────

	function abortedOutcome(run: Run, reason: AbortReason): StoredOutcome {
		return { ok: true, result: { usage: run.usage, aborted: reason, oomKills: 0, hasSession: sessionExists(run) } };
	}

	function errorOutcome(run: Run, err: unknown): StoredOutcome {
		const error = err instanceof Error ? err : new Error(String(err));
		return { ok: false, error: { name: error.name, message: error.message }, usage: run.usage };
	}

	/** Hands the outcome to the attached caller (usage first, once, OBS-05), then forgets the run. */
	function deliver(run: Run): void {
		const caller = run.caller;
		const outcome = run.outcome;
		if (!caller || !outcome) return;
		run.caller = undefined;
		caller.cleanup();
		guard("usage sink", () => caller.hooks.onUsage?.(outcome.ok ? outcome.result.usage : outcome.usage), { run: run.id });
		if (run.id) db.updateRun(run.id, { result: null });
		forget(run);
		if (outcome.ok) caller.resolve(outcome.result);
		else caller.reject(toError(outcome.error));
	}

	/** Ends the run: stores the outcome until a caller receives it, settles everything still waiting, frees its slot. */
	function finishRun(run: Run, outcome: StoredOutcome, dbOutcome: RunOutcome): void {
		if (run.outcome) return;
		run.outcome = outcome;
		const id = run.id;
		if (id) {
			db.raw.transaction(() => {
				db.transitionRun(id, [...ACTIVE_STATES], "finished", {
					outcome: dbOutcome,
					error: outcome.ok ? null : outcome.error.message,
					result: JSON.stringify(outcome),
				});
				relayOf(id).clear();
				for (const q of db.questionsForRun(id)) db.deleteQuestion(id, q.request_id);
			})();
			artifacts.release(id);
			leaseEnded(id);
			refs.settle(id, dbOutcome).catch(err => log("warn", "settling the run's refs failed", { run: id, error: errorMessage(err) }));
		}
		const index = waiting.indexOf(run);
		if (index >= 0) waiting.splice(index, 1);
		for (const s of [...run.queued, ...run.sent.values()]) s.resolve("ended");
		run.queued = [];
		run.sent.clear();
		for (const q of run.questions.values()) {
			q.stale = true;
			q.controller.abort();
			q.settle(false);
		}
		run.questions.clear();
		for (const d of run.deliveries) d.settle(false);
		run.deliveries = [];
		log("info", "run finished", { run: id, owner: run.key, outcome: dbOutcome });
		deliver(run);
		admit();
	}

	/** A `runs` row nobody can continue (no request known): finished without a result, so the owner's next call starts afresh. */
	function dropOrphan(row: RunRow): void {
		db.transitionRun(row.id, ["pending"], "finished", { outcome: "cancelled" });
		relayOf(row.id).clear();
		const run = byId.get(row.id);
		if (run) forget(run);
		log("info", "orphaned pending run dropped", { run: row.id });
	}

	// ── Admission and claims (RUN-01, RUN-02) ─────────────────────────────────────────────────

	function activeCounts(): { job: number; chat: number; total: number } {
		let job = 0;
		let chat = 0;
		for (const row of db.runsInState(...ACTIVE_STATES)) {
			if (row.job_id) job++;
			else chat++;
		}
		for (const run of preparing) {
			if (run.category === "job") job++;
			else chat++;
		}
		let mcp = 0;
		for (const task of tasks.values()) if (task.state === "pending" || task.state === "assigned") mcp++;
		return { job, chat, total: job + chat + mcp };
	}

	/** The run becomes claimable: its `runs` row is inserted as `pending`, with its checkout when it has one. */
	function insertPending(entry: Run, prepared: PreparedCheckout | undefined): void {
		const req = entry.req!;
		const [column, ownerId] = ownerColumn(entry.owner);
		try {
			const row = db.insertRun({
				kind: req.kind,
				jobId: column === "job_id" ? ownerId : undefined,
				chatThreadId: column === "chat_thread_id" ? ownerId : undefined,
				planThreadId: column === "plan_thread_id" ? ownerId : undefined,
				draftId: column === "draft_id" ? ownerId : undefined,
				threadId: req.threadId,
				repo: prepared?.repo,
				startRef: prepared?.startRef,
				startCommit: prepared?.startCommit,
				setupCommand: prepared?.setupCommand,
				continuesRunId: prepared?.continuesRunId,
				sessionKey: req.session,
				scratchDir: req.scratchDir,
				request: JSON.stringify(turnOf(req)),
			});
			entry.id = row.id;
			byId.set(row.id, entry);
			log("info", "run pending", {
				run: row.id,
				owner: entry.key,
				kind: req.kind,
				...(prepared ? { repo: prepared.repo, start: prepared.startRef, commit: prepared.startCommit, continues: prepared.continuesRunId } : {}),
			});
		} catch (err) {
			finishRun(entry, errorOutcome(entry, err), "failed");
		}
	}

	/** RUN-17: fetch the mirror and fix the start commit before the run becomes `pending`; the slot is held meanwhile. */
	async function prepare(entry: Run): Promise<void> {
		let prepared: PreparedCheckout | undefined;
		let failure: unknown;
		try {
			prepared = await prepareCheckout(opts.repos, db, entry.req!);
		} catch (err) {
			failure = err;
		}
		preparing.delete(entry);
		// Aborted (or otherwise ended) while the mirror was fetched: its slot is free again.
		if (entry.outcome) return admit();
		if (prepared) insertPending(entry, prepared);
		else {
			log("warn", "run checkout preparation failed", { owner: entry.key, repo: entry.req?.checkout?.repo, error: errorMessage(failure) });
			finishRun(entry, errorOutcome(entry, failure), "failed");
		}
		admit();
	}

	/** Moves waiting runs and mcp tests to `pending` as far as the caps allow, oldest first. */
	function admit(): void {
		const limits = opts.limits();
		if (limits && waiting.length > 0) {
			const counts = activeCounts();
			for (let i = 0; i < waiting.length && counts.total < limits.maxConcurrentRuns; ) {
				const entry = waiting[i]!;
				if (entry.type === "mcp") {
					waiting.splice(i, 1);
					entry.state = "pending";
					counts.total++;
					continue;
				}
				const full = entry.category === "job" ? counts.job >= limits.maxConcurrentJobs : counts.chat >= limits.maxChatSessions;
				if (full) {
					i++;
					continue;
				}
				waiting.splice(i, 1);
				counts[entry.category]++;
				counts.total++;
				if (entry.req!.checkout) {
					preparing.add(entry);
					prepare(entry).catch(err => log("error", "run admission failed", { owner: entry.key, error: errorMessage(err) }));
				} else insertPending(entry, undefined);
			}
		}
		match();
	}

	/** Hands pending runs and mcp tests to waiting claims, oldest first. */
	function match(): void {
		while (claimers.length > 0) {
			let row: RunRow | undefined;
			for (const pending of db.runsInState("pending")) {
				if (byId.get(pending.id)?.req) {
					row = pending;
					break;
				}
				dropOrphan(pending);
			}
			let task: McpTask | undefined;
			for (const t of tasks.values()) if (t.state === "pending" && (!task || t.createdAt < task.createdAt)) task = t;
			if (!row && !task) return;
			const conn = claimers.shift()!;
			clearTimeout(conn.claimTimer);
			if (!conn.open || !conn.workerId) continue;
			if (addressBusy(conn)) {
				send(conn, { t: "nothing" });
				continue;
			}
			if (task && (!row || task.createdAt <= Date.parse(row.created_at))) {
				assignTask(conn, task);
				continue;
			}
			const claimed = claimNextRun(db, conn.workerId, leaseMs, conn.address);
			if (!claimed) {
				send(conn, { t: "nothing" });
				continue;
			}
			void assignRun(conn, claimed);
		}
	}

	/**
	 * Architecture §6: another connection from `conn`'s address holds a run or mcp test, or one claimed from it ended
	 * less than `ADDRESS_QUIET_MS` ago. The runs table keeps the address, so this holds across a restart.
	 */
	function addressBusy(conn: Conn): boolean {
		if (!opts.bindWorkerAddresses) return false;
		for (const other of conns.values()) if (other !== conn && other.address === conn.address && other.runId) return true;
		const since = Date.now() - ADDRESS_QUIET_MS;
		if ((released.get(conn.address) ?? 0) > since) return true;
		return db.addressHoldsRun(conn.address, new Date(since));
	}

	function bind(conn: Conn, run: Run): void {
		if (run.conn && run.conn !== conn) run.conn.runId = undefined;
		run.conn = conn;
		conn.runId = run.id;
	}

	async function assignRun(conn: Conn, row: ClaimedRun): Promise<void> {
		const run = byId.get(row.id)!;
		bind(conn, run);
		log("info", "run claimed", { run: row.id, worker: conn.workerId });
		let spec: RunSpec;
		try {
			const previous = row.continues_run_id ? db.getRun(row.continues_run_id) : null;
			spec = await buildRunSpec(row, run.req!, opts.spec, previous !== null && refs.restoreKind(previous) !== undefined, opts.ompRuntime?.forRun(row.id));
		} catch (err) {
			log("error", "run spec failed", { run: row.id, error: errorMessage(err) });
			const holder = run.conn;
			finishRun(run, errorOutcome(run, err), "failed");
			send(holder, { t: "lease-invalid", runId: row.id });
			return;
		}
		const now = db.getRun(row.id);
		if (run.outcome || now?.lease_token !== row.lease_token || now?.state !== "assigned") return;
		leaseLive(row.id, row.leaseToken);
		send(run.conn, { t: "assign", runId: row.id, token: row.leaseToken, kind: "run", spec });
	}

	function assignTask(conn: Conn, task: McpTask): void {
		if (!db.recordWorkerClaim(conn.workerId!, task.id)) {
			send(conn, { t: "nothing" });
			return;
		}
		task.state = "assigned";
		task.workerId = conn.workerId;
		task.token = newLeaseToken();
		leaseLive(task.id, task.token);
		task.conn = conn;
		task.leaseExpiresAt = Date.now() + leaseMs;
		conn.runId = task.id;
		sendTaskAssign(task);
		guard("mcp test start sink", () => task.onStarted?.());
		task.timer = setTimeout(
			() => settleTask(task, { ok: false, tools: [], error: `no answer from the worker within ${(MCP_TEST_TIMEOUT_MS + MCP_TEST_SLACK_MS) / 1000} s` }),
			MCP_TEST_TIMEOUT_MS + MCP_TEST_SLACK_MS,
		);
	}

	function sendTaskAssign(task: McpTask): void {
		send(task.conn, {
			t: "assign",
			runId: task.id,
			token: task.token!,
			kind: "mcp-test",
			mcp: { name: task.name, server: task.server, timeoutMs: MCP_TEST_TIMEOUT_MS },
		});
	}

	function settleTask(task: McpTask, result: { ok: boolean; tools: string[]; error?: string }): void {
		if (task.state === "done") return;
		const wasWaiting = task.state === "waiting";
		task.state = "done";
		clearTimeout(task.timer);
		tasks.delete(task.id);
		leaseEnded(task.id);
		if (wasWaiting) waiting.splice(waiting.indexOf(task), 1);
		send(task.conn, { t: "lease-invalid", runId: task.id });
		task.resolve(result);
		admit();
	}

	// ── Leases (RUN-02, RUN-04, RUN-07) ────────────────────────────────────────────────────────

	function sweep(): void {
		const { requeued, lost } = db.expireLeases();
		for (const row of requeued) {
			leaseEnded(row.id);
			const run = byId.get(row.id);
			if (run?.conn) {
				run.conn.runId = undefined;
				run.conn = undefined;
			}
			if (run?.aborted) finishRun(run, abortedOutcome(run, run.aborted), "aborted");
			else if (!run?.req) dropOrphan(row);
			else {
				// Pending again: the next claim builds a fresh spec.
				log("warn", "run lease expired before it started; pending again", { run: row.id });
				guard("waiting sink", () => run.caller?.hooks.onWaitingForWorker?.(), { run: row.id });
			}
		}
		for (const row of lost) {
			const run = ensureRun(row);
			run.conn = undefined;
			log("warn", "worker lost", { run: row.id, worker: row.worker_id, losses: row.loss_count });
			if (run.aborted) finishRun(run, abortedOutcome(run, run.aborted), "aborted");
			else finishRun(run, { ok: false, error: { name: "RunLost", message: new RunLost().message }, usage: run.usage }, "lost");
		}
		const now = Date.now();
		for (const task of tasks.values()) {
			if (task.state === "assigned" && (task.leaseExpiresAt ?? 0) < now) {
				settleTask(task, { ok: false, tools: [], error: new RunLost().message });
			}
		}
		for (const [address, at] of released) if (at <= now - ADDRESS_QUIET_MS) released.delete(address);
		if (requeued.length > 0 || waiting.length > 0) admit();
	}

	// ── Steering, abort, questions (RUN-05, RUN-08, RUN-15) ──────────────────────────────────

	function reportQueued(s: Steer): void {
		if (s.queuedReported) return;
		s.queuedReported = true;
		guard("steer queued sink", () => s.opts?.onQueued?.());
	}

	function sendRelay(run: Run, build: (seq: number) => RelayDown["msg"]): RelayDown {
		const envelope = relayOf(run.id!).enqueue(build);
		send(run.conn, envelope);
		return envelope;
	}

	function sendSteer(run: Run, s: Steer): void {
		const inputs = s.opts?.scratchInputs ?? [];
		const envelope = relayOf(run.id!).enqueue(id => ({ t: "steer", id, text: s.text }));
		run.sent.set(envelope.seq, s);
		if (inputs.length > 0) run.scratchBefore.set(envelope.seq, inputs);
		if (!run.conn?.open) {
			reportQueued(s);
			return;
		}
		for (const name of inputs) send(run.conn, { t: "scratch-input", runId: run.id!, name });
		send(run.conn, envelope);
	}

	function steer(run: Run, text: string, steerOpts: SteerOptions | undefined): Promise<"delivered" | "ended"> {
		if (run.outcome) return Promise.resolve("ended");
		const { promise, resolve } = Promise.withResolvers<"delivered" | "ended">();
		const s: Steer = { text, opts: steerOpts, resolve, queuedReported: false };
		if (run.registered && run.id) sendSteer(run, s);
		else {
			reportQueued(s);
			run.queued.push(s);
		}
		return promise;
	}

	function abort(run: Run, reason: AbortReason): void {
		if (run.outcome || run.aborted) return;
		run.aborted = reason;
		const state = rowState(run);
		log("info", "run abort requested", { run: run.id, owner: run.key, reason, state });
		if (state === "assigned" && !run.conn?.open) {
			// RUN-05: its worker is away and may have started the run meanwhile: finished when it re-announces, or at lease expiry.
			return;
		}
		if (!run.id || state === "pending" || state === "assigned") {
			// Nothing ran yet: finish now; the worker holding the lease is told to stop.
			const holder = run.conn;
			finishRun(run, abortedOutcome(run, reason), "aborted");
			if (run.id) send(holder, { t: "lease-invalid", runId: run.id });
			return;
		}
		// Running: delivered now or after the reconnect (stored in the outbox); a lease expiry finishes it instead.
		sendRelay(run, id => ({ t: "abort", id, reason }));
	}

	function invokeQuestion(run: Run, requestId: string): void {
		const caller = run.caller;
		const row = run.id ? db.getQuestion(run.id, requestId) : null;
		if (!caller || !row || run.outcome) return;
		const id = Number(requestId);
		const previous = run.questions.get(id);
		if (previous?.caller === caller) return;
		if (previous) {
			previous.stale = true;
			previous.controller.abort();
			previous.settle(false);
		}
		const { method, args, dialog } = JSON.parse(row.options) as { method: Exclude<UiMethod, "notify">; args: unknown[]; dialog?: object };
		const delivered = Promise.withResolvers<boolean>();
		const question: Question = { caller, controller: new AbortController(), settle: delivered.resolve, stale: false, cancelled: false };
		run.questions.set(id, question);
		const runId = run.id!;
		const context: UiCallContext = {
			key: `${runId}:${requestId}`,
			...(row.channel_id ? { posted: { channelId: row.channel_id, messageIds: row.message_id ? row.message_id.split(",") : [] } } : {}),
			onPosted: posted => guard("question record", () => db.setQuestionPosted(runId, requestId, posted.channelId, posted.messageIds), { run: runId }),
			delivered: delivered.promise,
		};
		const answer = (result: { ok: true; value?: unknown } | { ok: false; error: string; aborted?: boolean }) => {
			if (question.stale) return;
			if (run.questions.get(id) === question) run.questions.delete(id);
			if (run.outcome || question.cancelled) {
				question.settle(false);
				return;
			}
			db.deleteQuestion(runId, requestId);
			const envelope = sendRelay(run, () => ({ t: "reply", id, ...result }));
			run.deliveries.push({ seq: envelope.seq, settle: question.settle });
		};
		void Promise.resolve()
			.then(() => callUi(caller.hooks.ui, method, args, { ...dialog, signal: question.controller.signal, [UI_CALL_CONTEXT]: context }))
			.then(
				value => answer({ ok: true, value }),
				err =>
					answer({
						ok: false,
						error: errorMessage(err),
						...(err instanceof Error && err.name === "AbortError" ? { aborted: true } : {}),
					}),
			);
	}

	function runTool(run: Run, call: Extract<ChildMessage, { t: "tool_call" }>): void {
		const createIssue = run.req?.createIssue;
		const work =
			call.name === "create_issue" && createIssue
				? createIssue.file(call.params.title, call.params.body)
				: Promise.reject(new Error(`Tool ${call.name} is not available`));
		void work.then(
			value => {
				if (!run.outcome) sendRelay(run, () => ({ t: "reply", id: call.id, ok: true, value }));
			},
			err => {
				if (!run.outcome) sendRelay(run, () => ({ t: "reply", id: call.id, ok: false, error: errorMessage(err) }));
			},
		);
	}

	// ── Relay from the agent host (architecture §4.2) ────────────────────────────────────────

	async function onRelay(run: Run, msg: ChildMessage): Promise<void> {
		const hooks = run.caller?.hooks;
		const fields = { run: run.id };
		switch (msg.t) {
			case "progress":
				run.usage = msg.usage;
				if (msg.tool) run.lastTool = msg.tool;
				guard("progress sink", () => hooks?.onProgress?.({ tool: msg.tool, intent: msg.intent, usage: msg.usage, elapsedMs: msg.elapsedMs }), fields);
				return;
			case "transcript":
				guard("transcript sink", () => hooks?.onTranscript?.(msg.event), fields);
				return;
			case "todos":
				guard("todo sink", () => hooks?.onTodos?.(msg.todos), fields);
				return;
			case "loadout":
				run.loadout = msg.loadout;
				guard("loadout sink", () => hooks?.onLoadout?.(msg.loadout), fields);
				return;
			case "usage":
				run.usage = msg.usage;
				return;
			case "log":
				// F9: one JSON object per line, attributed here; anything else could forge entries and is dropped.
				if (!writeRelayedLogLine(msg.line, { component: "agent-host", ...(run.id ? { run: run.id } : {}) })) {
					log("warn", "relayed agent host log line dropped: not one JSON object on one line", { run: run.id, bytes: msg.line.length });
				}
				return;
			case "session_file":
				// The worker uploaded the session before relaying this (RUN-18); the host waits for this reply.
				sendRelay(run, () => ({ t: "reply", id: msg.id, ok: true }));
				return;
			case "registered":
				if (run.id) db.transitionRun(run.id, ["assigned"], "running");
				run.registered = true;
				log("info", "run started", fields);
				for (const s of run.queued.splice(0)) sendSteer(run, s);
				return;
			case "ui":
				if (msg.method === "notify") {
					const a = msg.args as never[];
					guard("notify", () => void hooks?.ui.notify(a[0], a[1]), fields);
					return;
				}
				if (!db.getQuestion(run.id!, String(msg.id))) {
					db.insertQuestion({
						runId: run.id!,
						requestId: String(msg.id),
						channelId: "",
						messageId: "",
						options: { method: msg.method, args: msg.args, dialog: msg.dialog },
					});
				}
				invokeQuestion(run, String(msg.id));
				return;
			case "ui_cancel": {
				const question = run.questions.get(msg.id);
				if (question) {
					question.cancelled = true;
					question.controller.abort();
				}
				db.deleteQuestion(run.id!, String(msg.id));
				return;
			}
			case "tool_call":
				if (run.req) runTool(run, msg);
				else run.deferredTools.push(msg);
				return;
			case "reply": {
				const s = run.sent.get(msg.id);
				if (!s) return;
				run.sent.delete(msg.id);
				if (msg.ok) s.resolve("delivered");
				else if (/not ready/i.test(msg.error)) {
					// RUN-15: resent after the next `registered`.
					reportQueued(s);
					run.queued.push(s);
				} else s.resolve("ended");
				return;
			}
			case "done": {
				const r = msg.result;
				const row = db.getRun(run.id!);
				const outputs = row?.scratch_dir ? await changedOutputs(row) : undefined;
				// RUN-19: the worker uploaded the result bundle before relaying this; none means no new commits.
				let code: RunResult["code"];
				try {
					if (row?.repo && writesCode(row.kind)) code = { runId: row.id, commits: await refs.resultCommits(row) };
				} catch (err) {
					finishRun(run, errorOutcome(run, new Error(`The run's result could not be read: ${errorMessage(err)}`)), "failed");
					return;
				}
				const result: RunResult = {
					output: r.output,
					usage: r.usage,
					...(r.aborted ? { aborted: r.aborted } : {}),
					oomKills: r.oomKills,
					hasSession: sessionExists(run),
					...(outputs ? { outputs } : {}),
					...(code ? { code } : {}),
				};
				run.usage = r.usage;
				finishRun(run, { ok: true, result }, r.aborted ? "aborted" : "succeeded");
				return;
			}
			case "failed":
				finishRun(run, { ok: false, error: { name: msg.name, message: msg.message }, usage: run.usage }, "failed");
				return;
			case "credential_request":
				// Handled by the worker supervisor as `credential-request`; never relayed.
				return;
		}
	}

	// ── Worker connections ──────────────────────────────────────────────────────────────────

	/** The run `conn` holds the lease of, if `runId` is it. */
	function heldRun(conn: Conn, runId: string): Run | undefined {
		const run = byId.get(runId);
		return run && run.conn === conn && conn.runId === runId ? run : undefined;
	}

	function resend(run: Run): void {
		for (const envelope of relayOf(run.id!).unacked()) {
			for (const name of run.scratchBefore.get(envelope.seq) ?? []) send(run.conn, { t: "scratch-input", runId: run.id!, name });
			send(run.conn, envelope);
		}
	}

	function onHello(conn: Conn, msg: Extract<WorkerControl, { t: "hello" }>): void {
		if (conn.workerId) return;
		if (opts.bindWorkerAddresses) {
			const bound = db.bindWorkerAddress(msg.workerId, conn.address);
			if (bound !== conn.address) {
				// Architecture §6: a worker id belongs to the address it first came from; nobody else may take it over.
				log("warn", "worker id used from another address; refused", { worker: msg.workerId, address: conn.address, bound });
				conn.ws.close(1008, "worker id bound to another address");
				return;
			}
		}
		for (const other of conns.values()) {
			if (other !== conn && other.workerId === msg.workerId) {
				log("warn", "worker reconnected; closing its previous connection", { worker: msg.workerId });
				other.ws.close(1000, "replaced by a newer connection");
				onClose(other);
			}
		}
		conn.workerId = msg.workerId;
		conn.version = msg.identity.version;
		conn.ompVersion = msg.ompVersion;
		log("info", "worker connected", { worker: msg.workerId, address: conn.address, version: msg.identity.version, lease: msg.lease?.runId });
		if (!msg.lease) return;
		const { runId, token } = msg.lease;
		const task = tasks.get(runId);
		if (task) {
			if (task.state === "assigned" && task.workerId === msg.workerId && task.token && sameToken(token, task.token)) {
				task.conn = conn;
				conn.runId = task.id;
				task.leaseExpiresAt = Date.now() + leaseMs;
			} else send(conn, { t: "lease-invalid", runId });
			return;
		}
		const row = db.getRun(runId);
		if (!holdsLease(row, msg.workerId, token) || !db.renewLease(runId, token, leaseMs)) {
			log("info", "stale lease refused", { worker: msg.workerId, run: runId });
			send(conn, { t: "lease-invalid", runId });
			return;
		}
		const run = ensureRun(row);
		bind(conn, run);
		leaseLive(runId, token);
		log("info", "worker re-attached", { worker: msg.workerId, run: runId });
		if (run.aborted && rowState(run) === "assigned") {
			// RUN-05: an abort requested while its worker was away.
			finishRun(run, abortedOutcome(run, run.aborted), "aborted");
			send(conn, { t: "lease-invalid", runId });
			return;
		}
		resend(run);
		if (run.registered) for (const s of run.queued.splice(0)) sendSteer(run, s);
	}

	function onClaim(conn: Conn): void {
		const workerId = conn.workerId!;
		const previous = db.workerClaim(workerId);
		if (previous !== null) {
			// One claim per worker id, ever (architecture §6); an assignment lost in a reconnect goes back to pending at lease expiry (RUN-02).
			log("warn", "second claim refused", { worker: workerId, claimed: previous });
			send(conn, { t: "nothing" });
			return;
		}
		if (addressBusy(conn)) {
			log("warn", "claim refused: this address already holds a claim", { worker: workerId, address: conn.address });
			send(conn, { t: "nothing" });
			return;
		}
		if (claimers.includes(conn)) return;
		claimers.push(conn);
		conn.claimTimer = setTimeout(() => {
			const index = claimers.indexOf(conn);
			if (index < 0) return;
			claimers.splice(index, 1);
			send(conn, { t: "nothing" });
		}, claimWaitMs);
		match();
	}

	async function answerCredential(conn: Conn, msg: Extract<WorkerControl, { t: "credential-request" }>): Promise<void> {
		const timeout = Promise.withResolvers<CredentialAnswer>();
		const timer = setTimeout(() => timeout.resolve({ ok: false, error: "the orchestrator could not refresh the sign-in in time" }), CREDENTIAL_ANSWER_MS);
		let answer: CredentialAnswer;
		try {
			answer = await Promise.race([
				opts.credentialRequest({ provider: msg.provider, credentialId: msg.credentialId, accessToken: msg.accessToken }),
				timeout.promise,
			]);
		} catch (err) {
			answer = { ok: false, error: errorMessage(err) };
		} finally {
			clearTimeout(timer);
		}
		send(conn, { t: "credential-response", runId: msg.runId, requestId: msg.requestId, ...answer });
	}

	async function onMessage(conn: Conn, msg: UpMessage): Promise<void> {
		if (msg.t === "hello") return onHello(conn, msg);
		if (!conn.workerId) {
			log("warn", "worker message before hello; closing", { address: conn.address, type: msg.t });
			conn.ws.close(1008, "hello first");
			return;
		}
		switch (msg.t) {
			case "claim":
				return onClaim(conn);
			case "heartbeat": {
				conn.phase = msg.phase;
				const task = tasks.get(msg.runId);
				if (task?.token && task.workerId === conn.workerId && sameToken(msg.token, task.token) && task.state === "assigned") {
					task.leaseExpiresAt = Date.now() + leaseMs;
					return;
				}
				if (!holdsLease(db.getRun(msg.runId), conn.workerId, msg.token) || !db.renewLease(msg.runId, msg.token, leaseMs)) {
					send(conn, { t: "lease-invalid", runId: msg.runId });
				}
				return;
			}
			case "relay": {
				const run = heldRun(conn, msg.runId);
				if (!run) {
					send(conn, { t: "lease-invalid", runId: msg.runId });
					return;
				}
				const relay = relayOf(msg.runId);
				if (relay.accept(msg.seq)) {
					try {
						await onRelay(run, msg.msg);
					} catch (err) {
						log("error", "relay message failed", { run: msg.runId, type: msg.msg.t, error: errorMessage(err) });
					}
				}
				send(conn, { t: "ack", runId: msg.runId, seq: relay.received() });
				return;
			}
			case "ack": {
				const run = heldRun(conn, msg.runId);
				if (!run) return;
				relayOf(msg.runId).ack(msg.seq);
				for (const seq of run.scratchBefore.keys()) if (seq <= msg.seq) run.scratchBefore.delete(seq);
				const settled = run.deliveries.filter(d => d.seq <= msg.seq);
				run.deliveries = run.deliveries.filter(d => d.seq > msg.seq);
				for (const d of settled) d.settle(true);
				return;
			}
			case "run-info": {
				if (!heldRun(conn, msg.runId)) return;
				conn.runOmpVersion = msg.ompVersion;
				db.updateRun(msg.runId, { omp_version: msg.ompVersion });
				return;
			}
			case "omp-runtime-failed": {
				if (!heldRun(conn, msg.runId)) return;
				const { t: _t, ...report } = msg;
				guard("omp runtime canary report", () => opts.ompRuntime?.canaryFailed(report), { run: msg.runId, copy: msg.copy });
				return;
			}
			case "setup-output":
				log("info", "setup command finished", { run: msg.runId, exitCode: msg.exitCode, tail: msg.tail });
				return;
			case "checkpoint":
				log("debug", "checkpoint uploaded", { run: msg.runId });
				return;
			case "gone": {
				const run = heldRun(conn, msg.runId);
				if (!run) {
					send(conn, { t: "lease-invalid", runId: msg.runId });
					return;
				}
				const reason = msg.signal ? `signal ${msg.signal}` : `code ${msg.exitCode}`;
				const message =
					msg.signal === "SIGKILL" && msg.oomKills > 0
						? `agent process was killed (${reason}); the kernel OOM killer killed ${msg.oomKills} process(es) in the worker meanwhile, so it most likely ran out of memory`
						: `agent process exited with ${reason}`;
				if (run.aborted) finishRun(run, abortedOutcome(run, run.aborted), "aborted");
				else finishRun(run, { ok: false, error: { name: "Error", message }, usage: run.usage }, "failed");
				send(conn, { t: "lease-invalid", runId: msg.runId });
				return;
			}
			case "credential-request":
				if (!heldRun(conn, msg.runId)) {
					send(conn, { t: "credential-response", runId: msg.runId, requestId: msg.requestId, ok: false, error: "no such run" });
					return;
				}
				void answerCredential(conn, msg);
				return;
			case "mcp-test-result": {
				const task = tasks.get(msg.runId);
				if (!task || task.conn !== conn) return;
				settleTask(task, { ok: msg.ok, tools: msg.tools, ...(msg.error ? { error: msg.error } : {}) });
				return;
			}
		}
	}

	function onClose(conn: Conn): void {
		if (conn.closed) return;
		conn.closed = true;
		if (conn.runId) released.set(conn.address, Date.now());
		conn.open = false;
		conns.delete(conn.ws.data);
		clearTimeout(conn.claimTimer);
		const index = claimers.indexOf(conn);
		if (index >= 0) claimers.splice(index, 1);
		if (conn.runId) {
			const run = byId.get(conn.runId);
			if (run?.conn === conn) run.conn = undefined;
			const task = tasks.get(conn.runId);
			if (task?.conn === conn) task.conn = undefined;
		}
		if (conn.workerId) log("info", "worker disconnected", { worker: conn.workerId, run: conn.runId });
	}

	const websocket: WebSocketHandler<WorkerSocketData> = {
		// Bigger than the 4 MiB limit so oversized messages can be logged with their run and type (RUN-16).
		maxPayloadLength: 16 * 1024 * 1024,
		open(ws) {
			conns.set(ws.data, { ws, address: ws.data.address, connectedAt: new Date().toISOString(), queue: Promise.resolve(), open: true, closed: false });
		},
		message(ws, raw) {
			const conn = conns.get(ws.data);
			if (!conn) return;
			const text = typeof raw === "string" ? raw : raw.toString("utf8");
			const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
			if (bytes > MAX_WS_MESSAGE_BYTES) {
				const { type, run } = sniff(text);
				log("warn", "worker message over 4 MiB rejected", { worker: conn.workerId, run, type, bytes });
				return;
			}
			let msg: UpMessage;
			try {
				msg = JSON.parse(text) as UpMessage;
			} catch {
				log("warn", "worker message is not JSON", { worker: conn.workerId, bytes });
				return;
			}
			conn.queue = conn.queue
				.then(() => onMessage(conn, msg))
				.catch(err => log("error", "worker message failed", { worker: conn.workerId, type: msg.t, error: errorMessage(err) }));
		},
		close(ws) {
			const conn = conns.get(ws.data);
			if (!conn) return;
			// Messages that arrived before the close are still handled, in order.
			conn.open = false;
			conn.queue = conn.queue.then(() => onClose(conn));
		},
	};

	// ── Start: RUN-07 ────────────────────────────────────────────────────────────────────────

	// NFR-03: a run still pending has no worker and its request (closures included) was only in memory, so its row is
	// finished; its turn is kept for the reattach grace so the owner's engine, re-attaching on start, re-issues the same turn.
	const reissue = new Map<string, RunTurn>();
	for (const row of db.runsInState("pending")) {
		const turn = row.request ? parseJson<RunTurn>(row.request) : undefined;
		if (turn) reissue.set(ownerKey(rowOwner(row)), turn);
		dropOrphan(row);
	}
	const reissueExpiry = setTimeout(() => reissue.clear(), opts.reattachGraceMs);
	for (const row of db.runsInState("lost", "finishing")) {
		const run = ensureRun(row);
		finishRun(run, { ok: false, error: { name: "RunLost", message: new RunLost().message }, usage: ZERO_USAGE }, "lost");
	}
	db.graceLeases(opts.reattachGraceMs);
	const sweeper = setInterval(() => guard("lease sweep", sweep), opts.sweepMs ?? 1000);
	// WS-07, RUN-20: refs of runs that are finished and not kept for Retry go at start; WS-01: unused mirrors go daily.
	const maintenance = (async () => {
		await refs.prune();
		await refs.expireMirrors();
	})().catch(err => log("warn", "start-up run ref maintenance failed", { error: errorMessage(err) }));
	const mirrorExpiry = setInterval(() => void refs.expireMirrors(), MIRROR_EXPIRY_MS);

	// ── Dispatcher API ──────────────────────────────────────────────────────────────────────

	function attach(run: Run, req: RunRequest, hooks: RunHooks, signal: AbortSignal | undefined): Promise<RunResult> {
		const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
		if (signal?.aborted) {
			reject(new RunDetached());
			return promise;
		}
		// The newest caller's request carries the live engine's closures (create_issue); the turn stays the one requested
		// (an engine re-attaching after a restart asks with no turn of its own).
		run.req = run.req ? { ...req, ...turnOf(run.req) } : req;
		const previous = run.caller;
		if (previous) {
			previous.cleanup();
			previous.reject(new RunDetached());
		}
		const onAbort = () => {
			if (run.caller !== caller) return;
			run.caller = undefined;
			caller.cleanup();
			for (const q of run.questions.values()) {
				if (q.caller !== caller) continue;
				q.stale = true;
				q.controller.abort();
				q.settle(false);
			}
			reject(new RunDetached());
		};
		const caller: Caller = { hooks, resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) };
		signal?.addEventListener("abort", onAbort, { once: true });
		run.caller = caller;
		if (run.outcome) {
			deliver(run);
			return promise;
		}
		const state = rowState(run);
		if (!run.id || state === "pending" || state === "assigned") guard("waiting sink", () => hooks.onWaitingForWorker?.(), { run: run.id });
		// Abort and steering work from the start: a run no worker started is finished at once (RUN-05); steers wait (⏳) for `registered` (RUN-15).
		guard("register sink", () => hooks.register(run.handle), { run: run.id });
		if (run.id) {
			// RUN-08: questions still open bind to the messages already posted.
			for (const q of db.questionsForRun(run.id)) invokeQuestion(run, q.request_id);
			for (const call of run.deferredTools.splice(0)) runTool(run, call);
		}
		if (state === "pending") match();
		return promise;
	}

	return {
		runAgent(req, hooks, signal) {
			const key = ownerKey(req.owner);
			let run = runs.get(key);
			if (!run) {
				const [column, ownerId] = ownerColumn(req.owner);
				const row = db.currentRun(column, ownerId);
				if (row) run = ensureRun(row);
			}
			if (run) return attach(run, req, hooks, signal);
			if (signal?.aborted) return Promise.reject(new RunDetached());
			const kept = reissue.get(key);
			reissue.delete(key);
			const turnReq: RunRequest = kept ? { ...req, ...kept } : req;
			if (kept) log("info", "pending run re-issued after restart", { owner: key });
			const reason = unrunnableReason(turnReq);
			if (reason) return Promise.reject(new Error(reason));
			const fresh = newRun(req.owner, turnReq);
			runs.set(key, fresh);
			waiting.push(fresh);
			const result = attach(fresh, turnReq, hooks, signal);
			admit();
			return result;
		},
		hasRun(owner) {
			if (runs.has(ownerKey(owner)) || reissue.has(ownerKey(owner))) return true;
			const [column, ownerId] = ownerColumn(owner);
			return db.currentRun(column, ownerId) !== null;
		},
		hasUnfinishedRun(owner) {
			const run = runs.get(ownerKey(owner));
			if (run) return !run.outcome;
			if (reissue.has(ownerKey(owner))) return true;
			const [column, ownerId] = ownerColumn(owner);
			const row = db.currentRun(column, ownerId);
			return row !== null && row.state !== "finished";
		},
		counts() {
			let pending = 0;
			let running = 0;
			let oldest: number | undefined;
			for (const row of db.runsInState("pending", "assigned", "running", "finishing")) {
				if (row.state !== "pending") {
					running++;
					continue;
				}
				pending++;
				const since = Date.parse(row.created_at);
				if (oldest === undefined || since < oldest) oldest = since;
			}
			for (const task of tasks.values()) {
				if (task.state === "assigned") running++;
				if (task.state !== "pending") continue;
				pending++;
				if (oldest === undefined || task.createdAt < oldest) oldest = task.createdAt;
			}
			return { pending, running, oldestPendingMs: oldest === undefined ? null : Date.now() - oldest };
		},
		async mcpTest(spec, testOpts) {
			let server: McpServer;
			try {
				server = parseOmpConfig({ mcpServers: { [spec.name]: spec.server } }).mcpServers[spec.name]!;
			} catch (err) {
				return { ok: false, tools: [], error: errorMessage(err) };
			}
			const { promise, resolve } = Promise.withResolvers<{ ok: boolean; tools: string[]; error?: string }>();
			const task: McpTask = {
				type: "mcp",
				id: `mcp-${crypto.randomUUID()}`,
				name: spec.name,
				server,
				createdAt: Date.now(),
				state: "waiting",
				resolve,
				...(testOpts?.onStarted ? { onStarted: testOpts.onStarted } : {}),
			};
			tasks.set(task.id, task);
			waiting.push(task);
			guard("waiting sink", () => testOpts?.onWaitingForWorker?.());
			admit();
			return promise;
		},
		activeRuns() {
			return db.runsInState("pending", "assigned", "running", "finishing").map(row => {
				const run = byId.get(row.id);
				const claimed = row.state !== "pending" && row.claimed_at ? row.claimed_at : undefined;
				const status: RunStatus = {
					id: row.id,
					kind: row.kind,
					state: row.state as RunStatus["state"],
					owner: ownerKey(rowOwner(row)),
					createdAt: row.created_at,
					usage: run?.usage ?? ZERO_USAGE,
				};
				if (row.repo) status.repo = row.repo;
				if (row.thread_id) status.threadId = row.thread_id;
				if (row.worker_id && row.state !== "pending") status.workerId = row.worker_id;
				if (claimed) status.claimedAt = claimed;
				if (row.started_at) status.startedAt = row.started_at;
				if (claimed && row.started_at) status.setupMs = Math.max(0, Date.parse(row.started_at) - Date.parse(claimed));
				if (run?.lastTool) status.lastTool = run.lastTool;
				if (run?.loadout) status.loadout = run.loadout;
				return status;
			});
		},
		workers() {
			const list: WorkerStatus[] = [];
			for (const conn of conns.values()) {
				if (!conn.workerId) continue;
				list.push({
					id: conn.workerId,
					address: conn.address,
					version: conn.version ?? "",
					ompVersion: conn.runOmpVersion ?? conn.ompVersion ?? "",
					...(conn.runId ? { runId: conn.runId } : {}),
					...(conn.phase ? { phase: conn.phase } : {}),
					connectedAt: conn.connectedAt,
				});
			}
			return list;
		},
		pendingRuns() {
			let n = db.runsInState("pending").length;
			for (const task of tasks.values()) if (task.state === "pending") n++;
			return n;
		},
		socketData: address => ({ address }),
		websocket,
		artifact: req => artifacts.handle(req),
		git: req => gitEndpoint(req),
		async pushResult(runId, branch, token) {
			const row = db.getRun(runId);
			if (!row?.repo || !row.has_result) throw new Error(`run ${runId} keeps no result to push`);
			const outcome = await opts.repos.push(row.repo, runId, branch, token);
			log(outcome.pushed ? "info" : "warn", outcome.pushed ? "run result pushed" : "run result push rejected: the branch moved", {
				run: runId,
				repo: row.repo,
				branch,
				...(outcome.pushed ? { sha: outcome.sha } : {}),
			});
			return outcome;
		},
		async discardResult(runId) {
			const row = db.getRun(runId);
			if (row) await refs.release(row, ["result"]);
		},
		releaseIssue: issueId => refs.releaseIssue(issueId),
		async repoConfig(checkout) {
			const { baseBranch, setupCommand } = await readRepoConfig(opts.repos, checkout);
			return { baseBranch, ...(setupCommand ? { setupCommand } : {}) };
		},
		maintenance: () => maintenance,
		close() {
			clearInterval(sweeper);
			clearInterval(mirrorExpiry);
			clearTimeout(reissueExpiry);
			for (const conn of claimers.splice(0)) clearTimeout(conn.claimTimer);
			for (const task of tasks.values()) clearTimeout(task.timer);
		},
	};
}
