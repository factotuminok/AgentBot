import type { RunStatus, WorkerStatus } from "../../shared/adminApi";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentProfile, Loadout, TodoItem } from "../../shared/agent";
import type { RunUsage, TranscriptEvent } from "../../shared/transcript";
import type { RunKind } from "../engine/state";

/**
 * The engine's view of agent runs (architecture §3: the runner becomes the dispatcher and keeps the `runAgent` API).
 * `createWorkerDispatcher` implements it with runs, leases and workers; `createFakeDispatcher` is the test double.
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

/** Stable text key of an owner: `job:<id>`, `chat:<thread>`, `plan:<thread>` or `draft:<id>`. */
export function ownerKey(owner: RunOwner): string {
	switch (owner.kind) {
		case "job":
			return `job:${owner.jobId}`;
		case "chat":
			return `chat:${owner.threadId}`;
		case "plan":
			return `plan:${owner.threadId}`;
		case "draft":
			return `draft:${owner.draftId}`;
	}
}

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
	/** The repository checkout (RUN-17); absent for `/ask`, required for every other kind. */
	checkout?: CheckoutRequest;
	/** Discord thread the run reports into (RUN-14). */
	threadId?: string;
	/** `create_issue` (chat profile, AGT-10): executed in the orchestrator, result returned to the agent. */
	createIssue?: { repo: string; file(title: string, body: string): Promise<{ number: number; url: string }> };
	/**
	 * Ask runs (CHAT-07): the thread's scratch directory in the orchestrator (`<state>/scratch/<threadId>`). The dispatcher
	 * serves `inputs/` to the worker and writes new or changed outputs it uploads into `outputs/` before the run settles.
	 */
	scratchDir?: string;
}

/** What the engine tells the dispatcher about a run's checkout; the dispatcher fixes the start commit (RUN-17). */
export interface CheckoutRequest {
	/** `owner/name`. */
	repo: string;
	/** The repository's default branch on GitHub: `.agentbot.yml` is read from it, and it is the base branch unless the file sets `baseBranch` (GH-26). */
	defaultBranch(): Promise<string>;
	/** Job runs: the issue branch `agentbot/issue-<n>-<slug>` (WS-03). revise and fix_ci start from its head (RUN-17). */
	issueBranch?: string;
	/** Runs that write code: the commit message for leftover changes, e.g. `<agent>: remaining changes for #N` (JOB-19, JOB-22, DSC-30). */
	leftoverMessage?: string;
	/** The bot's git identity, for the worker's local commits (GH-04). */
	identity: { name: string; email: string };
	/** An installation token for fetching the mirror (WS-02); asked for each time the run is about to become pending. */
	gitToken(): Promise<string>;
}

/** implement, revise and fix_ci change code: their checkpoints hold the working tree and their result is pushed (RUN-18, RUN-19). */
export function writesCode(kind: RunRequest["kind"]): boolean {
	return kind === "implement" || kind === "revise" || kind === "fix_ci";
}

export type AbortReason = "user" | "time" | "cost";

export interface SteerOptions {
	/** Called once if the text can't be delivered right now (worker disconnected, host not `registered`): react ⏳ (RUN-15). */
	onQueued?(): void;
	/** New ask attachments saved to `inputs/` that the worker must download before this steer (`scratch-input`, CHAT-08). */
	scratchInputs?: string[];
}

export interface RunHandle {
	/**
	 * AGT-15: delivered as `[Discord @user]: <text>`. Resolves when the run settled it (RUN-15): `delivered` once the host's
	 * reply came back ok (react 👀), `ended` if the run ended first ("Not delivered…"). A host "not ready" refusal is retried
	 * after `registered`, so callers never see it.
	 */
	steer(text: string, from: string, opts?: SteerOptions): Promise<"delivered" | "ended">;
	/** One-shot; the first reason wins (AGT-07). */
	abort(reason: AbortReason): Promise<void>;
}

/**
 * Passed as an extra member of the dialog options object to every `RunUi` call (questions, DSC-16 to DSC-20; RUN-08, RUN-15).
 * Read it with `uiCallContext(dialogOptions)`.
 */
export interface UiCallContext {
	/** Stable across orchestrator restarts: `<runId>:<host request id>`. */
	key: string;
	/** Discord message ids of this question if it was already posted before a restart (RUN-08): bind to them, don't repost. */
	posted?: { channelId: string; messageIds: string[] };
	/** Record the question's Discord message ids as soon as it is posted (RUN-08). */
	onPosted(posted: { channelId: string; messageIds: string[] }): void;
	/** Resolves true when the worker acknowledged the relayed answer (react ✅), false if the run ended first. */
	delivered: Promise<boolean>;
}

export const UI_CALL_CONTEXT = "agentbotCall";

export function uiCallContext(dialogOptions: unknown): UiCallContext | undefined {
	return (dialogOptions as Record<string, UiCallContext | undefined> | undefined)?.[UI_CALL_CONTEXT];
}

export interface RunHooks {
	ui: RunUi;
	/**
	 * Once per `runAgent` call, as soon as the run can take steering and abort. The worker dispatcher registers at once:
	 * an abort before any worker started the run finishes it immediately (RUN-05), and steers sent before the host is
	 * `registered` are queued (⏳ via `onQueued`) and delivered afterwards (RUN-15). The fake registers per its script.
	 */
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
	/** Ask runs: names of new or changed regular files written to `<scratchDir>/outputs` (CHAT-10). */
	outputs?: string[];
	/**
	 * Runs that write code: the result bundle was imported into the runs repo (`commits` > 0) and waits for `pushResult`
	 * or `discardResult`, or the run's branch had no new commits (`commits` 0, nothing kept) (RUN-19).
	 */
	code?: { runId: string; commits: number };
}

/** `pushResult`: `pushed: false` when the branch changed on GitHub during the run, so the push was not a fast-forward (RUN-19). */
export type PushOutcome = { pushed: true; sha: string } | { pushed: false };

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
	/** True while `owner` has a run to attach to: unfinished, or finished with a result no caller has received (NFR-03). */
	hasRun(owner: RunOwner): boolean;
	/** Counts for health and status (architecture §4.5). */
	counts(): { pending: number; running: number; oldestPendingMs: number | null };
	/** Connected workers for the status page (§9.3); none for the fake. */
	workers(): WorkerStatus[];
	/** Read-only view of the unfinished runs for the status page, oldest first (§9.3, NFR-06). */
	activeRuns(): RunStatus[];
	/** AGT-21: connect one MCP server on a worker; the 20 s timeout starts when a worker picks the test up (`onStarted`). */
	mcpTest(
		spec: { name: string; server: unknown },
		opts?: { onWaitingForWorker?(): void; onStarted?(): void },
	): Promise<{ ok: boolean; tools: string[]; error?: string }>;
	/** RUN-19: pushes a finished run's imported result to `branch` on GitHub, fast-forward only. The result stays kept until `discardResult`. */
	pushResult(runId: string, branch: string, token: string): Promise<PushOutcome>;
	/** RUN-20: deletes a run's result once it was pushed, or when it is discarded (a rejected push, nothing to push). */
	discardResult(runId: string): Promise<void>;
	/** WS-08: deletes every temporary ref the issue's runs keep (terminal cleanup). Never throws. */
	releaseIssue(issueId: number): Promise<void>;
	/** GH-26: the repository's base branch and `setupCommand`, read from `.agentbot.yml` on a freshly fetched mirror. Throws with the problem. */
	repoConfig(checkout: CheckoutRequest): Promise<{ baseBranch: string; setupCommand?: string }>;
}

/** RUN-14: the Discord state of a run's live messages, kept per owner so a restarted orchestrator edits the same messages. */
export interface RunUiState {
	threadId?: string;
	statusMessage?: { channelId: string; messageId: string };
	todoMessage?: { channelId: string; messageId: string };
	/** Latest progress snapshot (state, activity, elapsed, cost). */
	progress?: { state: string; activity: string; elapsedMs: number; costUsd: number };
	todos?: TodoItem[];
}
