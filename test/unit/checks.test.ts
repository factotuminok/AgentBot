import { describe, expect, test } from "bun:test";
import { branchCiVerdict, evaluateChecks } from "../../src/orchestrator/github/feedback";
import type { GhCheckRun, GhWorkflowRun } from "../../src/orchestrator/github/types";

const MAX = 2;
const fresh = { ci_last_sha: null, ci_attempts: 0 };

function run(over: Partial<GhCheckRun>): GhCheckRun {
	return {
		id: 1,
		name: "build",
		status: "completed",
		conclusion: "success",
		app: { slug: "github-actions" },
		check_suite: null,
		output: { summary: null },
		...over,
	};
}

describe("evaluateChecks", () => {
	test("no runs → no action", () => {
		expect(evaluateChecks([], "sha1", fresh, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("all green → no action", () => {
		expect(evaluateChecks([run({}), run({ id: 2 })], "sha1", fresh, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("in-progress runs → no action even with a failure present", () => {
		const runs = [run({ id: 1, conclusion: "failure" }), run({ id: 2, status: "in_progress", conclusion: null })];
		expect(evaluateChecks(runs, "sha1", fresh, MAX)).toEqual({ failures: [], exhausted: false });
		const queued = [run({ id: 1, conclusion: "failure" }), run({ id: 2, status: "queued", conclusion: null })];
		expect(evaluateChecks(queued, "sha1", fresh, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("failure on a new sha → failures returned", () => {
		const failing = run({ id: 2, name: "test", conclusion: "failure" });
		expect(evaluateChecks([run({}), failing], "sha2", { ci_last_sha: "sha1", ci_attempts: 1 }, MAX)).toEqual({
			failures: [failing],
			exhausted: false,
		});
	});

	test("failure on the already-attempted sha → no action", () => {
		const runs = [run({ conclusion: "failure" })];
		expect(evaluateChecks(runs, "sha1", { ci_last_sha: "sha1", ci_attempts: 1 }, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("attempts exhausted on a new failing sha → exhausted flag", () => {
		const runs = [run({ conclusion: "failure" })];
		expect(evaluateChecks(runs, "sha3", { ci_last_sha: "sha2", ci_attempts: MAX }, MAX)).toEqual({ failures: [], exhausted: true });
	});

	test("attempts exhausted but same sha → no exhausted flag", () => {
		const runs = [run({ conclusion: "failure" })];
		expect(evaluateChecks(runs, "sha2", { ci_last_sha: "sha2", ci_attempts: MAX }, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("attempts exhausted but green → no exhausted flag", () => {
		expect(evaluateChecks([run({})], "sha3", { ci_last_sha: "sha2", ci_attempts: MAX }, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("timed_out counts as a failure", () => {
		const timedOut = run({ conclusion: "timed_out" });
		expect(evaluateChecks([timedOut], "sha1", fresh, MAX)).toEqual({ failures: [timedOut], exhausted: false });
	});

	test("neutral and skipped do not count as failures", () => {
		const runs = [run({ id: 1, conclusion: "neutral" }), run({ id: 2, conclusion: "skipped" }), run({ id: 3, conclusion: "success" })];
		expect(evaluateChecks(runs, "sha1", fresh, MAX)).toEqual({ failures: [], exhausted: false });
	});

	test("only failing runs are returned alongside neutral/skipped", () => {
		const failing = run({ id: 3, conclusion: "failure" });
		const runs = [run({ id: 1, conclusion: "neutral" }), run({ id: 2, conclusion: "skipped" }), failing];
		expect(evaluateChecks(runs, "sha1", fresh, MAX).failures).toEqual([failing]);
	});
});

function wf(over: Partial<GhWorkflowRun>): GhWorkflowRun {
	return {
		id: 100,
		status: "completed",
		conclusion: "success",
		workflow_id: 1,
		event: "push",
		run_number: 1,
		head_sha: "sha1",
		...over,
	};
}

describe("branchCiVerdict", () => {
	test("no check runs and no workflow runs → none", () => {
		expect(branchCiVerdict([], [])).toBe("none");
	});

	test("a workflow run that is not completed is pending even without check runs (held back by concurrency)", () => {
		expect(branchCiVerdict([], [wf({ status: "queued", conclusion: null })])).toBe("pending");
		expect(branchCiVerdict([run({})], [wf({ status: "pending", conclusion: null })])).toBe("pending");
	});

	test("a check run that is not completed is pending", () => {
		expect(branchCiVerdict([run({}), run({ id: 2, name: "test", status: "in_progress", conclusion: null })], [wf({})])).toBe("pending");
	});

	test("failure and timed_out check runs fail, also while a passing run exists", () => {
		expect(branchCiVerdict([run({}), run({ id: 2, name: "test", conclusion: "failure" })], [wf({})])).toBe("failed");
		expect(branchCiVerdict([run({ conclusion: "timed_out" })], [])).toBe("failed");
	});

	test("a workflow that failed without producing check runs fails", () => {
		expect(branchCiVerdict([], [wf({ conclusion: "startup_failure" })])).toBe("failed");
		expect(branchCiVerdict([], [wf({ conclusion: "failure" })])).toBe("failed");
	});

	test("cancelled is neither failed nor passed", () => {
		expect(branchCiVerdict([run({ conclusion: "cancelled" })], [wf({ conclusion: "cancelled" })])).toBe("cancelled");
		expect(branchCiVerdict([], [wf({ conclusion: "cancelled" })])).toBe("cancelled");
		expect(branchCiVerdict([run({}), run({ id: 2, name: "test", conclusion: "cancelled" })], [wf({})])).toBe("cancelled");
	});

	test("a failure wins over a cancelled run", () => {
		expect(branchCiVerdict([run({ conclusion: "cancelled" }), run({ id: 2, name: "test", conclusion: "failure" })], [])).toBe("failed");
	});

	test("success, skipped and neutral pass", () => {
		const runs = [run({}), run({ id: 2, name: "test", conclusion: "skipped" }), run({ id: 3, name: "lint", conclusion: "neutral" })];
		expect(branchCiVerdict(runs, [wf({})])).toBe("passed");
		expect(branchCiVerdict([], [wf({ conclusion: "skipped" })])).toBe("passed");
	});

	describe("superseded runs", () => {
		// The #37 incident: two push runs of one workflow, the first cancelled by `cancel-in-progress`.
		const cancelled = wf({ id: 100, run_number: 7, conclusion: "cancelled", check_suite_id: 50 });
		const newer = wf({ id: 101, run_number: 8, check_suite_id: 51 });

		test("a cancelled run replaced by a passing run of the same workflow passes, with or without check runs", () => {
			expect(branchCiVerdict([], [cancelled, newer])).toBe("passed");
			expect(branchCiVerdict([run({ id: 5, name: "test", check_suite: { id: 51 } })], [cancelled, newer])).toBe("passed");
			expect(branchCiVerdict([run({ id: 4, name: "test", conclusion: "cancelled", check_suite: { id: 50 } }), run({ id: 5, name: "test", check_suite: { id: 51 } })], [newer, cancelled])).toBe("passed");
		});

		test("a newest run that is cancelled still counts", () => {
			const older = wf({ id: 100, run_number: 7, check_suite_id: 50 });
			const newest = wf({ id: 101, run_number: 8, conclusion: "cancelled", check_suite_id: 51 });
			expect(branchCiVerdict([], [older, newest])).toBe("cancelled");
			const checks = [run({ id: 4, name: "test", check_suite: { id: 50 } }), run({ id: 5, name: "test", conclusion: "cancelled", check_suite: { id: 51 } })];
			expect(branchCiVerdict(checks, [older, newest])).toBe("cancelled");
		});

		test("a failed run replaced by a newer run is not a failure", () => {
			const failed = wf({ id: 100, run_number: 7, conclusion: "failure", check_suite_id: 50 });
			const checks = [run({ id: 4, name: "test", conclusion: "failure", check_suite: { id: 50 } }), run({ id: 5, name: "test", check_suite: { id: 51 } })];
			expect(branchCiVerdict(checks, [failed, newer])).toBe("passed");
			expect(branchCiVerdict([], [failed, newer])).toBe("passed");
		});

		test("a re-requested check run replaces the older one of the same suite and name", () => {
			const checks = [run({ id: 4, name: "test", conclusion: "failure", check_suite: { id: 50 } }), run({ id: 9, name: "test", check_suite: { id: 50 } })];
			expect(branchCiVerdict(checks, [wf({ check_suite_id: 50 })])).toBe("passed");
		});

		test("the same workflow on push and on pull_request counts for both events", () => {
			const push = wf({ id: 100, event: "push", run_number: 7, conclusion: "failure" });
			const pr = wf({ id: 101, event: "pull_request", run_number: 8 });
			expect(branchCiVerdict([], [push, pr])).toBe("failed");
		});

		test("two workflows with a same-named job are both judged", () => {
			const checks = [
				run({ id: 4, name: "test", conclusion: "failure", check_suite: { id: 50 } }),
				run({ id: 5, name: "test", check_suite: { id: 51 } }),
			];
			const workflows = [wf({ id: 100, workflow_id: 1, check_suite_id: 50 }), wf({ id: 101, workflow_id: 2, check_suite_id: 51 })];
			expect(branchCiVerdict(checks, workflows)).toBe("failed");
		});
	});
});
