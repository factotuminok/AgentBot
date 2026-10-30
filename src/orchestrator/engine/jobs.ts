import { errorMessage, log } from "../../shared/log";
import { allowedMentions, memberAllowed } from "../discord/access";
import { type Progress, startProgress } from "../discord/progress";
import { createDiscordUI } from "../discord/questions";
import { activityText, failureMessage, planMessage } from "../discord/render";
import { ISSUE_ICONS, setTopIcon } from "../discord/topMessage";
import { RunDetached, type RunHandle, type RunOwner, type RunRequest, type RunResult } from "../dispatch/dispatcher";
import type { CiFailure, FeedbackItem } from "../github/feedback";
import { syncLabels } from "../github/labels";
import { type IssueRow, type JobRow, parseJson } from "../store/db";
import { createRunUiStore } from "../store/runUi";
import { issuePlanSessionKey, removeIssueSessions } from "../store/sessions";
import { loadoutKey } from "../store/stats";
import type { EngineDeps } from "./deps";
import { PLAN_SCHEMA, type PlanOutput, planPrompt, restartNote, runPrompt } from "./prompts";
import { type IssueEvent, type JobKind, TERMINAL_STATES, transition } from "./state";

/**
 * Job execution and issue state handling (JOB-05 to JOB-17, ISS-05, ISS-06, WS-08 subset), ported from DevForge
 * `src/engine/jobs.ts` onto `EngineDeps`: Discord through the surface, agent runs through the dispatcher. Phase 2 runs
 * only the plan job; implement, revise and fix_ci need worker checkouts (phase 4/5) and fail saying so.
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
 * Terminal cleanup (WS-08, without the runs-repo refs that arrive with phase 4): deletes the issue's sessions when it is
 * `done` or `cancelled`, posts the final message and archives the thread. Never throws.
 */
export async function terminalCleanup(deps: EngineDeps, issue: IssueRow, message: string): Promise<void> {
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

/** Runs one agent session for a job with the Discord UI, live progress, transcripts, usage and the run handle wired up. */
async function runJobAgent(
	ctx: RunContext,
	opts: Pick<RunRequest, "profile" | "prompt" | "outputSchema" | "model" | "session" | "resume"> & { minutes: number },
): Promise<RunResult> {
	const { deps, job, issue, threadId, progress } = ctx;
	const { config } = deps;
	assertIssueLive(ctx);
	assertAttached(ctx);
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
	const logRun = { run: job.id, kind: job.kind, repo: issue.repo, issue: issue.number, thread: threadId };
	const result = await deps.dispatcher.runAgent(
		{
			owner: { kind: "job", jobId: job.id },
			kind: job.kind,
			profile: opts.profile,
			prompt: runPrompt(config.agent.name, opts.prompt),
			outputSchema: opts.outputSchema,
			model: opts.model,
			thinking: config.models.thinking,
			limits: { minutes: opts.minutes, costUsd: config.limits.maxCostUsdPerJob },
			session: opts.session,
			resume: opts.resume,
			repo: issue.repo,
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
			onUsage: usage =>
				deps.db.recordRun({ kind: job.kind, repo: issue.repo, issueNumber: issue.number, jobId: job.id, threadId, startedAt, usage }),
		},
		ctx.signal,
	);
	if (result.aborted === "user") throw new JobCancelled("Cancelled by user");
	assertIssueLive(ctx);
	if (result.aborted) throw new Error(`${job.kind} job exceeded the ${limitText(deps, job.kind, result.aborted, opts.minutes)}`);
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
	const issue = deps.db.getIssue(job.issue_id);
	if (!issue || TERMINAL_STATES[issue.state]) throw new JobCancelled(issue ? "Issue was closed or cancelled" : `Issue ${job.issue_id} not found`);
	if (!issue.thread_id) throw new Error(`Issue #${issue.number} has no Discord thread`);
	// Implement, revise and fix_ci run on worker checkouts (phases 4 and 5).
	if (job.kind !== "plan") throw new Error(`${job.kind} runs need worker checkouts, which this build does not have yet`);
	if (signal.aborted) throw new RunDetached();
	// RUN-14: a job re-executed after a restart keeps editing its status and to-do messages.
	const owner: RunOwner = { kind: "job", jobId: job.id };
	const runUi = createRunUiStore(deps.db);
	// JOB-09: a re-executed plan job whose plan is already out only completes (no progress message, nothing republished).
	const published = parseJson<PlanJobResult>(job.result);
	if (published?.announced && issue.state === "awaiting_approval") {
		runUi.clear(owner);
		return { result: published };
	}
	const threadId = issue.thread_id;
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
		const success = await planJob(ctx, parseJson<JobInput>(job.input) ?? {});
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
