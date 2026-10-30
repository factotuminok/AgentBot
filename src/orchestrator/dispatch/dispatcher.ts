import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentProfile, Loadout, TodoItem } from "../../shared/agent";
import type { RunUsage, TranscriptEvent } from "../../shared/transcript";
import type { RunKind } from "../engine/state";

/**
 * The engine's view of agent runs (architecture §3: the runner becomes the dispatcher and keeps the `runAgent` API).
 * Phase 2 ships only a fake (`createFakeDispatcher`); phase 3 implements it with runs, leases and workers.
 *
 * Contract:
 * - `runAgent` is **start or attach**: if an unfinished run exists for `req.owner` (RUN-21: at most one), the call attaches
 *   to it instead of starting another. That is how jobs survive engine and orchestrator restarts (JOB-08): the engine simply
 *   runs the job again and the dispatcher re-attaches.
 * - A finished run's result is kept until an attached caller has received it. The dispatcher then forgets it.
 * - Aborting `signal` **detaches**: the promise rejects with `RunDetached` and the run keeps going (ENG-02, RUN-09). It never aborts the run.
 * - `handle.abort(reason)` aborts the run; the result then carries `aborted`.
 */

/** Whose run it is; one unfinished run per owner (RUN-21). */
export type RunOwner =
	| { kind: "job"; jobId: string }
	| { kind: "chat"; threadId: string }
	| { kind: "plan"; threadId: string }
	| { kind: "draft"; draftId: string };

/** The orchestrator-side UI that answers the agent's relayed `ui` calls (questions, DSC-16 to DSC-20). */
export type RunUi = Pick<ExtensionUIContext, "askDialog" | "select" | "input" | "editor" | "confirm" | "notify">;

export interface RunProgress {
	tool?: string;
	intent?: string;
	usage: RunUsage;
	/** Run time so far, excluding answer waits and worker start/checkout (AGT-14, RUN-03). */
	elapsedMs: number;
}

export interface RunRequest {
	owner: RunOwner;
	/** `ask` is the public `/ask` chat; the others are `RunKind`s. */
	kind: RunKind | "ask";
	profile: AgentProfile;
	prompt: string;
	/** JSON Schema of the `yield` output (AGT-12). */
	outputSchema?: object;
	/** `models.*` pattern; undefined = omp default. */
	model?: string;
	thinking: string;
	limits: { minutes: number; costUsd: number };
	/**
	 * The omp session this run writes, as a file-name-safe key (e.g. `issue-<id>-plan`, `issue-<id>-impl`, `chat-<threadId>`,
	 * `plan-<threadId>`). The orchestrator keeps it at `<state>/sessions/<key>.jsonl` between runs (JOB-10); revise and fix_ci
	 * use the implement session's key.
	 */
	session: string;
	/** Continue that session instead of starting it fresh (JOB-10, CHAT-03, plan revisions). */
	resume: boolean;
	/** Repository the run checks out (`owner/name`); absent for `/ask`. Checkout details arrive in phase 4. */
	repo?: string;
	/** Discord thread the run reports into (RUN-14). */
	threadId?: string;
	/** `create_issue` (chat profile, AGT-10): executed in the orchestrator, result returned to the agent. */
	createIssue?(title: string, body: string): Promise<{ number: number; url: string }>;
}

export type AbortReason = "user" | "time" | "cost";

export interface RunHandle {
	/** AGT-15: delivered as `[Discord @user]: <text>`. Resolves `delivered` when the agent received it (RUN-15). */
	steer(text: string, from: string): Promise<"delivered" | "queued" | "not-ready" | "ended">;
	/** One-shot; the first reason wins (AGT-07). */
	abort(reason: AbortReason): Promise<void>;
}

export interface RunHooks {
	ui: RunUi;
	/** Once, as soon as the run can take steering and abort (relayed `registered`); also after re-attach. */
	register(handle: RunHandle): void;
	/** While no worker has started the run (RUN-03): "Waiting for a worker…". */
	onWaitingForWorker?(): void;
	onProgress?(p: RunProgress): void;
	onTodos?(todos: TodoItem[]): void;
	onTranscript?(event: TranscriptEvent): void;
	onLoadout?(loadout: Loadout): void;
	/** Once when the run ends, whatever the outcome (OBS-05). */
	onUsage?(usage: RunUsage): void;
}

export interface RunResult {
	output?: unknown;
	usage: RunUsage;
	aborted?: AbortReason;
	/** Processes the kernel OOM-killed during the run (AGT-17 to AGT-19). */
	oomKills: number;
	/** The run's omp session exists in the orchestrator and can be resumed (JOB-10). */
	hasSession: boolean;
}

/** The caller detached (engine stopping); the run keeps going. */
export class RunDetached extends Error {
	override name = "RunDetached";
	constructor() {
		super("detached from run");
	}
}

/** RUN-04: the worker was lost. The dispatcher never requeues; the scheduler requeues a job once with `resume: true`, chats/plans/drafts fail. */
export class RunLost extends Error {
	override name = "RunLost";
	constructor() {
		super("the worker running this was lost (pod evicted or crashed)");
	}
}

/** The run ended without a successful `yield` after one nudge (AGT-12). */
export class NoStructuredOutput extends Error {
	override name = "NoStructuredOutput";
	constructor() {
		super("finished without calling yield");
	}
}

export interface Dispatcher {
	runAgent(req: RunRequest, hooks: RunHooks, signal?: AbortSignal): Promise<RunResult>;
	/** True while `owner` has a pending or active run (CHAT-04, DSC-06, RUN-21). */
	hasUnfinishedRun(owner: RunOwner): boolean;
	/** Counts for health and status (architecture §4.5). */
	counts(): { pending: number; running: number; oldestPendingMs: number | null };
}
