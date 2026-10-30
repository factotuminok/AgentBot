import { afterEach, describe, expect, test } from "bun:test";
import type { RunOwner } from "../../src/orchestrator/dispatch/dispatcher";
import type { Scheduler } from "../../src/orchestrator/engine/deps";
import { createScheduler } from "../../src/orchestrator/engine/scheduler";
import type { IssueRow, JobRow } from "../../src/orchestrator/store/db";
import { createEngineHarness, type EngineHarness } from "../fakes/engine";

let h: EngineHarness;
afterEach(async () => {
	await h?.stop();
});

/** Jobs run in the background against the fake GitHub's HTTP server; poll for the awaited condition. */
async function until(check: () => boolean, what = "condition"): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

const finished = (job: JobRow | null) => job !== null && job.status !== "queued" && job.status !== "running";
const jobOwner = (job: JobRow): RunOwner => ({ kind: "job", jobId: job.id });

async function setup(config?: Record<string, unknown>) {
	h = await createEngineHarness({ config });
	h.gh.addRepo("o/r");
}

/** A queued issue with its labelled GitHub issue, top message and thread; no job yet. */
async function seedIssue(title = "Add thing"): Promise<IssueRow> {
	const fake = h.gh.addIssue("o/r", { title, labels: ["agentbot"] });
	const top = await h.discord.send(h.workChannelId, { content: `📥 **#${fake.number} ${title}**` });
	const threadId = await h.discord.startThread(top, { name: title, autoArchiveMinutes: 10080 });
	const issue = h.db.insertIssue("o/r", fake.number, title);
	return h.db.updateIssue(issue.id, { thread_id: threadId });
}

const failureIn = (threadId: string) => h.discord.messages(threadId).find(m => m.content.startsWith("❌ ") && m.components.length > 0);

describe("scheduler failure path", () => {
	test("a plan job failing before the agent starts leaves the issue failed with a Retry button", async () => {
		await setup();
		const issue = await seedIssue();
		h.gh.failRoute(/^GET \/repos\/o\/r\/issues\/\d+$/, 422);
		const job = createScheduler(h.deps).enqueue(issue.id, "plan");
		await until(() => failureIn(issue.thread_id!) !== undefined, "failure message");

		expect(h.db.getIssue(issue.id)?.state).toBe("failed");
		expect(h.db.getJob(job.id)?.status).toBe("failed");
		expect(h.dispatcher.calls).toHaveLength(0);
		expect(h.gh.getIssue("o/r", issue.number).labels.sort()).toEqual(["agentbot", "agentbot:failed"]);
		expect(failureIn(issue.thread_id!)!.content).toStartWith("❌ plan failed: ");
	});

	test("a failed revise keeps the issue in review and marks its feedback seen so polling does not re-run it", async () => {
		await setup();
		const issue = await seedIssue();
		h.db.updateIssue(issue.id, { state: "in_review", pr_number: 42 });
		createScheduler(h.deps).enqueue(issue.id, "revise", { items: [{ id: "rc:1" }, { id: "review:2" }] });
		await until(() => failureIn(issue.thread_id!) !== undefined, "failure message");

		expect(h.db.getIssue(issue.id)?.state).toBe("in_review");
		expect([...h.db.seenIds("o/r", 42)].sort()).toEqual(["rc:1", "review:2"]);
	});

	test("a failure on an issue that is already terminal does not change its state (ISS-05)", async () => {
		await setup();
		const issue = await seedIssue();
		h.dispatcher.once({ kind: "plan" }, { error: "boom", steps: [{ delayMs: 20 }] });
		const job = createScheduler(h.deps).enqueue(issue.id, "plan");
		await until(() => h.dispatcher.runs.length === 1, "run");
		h.db.setIssueState(issue.id, "cancelled");
		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.db.getIssue(issue.id)?.state).toBe("cancelled");
		expect(failureIn(issue.thread_id!)).toBeUndefined();
	});
});

describe("scheduling (JOB-02, JOB-03)", () => {
	test("runs at most maxConcurrentJobs at once and starts the next job when one finishes", async () => {
		await setup({ limits: { maxConcurrentJobs: 1 } });
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const scheduler = createScheduler(h.deps);
		const a = await seedIssue("A");
		const b = await seedIssue("B");
		const jobA = scheduler.enqueue(a.id, "plan");
		const jobB = scheduler.enqueue(b.id, "plan");
		await until(() => h.dispatcher.runs.length === 1, "first run");
		expect(h.db.getJob(jobB.id)?.status).toBe("queued");
		h.dispatcher.run(jobOwner(jobA))!.finish();
		await until(() => h.dispatcher.runs.length === 2, "second run");
		expect(h.dispatcher.runs[1]!.req.owner).toEqual(jobOwner(jobB));
		await until(() => finished(h.db.getJob(jobA.id)), "first job");
		expect(h.db.getJob(jobA.id)?.status).toBe("succeeded");
	});

	test("one running job per issue: a second job of the same issue waits", async () => {
		await setup({ limits: { maxConcurrentJobs: 2 } });
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const scheduler = createScheduler(h.deps);
		const issue = await seedIssue();
		scheduler.enqueue(issue.id, "plan");
		const second = scheduler.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.runs.length === 1, "run");
		expect(h.db.getJob(second.id)?.status).toBe("queued");
		expect(scheduler.isBusy(issue.id)).toBe(true);
	});
});

describe("cancelIssue (JOB-05)", () => {
	test("cancels queued jobs, aborts the live run, moves the issue to cancelled and cleans up", async () => {
		await setup();
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const scheduler = createScheduler(h.deps);
		const issue = await seedIssue();
		const running = scheduler.enqueue(issue.id, "plan");
		const queued = scheduler.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.run(jobOwner(running))?.registered === true, "registered run");

		await scheduler.cancelIssue(issue.id, "issue closed");

		expect(h.dispatcher.runs[0]!.aborted).toBe("user");
		await until(() => finished(h.db.getJob(running.id)), "running job");
		expect(h.db.getJob(running.id)?.status).toBe("cancelled");
		expect(h.db.getJob(queued.id)?.status).toBe("cancelled");
		expect(h.db.getIssue(issue.id)?.state).toBe("cancelled");
		const contents = h.discord.messages(issue.thread_id!).map(m => m.content);
		expect(contents).toContain("⏹️ **Cancelled** — issue closed. Archiving this thread.");
		expect(h.discord.channels().find(c => c.id === issue.thread_id)?.archived).toBe(true);
		expect(failureIn(issue.thread_id!)).toBeUndefined();
	});

	test("a cancel before the run registered is applied when it registers (AGT-07)", async () => {
		await setup();
		const gate = Promise.withResolvers<void>();
		h.dispatcher.once({ kind: "plan" }, { registerAt: 1, steps: [{ until: gate.promise }, { delayMs: 1 }], hold: true });
		const scheduler = createScheduler(h.deps);
		const issue = await seedIssue();
		const job = scheduler.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.runs.length === 1, "run");
		expect(await scheduler.steer(issue.id, "hi", "alice")).toBe("not-ready");

		await scheduler.cancelIssue(issue.id, "stop");
		expect(h.dispatcher.runs[0]!.aborted).toBeUndefined();
		gate.resolve();

		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.dispatcher.runs[0]!.aborted).toBe("user");
		expect(h.db.getJob(job.id)?.status).toBe("cancelled");
	});

	test("an issue that is already terminal only has its jobs and run stopped (GH-14)", async () => {
		await setup();
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const scheduler = createScheduler(h.deps);
		const issue = await seedIssue();
		const job = scheduler.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.run(jobOwner(job))?.registered === true, "registered run");
		h.db.setIssueState(issue.id, "done");
		await scheduler.cancelIssue(issue.id, "merged");
		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.db.getJob(job.id)?.status).toBe("cancelled");
		expect(h.db.getIssue(issue.id)?.state).toBe("done");
		expect(h.discord.messages(issue.thread_id!).some(m => m.content.includes("Cancelled"))).toBe(false);
	});
});

describe("steer", () => {
	test("reaches the issue's live run; none without one", async () => {
		await setup();
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const scheduler = createScheduler(h.deps);
		const issue = await seedIssue();
		expect(await scheduler.steer(issue.id, "hi", "alice")).toBe("none");
		const job = scheduler.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.run(jobOwner(job))?.registered === true, "registered run");
		expect(await scheduler.steer(issue.id, "use the cache", "alice")).toBe("delivered");
		expect(h.dispatcher.runs[0]!.steers).toEqual([{ text: "use the cache", from: "alice" }]);
	});
});

describe("detach and recover (JOB-08, RUN-09)", () => {
	test("detach leaves the job running and the run going; the next engine re-attaches and finishes it", async () => {
		await setup();
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const first = createScheduler(h.deps);
		const issue = await seedIssue();
		const job = first.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.run(jobOwner(job))?.registered === true, "registered run");

		await first.detach();

		expect(h.db.getJob(job.id)?.status).toBe("running");
		expect(h.dispatcher.hasUnfinishedRun(jobOwner(job))).toBe(true);
		expect(h.dispatcher.runs[0]!.aborted).toBeUndefined();
		expect(h.dispatcher.runs[0]!.attached).toBe(false);
		// A detached scheduler claims nothing new.
		const other = await seedIssue("Other");
		const queued = first.enqueue(other.id, "plan");
		expect(h.db.getJob(queued.id)?.status).toBe("queued");
		h.db.cancelQueuedJobs(other.id);

		const second: Scheduler = createScheduler(h.deps);
		second.recover();
		await until(() => h.dispatcher.runs[0]!.attached, "re-attach");
		expect(h.dispatcher.runs).toHaveLength(1);
		expect(h.dispatcher.calls.at(-1)?.attached).toBe(true);
		h.dispatcher.runs[0]!.finish();

		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(h.db.getIssue(issue.id)?.state).toBe("awaiting_approval");
		expect(h.gh.getIssue("o/r", issue.number).comments).toHaveLength(1);
		expect(h.db.raw.query("SELECT count(*) AS n FROM agent_runs").get()).toEqual({ n: 1 });
	});

	test("a run that finished while detached is delivered on re-attach", async () => {
		await setup();
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const first = createScheduler(h.deps);
		const issue = await seedIssue();
		const job = first.enqueue(issue.id, "plan");
		await until(() => h.dispatcher.run(jobOwner(job))?.registered === true, "registered run");
		await first.detach();
		h.dispatcher.runs[0]!.finish();
		expect(h.dispatcher.run(jobOwner(job))).toBeDefined();

		createScheduler(h.deps).recover();
		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(h.dispatcher.run(jobOwner(job))).toBeUndefined();
		expect(h.db.raw.query("SELECT count(*) AS n FROM agent_runs").get()).toEqual({ n: 1 });
	});

	test("a run lost while detached is requeued once with resume: true (RUN-04)", async () => {
		await setup();
		const issue = await seedIssue();
		h.db.setIssueState(issue.id, "planning");
		h.db.insertJob(issue.id, "plan");
		const job = h.db.claimNextJob()!;
		h.dispatcher.markLost(jobOwner(job));

		createScheduler(h.deps).recover();
		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(JSON.parse(h.db.getJob(job.id)!.input)).toMatchObject({ resume: true, lost: 1 });
		expect(h.dispatcher.calls).toHaveLength(2);
	});

	test("a second loss fails the job", async () => {
		await setup();
		h.dispatcher.script({ kind: "plan" }, { lost: true });
		const issue = await seedIssue();
		const job = createScheduler(h.deps).enqueue(issue.id, "plan");
		await until(() => finished(h.db.getJob(job.id)), "job");
		expect(h.db.getJob(job.id)).toMatchObject({ status: "failed", error: "the worker running this was lost (pod evicted or crashed)" });
		expect(h.dispatcher.runs).toHaveLength(2);
		expect(h.dispatcher.runs[1]!.req.resume).toBe(false);
		await until(() => failureIn(issue.thread_id!) !== undefined, "failure message");
		expect(h.db.getIssue(issue.id)?.state).toBe("failed");
	});
});
