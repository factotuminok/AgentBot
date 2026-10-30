import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { IssueState, JobKind, RunKind } from "../engine/state";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface IssueRow {
	id: number;
	repo: string;
	number: number;
	title: string;
	state: IssueState;
	thread_id: string | null;
	branch: string | null;
	worktree: string | null;
	plan_session: string | null;
	impl_session: string | null;
	plan_rev: number;
	plan_comment_id: number | null;
	pr_number: number | null;
	ci_attempts: number;
	ci_last_sha: string | null;
	created_at: string;
	updated_at: string;
}

export interface JobRow {
	id: string;
	issue_id: number;
	kind: JobKind;
	status: JobStatus;
	input: string;
	result: string | null;
	error: string | null;
	cost_usd: number;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
}

export interface ChatRow {
	thread_id: string;
	repo: string;
	session_file: string | null;
	worktree: string | null;
	last_active_at: string;
}

/** Extra row of a chat in an ask-only channel (`/ask`); the chat's `chats` row carries the session and scratch path. */
export interface AskChatRow {
	thread_id: string;
	channel_id: string;
	/** Discord user id of the person who started the thread. */
	owner_id: string;
}

/** `/work plan` thread: `executing` means the plan was handed to the issue pipeline (`issue_number`). */
export type PlanState = "planning" | "awaiting" | "approved" | "executing" | "rejected" | "failed";

export interface PlanRow {
	thread_id: string;
	repo: string;
	request: string;
	/** Discord username of whoever ran `/work plan`. */
	author: string;
	state: PlanState;
	/** Number of plans posted so far; the buttons of revision `rev` are the current ones. */
	rev: number;
	/** JSON `RequestPlanOutput` of the latest plan. */
	output: string | null;
	session_file: string | null;
	issue_number: number | null;
	/** The review message of `rev` in the plan thread; null until it is posted (a restart reposts it, NFR-03). */
	review_message_id: string | null;
	/** When Execute finished handing the plan to the issue pipeline; null while a restart must still complete it. */
	executed_at: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * `/work issue` draft (NFR-03): `drafting` until the run's output is stored (`drafted`), `filing` from just before the
 * GitHub issue is created until its number is stored (`filed`), then `done` or `failed` once the result was reported.
 */
export type DraftState = "drafting" | "drafted" | "filing" | "filed" | "done" | "failed";

export interface DraftRow {
	id: string;
	repo: string;
	request: string;
	/** Discord username of the requester (quoted in the issue body). */
	author: string;
	author_id: string;
	/** Where the command ran: the result goes there when the command's reply can no longer be edited. */
	channel_id: string;
	state: DraftState;
	title: string | null;
	body: string | null;
	issue_number: number | null;
	issue_url: string | null;
	/** Session key of the draft run; deleted when the draft ends (ENG-05). */
	session_file: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
}

export interface NewDraft {
	id: string;
	repo: string;
	request: string;
	author: string;
	authorId: string;
	channelId: string;
}

/** Architecture §4.1. `lost` is transient: the dispatcher moves it to `pending` (first loss of a job) or `finished`. */
export type RunState = "pending" | "assigned" | "running" | "finishing" | "finished" | "lost";
export type RunOutcome = "succeeded" | "failed" | "aborted" | "cancelled" | "lost";

/**
 * One agent session on its own worker. Exactly one owner column is set: `job_id` (issue job), `chat_thread_id`
 * (repo or ask chat turn), `plan_thread_id` (`/work plan` turn) or `draft_id` (`/work issue` draft).
 */
export interface RunRow {
	id: string;
	state: RunState;
	/** `ask` is the public `/ask` chat (owner `chat_thread_id`); the others are `RunKind`s. */
	kind: RunKind | "ask";
	job_id: string | null;
	chat_thread_id: string | null;
	plan_thread_id: string | null;
	draft_id: string | null;
	worker_id: string | null;
	/** Network address of the connection that claimed the run (architecture §6: one claim per address; kept after it finishes). */
	worker_address: string | null;
	/** sha256 (hex) of the token that authorises the worker's heartbeats and its git and artifact requests (RUN-02, SEC-14); the token itself is never stored. */
	lease_token: string | null;
	lease_expires_at: string | null;
	loss_count: number;
	omp_version: string | null;
	/** `owner/name` the run checks out; null for `/ask` runs (RUN-17). */
	repo: string | null;
	/** The start ref (`refs/heads/<branch>`) and its commit, fixed when the run became pending (RUN-17). */
	start_ref: string | null;
	start_commit: string | null;
	/** `.agentbot.yml` `setupCommand` read when the run became pending (GH-26, WS-05). */
	setup_command: string | null;
	/** The earlier run whose kept checkpoint or result this run restores (RUN-17). */
	continues_run_id: string | null;
	/** 1 while `refs/agentbot/checkpoints/<id>` is kept in the runs repo (RUN-18, RUN-20). */
	has_checkpoint: number;
	/** 1 while `refs/agentbot/runs/<id>` is kept in the runs repo (RUN-19, RUN-20). */
	has_result: number;
	/** Discord thread, live status message and to-do message (RUN-14). */
	thread_id: string | null;
	status_message_id: string | null;
	todo_message_id: string | null;
	/** JSON of the latest `progress` snapshot and to-do list (RUN-14). */
	progress: string | null;
	todos: string | null;
	/** Last relay sequence number given to an outgoing message (RUN-06). */
	relay_out_seq: number;
	/** Highest relay sequence number received from the worker and stored (RUN-06). */
	relay_in_seq: number;
	/** The run's omp session key: `<state>/sessions/<key>.jsonl` (JOB-10). */
	session_key: string | null;
	/** Ask runs: the thread's scratch directory in the orchestrator (CHAT-07). */
	scratch_dir: string | null;
	/** JSON of the run request's serialisable turn (see `NewRun.request`). */
	request: string | null;
	/**
	 * JSON of the run's outcome while no attached caller has received it yet (the `Dispatcher` contract: results are kept
	 * until delivered, across restarts too); null once delivered or when the run never produced one.
	 */
	result: string | null;
	outcome: RunOutcome | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	/** The latest claim by a worker (RUN-02); with `started_at`, the run's setup time (NFR-06). */
	claimed_at: string | null;
	/** The agent started (`registered`). */
	started_at: string | null;
	finished_at: string | null;
}

/** An orchestrator → worker relay message not yet acknowledged by the worker (RUN-06). */
export interface OutboxRow {
	run_id: string;
	seq: number;
	/** JSON of the relayed message. */
	payload: string;
	created_at: string;
}

/** A posted `ui` question, so a re-attached run's request binds to it instead of posting again (RUN-08). */
export interface QuestionRow {
	run_id: string;
	request_id: string;
	channel_id: string;
	message_id: string;
	/** JSON of the question's options. */
	options: string;
	created_at: string;
}

export type WatchState = "watching" | "unwatched" | "suspended";

/** DSC-35 to DSC-37: keyed by the GitHub repository id so renames and transfers keep the watch. */
export interface WatchRow {
	repo_id: number;
	/** Current `owner/name`. */
	repo: string;
	channel_id: string;
	/** Discord user id or admin username. */
	created_by: string;
	state: WatchState;
	last_error: string | null;
	/** Newest issue `updated_at` seen by the poller (GH-10); null polls all labelled issues. */
	cursor: string | null;
	last_polled_at: string | null;
	created_at: string;
	updated_at: string;
}

/** Columns callers may change via `updateIssue`. */
export type IssuePatch = Partial<Omit<IssueRow, "id" | "repo" | "number" | "created_at" | "updated_at">>;
export type ChatPatch = Partial<Omit<ChatRow, "thread_id" | "repo">>;
export type PlanPatch = Partial<Pick<PlanRow, "state" | "rev" | "output" | "session_file" | "issue_number" | "review_message_id" | "executed_at">>;
export type DraftPatch = Partial<Pick<DraftRow, "state" | "title" | "body" | "issue_number" | "issue_url" | "session_file" | "error">>;
export type RunPatch = Partial<
	Pick<
		RunRow,
		| "omp_version"
		| "start_ref"
		| "start_commit"
		| "has_checkpoint"
		| "has_result"
		| "thread_id"
		| "status_message_id"
		| "todo_message_id"
		| "progress"
		| "todos"
		| "outcome"
		| "error"
		| "result"
	>
>;
export type WatchPatch = Partial<Pick<WatchRow, "repo" | "channel_id" | "state" | "last_error" | "cursor" | "last_polled_at">>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues(
	id INTEGER PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
	thread_id TEXT, branch TEXT, worktree TEXT, plan_session TEXT, impl_session TEXT,
	plan_rev INTEGER NOT NULL DEFAULT 0, plan_comment_id INTEGER, pr_number INTEGER,
	ci_attempts INTEGER NOT NULL DEFAULT 0, ci_last_sha TEXT,
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(repo, number));
CREATE TABLE IF NOT EXISTS jobs(
	id TEXT PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issues(id), kind TEXT NOT NULL, status TEXT NOT NULL,
	input TEXT NOT NULL DEFAULT '{}', result TEXT, error TEXT, cost_usd REAL NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS chats(
	thread_id TEXT PRIMARY KEY, repo TEXT NOT NULL, session_file TEXT, worktree TEXT, last_active_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ask_chats(thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, owner_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans(
	thread_id TEXT PRIMARY KEY, repo TEXT NOT NULL, request TEXT NOT NULL, author TEXT NOT NULL, state TEXT NOT NULL,
	rev INTEGER NOT NULL DEFAULT 0, output TEXT, session_file TEXT, issue_number INTEGER, review_message_id TEXT, executed_at TEXT,
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts(
	id TEXT PRIMARY KEY, repo TEXT NOT NULL, request TEXT NOT NULL, author TEXT NOT NULL, author_id TEXT NOT NULL,
	channel_id TEXT NOT NULL, state TEXT NOT NULL, title TEXT, body TEXT, issue_number INTEGER, issue_url TEXT,
	session_file TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen_feedback(
	repo TEXT NOT NULL, pr_number INTEGER NOT NULL, github_id TEXT NOT NULL, PRIMARY KEY(repo, pr_number, github_id));
CREATE TABLE IF NOT EXISTS agent_runs(
	id INTEGER PRIMARY KEY, kind TEXT NOT NULL, repo TEXT NOT NULL, issue_number INTEGER, job_id TEXT, thread_id TEXT,
	started_at TEXT NOT NULL, finished_at TEXT NOT NULL, cost_usd REAL NOT NULL, tokens_in INTEGER NOT NULL,
	tokens_out INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_runs_finished ON agent_runs(finished_at);
CREATE TABLE IF NOT EXISTS runs(
	id TEXT PRIMARY KEY, state TEXT NOT NULL, kind TEXT NOT NULL,
	job_id TEXT REFERENCES jobs(id), chat_thread_id TEXT REFERENCES chats(thread_id),
	plan_thread_id TEXT REFERENCES plans(thread_id), draft_id TEXT,
	worker_id TEXT, worker_address TEXT, lease_token TEXT UNIQUE, lease_expires_at TEXT, loss_count INTEGER NOT NULL DEFAULT 0,
	omp_version TEXT, repo TEXT, start_ref TEXT, start_commit TEXT, setup_command TEXT, continues_run_id TEXT REFERENCES runs(id),
	has_checkpoint INTEGER NOT NULL DEFAULT 0, has_result INTEGER NOT NULL DEFAULT 0,
	thread_id TEXT, status_message_id TEXT, todo_message_id TEXT, progress TEXT, todos TEXT,
	relay_out_seq INTEGER NOT NULL DEFAULT 0, relay_in_seq INTEGER NOT NULL DEFAULT 0, session_key TEXT, scratch_dir TEXT, result TEXT,
	outcome TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_at TEXT, started_at TEXT, finished_at TEXT,
	CHECK((job_id IS NOT NULL) + (chat_thread_id IS NOT NULL) + (plan_thread_id IS NOT NULL) + (draft_id IS NOT NULL) = 1));
CREATE INDEX IF NOT EXISTS runs_state ON runs(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS runs_active_job ON runs(job_id) WHERE state != 'finished';
CREATE UNIQUE INDEX IF NOT EXISTS runs_active_chat ON runs(chat_thread_id) WHERE state != 'finished';
CREATE UNIQUE INDEX IF NOT EXISTS runs_active_plan ON runs(plan_thread_id) WHERE state != 'finished';
CREATE TABLE IF NOT EXISTS relay_outbox(
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, payload TEXT NOT NULL,
	created_at TEXT NOT NULL, PRIMARY KEY(run_id, seq));
CREATE TABLE IF NOT EXISTS open_questions(
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, channel_id TEXT NOT NULL,
	message_id TEXT NOT NULL, options TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id, request_id));
CREATE TABLE IF NOT EXISTS worker_claims(worker_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, claimed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worker_addresses(worker_id TEXT PRIMARY KEY, address TEXT NOT NULL, first_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS watches(
	repo_id INTEGER PRIMARY KEY, repo TEXT NOT NULL, channel_id TEXT NOT NULL, created_by TEXT NOT NULL,
	state TEXT NOT NULL, last_error TEXT, cursor TEXT, last_polled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS watches_repo ON watches(repo COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS watches_channel ON watches(channel_id);
`;

/** Tokens and cost consumed by one agent run (the shape of `RunUsage`). */
export interface UsageRecord {
	costUsd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** One agent run's usage: the unit of usage accounting for the status page. */
export interface AgentRunRecord {
	kind: RunKind;
	repo: string;
	issueNumber?: number;
	jobId?: string;
	threadId?: string;
	startedAt: string;
	usage: UsageRecord;
}

/** The `runs` column that names a run's owner (exactly one is set per row). */
export type RunOwnerColumn = "job_id" | "chat_thread_id" | "plan_thread_id" | "draft_id";
const RUN_OWNER_COLUMNS: readonly string[] = ["job_id", "chat_thread_id", "plan_thread_id", "draft_id"] satisfies RunOwnerColumn[];

/** A new run; exactly one of `jobId`, `chatThreadId`, `planThreadId` and `draftId` must be set. */
export interface NewRun {
	kind: RunKind | "ask";
	jobId?: string;
	chatThreadId?: string;
	planThreadId?: string;
	draftId?: string;
	threadId?: string;
	repo?: string;
	startRef?: string;
	startCommit?: string;
	setupCommand?: string;
	continuesRunId?: string;
	sessionKey?: string;
	scratchDir?: string;
	/** The serialisable part of the run's request (prompt, session, limits …), JSON; lets a run still pending at a restart be re-issued (NFR-03). */
	request?: string;
}

export interface NewQuestion {
	runId: string;
	requestId: string;
	channelId: string;
	messageId: string;
	options: unknown;
}

export interface NewWatch {
	repoId: number;
	repo: string;
	channelId: string;
	createdBy: string;
}

/** Runs whose lease ran out: `requeued` went back to `pending` (never started), `lost` died while running. */
export interface ExpiredLeases {
	requeued: RunRow[];
	lost: RunRow[];
}

const ISSUE_COLUMNS: Record<keyof IssuePatch, true> = {
	title: true,
	state: true,
	thread_id: true,
	branch: true,
	worktree: true,
	plan_session: true,
	impl_session: true,
	plan_rev: true,
	plan_comment_id: true,
	pr_number: true,
	ci_attempts: true,
	ci_last_sha: true,
};

const CHAT_COLUMNS: Record<keyof ChatPatch, true> = {
	session_file: true,
	worktree: true,
	last_active_at: true,
};

const PLAN_COLUMNS: Record<keyof PlanPatch, true> = {
	state: true,
	rev: true,
	output: true,
	session_file: true,
	issue_number: true,
	review_message_id: true,
	executed_at: true,
};

const DRAFT_COLUMNS: Record<keyof DraftPatch, true> = {
	state: true,
	title: true,
	body: true,
	issue_number: true,
	issue_url: true,
	session_file: true,
	error: true,
};

const RUN_COLUMNS: Record<keyof RunPatch, true> = {
	omp_version: true,
	start_ref: true,
	start_commit: true,
	has_checkpoint: true,
	has_result: true,
	thread_id: true,
	status_message_id: true,
	todo_message_id: true,
	progress: true,
	todos: true,
	outcome: true,
	error: true,
	result: true,
};

const WATCH_COLUMNS: Record<keyof WatchPatch, true> = {
	repo: true,
	channel_id: true,
	state: true,
	last_error: true,
	cursor: true,
	last_polled_at: true,
};

export interface JobOutcome {
	status: Exclude<JobStatus, "queued" | "running">;
	result?: unknown;
	error?: string;
}

/** Typed access to the AgentBot SQLite store. */
export interface Db {
	raw: Database;
	close(): void;

	getIssue(id: number): IssueRow | null;
	findIssue(repo: string, number: number): IssueRow | null;
	issueByThread(threadId: string): IssueRow | null;
	/** Insert a new issue in state `queued`. Throws on duplicate (repo, number). */
	insertIssue(repo: string, number: number, title: string): IssueRow;
	updateIssue(id: number, patch: IssuePatch): IssueRow;
	setIssueState(id: number, state: IssueState): IssueRow;
	/** Issues not in `done`/`cancelled`. */
	openIssues(): IssueRow[];
	/** `done`/`cancelled` issues that still store a `plan_session` or `impl_session` path. */
	closedIssuesWithSessions(): IssueRow[];

	insertJob(issueId: number, kind: JobKind, input?: object): JobRow;
	getJob(id: string): JobRow | null;
	/** Atomically claim the oldest queued job whose issue has no running job; marks it `running`. */
	claimNextJob(): JobRow | null;
	/** Records the outcome; `cost_usd` becomes the sum of the job's agent runs (across resumes). */
	finishJob(id: string, outcome: JobOutcome): void;
	/** What the job's agent runs have cost so far (JOB-04): the budget its next run must stay within (JOB-07). */
	jobCostUsd(id: string): number;
	queuedJobCount(): number;
	/** Put a job back in the queue with `input` replaced (used for resume). */
	requeueJob(id: string, input: object): void;
	/** Store a job's result before it finishes (resume after a crash reads it back). */
	setJobResult(id: string, result: unknown): void;
	runningJobs(): JobRow[];
	cancelQueuedJobs(issueId: number): void;
	/** First queued or running job for the issue, if any. */
	activeJob(issueId: number): JobRow | null;
	/** Most recent job of `kind` with `status` (default `succeeded`). */
	latestJob(issueId: number, kind: JobKind, status?: JobStatus): JobRow | null;
	/** The issue's most recent job of any kind and status (a Retry acts only on it, DSC-21). */
	newestJob(issueId: number): JobRow | null;

	getChat(threadId: string): ChatRow | null;
	insertChat(threadId: string, repo: string): ChatRow;
	updateChat(threadId: string, patch: ChatPatch): void;
	/** Chats with a live worktree idle since before `cutoffIso`. */
	idleChats(cutoffIso: string): ChatRow[];
	/** Marks a chat as an ask-only chat started by `ownerId` in `channelId`. */
	insertAskChat(threadId: string, channelId: string, ownerId: string): AskChatRow;
	/** The ask-only extras of a chat; null for repo chats. */
	getAskChat(threadId: string): AskChatRow | null;

	getPlan(threadId: string): PlanRow | null;
	insertPlan(threadId: string, repo: string, request: string, author: string): PlanRow;
	updatePlan(threadId: string, patch: PlanPatch): PlanRow;
	/** Moves the plan from `from` to `to` only if it is still in `from` at revision `rev`; null when it was not. */
	claimPlan(threadId: string, rev: number, from: PlanState, to: PlanState): PlanRow | null;
	plansInState(state: PlanState): PlanRow[];

	/** Records a `/work issue` draft in state `drafting`. */
	insertDraft(draft: NewDraft): DraftRow;
	getDraft(id: string): DraftRow | null;
	updateDraft(id: string, patch: DraftPatch): DraftRow;
	/** Drafts in any of `states`, oldest first. */
	draftsInState(...states: DraftState[]): DraftRow[];

	kvGet(key: string): string | undefined;
	kvSet(key: string, value: string): void;
	markSeen(repo: string, pr: number, githubId: string): void;
	seenIds(repo: string, pr: number): Set<string>;
	/** Append one agent run's usage (stamped with the current time as `finished_at`). */
	recordRun(run: AgentRunRecord): void;

	/** Inserts a `pending` run. Throws when its owner already has a run that is not `finished` (RUN-21). */
	insertRun(run: NewRun): RunRow;
	getRun(id: string): RunRow | null;
	/** Runs in any of `states`, oldest first. */
	runsInState(...states: RunState[]): RunRow[];
	/** The owner's current run: the newest one that is not `finished` or still holds an undelivered `result`. */
	currentRun(column: RunOwnerColumn, ownerId: string): RunRow | null;
	/**
	 * Atomically assigns the oldest pending run to `workerId` with a fresh lease of `leaseMs` (RUN-02), recording the
	 * claiming connection's `address`.
	 */
	claimRun(workerId: string, leaseMs: number, address?: string): ClaimedRun | null;
	/** Extends the lease if `token` still holds run `id` (assigned, running or finishing); null otherwise. */
	renewLease(id: string, token: string, leaseMs: number): RunRow | null;
	/** The run a live lease token belongs to; null when the token is unknown or the run no longer holds it. */
	runForLease(token: string): RunRow | null;
	/**
	 * Expires leases that ran out before `at`: `assigned` runs go back to `pending`, `running` runs become `lost`
	 * with their loss count raised (RUN-02, RUN-04). The tokens are revoked.
	 */
	expireLeases(at?: Date): ExpiredLeases;
	/** After a restart, gives every `assigned`/`running` run at least `graceMs` to re-announce (RUN-07). */
	graceLeases(graceMs: number): void;
	/**
	 * Moves run `id` to `to` only if it is in one of `from`; null when it was not. Moving to `pending` releases the
	 * worker and lease; to `finished` revokes the lease and stamps `finished_at`; to `running` stamps `started_at`.
	 */
	transitionRun(id: string, from: RunState[], to: RunState, patch?: RunPatch): RunRow | null;
	updateRun(id: string, patch: RunPatch): RunRow;
	/** Finished runs of the issue's jobs that still keep a checkpoint or result ref, newest first (RUN-17, RUN-20). */
	keptRuns(issueId: number): RunRow[];
	/** Repositories of runs that are unfinished or still keep refs: their mirrors must stay (WS-01). */
	reposInUse(): string[];

	/** Stores an outgoing relay message under the run's next sequence number and returns that number (RUN-06). */
	appendOutbox(runId: string, payload: unknown): number;
	/** Unacknowledged outgoing messages of the run in sequence order (resent after a reconnect). */
	outbox(runId: string): OutboxRow[];
	/** Drops the run's outgoing messages up to and including `seq`; returns how many were dropped. */
	ackOutbox(runId: string, seq: number): number;
	/** Records an incoming relay sequence number; false when it was already received (a duplicate to drop). */
	acceptInbound(runId: string, seq: number): boolean;
	/** The run (or `mcp-test` task) id `workerId` claimed, if it ever claimed one (one claim per worker id, architecture §6). */
	workerClaim(workerId: string): string | null;
	/** Records the one claim of `workerId`; false when it already has one. */
	recordWorkerClaim(workerId: string, runId: string): boolean;
	/**
	 * True when a run claimed from `address` still holds its lease, is `lost`, or finished at or after `since`
	 * (architecture §6: one claim per network address).
	 */
	addressHoldsRun(address: string, since: Date): boolean;
	/** The address `workerId` first said hello from, recording `address` when it is new (architecture §6). */
	bindWorkerAddress(workerId: string, address: string): string;

	insertQuestion(question: NewQuestion): QuestionRow;
	getQuestion(runId: string, requestId: string): QuestionRow | null;
	questionsForRun(runId: string): QuestionRow[];
	deleteQuestion(runId: string, requestId: string): void;
	/** Records the Discord messages a question was posted as (RUN-08); message ids are stored comma-separated. */
	setQuestionPosted(runId: string, requestId: string, channelId: string, messageIds: string[]): void;

	/**
	 * Records a watch in state `watching` (DSC-35). Re-watching an `unwatched` repository clears its cursor so issues
	 * labelled meanwhile are picked up (GH-10); its last error is cleared.
	 */
	watchRepo(watch: NewWatch): WatchRow;
	getWatch(repoId: number): WatchRow | null;
	/** By `owner/name`, compared case-insensitively as GitHub does. */
	watchByName(repo: string): WatchRow | null;
	watchByChannel(channelId: string): WatchRow | null;
	/** All watches, or those in `state`, by name. */
	listWatches(state?: WatchState): WatchRow[];
	updateWatch(repoId: number, patch: WatchPatch): WatchRow;
}

const now = () => new Date().toISOString();

/** The database file inside the state directory (DB-01). */
export function dbPath(stateDir: string): string {
	return join(stateDir, "agentbot.db");
}

type Params = Record<string, string | number | null>;

/** sha256 hex of a lease token: what the runs table stores and looks up, so the SQL comparison leaks nothing (SEC-14). */
export function hashLeaseToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A run just claimed, with its lease token (returned to the claimer once; only its hash is stored). */
export type ClaimedRun = RunRow & { leaseToken: string };

/** Open (and create) the store at `path` (`dbPath(stateDir)`). Pass `":memory:"` for tests and dry-run. */
export function openDb(path: string): Db {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode=WAL");
	// Under WAL, NORMAL fsyncs at checkpoints instead of at every commit: a commit still survives a process crash, and
	// only an OS crash or power loss can lose the last few. FULL blocked the event loop (bun:sqlite is synchronous) for up
	// to 17 s in the phase 11 load test, when 10 workers' installs kept the node's disk busy (wiki/load-test.md).
	db.run("PRAGMA synchronous=NORMAL");
	db.run("PRAGMA foreign_keys=ON");
	db.run("PRAGMA busy_timeout=5000");
	db.transaction(() => {
		for (const stmt of SCHEMA.split(";")) if (stmt.trim()) db.run(stmt);
		// Columns added after the runs table first shipped (phases 3, 4 and 6).
		const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(runs)").all().map(c => c.name));
		for (const column of ["session_key", "scratch_dir", "result", "repo", "setup_command", "claimed_at", "worker_address", "request"]) {
			if (!columns.has(column)) db.run(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
		}
		// Columns added to plans in phase 5.
		const planColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(plans)").all().map(c => c.name));
		for (const column of ["review_message_id", "executed_at"]) {
			if (!planColumns.has(column)) db.run(`ALTER TABLE plans ADD COLUMN ${column} TEXT`);
		}
		// SEC-14 (phase 11): leases are stored as sha256 hex; tokens stored raw before that are hashed in place.
		for (const row of db.query<{ id: string; lease_token: string }, []>("SELECT id, lease_token FROM runs WHERE lease_token IS NOT NULL AND length(lease_token) <> 64").all()) {
			db.run("UPDATE runs SET lease_token = ? WHERE id = ?", [hashLeaseToken(row.lease_token), row.id]);
		}
	})();

	const q = {
		issueById: db.query<IssueRow, [number]>("SELECT * FROM issues WHERE id = ?"),
		issueByRepoNumber: db.query<IssueRow, [string, number]>("SELECT * FROM issues WHERE repo = ? AND number = ?"),
		issueByThread: db.query<IssueRow, [string]>("SELECT * FROM issues WHERE thread_id = ?"),
		insertIssue: db.query<IssueRow, [string, number, string, string, string]>(
			"INSERT INTO issues(repo, number, title, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?) RETURNING *",
		),
		issuesNotIn: db.query<IssueRow, []>("SELECT * FROM issues WHERE state NOT IN ('done', 'cancelled') ORDER BY id"),
		closedWithSessions: db.query<IssueRow, []>(
			"SELECT * FROM issues WHERE state IN ('done', 'cancelled') AND (plan_session IS NOT NULL OR impl_session IS NOT NULL) ORDER BY id",
		),
		insertJob: db.query<JobRow, [string, number, string, string, string]>(
			"INSERT INTO jobs(id, issue_id, kind, status, input, created_at) VALUES (?, ?, ?, 'queued', ?, ?) RETURNING *",
		),
		jobById: db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?"),
		claimNext: db.query<JobRow, [string]>(
			`UPDATE jobs SET status = 'running', started_at = ?1 WHERE id = (
				SELECT j.id FROM jobs j WHERE j.status = 'queued'
				AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.issue_id = j.issue_id AND r.status = 'running')
				ORDER BY j.created_at, j.rowid LIMIT 1) RETURNING *`,
		),
		finishJob: db.query<null, [string, string | null, string | null, string, string]>(
			`UPDATE jobs SET status = ?1, result = COALESCE(?2, result), error = ?3, finished_at = ?4,
				cost_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM agent_runs WHERE job_id = ?5) WHERE id = ?5`,
		),
		jobCost: db.query<{ cost: number }, [string]>("SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM agent_runs WHERE job_id = ?"),
		queuedCount: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"),
		requeueJob: db.query<null, [string, string]>(
			"UPDATE jobs SET status = 'queued', input = ?, started_at = NULL WHERE id = ?",
		),
		setJobResult: db.query<null, [string, string]>("UPDATE jobs SET result = ? WHERE id = ?"),
		runningJobs: db.query<JobRow, []>("SELECT * FROM jobs WHERE status = 'running'"),
		cancelQueued: db.query<null, [string, number]>(
			"UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE issue_id = ? AND status = 'queued'",
		),
		activeJobForIssue: db.query<JobRow, [number]>(
			"SELECT * FROM jobs WHERE issue_id = ? AND status IN ('queued', 'running') ORDER BY status = 'running' DESC, created_at, rowid LIMIT 1",
		),
		latestJob: db.query<JobRow, [number, string, string]>(
			"SELECT * FROM jobs WHERE issue_id = ? AND kind = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
		),
		newestJob: db.query<JobRow, [number]>("SELECT * FROM jobs WHERE issue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
		chat: db.query<ChatRow, [string]>("SELECT * FROM chats WHERE thread_id = ?"),
		insertChat: db.query<ChatRow, [string, string, string]>(
			"INSERT INTO chats(thread_id, repo, last_active_at) VALUES (?, ?, ?) RETURNING *",
		),
		idleChats: db.query<ChatRow, [string]>(
			"SELECT * FROM chats WHERE worktree IS NOT NULL AND last_active_at < ?",
		),
		askChat: db.query<AskChatRow, [string]>("SELECT * FROM ask_chats WHERE thread_id = ?"),
		insertAskChat: db.query<AskChatRow, [string, string, string]>(
			"INSERT INTO ask_chats(thread_id, channel_id, owner_id) VALUES (?, ?, ?) RETURNING *",
		),
		plan: db.query<PlanRow, [string]>("SELECT * FROM plans WHERE thread_id = ?"),
		insertPlan: db.query<PlanRow, [string, string, string, string, string, string]>(
			"INSERT INTO plans(thread_id, repo, request, author, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'planning', ?, ?) RETURNING *",
		),
		claimPlan: db.query<PlanRow, [string, string, string, number, string]>(
			"UPDATE plans SET state = ?, updated_at = ? WHERE thread_id = ? AND rev = ? AND state = ? RETURNING *",
		),
		plansInState: db.query<PlanRow, [string]>("SELECT * FROM plans WHERE state = ?"),
		insertDraft: db.query<DraftRow, [string, string, string, string, string, string, string, string]>(
			"INSERT INTO drafts(id, repo, request, author, author_id, channel_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'drafting', ?, ?) RETURNING *",
		),
		draft: db.query<DraftRow, [string]>("SELECT * FROM drafts WHERE id = ?"),
		kvGet: db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?"),
		kvSet: db.query<null, [string, string]>(
			"INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		),
		markSeen: db.query<null, [string, number, string]>(
			"INSERT OR IGNORE INTO seen_feedback(repo, pr_number, github_id) VALUES (?, ?, ?)",
		),
		seenFor: db.query<{ github_id: string }, [string, number]>(
			"SELECT github_id FROM seen_feedback WHERE repo = ? AND pr_number = ?",
		),
		recordRun: db.query<null, [string, string, number | null, string | null, string | null, string, string, number, number, number, number, number]>(
			`INSERT INTO agent_runs(kind, repo, issue_number, job_id, thread_id, started_at, finished_at, cost_usd,
				tokens_in, tokens_out, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),

		insertRun: db.query<RunRow, [Params]>(
			`INSERT INTO runs(id, state, kind, job_id, chat_thread_id, plan_thread_id, draft_id, thread_id, repo, start_ref,
				start_commit, setup_command, continues_run_id, session_key, scratch_dir, request, created_at, updated_at)
			VALUES ($id, 'pending', $kind, $job_id, $chat_thread_id, $plan_thread_id, $draft_id, $thread_id, $repo, $start_ref,
				$start_commit, $setup_command, $continues_run_id, $session_key, $scratch_dir, $request, $now, $now) RETURNING *`,
		),
		keptRuns: db.query<RunRow, [number]>(
			`SELECT runs.* FROM runs JOIN jobs ON jobs.id = runs.job_id
			WHERE jobs.issue_id = ? AND runs.state = 'finished' AND (runs.has_checkpoint = 1 OR runs.has_result = 1)
			ORDER BY runs.created_at DESC, runs.rowid DESC`,
		),
		reposInUse: db.query<{ repo: string }, []>(
			`SELECT DISTINCT repo FROM runs WHERE repo IS NOT NULL AND (state != 'finished' OR has_checkpoint = 1 OR has_result = 1)`,
		),
		runById: db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?"),
		claimRun: db.query<RunRow, [string, string, string, string, string | null]>(
			`UPDATE runs SET state = 'assigned', worker_id = ?1, lease_token = ?2, lease_expires_at = ?3, updated_at = ?4, claimed_at = ?4,
				worker_address = ?5
			WHERE id = (SELECT id FROM runs WHERE state = 'pending' ORDER BY created_at, rowid LIMIT 1) RETURNING *`,
		),
		renewLease: db.query<RunRow, [string, string, string, string]>(
			`UPDATE runs SET lease_expires_at = ?1, updated_at = ?2
			WHERE id = ?3 AND lease_token = ?4 AND state IN ('assigned', 'running', 'finishing') RETURNING *`,
		),
		runForLease: db.query<RunRow, [string]>(
			"SELECT * FROM runs WHERE lease_token = ? AND state IN ('assigned', 'running', 'finishing')",
		),
		expireAssigned: db.query<RunRow, [string]>(
			`UPDATE runs SET state = 'pending', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?1
			WHERE state = 'assigned' AND lease_expires_at < ?1 RETURNING *`,
		),
		expireRunning: db.query<RunRow, [string]>(
			`UPDATE runs SET state = 'lost', loss_count = loss_count + 1, lease_token = NULL, lease_expires_at = NULL,
				updated_at = ?1
			WHERE state = 'running' AND lease_expires_at < ?1 RETURNING *`,
		),
		graceLeases: db.query<null, [string]>(
			`UPDATE runs SET lease_expires_at = ?1
			WHERE state IN ('assigned', 'running') AND (lease_expires_at IS NULL OR lease_expires_at < ?1)`,
		),
		bumpOutSeq: db.query<{ relay_out_seq: number }, [string]>(
			"UPDATE runs SET relay_out_seq = relay_out_seq + 1 WHERE id = ? RETURNING relay_out_seq",
		),
		insertOutbox: db.query<null, [string, number, string, string]>(
			"INSERT INTO relay_outbox(run_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
		),
		outbox: db.query<OutboxRow, [string]>("SELECT * FROM relay_outbox WHERE run_id = ? ORDER BY seq"),
		ackOutbox: db.query<null, [string, number]>("DELETE FROM relay_outbox WHERE run_id = ? AND seq <= ?"),
		acceptInbound: db.query<{ relay_in_seq: number }, [number, string]>(
			"UPDATE runs SET relay_in_seq = ?1 WHERE id = ?2 AND relay_in_seq < ?1 RETURNING relay_in_seq",
		),
		insertQuestion: db.query<QuestionRow, [string, string, string, string, string, string]>(
			`INSERT INTO open_questions(run_id, request_id, channel_id, message_id, options, created_at)
			VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
		),
		question: db.query<QuestionRow, [string, string]>(
			"SELECT * FROM open_questions WHERE run_id = ? AND request_id = ?",
		),
		questionsForRun: db.query<QuestionRow, [string]>(
			"SELECT * FROM open_questions WHERE run_id = ? ORDER BY created_at, rowid",
		),
		deleteQuestion: db.query<null, [string, string]>("DELETE FROM open_questions WHERE run_id = ? AND request_id = ?"),
		setQuestionPosted: db.query<null, [string, string, string, string]>(
			"UPDATE open_questions SET channel_id = ?3, message_id = ?4 WHERE run_id = ?1 AND request_id = ?2",
		),
		workerClaim: db.query<{ run_id: string }, [string]>("SELECT run_id FROM worker_claims WHERE worker_id = ?"),
		recordWorkerClaim: db.query<null, [string, string, string]>(
			"INSERT OR IGNORE INTO worker_claims(worker_id, run_id, claimed_at) VALUES (?, ?, ?)",
		),
		addressHoldsRun: db.query<{ id: string }, [string, string]>(
			`SELECT id FROM runs WHERE worker_address = ?1
				AND (state IN ('assigned', 'running', 'finishing', 'lost') OR finished_at >= ?2) LIMIT 1`,
		),
		recordWorkerAddress: db.query<null, [string, string, string]>(
			"INSERT OR IGNORE INTO worker_addresses(worker_id, address, first_seen_at) VALUES (?, ?, ?)",
		),
		workerAddress: db.query<{ address: string }, [string]>("SELECT address FROM worker_addresses WHERE worker_id = ?"),
		watchRepo: db.query<WatchRow, [number, string, string, string, string]>(
			`INSERT INTO watches(repo_id, repo, channel_id, created_by, state, created_at, updated_at)
			VALUES (?1, ?2, ?3, ?4, 'watching', ?5, ?5)
			ON CONFLICT(repo_id) DO UPDATE SET repo = excluded.repo, channel_id = excluded.channel_id,
				created_by = excluded.created_by, state = 'watching', last_error = NULL,
				cursor = CASE WHEN watches.state = 'unwatched' THEN NULL ELSE watches.cursor END, updated_at = excluded.updated_at
			RETURNING *`,
		),
		watch: db.query<WatchRow, [number]>("SELECT * FROM watches WHERE repo_id = ?"),
		watchByName: db.query<WatchRow, [string]>("SELECT * FROM watches WHERE repo = ? COLLATE NOCASE"),
		watchByChannel: db.query<WatchRow, [string]>("SELECT * FROM watches WHERE channel_id = ?"),
		watches: db.query<WatchRow, []>("SELECT * FROM watches ORDER BY repo COLLATE NOCASE"),
		watchesInState: db.query<WatchRow, [string]>("SELECT * FROM watches WHERE state = ? ORDER BY repo COLLATE NOCASE"),
	};

	/**
	 * `UPDATE table SET <allowed patch columns> [, updated_at] WHERE key [AND where] RETURNING *`. Null when no row
	 * matched or there is nothing to set.
	 */
	function patchRow<T>(
		table: string,
		keyColumn: string,
		key: string | number,
		columns: Record<string, true>,
		patch: object,
		extra: { stamp?: boolean; sets?: string[]; where?: string; params?: Params } = {},
	): T | null {
		const entries = Object.entries(patch).filter(([k]) => k in columns);
		const params: Params = { key, ...extra.params };
		for (const [k, v] of entries) params[k] = (v as string | number | null | undefined) ?? null;
		const sets = entries.map(([k]) => `${k} = $${k}`).concat(extra.sets ?? []);
		if (extra.stamp !== false) {
			params.updated_at = now();
			sets.push("updated_at = $updated_at");
		}
		if (!sets.length) return null;
		const where = `${keyColumn} = $key${extra.where ? ` AND ${extra.where}` : ""}`;
		return db.query<T, [Params]>(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${where} RETURNING *`).get(params);
	}

	function updateIssue(id: number, patch: IssuePatch): IssueRow {
		const row = patchRow<IssueRow>("issues", "id", id, ISSUE_COLUMNS, patch);
		if (!row) throw new Error(`issue ${id} not found`);
		return row;
	}

	function updatePlan(threadId: string, patch: PlanPatch): PlanRow {
		const row = patchRow<PlanRow>("plans", "thread_id", threadId, PLAN_COLUMNS, patch);
		if (!row) throw new Error(`plan thread ${threadId} not found`);
		return row;
	}

	function updateDraft(id: string, patch: DraftPatch): DraftRow {
		const row = patchRow<DraftRow>("drafts", "id", id, DRAFT_COLUMNS, patch);
		if (!row) throw new Error(`draft ${id} not found`);
		return row;
	}

	function transitionRun(id: string, from: RunState[], to: RunState, patch: RunPatch = {}): RunRow | null {
		const sets = ["state = $to"];
		if (to === "pending") sets.push("worker_id = NULL", "lease_token = NULL", "lease_expires_at = NULL");
		if (to === "finished") sets.push("lease_token = NULL", "lease_expires_at = NULL", "finished_at = $updated_at");
		if (to === "running") sets.push("started_at = COALESCE(started_at, $updated_at)");
		const params: Params = { to };
		const fromNames = from.map((state, i) => {
			params[`from${i}`] = state;
			return `$from${i}`;
		});
		if (!fromNames.length) return null;
		return patchRow<RunRow>("runs", "id", id, RUN_COLUMNS, patch, {
			sets,
			where: `state IN (${fromNames.join(", ")})`,
			params,
		});
	}

	return {
		raw: db,
		close: () => db.close(),

		getIssue: id => q.issueById.get(id),
		findIssue: (repo, number) => q.issueByRepoNumber.get(repo, number),
		issueByThread: threadId => q.issueByThread.get(threadId),
		insertIssue: (repo, number, title) => {
			const ts = now();
			return q.insertIssue.get(repo, number, title, ts, ts)!;
		},
		updateIssue,
		setIssueState: (id, state) => updateIssue(id, { state }),
		openIssues: () => q.issuesNotIn.all(),
		closedIssuesWithSessions: () => q.closedWithSessions.all(),

		insertJob: (issueId, kind, input = {}) =>
			q.insertJob.get(crypto.randomUUID(), issueId, kind, JSON.stringify(input), now())!,
		getJob: id => q.jobById.get(id),
		claimNextJob: () => db.transaction(() => q.claimNext.get(now()))(),
		finishJob: (id, outcome) => {
			q.finishJob.run(
				outcome.status,
				outcome.result === undefined ? null : JSON.stringify(outcome.result),
				outcome.error ?? null,
				now(),
				id,
			);
		},
		jobCostUsd: id => q.jobCost.get(id)!.cost,
		queuedJobCount: () => q.queuedCount.get()!.n,
		requeueJob: (id, input) => {
			q.requeueJob.run(JSON.stringify(input), id);
		},
		setJobResult: (id, result) => {
			q.setJobResult.run(JSON.stringify(result), id);
		},
		runningJobs: () => q.runningJobs.all(),
		cancelQueuedJobs: issueId => {
			q.cancelQueued.run(now(), issueId);
		},
		activeJob: issueId => q.activeJobForIssue.get(issueId),
		latestJob: (issueId, kind, status = "succeeded") => q.latestJob.get(issueId, kind, status),
		newestJob: issueId => q.newestJob.get(issueId),

		getChat: threadId => q.chat.get(threadId),
		insertChat: (threadId, repo) => q.insertChat.get(threadId, repo, now())!,
		updateChat: (threadId, patch) => {
			patchRow<ChatRow>("chats", "thread_id", threadId, CHAT_COLUMNS, patch, { stamp: false });
		},
		idleChats: cutoffIso => q.idleChats.all(cutoffIso),
		insertAskChat: (threadId, channelId, ownerId) => q.insertAskChat.get(threadId, channelId, ownerId)!,
		getAskChat: threadId => q.askChat.get(threadId),

		getPlan: threadId => q.plan.get(threadId),
		insertPlan: (threadId, repo, request, author) => q.insertPlan.get(threadId, repo, request, author, now(), now())!,
		updatePlan,
		claimPlan: (threadId, rev, from, to) => q.claimPlan.get(to, now(), threadId, rev, from),
		plansInState: state => q.plansInState.all(state),

		insertDraft: d => q.insertDraft.get(d.id, d.repo, d.request, d.author, d.authorId, d.channelId, now(), now())!,
		getDraft: id => q.draft.get(id),
		updateDraft,
		draftsInState: (...states) =>
			states.length === 0
				? []
				: db.query<DraftRow, string[]>(`SELECT * FROM drafts WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at, rowid`).all(...states),

		kvGet: key => q.kvGet.get(key)?.value,
		kvSet: (key, value) => {
			q.kvSet.run(key, value);
		},
		markSeen: (repo, pr, githubId) => {
			q.markSeen.run(repo, pr, githubId);
		},
		seenIds: (repo, pr) => new Set(q.seenFor.all(repo, pr).map(r => r.github_id)),
		recordRun: run => {
			const { usage } = run;
			q.recordRun.run(
				run.kind,
				run.repo,
				run.issueNumber ?? null,
				run.jobId ?? null,
				run.threadId ?? null,
				run.startedAt,
				now(),
				usage.costUsd,
				usage.input,
				usage.output,
				usage.cacheRead,
				usage.cacheWrite,
			);
		},

		insertRun: run =>
			q.insertRun.get({
				id: crypto.randomUUID(),
				kind: run.kind,
				job_id: run.jobId ?? null,
				chat_thread_id: run.chatThreadId ?? null,
				plan_thread_id: run.planThreadId ?? null,
				draft_id: run.draftId ?? null,
				thread_id: run.threadId ?? null,
				repo: run.repo ?? null,
				start_ref: run.startRef ?? null,
				start_commit: run.startCommit ?? null,
				setup_command: run.setupCommand ?? null,
				continues_run_id: run.continuesRunId ?? null,
				session_key: run.sessionKey ?? null,
				scratch_dir: run.scratchDir ?? null,
				request: run.request ?? null,
				now: now(),
			})!,
		getRun: id => q.runById.get(id),
		runsInState: (...states) => {
			if (!states.length) return [];
			return db
				.query<RunRow, string[]>(`SELECT * FROM runs WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at, rowid`)
				.all(...states);
		},
		currentRun: (column, ownerId) => {
			if (!RUN_OWNER_COLUMNS.includes(column)) throw new Error(`not a run owner column: ${column}`);
			return db
				.query<RunRow, [string]>(
					`SELECT * FROM runs WHERE ${column} = ? AND (state != 'finished' OR result IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get(ownerId);
		},
		claimRun: (workerId, leaseMs, address) => {
			const at = new Date();
			const leaseToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
			const row = q.claimRun.get(workerId, hashLeaseToken(leaseToken), new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), address ?? null);
			return row && { ...row, leaseToken };
		},
		renewLease: (id, token, leaseMs) => {
			const at = new Date();
			return q.renewLease.get(new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), id, hashLeaseToken(token));
		},
		runForLease: token => q.runForLease.get(hashLeaseToken(token)),
		expireLeases: (at = new Date()) =>
			db.transaction(() => {
				const iso = at.toISOString();
				return { requeued: q.expireAssigned.all(iso), lost: q.expireRunning.all(iso) };
			})(),
		graceLeases: graceMs => {
			q.graceLeases.run(new Date(Date.now() + graceMs).toISOString());
		},
		transitionRun,
		updateRun: (id, patch) => {
			const row = patchRow<RunRow>("runs", "id", id, RUN_COLUMNS, patch);
			if (!row) throw new Error(`run ${id} not found`);
			return row;
		},
		keptRuns: issueId => q.keptRuns.all(issueId),
		reposInUse: () => q.reposInUse.all().map(r => r.repo),

		appendOutbox: (runId, payload) =>
			db.transaction(() => {
				const bumped = q.bumpOutSeq.get(runId);
				if (!bumped) throw new Error(`run ${runId} not found`);
				q.insertOutbox.run(runId, bumped.relay_out_seq, JSON.stringify(payload), now());
				return bumped.relay_out_seq;
			})(),
		outbox: runId => q.outbox.all(runId),
		ackOutbox: (runId, seq) => q.ackOutbox.run(runId, seq).changes,
		acceptInbound: (runId, seq) => q.acceptInbound.get(seq, runId) !== null,
		workerClaim: workerId => q.workerClaim.get(workerId)?.run_id ?? null,
		recordWorkerClaim: (workerId, runId) => q.recordWorkerClaim.run(workerId, runId, now()).changes === 1,
		addressHoldsRun: (address, since) => q.addressHoldsRun.get(address, since.toISOString()) !== null,
		bindWorkerAddress: (workerId, address) => {
			q.recordWorkerAddress.run(workerId, address, now());
			return q.workerAddress.get(workerId)!.address;
		},

		insertQuestion: question =>
			q.insertQuestion.get(
				question.runId,
				question.requestId,
				question.channelId,
				question.messageId,
				JSON.stringify(question.options),
				now(),
			)!,
		getQuestion: (runId, requestId) => q.question.get(runId, requestId),
		questionsForRun: runId => q.questionsForRun.all(runId),
		deleteQuestion: (runId, requestId) => {
			q.deleteQuestion.run(runId, requestId);
		},
		setQuestionPosted: (runId, requestId, channelId, messageIds) => {
			q.setQuestionPosted.run(runId, requestId, channelId, messageIds.join(","));
		},

		watchRepo: watch => q.watchRepo.get(watch.repoId, watch.repo, watch.channelId, watch.createdBy, now())!,
		getWatch: repoId => q.watch.get(repoId),
		watchByName: repo => q.watchByName.get(repo),
		watchByChannel: channelId => q.watchByChannel.get(channelId),
		listWatches: state => (state ? q.watchesInState.all(state) : q.watches.all()),
		updateWatch: (repoId, patch) => {
			const row = patchRow<WatchRow>("watches", "repo_id", repoId, WATCH_COLUMNS, patch);
			if (!row) throw new Error(`watch for repository ${repoId} not found`);
			return row;
		},
	};
}

export function parseJson<T>(text: string | null): T | undefined {
	return text ? (JSON.parse(text) as T) : undefined;
}
