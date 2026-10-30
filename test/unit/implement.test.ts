import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { oomWarning } from "../../src/orchestrator/discord/render";
import type { PushOutcome } from "../../src/orchestrator/dispatch/dispatcher";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { CI_START_GRACE_MS } from "../../src/orchestrator/engine/ciGate";
import type { Scheduler } from "../../src/orchestrator/engine/deps";
import { BRANCH_MOVED_ERROR, branchName, type CiCheckpoint, type ImplementCheckpoint, NO_COMMITS_ERROR } from "../../src/orchestrator/engine/jobs";
import { createScheduler } from "../../src/orchestrator/engine/scheduler";
import type { IssueState } from "../../src/orchestrator/engine/state";
import type { IssueRow, JobRow } from "../../src/orchestrator/store/db";
import { sessionPath } from "../../src/orchestrator/store/sessions";
import { createEngineHarness, type EngineHarness } from "../fakes/engine";

const BRANCH = "agentbot/issue-1-add-thing";
const PLAN_URL = "https://github.com/o/r/issues/1#issuecomment-77";
const OUTPUT = { prTitle: "Add thing", prBody: "Adds the thing.", testing: "bun test: 12 pass" };
const PUSH_CI = { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active", source: "on: push\njobs: {}" };
const PR_ONLY_CI = { id: 2, name: "PR", path: ".github/workflows/pr.yml", state: "active", source: "on: pull_request\njobs: {}" };

let h: EngineHarness;
let scheduler: Scheduler;
/** Answers the next pushes, in order; afterwards every push succeeds. */
let pushScript: ((branch: string) => PushOutcome | Promise<PushOutcome>)[];
let pushCount: number;
/** Issue state and `pr_number` at every state change (PR-02). */
let transitions: { state: IssueState; pr: number | null }[];

afterEach(async () => {
	await h?.stop();
});

async function until(check: () => boolean, what = "condition", timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

const finished = (job: JobRow | null) => job !== null && job.status !== "queued" && job.status !== "running";

/** A push lands on the fake GitHub as `pushed-<n>` (the dispatcher pushes the run's result, RUN-19). */
function landPush(branch: string): PushOutcome {
	const sha = `pushed-${++pushCount}`;
	h.gh.getRepo("o/r").branches.set(branch, sha);
	return { pushed: true, sha };
}

async function setup(opts: { config?: Record<string, unknown>; baseBranch?: string } = {}) {
	pushScript = [];
	pushCount = 0;
	transitions = [];
	const dispatcher = createFakeDispatcher({
		push: ({ branch }) => (pushScript.shift() ?? landPush)(branch),
		...(opts.baseBranch ? { repoConfig: async () => ({ baseBranch: opts.baseBranch! }) } : {}),
	});
	h = await createEngineHarness({
		dispatcher,
		config: { github: { appId: 1, pollIntervalSeconds: 1 }, agent: { name: "Robo" }, models: { implement: "anthropic/sonnet" }, ...opts.config },
	});
	h.gh.addRepo("o/r");
	const setIssueState = h.db.setIssueState;
	h.db.setIssueState = (id, state) => {
		transitions.push({ state, pr: h.db.getIssue(id)?.pr_number ?? null });
		return setIssueState(id, state);
	};
	scheduler = createScheduler(h.deps);
}

/** Issue #1 "Add thing" in `state` with its thread and an approved plan (plan comment 77). */
async function seedIssue(state: IssueState = "implementing", patch: Partial<IssueRow> = {}): Promise<IssueRow> {
	const fake = h.gh.addIssue("o/r", { title: "Add thing", body: "Please add the thing.", labels: ["agentbot"] });
	const top = await h.discord.send(h.workChannelId, { content: `🛠️ **#${fake.number} Add thing**` });
	const threadId = await h.discord.startThread(top, { name: "Add thing", autoArchiveMinutes: 10080 });
	const issue = h.db.insertIssue("o/r", fake.number, "Add thing");
	h.db.insertJob(issue.id, "plan");
	const plan = h.db.claimNextJob()!;
	h.db.finishJob(plan.id, { status: "succeeded", result: { summary: "S", planMarkdown: "## Plan\n1. Add the thing.", complexity: "small", rev: 1 } });
	return h.db.updateIssue(issue.id, { state, thread_id: threadId, plan_rev: 1, plan_comment_id: 77, ...patch });
}

/** An issue in review: branch on GitHub, PR open, implement session kept. */
async function seedReview(): Promise<{ issue: IssueRow; pr: number }> {
	h.gh.getRepo("o/r").branches.set(BRANCH, "head-0");
	const issue = await seedIssue("in_review", { branch: BRANCH, impl_session: "issue-1-impl" });
	const pr = h.gh.addPull("o/r", { head: BRANCH, headSha: "head-0" }).number;
	return { issue: h.db.updateIssue(issue.id, { pr_number: pr }), pr };
}

/** A job left `running` by a stopped orchestrator, with `result` stored (JOB-08). */
function runningJob(issue: IssueRow, kind: JobRow["kind"], result?: unknown, input: object = {}): JobRow {
	h.db.insertJob(issue.id, kind, input);
	const job = h.db.claimNextJob()!;
	if (result !== undefined) h.db.setJobResult(job.id, result);
	return job;
}

async function runToEnd(issue: IssueRow, kind: JobRow["kind"], input: object = {}): Promise<JobRow> {
	const job = scheduler.enqueue(issue.id, kind, input);
	await until(() => finished(h.db.getJob(job.id)), `${kind} job`);
	return h.db.getJob(job.id)!;
}

const messages = (issue: IssueRow) => h.discord.messages(issue.thread_id!).map(m => m.content);
const failureOf = (issue: IssueRow, kind: string) => h.discord.messages(issue.thread_id!).find(m => m.content.startsWith(`❌ ${kind} failed`));
const pullRequests = () => h.gh.requests.filter(r => r.method === "POST" && r.path === "/repos/o/r/pulls");
const pullBody = () => (pullRequests()[0]?.body as { body: string } | undefined)?.body;
const prComments = (pr: number) => h.gh.getIssue("o/r", pr).comments.map(c => c.body);

function addPushCi(): void {
	h.gh.getRepo("o/r").workflows.push(PUSH_CI);
}

function ciCheckpoint(over: Partial<CiCheckpoint> = {}): CiCheckpoint {
	const now = new Date().toISOString();
	return { stage: "ci", output: OUTPUT, oomKills: 0, sha: "sha-red", shaSeenAt: now, waitStartedAt: now, fixes: 0, ...over };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe("branchName (WS-03)", () => {
	test("agentbot/issue-<n>-<slug>, the slug at most 40 characters", () => {
		expect(branchName(5, "Add thing!")).toBe("agentbot/issue-5-add-thing");
		expect(branchName(5, "!!!")).toBe("agentbot/issue-5");
		const long = branchName(7, `${"word ".repeat(20)}`);
		expect(long.slice("agentbot/issue-7-".length).length).toBeLessThanOrEqual(40);
		expect(long).not.toEndWith("-");
	});
});

describe("implement (JOB-18 to JOB-20, PR-01 to PR-03)", () => {
	test("runs the plan, pushes the branch and opens the PR on the base branch; no push CI opens it at once", async () => {
		await setup({ baseBranch: "develop" });
		h.gh.getRepo("o/r").workflows.push(PR_ONLY_CI);
		h.dispatcher.script({ kind: "implement" }, { output: OUTPUT });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");

		expect(job.status).toBe("succeeded");
		const req = h.dispatcher.calls[0]!.req;
		expect(req).toMatchObject({
			owner: { kind: "job", jobId: job.id },
			kind: "implement",
			profile: "implement",
			model: "anthropic/sonnet",
			session: `issue-${issue.id}-impl`,
			resume: false,
			limits: { minutes: 120 },
			checkout: { repo: "o/r", issueBranch: BRANCH, leftoverMessage: "Robo: remaining changes for #1" },
		});
		expect(req.prompt).toContain("## Approved plan\n## Plan\n1. Add the thing.");
		expect(h.dispatcher.pushes).toEqual([{ runId: "fake-run-1", branch: BRANCH, outcome: { pushed: true, sha: "pushed-1" } }]);
		expect(h.dispatcher.discarded).toEqual(["fake-run-1"]);

		expect(pullRequests()[0]!.body).toMatchObject({ head: BRANCH, base: "develop", title: "Add thing" });
		expect(pullBody()).toBe(`Adds the thing.\n\n### Testing\nbun test: 12 pass\n\nCloses #1\n\n_Plan: ${PLAN_URL}_`);
		const row = h.db.getIssue(issue.id)!;
		expect(row).toMatchObject({ state: "in_review", branch: BRANCH, impl_session: `issue-${issue.id}-impl`, pr_number: 2 });
		// PR-02: the PR number is recorded before `pr_opened`.
		expect(transitions).toEqual([{ state: "in_review", pr: 2 }]);
		const done = messages(issue).find(m => m.includes("Implementation complete"));
		expect(done).toContain("opened PR #2: https://github.com/o/r/pull/2");
		expect(done).not.toContain("**CI:**");
		expect(JSON.parse(job.result!)).toEqual(OUTPUT);
		expect(h.gh.getIssue("o/r", 1).labels.toSorted()).toEqual(["agentbot", "agentbot:in-review"]);
	});

	test("an issue without a branch (from /work plan) gets one on its first implement job", async () => {
		await setup();
		const issue = await seedIssue("implementing", { branch: null });
		await runToEnd(issue, "implement");
		expect(h.db.getIssue(issue.id)?.branch).toBe(BRANCH);
	});

	test("no commits fails the job with nothing pushed or discarded", async () => {
		await setup();
		h.dispatcher.script({ kind: "implement" }, { commits: 0 });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");
		expect(job).toMatchObject({ status: "failed", error: NO_COMMITS_ERROR });
		expect(h.dispatcher.pushes).toEqual([]);
		expect(h.dispatcher.discarded).toEqual([]);
		await until(() => failureOf(issue, "implement") !== undefined, "failure message");
		expect(failureOf(issue, "implement")!.content).toBe("❌ implement failed: Agent produced no commits");
		expect(h.db.getIssue(issue.id)?.state).toBe("failed");
	});

	test("a time limit keeps the run's result for Retry (RUN-20)", async () => {
		await setup();
		h.dispatcher.script({ kind: "implement" }, { aborted: "time" });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");
		expect(job.error).toBe("implement job exceeded the 120 minute time limit (limits.implementMinutes)");
		expect(h.dispatcher.pushes).toEqual([]);
		expect(h.dispatcher.discarded).toEqual([]);
	});

	test("a branch that moved during the run discards the result and fails with Retry; Retry runs again", async () => {
		await setup();
		pushScript.push(() => ({ pushed: false }));
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");
		expect(job).toMatchObject({ status: "failed", error: BRANCH_MOVED_ERROR });
		expect(BRANCH_MOVED_ERROR).toBe("The branch changed on GitHub during this run; press Retry to start again from the new head.");
		expect(h.dispatcher.discarded).toEqual(["fake-run-1"]);
		expect(job.result).toBe("null");
		await until(() => failureOf(issue, "implement") !== undefined, "failure message");
		expect(pullRequests()).toEqual([]);

		h.db.setIssueState(issue.id, "implementing");
		const retry = await runToEnd(issue, "implement", { resume: true });
		expect(retry.status).toBe("succeeded");
		expect(h.dispatcher.runs).toHaveLength(2);
		expect(h.dispatcher.calls[1]!.req).toMatchObject({ resume: true, session: `issue-${issue.id}-impl` });
		expect(h.dispatcher.calls[1]!.req.prompt).toContain("Robo restarted while you were working.");
		expect(pullRequests()).toHaveLength(1);
	});

	test("a job requeued after its run was lost resumes the session the run uploaded and continues its checkpoint (RUN-04, RUN-18)", async () => {
		await setup();
		const issue = await seedIssue();
		// The lost run uploaded its session while it ran; `impl_session` is only recorded when a run ends.
		mkdirSync(h.deps.sessionDir, { recursive: true });
		writeFileSync(sessionPath(h.deps.sessionDir, `issue-${issue.id}-impl`), "{}\n");
		const job = await runToEnd(issue, "implement", { resume: true, lost: 1 });
		expect(job.status).toBe("succeeded");
		expect(h.dispatcher.calls[0]!.req).toMatchObject({ resume: true, session: `issue-${issue.id}-impl` });
		expect(h.dispatcher.calls[0]!.req.prompt).toContain("Robo restarted while you were working.");
		expect(h.dispatcher.calls[0]!.req.prompt).not.toContain("Implement the approved plan");
	});

	test("a job requeued after a run lost before any upload starts over, still continuing whatever the issue keeps (RUN-17)", async () => {
		await setup();
		const issue = await seedIssue();
		await runToEnd(issue, "implement", { resume: true, lost: 1 });
		expect(h.dispatcher.calls[0]!.req).toMatchObject({ resume: true });
		expect(h.dispatcher.calls[0]!.req.prompt).toContain("Robo restarted while you were working.");
		expect(h.dispatcher.calls[0]!.req.prompt).toContain("Implement the approved plan");
	});

	test("a re-executed job whose push is recorded does not run or push again (JOB-09)", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "pushed-before-restart");
		const issue = await seedIssue("implementing", { branch: BRANCH });
		const job = runningJob(issue, "implement", { stage: "pushed", output: OUTPUT, oomKills: 0 } satisfies ImplementCheckpoint);
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");

		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(h.dispatcher.calls).toEqual([]);
		expect(h.dispatcher.pushes).toEqual([]);
		expect(pullRequests()).toHaveLength(1);
		expect(h.db.getIssue(issue.id)?.state).toBe("in_review");
	});

	test("a push that failed is retried from the kept result without a new run", async () => {
		await setup();
		pushScript.push(() => {
			throw new Error("connection reset");
		});
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");
		expect(job.error).toBe("connection reset");
		expect(JSON.parse(job.result!)).toMatchObject({ stage: "push", runId: "fake-run-1" });

		h.db.setIssueState(issue.id, "implementing");
		const retry = await runToEnd(issue, "implement", { resume: true });
		expect(retry.status).toBe("succeeded");
		expect(h.dispatcher.runs).toHaveLength(1);
		expect(h.dispatcher.pushes.map(p => p.runId)).toEqual(["fake-run-1"]);
		expect(h.dispatcher.discarded).toEqual(["fake-run-1"]);
		expect(pullRequests()).toHaveLength(1);
	});

	test("a job re-executed after the PR was opened only completes the state update (JOB-09)", async () => {
		await setup();
		const issue = await seedIssue("implementing", { branch: BRANCH, pr_number: 9 });
		const job = runningJob(issue, "implement", { stage: "pushed", output: OUTPUT, oomKills: 0 });
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(pullRequests()).toEqual([]);
		expect(h.dispatcher.calls).toEqual([]);
		expect(h.db.getIssue(issue.id)?.state).toBe("in_review");
	});
});

describe("CI gate before the PR (CI-01 to CI-09)", () => {
	test("waits for CI on the pushed commit; the PR body has the agent body, OOM warning, Testing, CI, Closes and plan link in order", async () => {
		await setup();
		addPushCi();
		h.gh.addCheckRun("o/r", "pushed-1", { name: "build" });
		h.dispatcher.script({ kind: "implement" }, { output: OUTPUT, oomKills: 2 });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");

		expect(job.status).toBe("succeeded");
		const ci = "✅ CI passed on `agentbot/issue-1-add-thing` at pushed- before this PR was opened.";
		expect(pullBody()).toBe(
			`Adds the thing.\n\n${oomWarning(2, "Robo")}\n\n### Testing\nbun test: 12 pass\n\n### CI\n${ci}\n\nCloses #1\n\n_Plan: ${PLAN_URL}_`,
		);
		const done = messages(issue).find(m => m.includes("Implementation complete"))!;
		expect(done).toContain(`**CI:** ${ci}`);
		expect(done).toContain("Local verification incomplete");
		expect(JSON.parse(h.db.getJob(job.id)!.result!)).toEqual({ ...OUTPUT, oomKills: 2 });
		expect(transitions).toEqual([{ state: "in_review", pr: 2 }]);
	});

	test("pending CI keeps the issue implementing; steering explains the wait and /work cancel stops it (CI-09)", async () => {
		await setup();
		addPushCi();
		h.gh.addCheckRun("o/r", "pushed-1", { name: "build", status: "in_progress", conclusion: null });
		const issue = await seedIssue();
		const job = scheduler.enqueue(issue.id, "implement");
		await until(() => h.gh.requests.some(r => r.path.includes("/commits/pushed-1/check-runs")), "the CI wait");
		await h.discord.settled();
		expect(messages(issue).some(m => m.includes("Waiting for CI on `agentbot/issue-1-add-thing`"))).toBe(true);
		expect(h.db.getIssue(issue.id)?.state).toBe("implementing");

		expect(await scheduler.steer(issue.id, "hello?", "alice")).toBe("ended");
		expect(messages(issue)).toContain("No agent is running — Robo is waiting for CI on `agentbot/issue-1-add-thing`; use /work cancel to stop.");

		await scheduler.cancelIssue(issue.id, "cancelled by @alice");
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(h.db.getJob(job.id)?.status).toBe("cancelled");
		expect(pullRequests()).toEqual([]);
	});

	test("a pending run that turns green opens the PR on the next poll", async () => {
		await setup();
		addPushCi();
		h.gh.addCheckRun("o/r", "pushed-1", { name: "build", status: "in_progress", conclusion: null });
		const issue = await seedIssue();
		const job = scheduler.enqueue(issue.id, "implement");
		await until(() => h.gh.requests.some(r => r.path.includes("/commits/pushed-1/check-runs")), "the CI wait");
		Object.assign(h.gh.getRepo("o/r").checkRuns.get("pushed-1")![0]!, { status: "completed", conclusion: "success" });
		await until(() => finished(h.db.getJob(job.id)), "implement job", 5000);
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(pullBody()).toContain("✅ CI passed");
	});

	test("failing CI runs a fix on the branch, pushes it and waits again; attempts count on the issue", async () => {
		await setup();
		addPushCi();
		h.gh.addCheckRun("o/r", "pushed-1", { name: "test", conclusion: "failure", summary: "2 failed" });
		h.gh.addCheckRun("o/r", "pushed-2", { name: "test" });
		h.dispatcher.script({ kind: "fix_ci" }, { output: { summary: "Fixed the flaky assertion." } });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");

		expect(job.status).toBe("succeeded");
		const fix = h.dispatcher.calls[1]!.req;
		expect(fix).toMatchObject({
			kind: "fix_ci",
			profile: "implement",
			session: `issue-${issue.id}-impl`,
			resume: true,
			limits: { minutes: 45 },
			checkout: { issueBranch: BRANCH, leftoverMessage: "Robo: follow-up changes for #1" },
		});
		expect(fix.prompt).toContain("Robo opens the pull request once CI passes");
		expect(fix.prompt).toContain("### test (failure)\n\n2 failed");
		expect(h.dispatcher.pushes.map(p => p.runId)).toEqual(["fake-run-1", "fake-run-2"]);
		expect(messages(issue).some(m => m.startsWith("✅ **CI fix pushed** to `agentbot/issue-1-add-thing` (attempt 1/3)."))).toBe(true);
		expect(h.db.getIssue(issue.id)).toMatchObject({ ci_attempts: 1, ci_last_sha: "pushed-1", state: "in_review" });
		expect(pullBody()).toContain("at pushed- before this PR was opened (after 1 Robo CI fix).");
	});

	test("maxCostUsdPerJob bounds the whole job: a CI fix run gets what the implement run left, and none once it is spent (JOB-07, JOB-04)", async () => {
		await setup();
		addPushCi();
		h.gh.addCheckRun("o/r", "pushed-1", { name: "test", conclusion: "failure" });
		h.gh.addCheckRun("o/r", "pushed-2", { name: "test", conclusion: "failure" });
		h.dispatcher.script({ kind: "implement" }, { output: OUTPUT, usage: { costUsd: 11 } });
		h.dispatcher.script({ kind: "fix_ci" }, { output: { summary: "Fixed." }, usage: { costUsd: 4 } });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");
		expect(h.dispatcher.calls.map(c => [c.req.kind, c.req.limits.costUsd])).toEqual([
			["implement", 15],
			["fix_ci", 4],
		]);
		// The fix's push is red again; the $15 are spent, so no second fix run starts.
		expect(job).toMatchObject({ status: "failed", error: "fix_ci job exceeded the $15 cost limit (limits.maxCostUsdPerJob)", cost_usd: 15 });
	});

	test("a fix that pushes nothing fails the job", async () => {
		await setup();
		addPushCi();
		h.gh.addCheckRun("o/r", "pushed-1", { name: "test", conclusion: "failure" });
		h.dispatcher.script({ kind: "fix_ci" }, { commits: 0, output: { summary: "No idea." } });
		const issue = await seedIssue();
		const job = await runToEnd(issue, "implement");
		expect(job).toMatchObject({ status: "failed", error: "Robo could not find a fix for test: No idea." });
		expect(pullRequests()).toEqual([]);
	});

	test("no CI run within the grace period opens the PR with a note (CI-05)", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "sha-1");
		const issue = await seedIssue("implementing", { branch: BRANCH });
		const job = runningJob(issue, "implement", ciCheckpoint({ sha: "sha-1", shaSeenAt: minutesAgo(CI_START_GRACE_MS / 60_000 + 1) }));
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(pullBody()).toContain("### CI\n⚠️ No CI run started for sha-1 within 5 minutes of the push; this PR was opened without a CI result.");
		expect(messages(issue).join("\n")).toContain("**CI:** ⚠️ No CI run started");
	});

	test("CI still running at ciWaitMinutes opens the PR with a note (CI-06)", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "sha-1");
		h.gh.addCheckRun("o/r", "sha-1", { name: "build", status: "queued", conclusion: null });
		const issue = await seedIssue("implementing", { branch: BRANCH });
		const job = runningJob(issue, "implement", ciCheckpoint({ sha: "sha-1", waitStartedAt: minutesAgo(61) }));
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(pullBody()).toContain("⚠️ CI had not finished after 60 minutes; Robo keeps watching it on this PR.");
	});

	test("a restarted job resumes the wait on the stored commit: no run, no push, one PR (CI-08)", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "sha-stored");
		h.gh.addCheckRun("o/r", "sha-stored", { name: "build" });
		const issue = await seedIssue("implementing", { branch: BRANCH });
		const job = runningJob(issue, "implement", ciCheckpoint({ sha: "sha-stored" }));
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(h.dispatcher.calls).toEqual([]);
		expect(h.dispatcher.pushes).toEqual([]);
		expect(pullRequests()).toHaveLength(1);
		expect(pullBody()).toContain("at sha-sto before this PR was opened");
	});

	test("a fix interrupted after its push is not repeated: the wait follows the moved head (CI-08)", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "sha-fix");
		h.gh.addCheckRun("o/r", "sha-fix", { name: "test" });
		const issue = await seedIssue("implementing", { branch: BRANCH, ci_attempts: 1 });
		const fixing = [{ checkRunId: 7, name: "test", conclusion: "failure", summary: null }];
		const job = runningJob(issue, "implement", ciCheckpoint({ sha: "sha-red", fixing }));
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(h.dispatcher.calls).toEqual([]);
		expect(pullBody()).toContain("at sha-fix before this PR was opened (after 1 Robo CI fix).");
	});

	test("exhausted attempts fail with 'needs a human'; Retry grants one more fix, then the PR opens", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "sha-red");
		h.gh.addCheckRun("o/r", "sha-red", { name: "test", conclusion: "failure" });
		h.gh.addCheckRun("o/r", "pushed-1", { name: "test" });
		const issue = await seedIssue("implementing", { branch: BRANCH, ci_attempts: 3 });
		const job = runningJob(issue, "implement", ciCheckpoint({ sha: "sha-red" }));
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		const error = "CI is still failing on agentbot/issue-1-add-thing (test) after 3 fix attempts — needs a human. Fix the branch and press Retry, or use /work cancel.";
		expect(h.db.getJob(job.id)).toMatchObject({ status: "failed", error });
		await until(() => failureOf(issue, "implement") !== undefined, "failure message");
		expect(failureOf(issue, "implement")!.components[0]!.components.map(c => ("label" in c ? c.label : undefined))).toEqual(["Retry"]);
		expect(h.db.getIssue(issue.id)?.state).toBe("failed");
		expect(pullRequests()).toEqual([]);
		expect(h.dispatcher.calls).toEqual([]);

		h.db.setIssueState(issue.id, "implementing");
		const retry = await runToEnd(issue, "implement", { resume: true });
		expect(retry.status).toBe("succeeded");
		expect(h.dispatcher.calls.map(c => c.req.kind)).toEqual(["fix_ci"]);
		expect(h.db.getIssue(issue.id)?.ci_attempts).toBe(4);
		expect(pullRequests()).toHaveLength(1);
	});

	test("Retry waits on the branch a human fixed, with fresh time bounds", async () => {
		await setup();
		h.gh.getRepo("o/r").branches.set(BRANCH, "sha-human");
		h.gh.addCheckRun("o/r", "sha-human", { name: "test" });
		const issue = await seedIssue("implementing", { branch: BRANCH });
		const failed = runningJob(issue, "implement", ciCheckpoint({ sha: "sha-red", waitStartedAt: minutesAgo(120), shaSeenAt: minutesAgo(120) }));
		h.db.finishJob(failed.id, { status: "failed", error: "CI is still failing" });

		const retry = scheduler.enqueue(issue.id, "implement", { resume: true });
		await until(() => finished(h.db.getJob(retry.id)), "retry");
		expect(h.db.getJob(retry.id)?.status).toBe("succeeded");
		expect(h.dispatcher.calls).toEqual([]);
		expect(pullBody()).toContain("✅ CI passed on `agentbot/issue-1-add-thing` at sha-hum");
	});
});

describe("revise and fix_ci (JOB-21 to JOB-23, DSC-22)", () => {
	const ITEMS = [{ id: "rc:1", kind: "inline", author: "alice", body: "Rename this", path: "a.ts", line: 3 }];
	const FAILURES = [{ checkRunId: 7, name: "test", conclusion: "failure", summary: "boom" }];

	test("revise resumes the implement session, pushes, comments on the PR and marks the feedback seen", async () => {
		await setup();
		h.dispatcher.script({ kind: "revise" }, { output: { summary: "Renamed it." } });
		const { issue, pr } = await seedReview();
		const job = await runToEnd(issue, "revise", { items: ITEMS });

		expect(job.status).toBe("succeeded");
		expect(h.dispatcher.calls[0]!.req).toMatchObject({
			kind: "revise",
			profile: "implement",
			session: "issue-1-impl",
			resume: true,
			limits: { minutes: 120 },
			checkout: { issueBranch: BRANCH, leftoverMessage: "Robo: follow-up changes for #1" },
		});
		expect(h.dispatcher.pushes).toEqual([{ runId: "fake-run-1", branch: BRANCH, outcome: { pushed: true, sha: "pushed-1" } }]);
		expect(h.dispatcher.discarded).toEqual(["fake-run-1"]);
		expect(prComments(pr)).toEqual(["Robo addressed feedback:\nRenamed it."]);
		expect(messages(issue).some(m => m.startsWith(`✅ **Review feedback addressed** — pushed changes to PR #${pr}.`))).toBe(true);
		expect([...h.db.seenIds("o/r", pr)]).toEqual(["rc:1"]);
		expect(h.db.getIssue(issue.id)?.state).toBe("in_review");
		expect(JSON.parse(job.result!)).toEqual({ summary: "Renamed it." });
	});

	test("a revise without commits pushes nothing and says no changes were needed", async () => {
		await setup();
		h.dispatcher.script({ kind: "revise" }, { commits: 0, output: { summary: "Explained why." }, oomKills: 1 });
		const { issue, pr } = await seedReview();
		await runToEnd(issue, "revise", { items: ITEMS });
		expect(h.dispatcher.pushes).toEqual([]);
		expect(prComments(pr)[0]).toStartWith("Robo addressed feedback:\nExplained why.\n\n⚠️ **Local verification incomplete**");
		expect(messages(issue).some(m => m.startsWith(`✅ **Review feedback handled** — no code changes were needed on PR #${pr}.`))).toBe(true);
	});

	test("a revise whose branch moved discards the result and fails; its items are still marked seen", async () => {
		await setup();
		pushScript.push(() => ({ pushed: false }));
		const { issue, pr } = await seedReview();
		const job = await runToEnd(issue, "revise", { items: ITEMS });
		expect(job).toMatchObject({ status: "failed", error: BRANCH_MOVED_ERROR });
		expect(h.dispatcher.discarded).toEqual(["fake-run-1"]);
		expect(prComments(pr)).toEqual([]);
		await until(() => failureOf(issue, "revise") !== undefined, "failure message");
		expect([...h.db.seenIds("o/r", pr)]).toEqual(["rc:1"]);
		expect(h.db.getIssue(issue.id)?.state).toBe("in_review");
	});

	test("a re-executed revise that already pushed and commented only posts the thread message (JOB-09)", async () => {
		await setup();
		const { issue, pr } = await seedReview();
		const job = runningJob(issue, "revise", { stage: "followup", run: { summary: "Done.", oomKills: 0, pushed: true }, commented: true }, { items: ITEMS });
		scheduler.recover();
		await until(() => finished(h.db.getJob(job.id)), "revise job");
		expect(h.dispatcher.calls).toEqual([]);
		expect(h.dispatcher.pushes).toEqual([]);
		expect(prComments(pr)).toEqual([]);
		expect(messages(issue).filter(m => m.includes("Review feedback addressed"))).toHaveLength(1);
	});

	test("a fix_ci run stopped at its time limit fails naming limits.fixMinutes (JOB-07)", async () => {
		await setup();
		h.dispatcher.script({ kind: "fix_ci" }, { aborted: "time" });
		const { issue } = await seedReview();
		const job = await runToEnd(issue, "fix_ci", { failures: FAILURES, sha: "head-0" });
		expect(job).toMatchObject({ status: "failed", error: "fix_ci job exceeded the 45 minute time limit (limits.fixMinutes)" });
	});

	test("fix_ci counts the attempt, records the sha, pushes the fix and says so in the thread", async () => {
		await setup();
		const { issue, pr } = await seedReview();
		const job = await runToEnd(issue, "fix_ci", { failures: FAILURES, sha: "head-0" });
		expect(job.status).toBe("succeeded");
		expect(h.dispatcher.calls[0]!.req).toMatchObject({ kind: "fix_ci", resume: true, limits: { minutes: 45 } });
		expect(h.dispatcher.calls[0]!.req.prompt).toContain("CI checks failed on this branch's pull request.");
		expect(h.dispatcher.pushes).toHaveLength(1);
		expect(h.db.getIssue(issue.id)).toMatchObject({ ci_attempts: 1, ci_last_sha: "head-0" });
		expect(prComments(pr)).toEqual([]);
		expect(messages(issue).some(m => m.startsWith(`✅ **CI fix pushed** to PR #${pr} (attempt 1/3).`))).toBe(true);
	});

	test("fix_ci without a fix comments on the PR and says it needs a human (JOB-23)", async () => {
		await setup();
		h.dispatcher.script({ kind: "fix_ci" }, { commits: 0, output: { summary: "Infra outage." } });
		const { issue, pr } = await seedReview();
		const job = await runToEnd(issue, "fix_ci", { failures: FAILURES, sha: "head-0" });
		expect(job.status).toBe("succeeded");
		expect(h.dispatcher.pushes).toEqual([]);
		expect(prComments(pr)).toEqual(["Robo could not find a fix for test\n\nInfra outage."]);
		expect(messages(issue).some(m => m.startsWith(`⚠️ **Couldn't fix the failing checks** (test) on PR #${pr} (attempt 1/3) — this needs a human.`))).toBe(true);
	});

	test("a resumed fix_ci does not count another attempt", async () => {
		await setup();
		const { issue } = await seedReview();
		h.db.updateIssue(issue.id, { ci_attempts: 2, ci_last_sha: "head-0" });
		await runToEnd(issue, "fix_ci", { failures: FAILURES, sha: "head-0", resume: true });
		expect(h.db.getIssue(issue.id)).toMatchObject({ ci_attempts: 2 });
		expect(messages(issue).some(m => m.startsWith("✅ **CI fix pushed** to PR #") && m.includes("(attempt 2/3)."))).toBe(true);
		expect(h.dispatcher.calls[0]!.req.prompt).toContain("Robo restarted while you were working.");
	});
});
