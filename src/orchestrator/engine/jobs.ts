import { existsSync } from "node:fs";
import { errorMessage, log } from "../../shared/log";
import { allowedMentions, memberAllowed } from "../discord/access";
import { type Progress, startProgress } from "../discord/progress";
import { createDiscordUI } from "../discord/questions";
import {
	activityText,
	chunkText,
	ciFixBeforePrMessage,
	failureMessage,
	followUpMessage,
	implementDoneMessage,
	oomWarning,
	planMessage,
} from "../discord/render";
import { ISSUE_ICONS, setTopIcon } from "../discord/topMessage";
import {
	type CheckoutRequest,
	RunDetached,
	type RunHandle,
	type RunOwner,
	type RunRequest,
	type RunResult,
	writesCode,
} from "../dispatch/dispatcher";
import { pushCiWorkflows } from "../github/ci";
import type { CiFailure, FeedbackItem } from "../github/feedback";
import { syncLabels } from "../github/labels";
import { type IssueRow, type JobRow, parseJson } from "../store/db";
import { createRunUiStore } from "../store/runUi";
import { issueImplSessionKey, issuePlanSessionKey, removeIssueSessions, sessionPath } from "../store/sessions";
import { loadoutKey } from "../store/stats";
import { CI_START_GRACE_MS, type CiGateResult, waitForBranchCi } from "./ciGate";
import type { EngineDeps } from "./deps";
import {
	fixCiPrompt,
	IMPLEMENT_SCHEMA,
	type ImplementOutput,
	implementPrompt,
	PLAN_SCHEMA,
	type PlanOutput,
	planPrompt,
	REVISE_SCHEMA,
	type ReviseOutput,
	restartNote,
	revisePrompt,
	runPrompt,
} from "./prompts";
import { type IssueEvent, type JobKind, TERMINAL_STATES, transition } from "./state";

/**
 * Job execution and issue state handling (JOB-05 to JOB-23, CI-01 to CI-09, PR-01 to PR-03, ISS-05, ISS-06, WS-08
 * subset), ported from DevForge `src/engine/jobs.ts` onto `EngineDeps`: Discord through the surface, agent runs through
 * the dispatcher on worker checkouts, results pushed by the dispatcher (RUN-19). Every externally visible step is
 * recorded in `jobs.result` first, so a re-executed or retried job never repeats it (JOB-09, NFR-03).
 */

/** Job input shapes stored as JSON in `jobs.input`. */
export interface JobInput {
	/** Continue the job's session (JOB-08, JOB-10, DSC-21 Retry). */
	resume?: boolean;
	/** A plan revision after "Request changes" (JOB-13). */
	revision?: { feedback: string };
	/** How many times this job's run was lost (RUN-04: requeued once, then failed). */
	lost?: number;
	items?: FeedbackItem[];
	failures?: CiFailure[];
	sha?: string;
}

/** What a plan job stores in `jobs.result`: the output (JOB-14) plus how far publishing got (JOB-09). */
export interface PlanJobResult extends PlanOutput {
	rev: number;
	comment?: { id: number; url: string };
	/** The "Plan ready for your approval" message was posted. */
	announced?: boolean;
}

export interface JobSuccess {
	result?: unknown;
}

/** The run ended because the issue was cancelled or closed (JOB-05, JOB-06); the scheduler records the job as cancelled. */
export class JobCancelled extends Error {
	override name = "JobCancelled";
}

/** The marker the plan comment starts with (JOB-15); the plan job skips it when reading comments. */
export const PLAN_COMMENT_MARKER = "<!-- agentbot:plan -->";

/** Progress message titles per job kind. */
const JOB_TITLES: Record<JobKind, string> = {
	plan: "Planning",
	implement: "Implementing",
	revise: "Addressing review feedback",
	fix_ci: "Fixing failing CI",
};

/**
 * Label and icon updates per issue, in transition order. Two transitions close together (a plan published and approved at
 * once) would otherwise interleave their GitHub calls and re-add a label the later transition removed (GH-09).
 */
const issueSyncs = new WeakMap<object, Map<number, Promise<void>>>();

/** Applies a state-machine event: persists the new state, syncs GitHub labels and the thread's top-message icon (ISS-06). */
export async function applyEvent(deps: EngineDeps, issue: IssueRow, event: IssueEvent, retryKind?: JobKind): Promise<IssueRow> {
	const next = transition(issue.state, event, retryKind);
	const updated = deps.db.setIssueState(issue.id, next);
	log("info", "issue transition", { repo: issue.repo, issue: issue.number, from: issue.state, to: next, event });
	const sync = async (): Promise<void> => {
		try {
			await syncLabels(deps.github, deps.labels, issue.repo, issue.number, issue.state, next);
		} catch (err) {
			log("warn", "label sync failed", { repo: issue.repo, issue: issue.number, error: errorMessage(err) });
		}
		if (issue.thread_id && ISSUE_ICONS[next] !== ISSUE_ICONS[issue.state]) await setTopIcon(deps.discord, issue.thread_id, ISSUE_ICONS[next]);
	};
	let syncs = issueSyncs.get(deps.db);
	if (!syncs) issueSyncs.set(deps.db, (syncs = new Map()));
	const done = (syncs.get(issue.id) ?? Promise.resolve()).then(sync);
	syncs.set(issue.id, done);
	await done;
	if (syncs.get(issue.id) === done) syncs.delete(issue.id);
	return updated;
}

/**
 * Terminal cleanup (WS-08): deletes the temporary refs the issue's runs keep, deletes its sessions when it is `done` or
 * `cancelled`, posts the final message and archives the thread. Never throws.
 */
export async function terminalCleanup(deps: EngineDeps, issue: IssueRow, message: string): Promise<void> {
	await deps.dispatcher.releaseIssue(issue.id);
	await removeIssueSessions(deps, issue.id);
	if (!issue.thread_id) return;
	try {
		await deps.discord.send(issue.thread_id, { content: message });
		await deps.discord.archiveThread(issue.thread_id);
	} catch (err) {
		log("warn", "thread cleanup failed", { repo: issue.repo, issue: issue.number, error: errorMessage(err) });
	}
}

/** ISS-05, DSC-21: records a failed job on its issue and posts `❌ <kind> failed: <error>` with a Retry button. Never throws. */
export async function handleJobFailure(deps: EngineDeps, job: JobRow, error: string): Promise<void> {
	try {
		let issue = deps.db.getIssue(job.issue_id);
		// A job racing a cancel or merge fails on its next step; the issue is already closed out.
		if (!issue || TERMINAL_STATES[issue.state]) return;
		if ((job.kind === "plan" || job.kind === "implement" || (job.kind === "revise" && !issue.pr_number)) && issue.state !== "failed") {
			issue = await applyEvent(deps, issue, "job_failed");
		}
		// Without this the poller re-detects the same feedback every cycle and re-runs the failing job; Retry carries the items.
		if (job.kind === "revise" && issue.pr_number) {
			for (const item of parseJson<JobInput>(job.input)?.items ?? []) deps.db.markSeen(issue.repo, issue.pr_number, item.id);
		}
		if (!issue.thread_id) return;
		await deps.discord.send(issue.thread_id, failureMessage({ jobId: job.id, kind: job.kind, error }));
	} catch (err) {
		log("warn", "failure post failed", { job: job.id, error: errorMessage(err) });
	}
}

interface RunContext {
	deps: EngineDeps;
	job: JobRow;
	issue: IssueRow;
	threadId: string;
	progress: Progress;
	signal: AbortSignal;
	onRegister(handle: RunHandle): void;
}

/** Stops a detached job before its next Discord or GitHub write (ENG-02). */
function assertAttached(ctx: RunContext): void {
	if (ctx.signal.aborted) throw new RunDetached();
}

/** JOB-06: a cancel or merge can land at any point of a job. */
function assertIssueLive(ctx: RunContext): void {
	const state = ctx.deps.db.getIssue(ctx.issue.id)?.state;
	if (!state || TERMINAL_STATES[state]) throw new JobCancelled("Issue was closed or cancelled");
}

function limitText(deps: EngineDeps, kind: JobKind, reason: "time" | "cost", minutes: number): string {
	if (reason === "cost") return `$${deps.config.limits.maxCostUsdPerJob} cost limit (limits.maxCostUsdPerJob)`;
	const setting = kind === "plan" ? "planMinutes" : kind === "fix_ci" ? "fixMinutes" : "implementMinutes";
	return `${minutes} minute time limit (limits.${setting})`;
}

/** The issue's repository checkout (RUN-17); runs that write code also get the issue branch and the leftover commit message (WS-03, JOB-19, JOB-22). */
function checkoutRequest(ctx: RunContext, kind?: JobKind): CheckoutRequest {
	const { deps, issue } = ctx;
	const checkout: CheckoutRequest = {
		repo: issue.repo,
		defaultBranch: async () => (await deps.github.repo(issue.repo)).defaultBranch,
		identity: { name: deps.github.identity.name, email: deps.github.identity.email },
		gitToken: () => deps.github.gitToken(issue.repo),
	};
	if (!kind || !writesCode(kind)) return checkout;
	const what = kind === "implement" ? "remaining changes" : "follow-up changes";
	return { ...checkout, issueBranch: issueBranch(ctx), leftoverMessage: `${deps.config.agent.name}: ${what} for #${issue.number}` };
}

/** Runs one agent session for a job with the Discord UI, live progress, transcripts, usage and the run handle wired up. */
async function runJobAgent(
	ctx: RunContext,
	opts: Pick<RunRequest, "profile" | "prompt" | "outputSchema" | "model" | "session" | "resume"> & {
		minutes: number;
		/** The run's kind when it differs from the job's: the CI fixes of an implement job are `fix_ci` runs (CI-07). */
		kind?: JobKind;
	},
): Promise<RunResult> {
	const { deps, job, issue, threadId, progress } = ctx;
	const { config } = deps;
	const kind = opts.kind ?? job.kind;
	assertIssueLive(ctx);
	assertAttached(ctx);
	// maxCostUsdPerJob bounds the whole job (JOB-07, JOB-04): each run gets what the job's earlier runs left, so CI fix
	// runs and a run re-executed after a restart or a lost worker share one budget.
	const budgetUsd = config.limits.maxCostUsdPerJob - deps.db.jobCostUsd(job.id);
	if (budgetUsd <= 0) throw new Error(`${kind} job exceeded the ${limitText(deps, kind, "cost", opts.minutes)}`);
	progress.phase("Starting the agent…");
	const startedAt = new Date().toISOString();
	const ui = createDiscordUI(deps.discord, threadId, {
		jobId: job.id,
		askTimeoutMs: config.limits.askTimeoutHours * 3_600_000,
		isAllowed: actor => memberAllowed(config, actor),
		replies: deps.replies,
		interactions: deps.interactions,
		mention: allowedMentions(config),
		onWaiting: on => progress.waiting(on),
	});
	const logRun = { run: job.id, kind, repo: issue.repo, issue: issue.number, thread: threadId };
	const result = await deps.dispatcher.runAgent(
		{
			owner: { kind: "job", jobId: job.id },
			kind,
			profile: opts.profile,
			prompt: runPrompt(config.agent.name, opts.prompt),
			outputSchema: opts.outputSchema,
			model: opts.model,
			thinking: config.models.thinking,
			limits: { minutes: opts.minutes, costUsd: budgetUsd },
			session: opts.session,
			resume: opts.resume,
			checkout: checkoutRequest(ctx, kind),
			threadId,
		},
		{
			ui,
			register: handle => ctx.onRegister(handle),
			onWaitingForWorker: () => progress.phase("Waiting for a worker…"),
			onProgress: p => progress.activity(activityText(p.tool, p.intent), p.usage.costUsd),
			onTodos: todos => progress.todos(todos),
			onTranscript: event => deps.agentLog.append(logRun, event),
			onLoadout: loadout => deps.db.kvSet(loadoutKey(loadout.profile), JSON.stringify(loadout)),
			onUsage: usage => deps.db.recordRun({ kind, repo: issue.repo, issueNumber: issue.number, jobId: job.id, threadId, startedAt, usage }),
		},
		ctx.signal,
	);
	if (result.aborted === "user") throw new JobCancelled("Cancelled by user");
	assertIssueLive(ctx);
	// RUN-20: a run stopped at a limit keeps its result and checkpoint for Retry; nothing is discarded here.
	if (result.aborted) throw new Error(`${kind} job exceeded the ${limitText(deps, kind, result.aborted, opts.minutes)}`);
	progress.phase("Agent finished; wrapping up…", result.usage.costUsd);
	return result;
}

/** The plan comment, or the issue itself when there is none. */
function planCommentUrl(issue: IssueRow): string {
	const url = `https://github.com/${issue.repo}/issues/${issue.number}`;
	return issue.plan_comment_id ? `${url}#issuecomment-${issue.plan_comment_id}` : url;
}

/** The latest published plan (JOB-13 revisions); throws when there is none. */
function latestPlan(deps: EngineDeps, issue: IssueRow): string {
	const plan = parseJson<PlanOutput>(deps.db.latestJob(issue.id, "plan")?.result ?? null);
	if (!plan) throw new Error(`No completed plan found for #${issue.number}`);
	return plan.planMarkdown;
}

/** Runs the planning agent and stores its output on the job (JOB-12 to JOB-14). */
async function producePlan(ctx: RunContext, input: JobInput): Promise<PlanJobResult> {
	const { deps } = ctx;
	const { repo, number } = ctx.issue;
	ctx.progress.phase("Reading the issue…");
	const ghIssue = await deps.github.getIssue(repo, number);
	const comments = (await deps.github.listIssueComments(repo, number))
		.filter(c => !c.body?.startsWith(PLAN_COMMENT_MARKER))
		.map(c => ({ author: c.user?.login ?? "unknown", body: c.body ?? "" }));

	const session = ctx.issue.plan_session ?? issuePlanSessionKey(ctx.issue.id);
	const hasSession = ctx.issue.plan_session !== null;
	const note = restartNote(deps.config.agent.name);
	let prompt: string;
	let resume: boolean;
	if (input.revision) {
		const revision = planPrompt(ghIssue, comments, { feedback: input.revision.feedback, previousPlan: latestPlan(deps, ctx.issue) });
		prompt = input.resume && hasSession ? `${note}\n\n${revision}` : revision;
		resume = hasSession;
	} else if (input.resume && hasSession) {
		prompt = note;
		resume = true;
	} else {
		prompt = planPrompt(ghIssue, comments);
		resume = false;
	}

	const run = await runJobAgent(ctx, {
		profile: "plan",
		prompt,
		outputSchema: PLAN_SCHEMA,
		model: deps.config.models.plan,
		session,
		resume,
		minutes: deps.config.limits.planMinutes,
	});
	const output = run.output as PlanOutput;
	const stored: PlanJobResult = {
		summary: output.summary,
		planMarkdown: output.planMarkdown,
		complexity: output.complexity,
		rev: ctx.issue.plan_rev + 1,
	};
	// JOB-14: stored before publishing, so a restart inside the publish window finishes without re-planning (JOB-09).
	deps.db.setJobResult(ctx.job.id, stored);
	ctx.issue = deps.db.updateIssue(ctx.issue.id, { plan_rev: stored.rev, ...(run.hasSession ? { plan_session: session } : {}) });
	return stored;
}

/**
 * The plan job (JOB-12 to JOB-16). Publishing is resumable (JOB-09): each externally visible step is recorded in the
 * job's result, and a re-executed or resumed job skips what is already done and only completes the state update.
 */
async function planJob(ctx: RunContext, input: JobInput): Promise<JobSuccess> {
	const { deps } = ctx;
	let stored = parseJson<PlanJobResult>(ctx.job.result);
	// JOB-12: transition first so any failure below lands in `failed` (with Retry) rather than stranding `queued`.
	if (ctx.issue.state === "queued") ctx.issue = await applyEvent(deps, ctx.issue, "plan_started");
	if (stored) log("info", "plan output already stored; finishing publication", { repo: ctx.issue.repo, issue: ctx.issue.number, job: ctx.job.id });
	else stored = await producePlan(ctx, input);
	const { repo, number } = ctx.issue;
	const rev = stored.rev;
	if (ctx.issue.plan_rev !== rev) ctx.issue = deps.db.updateIssue(ctx.issue.id, { plan_rev: rev });

	if (!stored.comment) {
		assertIssueLive(ctx);
		assertAttached(ctx);
		ctx.progress.phase("Posting the plan on GitHub…");
		const body = `${PLAN_COMMENT_MARKER}\n## ${deps.config.agent.name} plan (rev ${rev})\n${stored.summary}\n\n${stored.planMarkdown}`;
		const comment = ctx.issue.plan_comment_id
			? await deps.github.updateComment(repo, ctx.issue.plan_comment_id, body)
			: await deps.github.commentIssue(repo, number, body);
		ctx.issue = deps.db.updateIssue(ctx.issue.id, { plan_comment_id: comment.id });
		stored = { ...stored, comment: { id: comment.id, url: comment.url } };
		deps.db.setJobResult(ctx.job.id, stored);
	}

	if (!stored.announced) {
		assertIssueLive(ctx);
		assertAttached(ctx);
		await deps.discord.send(
			ctx.threadId,
			planMessage({
				issueId: ctx.issue.id,
				rev,
				summary: stored.summary,
				complexity: stored.complexity,
				commentUrl: stored.comment?.url ?? planCommentUrl(ctx.issue),
				planMarkdown: stored.planMarkdown,
				mention: allowedMentions(deps.config),
			}),
		);
		stored = { ...stored, announced: true };
		deps.db.setJobResult(ctx.job.id, stored);
	}

	assertIssueLive(ctx);
	assertAttached(ctx);
	const current = deps.db.getIssue(ctx.issue.id) ?? ctx.issue;
	if (current.state === "planning") ctx.issue = await applyEvent(deps, current, "plan_ready");
	return { result: stored };
}

/** WS-03: the issue branch `agentbot/issue-<n>-<slug>`, the slug taken from the title and at most 40 characters. */
export function branchName(issueNumber: number, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug ? `agentbot/issue-${issueNumber}-${slug}` : `agentbot/issue-${issueNumber}`;
}

/** The issue's branch; implement jobs record it on their first run (`runJob`), follow-ups need it. */
function issueBranch(ctx: RunContext): string {
	if (!ctx.issue.branch) throw new Error(`Issue #${ctx.issue.number} has no branch yet`);
	return ctx.issue.branch;
}

/** RUN-19, JOB-19: the push was refused because someone else pushed to the branch while the run was going. */
export const BRANCH_MOVED_ERROR = "The branch changed on GitHub during this run; press Retry to start again from the new head.";

/** JOB-19: an implement run whose branch had no new commits. */
export const NO_COMMITS_ERROR = "Agent produced no commits";

/**
 * Pushes a finished run's kept result to the issue branch (RUN-19). `pushed` records the push before the result is
 * discarded, so a re-executed job never pushes twice (JOB-09). A branch that moved on GitHub discards the result and
 * fails with `BRANCH_MOVED_ERROR` after `moved`.
 */
async function pushRun(ctx: RunContext, runId: string, record: { pushed(sha: string): void; moved(): void }): Promise<void> {
	const { deps, issue } = ctx;
	assertIssueLive(ctx);
	assertAttached(ctx);
	const branch = issueBranch(ctx);
	ctx.progress.phase(`Pushing \`${branch}\`…`);
	const outcome = await deps.dispatcher.pushResult(runId, branch, await deps.github.gitToken(issue.repo));
	if (!outcome.pushed) {
		record.moved();
		await deps.dispatcher.discardResult(runId);
		log("warn", "push refused: the branch moved", { repo: issue.repo, issue: issue.number, job: ctx.job.id, branch });
		throw new Error(BRANCH_MOVED_ERROR);
	}
	record.pushed(outcome.sha);
	await deps.dispatcher.discardResult(runId);
	log("info", "branch pushed", { repo: issue.repo, issue: issue.number, job: ctx.job.id, branch, sha: outcome.sha });
}

/** A run of the implement session that follows up on the branch (revise, fix_ci, CI fixes before the PR; JOB-21). */
async function followUpRun(ctx: RunContext, kind: "revise" | "fix_ci", prompt: string): Promise<RunResult> {
	const { deps } = ctx;
	const session = issueImplSessionKey(ctx.issue.id);
	const run = await runJobAgent(ctx, {
		kind,
		profile: "implement",
		prompt,
		outputSchema: REVISE_SCHEMA,
		model: deps.config.models.implement,
		session,
		resume: ctx.issue.impl_session !== null,
		minutes: kind === "fix_ci" ? deps.config.limits.fixMinutes : deps.config.limits.implementMinutes,
	});
	if (run.hasSession) ctx.issue = deps.db.updateIssue(ctx.issue.id, { impl_session: session });
	return run;
}

/** What a run that writes code yielded and how far its publication got. */
interface ImplementRun {
	output: ImplementOutput;
	oomKills: number;
}

/**
 * What an implement job stores in `jobs.result` while it publishes (JOB-09, CI-08); it survives restarts and, through the
 * failed job, Retry:
 * - `push`: the run finished with commits kept by the dispatcher under `runId`, not pushed yet;
 * - `pushed`: the branch is on GitHub; next is the CI decision;
 * - `ci`: waiting for CI on the branch before the PR (CI-02 to CI-08).
 */
export type ImplementCheckpoint = (ImplementRun & { stage: "push"; runId: string }) | (ImplementRun & { stage: "pushed" }) | CiCheckpoint;

export interface CiCheckpoint extends ImplementRun {
	stage: "ci";
	/** Commit the wait follows; moves when the system or a human pushes again. */
	sha: string;
	shaSeenAt: string;
	waitStartedAt: string;
	/** CI fixes pushed before the PR. */
	fixes: number;
	/** Failures being fixed; present means the next step is the fix, not the wait. */
	fixing?: CiFailure[];
	/** The fix run finished with commits (kept under `runId`); `pushed` once they are on the branch. */
	fixRun?: { runId: string; summary: string; oomKills: number; pushed?: boolean };
	/** Set by Retry: one more fix attempt is allowed even though `maxCiFixAttempts` is used up (CI-08). */
	retryGrant?: boolean;
}

const IMPLEMENT_STAGES: Record<string, boolean> = { push: true, pushed: true, ci: true };

function parseCheckpoint(raw: string | null): ImplementCheckpoint | undefined {
	const parsed = parseJson<ImplementCheckpoint>(raw);
	return parsed && IMPLEMENT_STAGES[parsed.stage] ? parsed : undefined;
}

/**
 * This job's checkpoint (a re-executed job), or on Retry the failed implement job's: a push still to make, a pushed
 * branch, or a CI wait, which Retry resumes with fresh time bounds and one extra fix attempt (CI-08).
 */
function loadCheckpoint(ctx: RunContext, input: JobInput): ImplementCheckpoint | undefined {
	const own = parseCheckpoint(ctx.job.result);
	if (own) return own;
	if (!input.resume) return undefined;
	const failed = ctx.deps.db.latestJob(ctx.issue.id, "implement", "failed");
	const prior = failed && failed.id !== ctx.job.id ? parseCheckpoint(failed.result) : undefined;
	if (!prior) return undefined;
	const now = new Date().toISOString();
	const carried: ImplementCheckpoint = prior.stage === "ci" ? { ...prior, shaSeenAt: now, waitStartedAt: now, retryGrant: true } : prior;
	ctx.deps.db.setJobResult(ctx.job.id, carried);
	return carried;
}

/** The implement job (JOB-18 to JOB-20, CI-01 to CI-09, PR-01 to PR-03). */
async function implementJob(ctx: RunContext, input: JobInput): Promise<JobSuccess> {
	const { deps } = ctx;
	// JOB-09: the PR exists (PR-02 records it first); only the state update may be missing.
	if (ctx.issue.pr_number) {
		if (ctx.issue.state === "implementing") ctx.issue = await applyEvent(deps, ctx.issue, "pr_opened");
		return {};
	}
	let cp = loadCheckpoint(ctx, input);
	if (cp) log("info", "implement checkpoint found; continuing", { repo: ctx.issue.repo, issue: ctx.issue.number, job: ctx.job.id, stage: cp.stage });
	else cp = await implementRun(ctx, input);
	if (cp.stage === "push") {
		const run = cp;
		const pushed: ImplementCheckpoint = { stage: "pushed", output: run.output, oomKills: run.oomKills };
		await pushRun(ctx, run.runId, {
			pushed: () => deps.db.setJobResult(ctx.job.id, pushed),
			// Nothing left to continue: Retry starts a new run from the branch's new head (RUN-17).
			moved: () => deps.db.setJobResult(ctx.job.id, null),
		});
		cp = pushed;
	}
	if (cp.stage === "pushed") return publishImplementation(ctx, cp);
	return awaitCiAndOpenPull(ctx, cp);
}

/** JOB-18, JOB-19: runs the implement agent on the approved plan; checkpoints its kept commits for the push. */
async function implementRun(ctx: RunContext, input: JobInput): Promise<ImplementCheckpoint> {
	const { deps } = ctx;
	const agent = deps.config.agent.name;
	ctx.progress.phase("Reading the issue…");
	const ghIssue = await deps.github.getIssue(ctx.issue.repo, ctx.issue.number);
	const fresh = implementPrompt(agent, ghIssue, latestPlan(deps, ctx.issue));
	const session = issueImplSessionKey(ctx.issue.id);
	// JOB-10, DSC-21: a resumed job continues its session; without one it starts over with the restart note. A lost run
	// uploaded its session while it ran (RUN-18) but never got to record `impl_session`, so the file itself counts too.
	const hasSession = ctx.issue.impl_session !== null || existsSync(sessionPath(deps.sessionDir, session));
	const resume = input.resume === true && hasSession;
	const note = restartNote(agent);
	const run = await runJobAgent(ctx, {
		profile: "implement",
		prompt: resume ? note : input.resume ? `${note}\n\n${fresh}` : fresh,
		outputSchema: IMPLEMENT_SCHEMA,
		model: deps.config.models.implement,
		session,
		// Also without a session: a requeued or retried run continues the issue's kept checkpoint or result (RUN-17).
		resume: input.resume === true,
		minutes: deps.config.limits.implementMinutes,
	});
	if (run.hasSession) ctx.issue = deps.db.updateIssue(ctx.issue.id, { impl_session: session });
	if (!run.code || run.code.commits === 0) throw new Error(NO_COMMITS_ERROR);
	const cp: ImplementCheckpoint = { stage: "push", output: run.output as ImplementOutput, oomKills: run.oomKills, runId: run.code.runId };
	deps.db.setJobResult(ctx.job.id, cp);
	return cp;
}

/** After the push: verify the branch, then open the PR at once (no push CI, CI-01) or wait for CI first. */
async function publishImplementation(ctx: RunContext, run: ImplementRun): Promise<JobSuccess> {
	const { deps } = ctx;
	const { repo } = ctx.issue;
	const branch = issueBranch(ctx);
	assertIssueLive(ctx);
	assertAttached(ctx);
	const sha = await deps.github.getBranchSha(repo, branch);
	if (!sha) throw new Error(`Branch ${branch} not found on GitHub after the push`);
	const workflows = pushCiWorkflows(await deps.github.listActiveWorkflows(repo, sha), branch);
	if (workflows.length === 0) return openPull(ctx, run);
	const now = new Date().toISOString();
	const cp: CiCheckpoint = { stage: "ci", output: run.output, oomKills: run.oomKills, sha, shaSeenAt: now, waitStartedAt: now, fixes: 0 };
	// From here a restart goes straight back to the CI wait: no agent run, no second push (CI-08).
	deps.db.setJobResult(ctx.job.id, cp);
	return awaitCiAndOpenPull(ctx, cp);
}

/**
 * One CI wait round on the branch (CI-02 to CI-06). CI-09: registers a handle so `/work cancel` stops the wait and a
 * thread message learns that no agent is running; an engine stop detaches (the next engine resumes the wait).
 */
async function waitRound(ctx: RunContext, cp: CiCheckpoint): Promise<CiGateResult> {
	const { deps, progress } = ctx;
	const { config, db } = deps;
	const branch = issueBranch(ctx);
	const cancel = new AbortController();
	ctx.onRegister({
		steer: async () => {
			await deps.discord.send(ctx.threadId, {
				content: `No agent is running — ${config.agent.name} is waiting for CI on \`${branch}\`; use /work cancel to stop.`,
			});
			return "ended";
		},
		abort: async () => cancel.abort(new JobCancelled("Cancelled by user")),
	});
	progress.phase(
		`Waiting for CI on \`${branch}\` (${cp.sha.slice(0, 7)}) — the pull request opens when it passes (up to ${config.limits.ciWaitMinutes} min)…`,
	);
	try {
		return await waitForBranchCi({
			github: deps.github,
			repo: ctx.issue.repo,
			branch,
			sha: cp.sha,
			shaSeenAt: Date.parse(cp.shaSeenAt),
			waitStartedAt: Date.parse(cp.waitStartedAt),
			limitMs: config.limits.ciWaitMinutes * 60_000,
			graceMs: CI_START_GRACE_MS,
			pollMs: config.github.pollIntervalSeconds * 1000,
			signal: AbortSignal.any([cancel.signal, ctx.signal]),
			onSha: (sha, at) => {
				cp.sha = sha;
				cp.shaSeenAt = new Date(at).toISOString();
				db.setJobResult(ctx.job.id, cp);
			},
			assertLive: () => assertIssueLive(ctx),
		});
	} catch (err) {
		if (ctx.signal.aborted && !cancel.signal.aborted) throw new RunDetached();
		throw err;
	}
}

/** The `### CI` note of a PR opened after the wait (CI-05, CI-06). */
function ciNote(ctx: RunContext, result: Exclude<CiGateResult, { kind: "failed" }>, fixes: number): string {
	const { config } = ctx.deps;
	const short = result.sha.slice(0, 7);
	switch (result.kind) {
		case "passed": {
			const after = fixes > 0 ? ` (after ${fixes} ${config.agent.name} CI fix${fixes === 1 ? "" : "es"})` : "";
			return `✅ CI passed on \`${issueBranch(ctx)}\` at ${short} before this PR was opened${after}.`;
		}
		case "no_run":
			return `⚠️ No CI run started for ${short} within ${CI_START_GRACE_MS / 60_000} minutes of the push; this PR was opened without a CI result.`;
		case "timeout":
			return `⚠️ CI had not finished after ${config.limits.ciWaitMinutes} minutes; ${config.agent.name} keeps watching it on this PR.`;
	}
}

/** Waits for CI, runs fix attempts on failure (CI-07), then opens the PR once CI passed, never started, or ran out of time. */
async function awaitCiAndOpenPull(ctx: RunContext, cp: CiCheckpoint): Promise<JobSuccess> {
	const { deps } = ctx;
	const { limits } = deps.config;
	const branch = issueBranch(ctx);
	const save = () => deps.db.setJobResult(ctx.job.id, cp);
	for (;;) {
		let restart = false;
		let failures: CiFailure[];
		if (cp.fixing) {
			restart = true;
			failures = cp.fixing;
		} else {
			const result = await waitRound(ctx, cp);
			cp.sha = result.sha;
			if (result.kind !== "failed") return openPull(ctx, cp, ciNote(ctx, result, cp.fixes));
			const checks = result.failures.map(f => f.name).join(", ");
			if (ctx.issue.ci_attempts >= limits.maxCiFixAttempts && !cp.retryGrant) {
				save();
				throw new Error(
					`CI is still failing on ${branch} (${checks}) after ${ctx.issue.ci_attempts} fix attempts — needs a human. Fix the branch and press Retry, or use /work cancel.`,
				);
			}
			// The same counter as the post-PR `fix_ci` jobs, so both share `maxCiFixAttempts` (CI-07).
			ctx.issue = deps.db.updateIssue(ctx.issue.id, { ci_attempts: ctx.issue.ci_attempts + 1, ci_last_sha: result.sha });
			cp.retryGrant = false;
			failures = result.failures;
			cp.fixing = failures;
			save();
		}
		await fixBeforePull(ctx, cp, failures, restart, save);
		const now = new Date().toISOString();
		cp.fixes += 1;
		cp.fixing = undefined;
		cp.fixRun = undefined;
		cp.sha = (await deps.github.getBranchSha(ctx.issue.repo, branch)) ?? cp.sha;
		cp.shaSeenAt = now;
		cp.waitStartedAt = now;
		save();
	}
}

/** CI-07: one fix run on the failing checks, then its push. A fix already on the branch (CI-08) needs no new run. */
async function fixBeforePull(ctx: RunContext, cp: CiCheckpoint, failures: CiFailure[], restart: boolean, save: () => void): Promise<void> {
	const { deps } = ctx;
	const { config } = deps;
	const branch = issueBranch(ctx);
	if (!cp.fixRun) {
		// Pushed just before a restart, or by a human before Retry: the head moved past the failing commit.
		const head = await deps.github.getBranchSha(ctx.issue.repo, branch);
		if (restart && head && head !== cp.sha) return;
		const prompt = fixCiPrompt(config.agent.name, failures, { beforePr: true });
		const run = await followUpRun(ctx, "fix_ci", restart ? `${restartNote(config.agent.name)}\n\n${prompt}` : prompt);
		const { summary } = run.output as ReviseOutput;
		cp.oomKills += run.oomKills;
		if (!run.code || run.code.commits === 0) {
			save();
			throw new Error(`${config.agent.name} could not find a fix for ${failures.map(f => f.name).join(", ")}: ${summary}`);
		}
		cp.fixRun = { runId: run.code.runId, summary, oomKills: run.oomKills };
		save();
	}
	const fix = cp.fixRun;
	if (!fix.pushed) {
		await pushRun(ctx, fix.runId, {
			pushed: () => {
				fix.pushed = true;
				save();
			},
			moved: () => {
				cp.fixRun = undefined;
				save();
			},
		});
	}
	assertIssueLive(ctx);
	assertAttached(ctx);
	await deps.discord.send(ctx.threadId, {
		content: ciFixBeforePrMessage({
			agentName: config.agent.name,
			branch,
			attempt: ctx.issue.ci_attempts,
			maxAttempts: config.limits.maxCiFixAttempts,
			summary: fix.summary,
			oomKills: fix.oomKills,
		}),
	});
}

/** PR-01 to PR-03: opens the pull request, records it before `pr_opened`, posts "Implementation complete". */
async function openPull(ctx: RunContext, run: ImplementRun, ci?: string): Promise<JobSuccess> {
	const { deps } = ctx;
	const { config } = deps;
	const { output, oomKills } = run;
	assertIssueLive(ctx);
	assertAttached(ctx);
	ctx.progress.phase("Opening the pull request…");
	const { baseBranch } = await deps.dispatcher.repoConfig(checkoutRequest(ctx));
	const warning = oomKills > 0 ? `${oomWarning(oomKills, config.agent.name)}\n\n` : "";
	const ciSection = ci ? `### CI\n${ci}\n\n` : "";
	const pr = await deps.github.createPull(ctx.issue.repo, {
		head: issueBranch(ctx),
		base: baseBranch,
		title: output.prTitle,
		body: `${output.prBody}\n\n${warning}### Testing\n${output.testing}\n\n${ciSection}Closes #${ctx.issue.number}\n\n_Plan: ${planCommentUrl(ctx.issue)}_`,
	});
	// PR-02: recorded before anything else, so a resumed job only completes the state update (JOB-09).
	ctx.issue = deps.db.updateIssue(ctx.issue.id, { pr_number: pr.number });
	log("info", "pull request opened", { repo: ctx.issue.repo, issue: ctx.issue.number, pr: pr.number });
	const done = implementDoneMessage({
		agentName: config.agent.name,
		prNumber: pr.number,
		prUrl: pr.url,
		prTitle: output.prTitle,
		prBody: output.prBody,
		testing: output.testing,
		mentionKeyword: config.github.mentionKeyword,
		oomKills,
		ci,
	});
	for (const chunk of chunkText(done)) await deps.discord.send(ctx.threadId, { content: chunk });
	assertIssueLive(ctx);
	const current = deps.db.getIssue(ctx.issue.id) ?? ctx.issue;
	if (current.state === "implementing") ctx.issue = await applyEvent(deps, current, "pr_opened");
	return { result: oomKills > 0 ? { ...output, oomKills } : output };
}

/** What a revise or fix_ci job stores in `jobs.result` as it goes, so a re-executed job repeats nothing (JOB-09). */
export interface FollowUpCheckpoint {
	stage: "followup";
	/** fix_ci: `ci_attempts` was incremented (JOB-23). */
	counted?: boolean;
	/** The run finished. */
	run?: { summary: string; oomKills: number; pushed: boolean };
	/** Commits kept by the dispatcher, not pushed yet. */
	pending?: string;
	commented?: boolean;
	announced?: boolean;
}

function loadFollowUp(ctx: RunContext): { cp: FollowUpCheckpoint; save(): void } {
	const stored = parseJson<FollowUpCheckpoint>(ctx.job.result);
	const cp: FollowUpCheckpoint = stored?.stage === "followup" ? stored : { stage: "followup" };
	return { cp, save: () => ctx.deps.db.setJobResult(ctx.job.id, cp) };
}

function requirePull(ctx: RunContext): number {
	if (!ctx.issue.pr_number) throw new Error(`Issue #${ctx.issue.number} has no pull request`);
	return ctx.issue.pr_number;
}

/** JOB-21, JOB-22: resumes the implement session on the branch's head and pushes new commits, if any. */
async function followUp(
	ctx: RunContext,
	state: { cp: FollowUpCheckpoint; save(): void },
	kind: "revise" | "fix_ci",
	prompt: string,
	input: JobInput,
): Promise<NonNullable<FollowUpCheckpoint["run"]>> {
	const { cp, save } = state;
	if (!cp.run) {
		const run = await followUpRun(ctx, kind, input.resume ? `${restartNote(ctx.deps.config.agent.name)}\n\n${prompt}` : prompt);
		const commits = run.code?.commits ?? 0;
		cp.run = { summary: (run.output as ReviseOutput).summary, oomKills: run.oomKills, pushed: commits > 0 };
		if (run.code && commits > 0) cp.pending = run.code.runId;
		save();
	}
	const pending = cp.pending;
	if (pending) {
		await pushRun(ctx, pending, {
			pushed: () => {
				cp.pending = undefined;
				save();
			},
			moved: () => {},
		});
	}
	return cp.run;
}

function followUpResult(run: NonNullable<FollowUpCheckpoint["run"]>): ReviseOutput & { oomKills?: number } {
	return run.oomKills > 0 ? { summary: run.summary, oomKills: run.oomKills } : { summary: run.summary };
}

/** JOB-21, JOB-22: addresses review feedback on the PR. */
async function reviseJob(ctx: RunContext, input: JobInput): Promise<JobSuccess> {
	const { deps } = ctx;
	const agent = deps.config.agent.name;
	const pr = requirePull(ctx);
	const items = input.items ?? [];
	const state = loadFollowUp(ctx);
	const { cp, save } = state;
	const run = await followUp(ctx, state, "revise", revisePrompt(agent, items), input);
	if (!cp.commented) {
		assertIssueLive(ctx);
		assertAttached(ctx);
		const warning = run.oomKills > 0 ? `\n\n${oomWarning(run.oomKills, agent)}` : "";
		await deps.github.commentIssue(ctx.issue.repo, pr, `${agent} addressed feedback:\n${run.summary}${warning}`);
		cp.commented = true;
		save();
	}
	if (!cp.announced) {
		assertAttached(ctx);
		await deps.discord.send(ctx.threadId, {
			content: followUpMessage({ agentName: agent, kind: "revise", prNumber: pr, pushed: run.pushed, summary: run.summary, oomKills: run.oomKills }),
		});
		cp.announced = true;
		save();
	}
	for (const item of items) deps.db.markSeen(ctx.issue.repo, pr, item.id);
	return { result: followUpResult(run) };
}

/** JOB-21 to JOB-23: fixes failing CI on the PR. */
async function fixCiJob(ctx: RunContext, input: JobInput): Promise<JobSuccess> {
	const { deps } = ctx;
	const agent = deps.config.agent.name;
	const pr = requirePull(ctx);
	const failures = input.failures ?? [];
	const state = loadFollowUp(ctx);
	const { cp, save } = state;
	if (!input.resume && !cp.counted) {
		ctx.issue = deps.db.updateIssue(ctx.issue.id, { ci_attempts: ctx.issue.ci_attempts + 1, ci_last_sha: input.sha ?? ctx.issue.ci_last_sha });
		cp.counted = true;
		save();
	}
	const run = await followUp(ctx, state, "fix_ci", fixCiPrompt(agent, failures), input);
	const checks = failures.map(f => f.name).join(", ");
	if (!run.pushed && !cp.commented) {
		assertIssueLive(ctx);
		assertAttached(ctx);
		const warning = run.oomKills > 0 ? `\n\n${oomWarning(run.oomKills, agent)}` : "";
		await deps.github.commentIssue(ctx.issue.repo, pr, `${agent} could not find a fix for ${checks}\n\n${run.summary}${warning}`);
		cp.commented = true;
		save();
	}
	if (!cp.announced) {
		assertAttached(ctx);
		await deps.discord.send(ctx.threadId, {
			content: followUpMessage({
				agentName: agent,
				kind: "fix_ci",
				prNumber: pr,
				pushed: run.pushed,
				attempt: ctx.issue.ci_attempts,
				maxAttempts: deps.config.limits.maxCiFixAttempts,
				summary: run.summary,
				...(run.pushed ? {} : { checks }),
				oomKills: run.oomKills,
			}),
		});
		cp.announced = true;
		save();
	}
	return { result: followUpResult(run) };
}

const HANDLERS: Record<JobKind, (ctx: RunContext, input: JobInput) => Promise<JobSuccess>> = {
	plan: planJob,
	implement: implementJob,
	revise: reviseJob,
	fix_ci: fixCiJob,
};

export interface RunJobOptions {
	/** The run can take steering and abort (relayed `registered`, also after re-attach). */
	onRegister?(handle: RunHandle): void;
}

/**
 * Executes a claimed job. Resolves with its result; throws `JobCancelled` when its issue was cancelled or closed,
 * `RunDetached` when `signal` aborted (the job stays `running` for the next engine to re-execute, JOB-08), `RunLost`
 * when its worker was lost, and any other error on failure.
 */
export async function runJob(deps: EngineDeps, job: JobRow, signal: AbortSignal, opts: RunJobOptions = {}): Promise<JobSuccess> {
	let issue = deps.db.getIssue(job.issue_id);
	if (!issue || TERMINAL_STATES[issue.state]) throw new JobCancelled(issue ? "Issue was closed or cancelled" : `Issue ${job.issue_id} not found`);
	const threadId = issue.thread_id;
	if (!threadId) throw new Error(`Issue #${issue.number} has no Discord thread`);
	if (signal.aborted) throw new RunDetached();
	// WS-03: the first implement job names the branch (an issue from `/work plan` Execute arrives without one).
	if (job.kind === "implement" && !issue.branch) issue = deps.db.updateIssue(issue.id, { branch: branchName(issue.number, issue.title) });
	// RUN-14: a job re-executed after a restart keeps editing its status and to-do messages.
	const owner: RunOwner = { kind: "job", jobId: job.id };
	const runUi = createRunUiStore(deps.db);
	// JOB-09: a re-executed plan job whose plan is already out only completes (no progress message, nothing republished).
	const published = job.kind === "plan" ? parseJson<PlanJobResult>(job.result) : null;
	if (published?.announced && issue.state === "awaiting_approval") {
		runUi.clear(owner);
		return { result: published };
	}
	const ctx: RunContext = {
		deps,
		job,
		issue,
		threadId,
		progress: await startProgress(deps.discord, threadId, `${JOB_TITLES[job.kind]} #${issue.number}`, "Starting…", {
			restore: runUi.get(owner),
			persist: state => runUi.set(owner, state),
		}),
		signal,
		onRegister: handle => opts.onRegister?.(handle),
	};
	log("info", "job started", { repo: issue.repo, issue: issue.number, job: job.id, kind: job.kind });
	try {
		const success = await HANDLERS[job.kind](ctx, parseJson<JobInput>(job.input) ?? {});
		await ctx.progress.finish("done");
		runUi.clear(owner);
		return success;
	} catch (err) {
		// Detached: stop updating and leave Discord as it is; the next engine re-attaches and reports from there.
		if (err instanceof RunDetached || signal.aborted) {
			ctx.progress.stop();
			throw err instanceof RunDetached ? err : new RunDetached();
		}
		// The scheduler posts the failure (with Retry) or the cancellation below this message.
		await ctx.progress.finish(err instanceof JobCancelled ? "cancelled" : "failed");
		runUi.clear(owner);
		throw err;
	}
}
