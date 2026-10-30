import { describe, expect, test } from "bun:test";
import { CI_START_GRACE_MS, type CiGateOptions, waitForBranchCi } from "../../src/orchestrator/engine/ciGate";
import type { GhCheckRun, GhWorkflowRun } from "../../src/orchestrator/github/types";

const POLL = 30_000;
const LIMIT = 60 * 60_000;

function check(over: Partial<GhCheckRun> = {}): GhCheckRun {
	return { id: 1, name: "build", status: "completed", conclusion: "success", app: { slug: "github-actions" }, check_suite: null, output: { summary: null }, ...over };
}

function workflow(over: Partial<GhWorkflowRun> = {}): GhWorkflowRun {
	return { id: 10, status: "completed", conclusion: "success", workflow_id: 1, event: "push", run_number: 1, head_sha: "sha-1", ...over };
}

interface Snapshot {
	head?: string | null;
	checks?: GhCheckRun[];
	workflows?: GhWorkflowRun[];
}

/** Scripted GitHub: poll N answers `script[min(N, last)]`; a fake clock advances by the requested sleep. */
function harness(script: Snapshot[], over: Partial<CiGateOptions> = {}) {
	let clock = 1_000_000;
	let poll = -1;
	const sleeps: number[] = [];
	const shas: { sha: string; at: number }[] = [];
	const queried: string[] = [];
	const current = () => script[Math.min(poll, script.length - 1)]!;
	const opts: CiGateOptions = {
		github: {
			getBranchSha: async () => {
				poll++;
				return current().head === undefined ? "sha-1" : current().head!;
			},
			listCheckRuns: async (_r, sha) => {
				queried.push(sha);
				return current().checks ?? [];
			},
			listWorkflowRuns: async () => current().workflows ?? [],
			getActionsJobLogTail: async (_r, id) => `log of ${id}`,
		},
		repo: "o/r",
		branch: "agentbot/issue-1-x",
		sha: "sha-1",
		shaSeenAt: clock,
		waitStartedAt: clock,
		limitMs: LIMIT,
		graceMs: CI_START_GRACE_MS,
		pollMs: POLL,
		signal: new AbortController().signal,
		onSha: (sha, at) => void shas.push({ sha, at }),
		assertLive: () => {},
		now: () => clock,
		sleep: async ms => {
			sleeps.push(ms);
			clock += ms;
		},
		...over,
	};
	return { opts, sleeps, shas, queried, polls: () => poll + 1 };
}

describe("waitForBranchCi", () => {
	test("pending polls, then passed", async () => {
		const pending = { checks: [check({ status: "in_progress", conclusion: null })], workflows: [workflow({ status: "in_progress", conclusion: null })] };
		const h = harness([pending, pending, { checks: [check()], workflows: [workflow()] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "passed", sha: "sha-1" });
		expect(h.sleeps).toEqual([POLL, POLL]);
	});

	test("skipped runs count as passed", async () => {
		const h = harness([{ checks: [check({ conclusion: "skipped" })], workflows: [workflow({ conclusion: "skipped" })] }]);
		expect((await waitForBranchCi(h.opts)).kind).toBe("passed");
	});

	test("failure returns the failing checks with log tails of GitHub Actions runs", async () => {
		const failing = check({ id: 7, name: "test", conclusion: "failure", output: { summary: "2 failed" } });
		const h = harness([{ checks: [check({ id: 6 }), failing], workflows: [workflow({ conclusion: "failure" })] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({
			kind: "failed",
			sha: "sha-1",
			failures: [{ checkRunId: 7, name: "test", conclusion: "failure", summary: "2 failed", logTail: "log of 7" }],
		});
	});

	test("a workflow that failed before any check run is reported as a failure", async () => {
		const h = harness([{ workflows: [workflow({ id: 11, run_number: 4, conclusion: "startup_failure" })] }]);
		const result = await waitForBranchCi(h.opts);
		expect(result).toMatchObject({ kind: "failed", failures: [{ checkRunId: 11, name: "workflow run #4", conclusion: "startup_failure" }] });
	});

	test("no run: keeps waiting until the grace period has passed, then gives up", async () => {
		const h = harness([{}]);
		const result = await waitForBranchCi(h.opts);
		expect(result).toEqual({ kind: "no_run", sha: "sha-1" });
		// The last sleep ended exactly at the grace boundary; no poll earlier than that returned no_run.
		expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(CI_START_GRACE_MS);
	});

	test("a run that appears within the grace period is awaited, not abandoned", async () => {
		const h = harness([{}, {}, { checks: [check({ status: "queued", conclusion: null })] }, { checks: [check()], workflows: [workflow()] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "passed", sha: "sha-1" });
	});

	test("a cancelled run on an unchanged head is not a verdict; the wait ends by timeout", async () => {
		const h = harness([{ checks: [check({ conclusion: "cancelled" })], workflows: [workflow({ conclusion: "cancelled" })] }]);
		const result = await waitForBranchCi(h.opts);
		expect(result).toEqual({ kind: "timeout", sha: "sha-1" });
		expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(LIMIT);
	});

	test("a cancelled run that is re-run on the same commit is followed to its result", async () => {
		const cancelled = { checks: [check({ conclusion: "cancelled" })], workflows: [workflow({ conclusion: "cancelled" })] };
		const h = harness([cancelled, { checks: [check()], workflows: [workflow()] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "passed", sha: "sha-1" });
	});

	test("a cancelled run replaced by a newer passing run of the same workflow passes on the first poll", async () => {
		const workflows = [workflow({ id: 10, run_number: 7, conclusion: "cancelled" }), workflow({ id: 11, run_number: 8 })];
		const h = harness([{ workflows }]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "passed", sha: "sha-1" });
		expect(h.sleeps).toEqual([]);
	});

	test("a failure of a superseded run is not reported", async () => {
		const superseded = workflow({ id: 10, run_number: 7, conclusion: "failure", check_suite_id: 50 });
		const current = workflow({ id: 11, run_number: 8, conclusion: "failure", check_suite_id: 51 });
		const checks = [
			check({ id: 6, name: "old-job", conclusion: "failure", check_suite: { id: 50 } }),
			check({ id: 7, name: "new-job", conclusion: "failure", check_suite: { id: 51 }, output: { summary: "boom" } }),
		];
		const h = harness([{ checks, workflows: [superseded, current] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({
			kind: "failed",
			sha: "sha-1",
			failures: [{ checkRunId: 7, name: "new-job", conclusion: "failure", summary: "boom", logTail: "log of 7" }],
		});
		const noChecks = harness([{ workflows: [superseded, current] }]);
		expect(await waitForBranchCi(noChecks.opts)).toMatchObject({ kind: "failed", failures: [{ checkRunId: 11, name: "workflow run #8" }] });
	});

	test("a newer push supersedes the run: the wait follows the new head and checkpoints it", async () => {
		const cancelled = { checks: [check({ conclusion: "cancelled" })], workflows: [workflow({ conclusion: "cancelled" })] };
		const h = harness([
			cancelled,
			{ head: "sha-2", checks: [check({ status: "in_progress", conclusion: null })], workflows: [workflow({ status: "in_progress", conclusion: null })] },
			{ head: "sha-2", checks: [check()], workflows: [workflow()] },
		]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "passed", sha: "sha-2" });
		expect(h.shas.map(s => s.sha)).toEqual(["sha-2"]);
		expect(h.queried).toEqual(["sha-1", "sha-2", "sha-2"]);
	});

	test("the no-run grace period restarts for a superseding commit", async () => {
		const h = harness([{}, {}, { head: "sha-2" }]);
		// Move the clock close to the first commit's grace boundary before the head moves.
		const sleep = h.opts.sleep!;
		h.opts.sleep = async (ms, signal) => sleep(ms === POLL ? CI_START_GRACE_MS - 1_000 : ms, signal);
		const result = await waitForBranchCi(h.opts);
		expect(result.kind).toBe("no_run");
		expect(result.sha).toBe("sha-2");
		expect(h.shas.map(s => s.sha)).toEqual(["sha-2"]);
		expect(h.polls()).toBeGreaterThan(3);
	});

	test("a vanished branch keeps following the last known commit", async () => {
		const h = harness([{ head: null, checks: [check()], workflows: [workflow()] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "passed", sha: "sha-1" });
	});

	test("pending checks time out after the limit", async () => {
		const h = harness([{ checks: [check({ status: "queued", conclusion: null })] }]);
		expect(await waitForBranchCi(h.opts)).toEqual({ kind: "timeout", sha: "sha-1" });
	});

	test("the limit counts from waitStartedAt, so a resumed wait does not start over", async () => {
		const h = harness([{ checks: [check({ status: "queued", conclusion: null })] }]);
		h.opts.waitStartedAt -= LIMIT - POLL;
		await waitForBranchCi(h.opts);
		expect(h.sleeps).toEqual([POLL]);
	});

	test("abort rejects with the signal's reason", async () => {
		const controller = new AbortController();
		const h = harness([{ checks: [check({ status: "queued", conclusion: null })] }], {
			signal: controller.signal,
			sleep: async () => controller.abort(new Error("stop")),
		});
		await expect(waitForBranchCi(h.opts)).rejects.toThrow("stop");
	});

	test("assertLive failures end the wait", async () => {
		const h = harness([{}], {
			assertLive: () => {
				throw new Error("issue cancelled");
			},
		});
		await expect(waitForBranchCi(h.opts)).rejects.toThrow("issue cancelled");
		expect(h.polls()).toBe(0);
	});
});
