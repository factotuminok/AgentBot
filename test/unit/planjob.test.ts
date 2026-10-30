import { afterEach, describe, expect, test } from "bun:test";
import { RunDetached } from "../../src/orchestrator/dispatch/dispatcher";
import type { TrackIssue } from "../../src/orchestrator/engine/deps";
import { createTrackIssue } from "../../src/orchestrator/engine/issues";
import { type PlanJobResult, PLAN_COMMENT_MARKER, runJob } from "../../src/orchestrator/engine/jobs";
import { createScheduler } from "../../src/orchestrator/engine/scheduler";
import type { IssueRow, JobRow } from "../../src/orchestrator/store/db";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

let h: EngineHarness;
afterEach(async () => {
	await h?.stop();
});

/** Jobs run in the background against the fake GitHub's HTTP server; poll the DB for the awaited condition. */
async function until(check: () => boolean, what = "condition"): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

const finished = (job: JobRow | null) => job !== null && job.status !== "queued" && job.status !== "running";

async function setup(config?: Record<string, unknown>) {
	h = await createEngineHarness({ config });
	h.gh.addRepo("o/r");
	const scheduler = createScheduler(h.deps);
	return { scheduler, trackIssue: createTrackIssue(h.deps, scheduler) };
}

/** Files a labelled issue on the fake GitHub and tracks it (GH-12); returns the issue row and its plan job. */
async function track(trackIssue: TrackIssue, title = "Add thing", body = "Please add the thing.") {
	const fake = h.gh.addIssue("o/r", { title, body, labels: ["agentbot"] });
	const gh = await h.deps.github.getIssue("o/r", fake.number);
	const issue = await trackIssue("o/r", gh, { via: "label" });
	const job = h.db.latestJob(issue.id, "plan", "queued") ?? h.db.activeJob(issue.id)!;
	return { issue, job, number: fake.number };
}

function planMessages(threadId: string) {
	return h.discord.messages(threadId).filter(m => m.content.includes("Plan ready for your approval"));
}

describe("tracking a new issue (GH-12, DSC-34)", () => {
	test("an unwatched repo's issue opens its thread in the work channel with the 📥 top message and a queued note", async () => {
		const { trackIssue } = await setup();
		const { issue, number } = await track(trackIssue);
		const top = h.discord.messages(h.workChannelId)[0]!;
		expect(top.content).toStartWith(`📥 **#${number} Add thing** — <https://github.com/o/r/issues/${number}>`);
		const thread = h.discord.channels().find(c => c.id === issue.thread_id)!;
		expect(thread).toMatchObject({ kind: "thread", parentId: h.workChannelId, name: `#${number} Add thing` });
		expect(h.discord.messages(thread.id)[0]?.content).toContain("Queued for planning");
		expect(h.db.getIssue(issue.id)?.thread_id).toBe(thread.id);
	});

	test("a repo with a watch channel opens the thread there, watched or not", async () => {
		const { trackIssue } = await setup();
		const channel = h.discord.addChannel({ name: "o-r", guildId: "g1" });
		h.db.watchRepo({ repoId: h.gh.getRepo("o/r").id, repo: "o/r", channelId: channel.id, createdBy: "u" });
		h.db.updateWatch(h.gh.getRepo("o/r").id, { state: "unwatched" });
		const { issue } = await track(trackIssue);
		expect(h.discord.channels().find(c => c.id === issue.thread_id)?.parentId).toBe(channel.id);
	});

	test("the thread name is cut to 100 characters", async () => {
		const { trackIssue } = await setup();
		const { issue } = await track(trackIssue, "x".repeat(150));
		expect(h.discord.channels().find(c => c.id === issue.thread_id)?.name).toHaveLength(100);
	});
});

describe("plan job (JOB-12 to JOB-16)", () => {
	test("runs the plan profile and publishes the comment, the approval message, labels and icon", async () => {
		const { trackIssue } = await setup({ models: { plan: "anthropic/opus" }, agent: { name: "Robo" } });
		const { issue, job, number } = await track(trackIssue);
		await until(() => finished(h.db.getJob(job.id)), "plan job");

		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		const row = h.db.getIssue(issue.id)!;
		expect(row).toMatchObject({ state: "awaiting_approval", plan_rev: 1, plan_session: `issue-${issue.id}-plan` });

		const req = h.dispatcher.calls[0]!.req;
		expect(req).toMatchObject({
			owner: { kind: "job", jobId: job.id },
			kind: "plan",
			profile: "plan",
			model: "anthropic/opus",
			session: `issue-${issue.id}-plan`,
			resume: false,
			checkout: { repo: "o/r" },
			threadId: issue.thread_id,
			limits: { minutes: 30, costUsd: 15 },
		});
		expect(req.prompt).toStartWith("Keep a todo list for this request with the `update_todos` tool; Robo shows it");
		expect(req.prompt).toContain("Do not modify, create, or delete any files.");
		expect(req.prompt).toContain("Never amend, rebase or otherwise rewrite the start commit.");
		expect(req.prompt).toContain(`## Issue #${number}: Add thing`);

		const comments = h.gh.getIssue("o/r", number).comments;
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toStartWith(`${PLAN_COMMENT_MARKER}\n## Robo plan (rev 1)\nCanned plan from the fake dispatcher.`);
		expect(row.plan_comment_id).toBe(comments[0]!.id);

		const [message] = planMessages(issue.thread_id!);
		expect(message).toBeDefined();
		expect(message!.content).toContain("rev 1");
		expect(message!.content).toContain("complexity: **small**");
		expect(message!.content).toContain(comments[0]!.html_url);
		expect(message!.content).toContain(`<@${ALLOWED_USER}>`);
		expect(message!.mentions?.users).toEqual([ALLOWED_USER]);
		expect(message!.files.map(f => f.name)).toEqual(["plan-rev1.md"]);
		const labels = message!.components.flatMap(row => row.components.map(c => ("label" in c ? c.label : undefined)));
		expect(labels).toEqual(["Approve", "Request changes", "Reject"]);

		expect(h.gh.getIssue("o/r", number).labels.sort()).toEqual(["agentbot", "agentbot:awaiting-approval"]);
		expect(h.discord.messages(h.workChannelId)[0]!.content).toStartWith("📋 ");

		const result = JSON.parse(h.db.getJob(job.id)!.result!) as PlanJobResult;
		expect(result).toMatchObject({ complexity: "small", rev: 1, announced: true, comment: { id: comments[0]!.id } });
		expect(h.db.raw.query("SELECT kind, job_id, issue_number FROM agent_runs").all()).toEqual([{ kind: "plan", job_id: job.id, issue_number: number }]);
		expect(h.deps.agentLog.recent(100).filter(e => e.run === job.id).map(e => e.type)).toEqual(["prompt", "run_end"]);
	});

	test("reads comments without the plan comment, each cut to 4000 characters", async () => {
		const { trackIssue } = await setup();
		const fake = h.gh.addIssue("o/r", { title: "T", labels: ["agentbot"] });
		h.gh.addIssueComment("o/r", fake.number, { body: `${PLAN_COMMENT_MARKER}\nold plan`, login: "agentbot[bot]" });
		h.gh.addIssueComment("o/r", fake.number, { body: "a".repeat(5000), login: "alice" });
		const issue = await trackIssue("o/r", await h.deps.github.getIssue("o/r", fake.number), { via: "label" });
		await until(() => h.db.getIssue(issue.id)?.state === "awaiting_approval", "plan");
		const prompt = h.dispatcher.calls[0]!.req.prompt;
		expect(prompt).not.toContain("old plan");
		expect(prompt).toContain("### @alice");
		expect(prompt).toContain(`${"a".repeat(4000)}\n…[truncated]`);
		expect(prompt).not.toContain("a".repeat(4001));
	});

	test("live progress and the to-do list are shown in the thread (DSC-10 to DSC-13)", async () => {
		const { trackIssue } = await setup();
		h.dispatcher.script(
			{ kind: "plan" },
			{
				steps: [
					{ todos: [{ content: "Read the code", status: "in_progress" }] },
					{ progress: { tool: "grep", intent: "Finding the loader" } },
					{ todos: [{ content: "Read the code", status: "completed" }] },
				],
			},
		);
		const { issue, job } = await track(trackIssue);
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		await h.discord.settled();
		const contents = h.discord.messages(issue.thread_id!).map(m => m.content);
		expect(contents.some(c => c.includes("Planning #"))).toBe(true);
		expect(contents.some(c => c.includes("Read the code"))).toBe(true);
	});

	test("a question goes to the thread and a typed reply answers it (DSC-16, DSC-18)", async () => {
		const { trackIssue } = await setup();
		h.dispatcher.script({ kind: "plan" }, { steps: [{ ui: (ui, signal) => ui.input("Which database?", undefined, { signal }) }] });
		const { issue, job } = await track(trackIssue);
		await until(() => h.discord.messages(issue.thread_id!).some(m => m.content.includes("Which database?")), "question");
		await until(() => h.deps.replies.deliver(issue.thread_id!, "Postgres"), "reply waiter");
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		expect(h.dispatcher.runs[0]!.answers).toEqual(["Postgres"]);
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
	});

	test("a revision resumes the plan session with the latest plan and the feedback, and edits the one comment", async () => {
		const { scheduler, trackIssue } = await setup();
		const { issue, job, number } = await track(trackIssue);
		await until(() => finished(h.db.getJob(job.id)), "first plan");
		const first = h.db.getIssue(issue.id)!;
		h.db.setIssueState(issue.id, "planning");
		h.dispatcher.once({ kind: "plan" }, { output: { summary: "Second", planMarkdown: "## Plan v2", complexity: "medium" } });
		const revision = scheduler.enqueue(issue.id, "plan", { revision: { feedback: "Use a queue instead." } });
		await until(() => finished(h.db.getJob(revision.id)), "revision");

		const req = h.dispatcher.calls[1]!.req;
		expect(req).toMatchObject({ session: `issue-${issue.id}-plan`, resume: true });
		expect(req.prompt).toContain("### Feedback\nUse a queue instead.");
		expect(req.prompt).toContain("### Previous plan\n## Plan\n1. Make the change.");
		const comments = h.gh.getIssue("o/r", number).comments;
		expect(comments).toHaveLength(1);
		expect(comments[0]!.id).toBe(first.plan_comment_id!);
		expect(comments[0]!.body).toContain("plan (rev 2)\nSecond");
		expect(h.db.getIssue(issue.id)).toMatchObject({ plan_rev: 2, state: "awaiting_approval" });
		expect(planMessages(issue.thread_id!).map(m => m.files[0]?.name)).toEqual(["plan-rev1.md", "plan-rev2.md"]);
	});

	test("a time limit fails the job naming the limit, with Retry (JOB-07, ISS-05)", async () => {
		const { trackIssue } = await setup();
		h.dispatcher.once({ kind: "plan" }, { aborted: "time" });
		const { issue, job, number } = await track(trackIssue);
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		const failureOf = () => h.discord.messages(issue.thread_id!).find(m => m.content.startsWith("❌ plan failed"));
		await until(() => failureOf() !== undefined, "failure message");
		expect(h.db.getJob(job.id)).toMatchObject({ status: "failed", error: "plan job exceeded the 30 minute time limit (limits.planMinutes)" });
		expect(h.db.getIssue(issue.id)?.state).toBe("failed");
		const failure = failureOf()!;
		expect(failure.content).toBe("❌ plan failed: plan job exceeded the 30 minute time limit (limits.planMinutes)");
		expect(failure.components[0]!.components.map(c => ("label" in c ? c.label : undefined))).toEqual(["Retry"]);
		expect(h.gh.getIssue("o/r", number).labels.sort()).toEqual(["agentbot", "agentbot:failed"]);
		// OBS-05: the run's usage is recorded whatever the outcome.
		expect(h.db.raw.query("SELECT count(*) AS n FROM agent_runs").get()).toEqual({ n: 1 });
	});

	test("the cost limit is named too", async () => {
		const { trackIssue } = await setup();
		h.dispatcher.once({ kind: "plan" }, { aborted: "cost" });
		const { job } = await track(trackIssue);
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		expect(h.db.getJob(job.id)?.error).toBe("plan job exceeded the $15 cost limit (limits.maxCostUsdPerJob)");
	});

	test("an implement job after the plan runs on the published plan and opens the PR", async () => {
		const { scheduler, trackIssue } = await setup();
		const { issue, job: plan, number } = await track(trackIssue);
		await until(() => finished(h.db.getJob(plan.id)), "plan");
		// The fake dispatcher's push does not reach the fake GitHub; the branch is there already.
		h.gh.getRepo("o/r").branches.set(`agentbot/issue-${number}-add-thing`, "pushed");
		h.db.setIssueState(issue.id, "implementing");
		const job = scheduler.enqueue(issue.id, "implement");
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(h.dispatcher.calls[1]!.req.prompt).toContain("## Approved plan\n## Plan\n1. Make the change.");
		expect(h.db.getIssue(issue.id)).toMatchObject({ state: "in_review", branch: `agentbot/issue-${number}-add-thing` });
	});

	test("a failed implement job leaves the issue failed", async () => {
		const { scheduler, trackIssue } = await setup();
		const { issue, job: plan } = await track(trackIssue);
		await until(() => finished(h.db.getJob(plan.id)), "plan");
		h.dispatcher.once({ kind: "implement" }, { commits: 0 });
		h.db.setIssueState(issue.id, "implementing");
		const job = scheduler.enqueue(issue.id, "implement");
		await until(() => finished(h.db.getJob(job.id)), "implement job");
		expect(h.db.getJob(job.id)).toMatchObject({ status: "failed", error: "Agent produced no commits" });
		await until(() => h.db.getIssue(issue.id)?.state === "failed", "failed state");
	});
});

describe("restart safety (JOB-08, JOB-09)", () => {
	/** An issue in `planning` with its thread and a running plan job whose stored result is `result`. */
	async function runningPlanJob(result: Partial<PlanJobResult> | undefined): Promise<{ issue: IssueRow; job: JobRow; number: number }> {
		const fake = h.gh.addIssue("o/r", { title: "Add thing", labels: ["agentbot", "agentbot:planning"] });
		const top = await h.discord.send(h.workChannelId, { content: `🛠️ **#${fake.number} Add thing**` });
		const threadId = await h.discord.startThread(top, { name: "t", autoArchiveMinutes: 10080 });
		const inserted = h.db.insertIssue("o/r", fake.number, "Add thing");
		const issue = h.db.updateIssue(inserted.id, { state: "planning", thread_id: threadId });
		h.db.insertJob(issue.id, "plan");
		const job = h.db.claimNextJob()!;
		if (result) h.db.setJobResult(job.id, { summary: "S", planMarkdown: "## P", complexity: "large", rev: 1, ...result });
		return { issue, job, number: fake.number };
	}

	test("a plan stored but not yet published is published without re-planning", async () => {
		h = await createEngineHarness();
		h.gh.addRepo("o/r");
		const { issue, job, number } = await runningPlanJob({});
		createScheduler(h.deps).recover();
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		expect(h.dispatcher.calls).toHaveLength(0);
		expect(h.gh.getIssue("o/r", number).comments).toHaveLength(1);
		expect(planMessages(issue.thread_id!)).toHaveLength(1);
		expect(h.db.getIssue(issue.id)).toMatchObject({ state: "awaiting_approval", plan_rev: 1 });
	});

	test("a plan already commented on is not commented again; only the message and the state update follow", async () => {
		h = await createEngineHarness();
		h.gh.addRepo("o/r");
		const { issue, job, number } = await runningPlanJob({ comment: { id: 77, url: "https://github.com/o/r/issues/1#issuecomment-77" } });
		createScheduler(h.deps).recover();
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		expect(h.gh.getIssue("o/r", number).comments).toHaveLength(0);
		expect(h.gh.requests.filter(r => r.path.includes("/comments"))).toEqual([]);
		expect(planMessages(issue.thread_id!)[0]?.content).toContain("issuecomment-77");
		expect(h.db.getIssue(issue.id)?.state).toBe("awaiting_approval");
	});

	test("a fully published plan job only completes", async () => {
		h = await createEngineHarness();
		h.gh.addRepo("o/r");
		const { issue, job } = await runningPlanJob({ comment: { id: 77, url: "u" }, announced: true });
		h.db.setIssueState(issue.id, "awaiting_approval");
		const before = h.gh.requests.length;
		createScheduler(h.deps).recover();
		await until(() => finished(h.db.getJob(job.id)), "plan job");
		expect(h.db.getJob(job.id)?.status).toBe("succeeded");
		expect(h.discord.messages(issue.thread_id!)).toHaveLength(0);
		expect(h.gh.requests).toHaveLength(before);
	});

	test("runJob rejects with RunDetached when its signal aborts, and the run keeps going", async () => {
		h = await createEngineHarness();
		h.gh.addRepo("o/r");
		h.dispatcher.script({ kind: "plan" }, { hold: true });
		const { issue, job } = await runningPlanJob(undefined);
		const controller = new AbortController();
		const running = runJob(h.deps, job, controller.signal);
		await until(() => h.dispatcher.runs.length === 1, "run start");
		controller.abort();
		expect(running).rejects.toBeInstanceOf(RunDetached);
		await running.catch(() => {});
		expect(h.dispatcher.hasUnfinishedRun({ kind: "job", jobId: job.id })).toBe(true);
		expect(h.db.getIssue(issue.id)?.state).toBe("planning");
	});
});
