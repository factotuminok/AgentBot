import { describe, expect, test } from "bun:test";
import { parseConfig, resolveLabelNames } from "../../src/shared/config";
import {
	IllegalTransition,
	type IssueEvent,
	type IssueState,
	type JobKind,
	STATE_ICONS,
	stateLabel,
	TERMINAL_STATES,
	transition,
} from "../../src/orchestrator/engine/state";

const STATES: IssueState[] = ["queued", "planning", "awaiting_approval", "implementing", "in_review", "done", "failed", "cancelled"];
const EVENTS: IssueEvent[] = ["plan_started", "plan_ready", "approved", "changes_requested", "rejected", "pr_opened", "pr_merged", "pr_closed", "job_failed", "retry", "cancelled"];

const allowed: [IssueState, IssueEvent, IssueState][] = [
	["queued", "plan_started", "planning"],
	["planning", "plan_ready", "awaiting_approval"],
	["planning", "job_failed", "failed"],
	["awaiting_approval", "approved", "implementing"],
	["awaiting_approval", "changes_requested", "planning"],
	["awaiting_approval", "rejected", "cancelled"],
	["implementing", "pr_opened", "in_review"],
	["implementing", "job_failed", "failed"],
	["in_review", "pr_merged", "done"],
	["in_review", "pr_closed", "cancelled"],
	["in_review", "job_failed", "failed"],
];

describe("transition", () => {
	for (const [from, event, to] of allowed) {
		test(`${from} --${event}--> ${to}`, () => expect(transition(from, event)).toBe(to));
	}

	const retries: [JobKind, IssueState][] = [
		["plan", "planning"],
		["implement", "implementing"],
		["revise", "in_review"],
		["fix_ci", "in_review"],
	];
	for (const [kind, to] of retries) {
		test(`failed --retry(${kind})--> ${to}`, () => expect(transition("failed", "retry", kind)).toBe(to));
	}

	test("every non-terminal state accepts cancelled", () => {
		for (const state of STATES.filter(s => !TERMINAL_STATES[s])) expect(transition(state, "cancelled")).toBe("cancelled");
	});

	test("only done and cancelled are terminal", () => {
		expect(STATES.filter(s => TERMINAL_STATES[s])).toEqual(["done", "cancelled"]);
	});

	test("every other (state, event) pair is illegal", () => {
		for (const state of STATES) {
			for (const event of EVENTS) {
				const ok = allowed.some(([s, e]) => s === state && e === event) || (event === "cancelled" && !TERMINAL_STATES[state]);
				if (ok) continue;
				expect(() => transition(state, event, state === "failed" && event === "retry" ? undefined : "plan")).toThrow(IllegalTransition);
			}
		}
	});

	test("retry without a job kind is illegal", () => {
		expect(() => transition("failed", "retry")).toThrow("Illegal transition: failed --retry-->");
	});
});

test("stateLabel uses the configured names; queued/done/cancelled have none", () => {
	const names = resolveLabelNames(
		parseConfig({ discord: { guildId: "1", allowedUserIds: ["1"], workChannelId: "9" }, github: { appId: 1 }, labels: { trigger: "ab", states: { inReview: "review-me" } } }),
	);
	expect(Object.fromEntries(STATES.map(s => [s, stateLabel(s, names)]))).toEqual({
		queued: null,
		planning: "ab:planning",
		awaiting_approval: "ab:awaiting-approval",
		implementing: "ab:implementing",
		in_review: "review-me",
		done: null,
		failed: "ab:failed",
		cancelled: null,
	});
});

test("STATE_ICONS", () => {
	expect(STATE_ICONS).toEqual({
		queued: "📥",
		planning: "🛠️",
		awaiting_approval: "📋",
		implementing: "🛠️",
		in_review: "👀",
		done: "✅",
		failed: "❌",
		cancelled: "⏹️",
	});
});
