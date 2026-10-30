import type { IssueRow } from "../store/db";
import type { GhCheckRun, GhIssueComment, GhReview, GhReviewComment, GhUser, GhWorkflowRun } from "./types";

export interface FeedbackItem {
	/** `review:<id>` | `rc:<id>` | `ic:<id>` */
	id: string;
	kind: "review" | "inline" | "comment";
	author: string;
	body: string;
	path?: string;
	line?: number;
	diffHunk?: string;
}

export interface CiFailure {
	checkRunId: number;
	name: string;
	conclusion: string;
	summary: string | null;
	logTail?: string;
}

/** `failures` empty = no action; `exhausted` = new failing sha but attempts used up. */
export interface CheckEvaluation {
	failures: GhCheckRun[];
	exhausted: boolean;
}

const TRUSTED_ASSOCIATIONS: Record<string, boolean> = { OWNER: true, MEMBER: true, COLLABORATOR: true };

export const FAILING_CONCLUSIONS: Record<string, boolean> = { failure: true, timed_out: true };

/** Login of a trusted human author, or undefined when the author is a bot, unknown, or lacks write association. */
function trustedAuthor(user: GhUser | null, association: string, botLogin: string): string | undefined {
	if (!user || user.type === "Bot" || user.login === botLogin) return undefined;
	return TRUSTED_ASSOCIATIONS[association] ? user.login : undefined;
}

/** GH-16, GH-17: new review feedback that should trigger a `revise` job. */
export function detectFeedback(input: {
	reviews: GhReview[];
	reviewComments: GhReviewComment[];
	issueComments: GhIssueComment[];
	botLogin: string;
	seen: Set<string>;
	mentionKeyword: string;
}): FeedbackItem[] {
	const { botLogin, seen, mentionKeyword } = input;
	const items: FeedbackItem[] = [];

	for (const review of input.reviews) {
		const id = `review:${review.id}`;
		const author = trustedAuthor(review.user, review.author_association, botLogin);
		if (!author || seen.has(id)) continue;
		const body = review.body?.trim() ?? "";
		if (!body && review.state !== "CHANGES_REQUESTED") continue;
		items.push({ id, kind: "review", author, body });
	}

	for (const comment of input.reviewComments) {
		const id = `rc:${comment.id}`;
		const author = trustedAuthor(comment.user, comment.author_association, botLogin);
		if (!author || seen.has(id)) continue;
		const line = comment.line ?? comment.original_line ?? undefined;
		items.push({ id, kind: "inline", author, body: comment.body, path: comment.path, line, diffHunk: comment.diff_hunk });
	}

	for (const comment of input.issueComments) {
		const id = `ic:${comment.id}`;
		const author = trustedAuthor(comment.user, comment.author_association, botLogin);
		if (!author || seen.has(id)) continue;
		const body = comment.body ?? "";
		if (!body.includes(mentionKeyword)) continue;
		items.push({ id, kind: "comment", author, body });
	}

	return items;
}

export interface ChecksSummary {
	/** Every run is `completed`. */
	done: boolean;
	failures: GhCheckRun[];
	cancelled: GhCheckRun[];
}

/** Shared CI rule: `null` without runs; failing = `failure`/`timed_out`; `cancelled` is neither failure nor success. */
export function summarizeChecks(runs: GhCheckRun[]): ChecksSummary | null {
	if (runs.length === 0) return null;
	return {
		done: runs.every(run => run.status === "completed"),
		failures: runs.filter(run => run.conclusion !== null && FAILING_CONCLUSIONS[run.conclusion]),
		cancelled: runs.filter(run => run.conclusion === "cancelled"),
	};
}

export type BranchCiVerdict = "none" | "pending" | "failed" | "cancelled" | "passed";

/** Workflow-run conclusions that fail without ever producing a check run (e.g. a broken workflow file). */
export const FAILING_WORKFLOW_CONCLUSIONS: Record<string, boolean> = { ...FAILING_CONCLUSIONS, startup_failure: true };

/**
 * Drops what a newer run replaced. Per `(workflow_id, event)` only the workflow run with the highest `run_number`
 * counts (e.g. `concurrency: cancel-in-progress` cancels the first of two pushes; a re-run keeps its number and
 * only changes its conclusion). Check runs of a superseded workflow run are dropped, and among the rest the
 * newest (highest id) per `(check suite or app, name)` counts, which covers re-requested checks.
 */
export function currentCiRuns(
	checkRuns: GhCheckRun[],
	workflowRuns: GhWorkflowRun[],
): { checkRuns: GhCheckRun[]; workflowRuns: GhWorkflowRun[] } {
	const newestWorkflow = new Map<string, GhWorkflowRun>();
	for (const run of workflowRuns) {
		const key = `${run.workflow_id}\0${run.event}`;
		const best = newestWorkflow.get(key);
		if (!best || run.run_number > best.run_number) newestWorkflow.set(key, run);
	}
	const current = new Set(newestWorkflow.values());
	const currentWorkflows = workflowRuns.filter(run => current.has(run));
	const supersededSuites = new Set<number>();
	for (const run of workflowRuns) {
		if (run.check_suite_id != null && !current.has(run)) supersededSuites.add(run.check_suite_id);
	}

	const newestCheck = new Map<string, GhCheckRun>();
	for (const run of checkRuns) {
		if (run.check_suite && supersededSuites.has(run.check_suite.id)) continue;
		const key = `${run.check_suite?.id ?? run.app?.slug ?? ""}\0${run.name}`;
		const best = newestCheck.get(key);
		if (!best || run.id > best.id) newestCheck.set(key, run);
	}
	const currentChecks = new Set(newestCheck.values());
	return { checkRuns: checkRuns.filter(run => currentChecks.has(run)), workflowRuns: currentWorkflows };
}

/**
 * CI state of a pushed commit before any PR exists. Workflow runs are consulted too: a run held back by
 * `concurrency` has no check runs yet but is not finished. `skipped` and `neutral` count as passed. A cancelled or
 * failed run counts only if no newer run replaced it (see `currentCiRuns`).
 */
export function branchCiVerdict(allCheckRuns: GhCheckRun[], allWorkflowRuns: GhWorkflowRun[]): BranchCiVerdict {
	const { checkRuns, workflowRuns } = currentCiRuns(allCheckRuns, allWorkflowRuns);
	const checks = summarizeChecks(checkRuns);
	if (!checks && workflowRuns.length === 0) return "none";
	if (workflowRuns.some(run => run.status !== "completed") || (checks && !checks.done)) return "pending";
	const workflowFailed = workflowRuns.some(run => run.conclusion !== null && FAILING_WORKFLOW_CONCLUSIONS[run.conclusion]);
	if ((checks && checks.failures.length > 0) || (!checks && workflowFailed)) return "failed";
	if ((checks && checks.cancelled.length > 0) || workflowRuns.some(run => run.conclusion === "cancelled")) return "cancelled";
	return "passed";
}

/** GH-18 to GH-20: decide whether the PR head's check runs warrant a `fix_ci` job. */
export function evaluateChecks(
	runs: GhCheckRun[],
	headSha: string,
	issue: Pick<IssueRow, "ci_last_sha" | "ci_attempts">,
	maxCiFixAttempts: number,
): CheckEvaluation {
	const none: CheckEvaluation = { failures: [], exhausted: false };
	const summary = summarizeChecks(runs);
	if (!summary?.done) return none;
	const { failures } = summary;
	if (failures.length === 0 || headSha === issue.ci_last_sha) return none;
	if (issue.ci_attempts >= maxCiFixAttempts) return { failures: [], exhausted: true };
	return { failures, exhausted: false };
}
