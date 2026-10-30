import type { LabelNames } from "../../shared/config";

export type IssueState =
	| "queued"
	| "planning"
	| "awaiting_approval"
	| "implementing"
	| "in_review"
	| "done"
	| "failed"
	| "cancelled";

export type JobKind = "plan" | "implement" | "revise" | "fix_ci";

/** Every kind of agent run: issue jobs, `/work ask` and `/ask` chats, and `/work issue` drafts. */
export type RunKind = JobKind | "chat" | "draft";

export type IssueEvent =
	| "plan_started"
	| "plan_ready"
	| "approved"
	| "changes_requested"
	| "rejected"
	| "pr_opened"
	| "pr_merged"
	| "pr_closed"
	| "job_failed"
	| "retry"
	| "cancelled";

/** ISS-01: only `done` and `cancelled` are terminal. */
export const TERMINAL_STATES: Record<IssueState, boolean> = {
	queued: false,
	planning: false,
	awaiting_approval: false,
	implementing: false,
	in_review: false,
	done: true,
	failed: false,
	cancelled: true,
};

/** ISS-06: leading icon of the thread's top message. */
export const STATE_ICONS: Record<IssueState, string> = {
	queued: "📥",
	planning: "🛠️",
	awaiting_approval: "📋",
	implementing: "🛠️",
	in_review: "👀",
	done: "✅",
	failed: "❌",
	cancelled: "⏹️",
};

/** GH-08: the GitHub state label for `state`; `queued`, `done` and `cancelled` carry none. */
export function stateLabel(state: IssueState, labels: LabelNames): string | null {
	switch (state) {
		case "planning":
			return labels.states.planning;
		case "awaiting_approval":
			return labels.states.awaitingApproval;
		case "implementing":
			return labels.states.implementing;
		case "in_review":
			return labels.states.inReview;
		case "failed":
			return labels.states.failed;
		default:
			return null;
	}
}

export class IllegalTransition extends Error {
	constructor(
		readonly state: IssueState,
		readonly event: IssueEvent,
	) {
		super(`Illegal transition: ${state} --${event}-->`);
		this.name = "IllegalTransition";
	}
}

/** ISS-02 / requirements §1 diagram. ISS-04: `approved` goes straight to implementing. */
const TABLE: Partial<Record<IssueState, Partial<Record<IssueEvent, IssueState>>>> = {
	queued: { plan_started: "planning" },
	planning: { plan_ready: "awaiting_approval", job_failed: "failed" },
	awaiting_approval: { approved: "implementing", changes_requested: "planning", rejected: "cancelled" },
	implementing: { pr_opened: "in_review", job_failed: "failed" },
	in_review: { pr_merged: "done", pr_closed: "cancelled", job_failed: "failed" },
};

/** ISS-03: state a failed job of `kind` resumes into on `retry`. */
export const RETRY_TARGET: Record<JobKind, IssueState> = {
	plan: "planning",
	implement: "implementing",
	revise: "in_review",
	fix_ci: "in_review",
};

/**
 * Pure state transition. `retryKind` is required for `failed --retry-->`.
 * Any non-terminal state accepts `cancelled`. Throws `IllegalTransition` otherwise.
 */
export function transition(state: IssueState, event: IssueEvent, retryKind?: JobKind): IssueState {
	if (event === "cancelled" && !TERMINAL_STATES[state]) return "cancelled";
	if (state === "failed" && event === "retry" && retryKind) return RETRY_TARGET[retryKind];
	const next = TABLE[state]?.[event];
	if (!next) throw new IllegalTransition(state, event);
	return next;
}
