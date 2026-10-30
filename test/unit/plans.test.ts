import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeId, type PlanRequestAction, parseId } from "../../src/orchestrator/discord/render";
import type { Actor } from "../../src/orchestrator/discord/surface";
import { cannedOutput, createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import type { Scheduler } from "../../src/orchestrator/engine/deps";
import { PLAN_COMMENT_MARKER } from "../../src/orchestrator/engine/jobs";
import { CAPACITY_REACHED } from "../../src/orchestrator/engine/chatSlots";
import { createPlanner, type Planner, STALE_PLAN } from "../../src/orchestrator/engine/plans";
import { REQUEST_PLAN_SCHEMA, type RequestPlanOutput } from "../../src/orchestrator/engine/prompts";
import type { JobKind } from "../../src/orchestrator/engine/state";
import { PLAN_THREAD_MARKER } from "../../src/orchestrator/github/poller";
import { parseJson } from "../../src/orchestrator/store/db";
import type { FakeMessage } from "../fakes/discord";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

const OUTPUT: RequestPlanOutput = {
	title: "Add a retry option to the loader",
	summary: "Adds `--retries` and backs off between attempts.",
	planMarkdown: "## Context\nThe loader gives up after one failure.\n\n## Approach\n1. Add the option.",
	complexity: "small",
};
const REQUEST = "Let the loader retry";

interface Setup {
	h: EngineHarness;
	dispatcher: FakeDispatcher;
	planner: Planner;
	enqueued: { issueId: number; kind: JobKind }[];
	alice: Actor;
	/** Swaps the planner the fake Discord delivers to (a restarted engine). */
	restart(): Promise<Planner>;
}

let current: Setup | undefined;

afterEach(async () => {
	if (!current) return;
	await current.planner.stop();
	await current.h.stop();
	current = undefined;
});

async function setup(opts: { limits?: Record<string, unknown> } = {}): Promise<Setup> {
	const dispatcher = createFakeDispatcher({ cannedOutput: req => (req.kind === "plan" ? OUTPUT : cannedOutput(req)) });
	const h = await createEngineHarness({ dispatcher, config: opts.limits ? { limits: opts.limits } : {} });
	h.gh.addRepo("o/r");
	const enqueued: { issueId: number; kind: JobKind }[] = [];
	const scheduler: Scheduler = {
		enqueue(issueId, kind, input) {
			enqueued.push({ issueId, kind });
			return h.db.insertJob(issueId, kind, input);
		},
		tick() {},
		async cancelIssue() {},
		async stopJobs() {},
		isBusy: () => false,
		steer: async () => "none",
		recover() {},
		async detach() {},
	};
	const repo = await h.deps.github.repo("o/r");
	let planner = createPlanner(h.deps, { scheduler });
	h.discord.onEvent(async event => {
		if (event.type === "command") {
			await event.defer({ ephemeral: true });
			await planner.command(event, repo);
		} else if (event.type === "component" || event.type === "modal") {
			const id = parseId(event.customId);
			if (id?.type !== "preq") return;
			if (event.type === "component") await planner.component(event, id);
			else await planner.modal(event, id);
		} else if (event.type === "message") {
			handled.push(await planner.message(event));
		}
	});
	await h.discord.login("token");
	current = {
		h,
		dispatcher,
		planner,
		enqueued,
		alice: h.discord.actor(ALLOWED_USER, { username: "alice" }),
		async restart() {
			await planner.stop();
			planner = createPlanner(h.deps, { scheduler });
			if (current) current.planner = planner;
			planner.start();
			return planner;
		},
	};
	return current;
}

/** What `planner.message` returned for each delivered thread message, in order. */
const handled: boolean[] = [];

/** Waits for work the planner does in the background (runs, GitHub calls and the Discord queue settle off the handler). */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** Runs `/work plan` in the work channel and returns the new thread's id and the command's responses. */
async function plan(s: Setup, prompt = REQUEST) {
	const before = s.h.discord.messages(s.h.workChannelId).length;
	const emitted = await s.h.discord.emitCommand({ command: "work", subcommand: "plan", options: { prompt }, actor: s.alice, channelId: s.h.workChannelId });
	const top = s.h.discord.messages(s.h.workChannelId)[before];
	return { threadId: top?.id ?? "", emitted };
}

const thread = (s: Setup, threadId: string): FakeMessage[] => s.h.discord.messages(threadId);
const reviews = (s: Setup, threadId: string) => thread(s, threadId).filter(m => m.content.includes("Plan ready for your review"));
const posted = (s: Setup, threadId: string, text: string) => thread(s, threadId).find(m => m.content.includes(text));
const topIcon = (s: Setup, threadId: string) => s.h.discord.message(threadId)?.content.split(" ")[0];

/** A planned thread whose rev-1 plan is up for review. */
async function planned(s: Setup) {
	const { threadId } = await plan(s);
	await until(() => reviews(s, threadId).length === 1 && s.h.db.getPlan(threadId)?.review_message_id != null, "the review message");
	await until(() => !s.planner.active().includes(threadId), "the run to settle");
	return threadId;
}

async function click(s: Setup, threadId: string, action: PlanRequestAction, rev = 1, actor = s.alice) {
	const review = reviews(s, threadId).find(m => m.files.some(f => f.name === `plan-rev${rev}.md`)) ?? reviews(s, threadId)[0]!;
	return s.h.discord.emitComponent({
		message: { channelId: threadId, messageId: review.id },
		customId: encodeId({ type: "preq", threadId, rev, action }),
		actor,
	});
}

function fakeRepo(s: Setup) {
	return s.h.gh.getRepo("o/r");
}

describe("/work plan (DSC-25)", () => {
	test("a full chat budget refuses up front, before any message or thread exists", async () => {
		const s = await setup({ limits: { maxChatSessions: 1 } });
		void s.h.deps.chatSlots.track("chat:busy", new Promise(() => {}));
		const { emitted } = await plan(s);
		expect(emitted.responses.map(r => r.type)).toEqual(["defer", "editReply"]);
		expect(emitted.responses[1]!.msg?.content).toBe(CAPACITY_REACHED);
		expect(s.h.discord.messages(s.h.workChannelId)).toHaveLength(0);
		expect(s.h.db.plansInState("planning")).toHaveLength(0);
		expect(s.dispatcher.calls).toHaveLength(0);
	});

	test("posts the starter, plans on a private checkout of the base branch and posts the plan for review", async () => {
		const s = await setup();
		const { threadId, emitted } = await plan(s);
		expect(s.h.discord.message(threadId)?.content).toMatch(/^\S+ \*\*Plan\*\* — Let the loader retry$/);
		expect(emitted.responses.at(-1)?.msg?.content).toContain(`<#${threadId}>`);
		await until(() => reviews(s, threadId).length === 1, "the review message");
		const [call] = s.dispatcher.calls;
		expect(call!.req.owner).toEqual({ kind: "plan", threadId });
		expect(call!.req.kind).toBe("plan");
		expect(call!.req.profile).toBe("plan");
		expect(call!.req.outputSchema).toBe(REQUEST_PLAN_SCHEMA);
		expect(call!.req.session).toBe(`plan-${threadId}`);
		expect(call!.req.resume).toBe(false);
		expect(call!.req.limits.minutes).toBe(s.h.deps.config.limits.planMinutes);
		expect(call!.req.prompt).toContain(REQUEST);
		expect(call!.req.checkout?.repo).toBe("o/r");
		expect(call!.req.checkout?.issueBranch).toBeUndefined();
		expect(await call!.req.checkout!.defaultBranch()).toBe(fakeRepo(s).defaultBranch);

		const review = reviews(s, threadId)[0]!;
		expect(review.files.map(f => f.name)).toEqual(["plan-rev1.md"]);
		expect(review.content).toContain(OUTPUT.title);
		expect(review.components[0]!.components.map(c => ("label" in c ? c.label : ""))).toEqual(["Approve", "Execute", "Refine", "Reject"]);
		await until(() => topIcon(s, threadId) === "📋", "the awaiting icon");
		const row = s.h.db.getPlan(threadId)!;
		expect(row.state).toBe("awaiting");
		expect(row.rev).toBe(1);
		expect(row.review_message_id).toBe(review.id);
		expect(row.session_file).toBe(`plan-${threadId}`);
		await until(() => !s.h.deps.chatSlots.has(`plan:${threadId}`), "the chat slot to be released");
	});

	test("a run that fails marks the plan failed and says so in the thread", async () => {
		const s = await setup();
		s.dispatcher.once({ kind: "plan" }, { error: "model unavailable" });
		const { threadId } = await plan(s);
		await until(() => !!posted(s, threadId, "❌ **Planning failed:** model unavailable"), "the failure message");
		expect(s.h.db.getPlan(threadId)?.state).toBe("failed");
	});
});

describe("plan decisions (DSC-26)", () => {
	test("Approve files an unlabelled issue holding the full plan, starts nothing and points to /work start", async () => {
		const s = await setup();
		const threadId = await planned(s);
		const emitted = await click(s, threadId, "approve");
		expect(emitted.responses[0]!.type).toBe("deferUpdate");
		const filed = [...fakeRepo(s).issues.values()];
		expect(filed).toHaveLength(1);
		expect(filed[0]!.title).toBe(OUTPUT.title);
		expect(filed[0]!.labels).toEqual([]);
		expect(filed[0]!.body).toContain(`> ${REQUEST}`);
		expect(filed[0]!.body).toContain(OUTPUT.summary);
		expect(filed[0]!.body).toContain(OUTPUT.planMarkdown);
		expect(filed[0]!.body).not.toContain(PLAN_THREAD_MARKER);
		const row = s.h.db.getPlan(threadId)!;
		expect(row.state).toBe("approved");
		expect(row.issue_number).toBe(filed[0]!.number);
		expect(s.h.db.findIssue("o/r", filed[0]!.number)).toBeNull();
		expect(s.enqueued).toEqual([]);
		const review = reviews(s, threadId)[0]!;
		expect(review.content).toContain(`/work start repo:o/r issue:${filed[0]!.number}`);
		expect(review.components).toEqual([]);
	});

	test("Execute files a labelled issue, tracks it in this thread in implementing and queues implement", async () => {
		const s = await setup();
		const threadId = await planned(s);
		await click(s, threadId, "execute");
		const [filed] = [...fakeRepo(s).issues.values()];
		expect(filed!.body).toContain(PLAN_THREAD_MARKER);
		expect(filed!.labels).toEqual([s.h.deps.labels.trigger, s.h.deps.labels.states.implementing]);
		// No state label other than implementing was ever applied.
		const labelWrites = s.h.gh.requests.filter(r => r.method === "POST" && r.path.endsWith("/labels")).flatMap(r => JSON.stringify(r.body));
		for (const label of [s.h.deps.labels.states.planning, s.h.deps.labels.states.awaitingApproval]) {
			expect(labelWrites.join()).not.toContain(label);
			expect(filed!.labels).not.toContain(label);
		}

		const issue = s.h.db.findIssue("o/r", filed!.number)!;
		expect(issue.state).toBe("implementing");
		expect(issue.thread_id).toBe(threadId);
		expect(issue.plan_rev).toBe(1);
		const planJob = s.h.db.latestJob(issue.id, "plan")!;
		expect(parseJson<RequestPlanOutput>(planJob.result)?.planMarkdown).toBe(OUTPUT.planMarkdown);
		expect(s.enqueued).toEqual([{ issueId: issue.id, kind: "implement" }]);

		expect(filed!.comments).toHaveLength(1);
		expect(filed!.comments[0]!.body.startsWith(`${PLAN_COMMENT_MARKER}\n## ${s.h.deps.config.agent.name} plan (rev 1)\n`)).toBe(true);
		expect(issue.plan_comment_id).toBe(filed!.comments[0]!.id);
		expect(s.h.discord.message(threadId)?.content).toBe(`🛠️ **#${filed!.number} ${OUTPUT.title}** — <https://github.com/o/r/issues/${filed!.number}>`);
		const row = s.h.db.getPlan(threadId)!;
		expect(row.state).toBe("executing");
		expect(row.executed_at).not.toBeNull();
		expect(reviews(s, threadId)[0]!.content).toContain("🚀 Execute pressed by @alice");
		// The thread is the issue's now.
		await s.h.discord.emitMessage({ channelId: threadId, content: "how is it going?", actor: s.alice });
		expect(handled.at(-1)).toBe(false);
	});

	test("a restart between filing and binding completes the Execute without filing again", async () => {
		const s = await setup();
		const threadId = await planned(s);
		// The orchestrator died right after GitHub filed the issue: the plan row holds its number, nothing else happened.
		const gh = s.h.gh.addIssue("o/r", { title: OUTPUT.title, body: PLAN_THREAD_MARKER, labels: [s.h.deps.labels.trigger] });
		expect(s.h.db.claimPlan(threadId, 1, "awaiting", "executing")).not.toBeNull();
		s.h.db.updatePlan(threadId, { issue_number: gh.number });

		await s.restart();
		await until(() => s.h.db.getPlan(threadId)?.executed_at != null, "the Execute to complete");
		expect(fakeRepo(s).issues.size).toBe(1);
		const issue = s.h.db.findIssue("o/r", gh.number)!;
		expect(issue.state).toBe("implementing");
		expect(issue.thread_id).toBe(threadId);
		expect(gh.comments).toHaveLength(1);
		expect(s.enqueued).toEqual([{ issueId: issue.id, kind: "implement" }]);

		// The old buttons are stale, and another restart repeats nothing.
		expect((await click(s, threadId, "execute")).responses[0]).toMatchObject({ type: "reply", ephemeral: true, msg: { content: STALE_PLAN } });
		await s.restart();
		await s.h.discord.settled();
		expect(fakeRepo(s).issues.size).toBe(1);
		expect(gh.comments).toHaveLength(1);
		expect(s.enqueued).toHaveLength(1);
	});

	test("a restart after binding finishes the remaining steps once", async () => {
		const s = await setup();
		const threadId = await planned(s);
		s.h.gh.failRoute(/POST .*\/issues\/\d+\/comments$/, 422);
		await click(s, threadId, "execute");
		const [filed] = [...fakeRepo(s).issues.values()];
		const issue = s.h.db.findIssue("o/r", filed!.number)!;
		expect(issue.plan_comment_id).toBeNull();
		// Simulate the crash before the plan comment and the hand-over were recorded.
		s.h.db.updatePlan(threadId, { executed_at: null });
		s.h.gh.failRoute(/POST .*\/issues\/\d+\/comments$/, undefined);
		await s.restart();
		await until(() => s.h.db.getPlan(threadId)?.executed_at != null, "the Execute to complete");
		expect(filed!.comments).toHaveLength(1);
		expect(s.h.db.findIssue("o/r", filed!.number)!.plan_comment_id).toBe(filed!.comments[0]!.id);
		expect(s.enqueued).toHaveLength(1);
	});

	test("a failed filing puts the plan back up for decision", async () => {
		const s = await setup();
		const threadId = await planned(s);
		s.h.gh.failRoute(/POST .*\/repos\/o\/r\/issues$/, 422);
		const emitted = await click(s, threadId, "execute");
		expect(emitted.responses.at(-1)).toMatchObject({ type: "followUp", ephemeral: true });
		expect(emitted.responses.at(-1)!.msg?.content).toContain("Couldn't file the issue");
		expect(s.h.db.getPlan(threadId)?.state).toBe("awaiting");
		expect(s.h.db.getPlan(threadId)?.issue_number).toBeNull();
		s.h.gh.failRoute(/POST .*\/repos\/o\/r\/issues$/, undefined);
		await click(s, threadId, "approve");
		expect(s.h.db.getPlan(threadId)?.state).toBe("approved");
		expect(fakeRepo(s).issues.size).toBe(1);
	});

	test("only the first decision on the latest revision acts; everything else is stale", async () => {
		const s = await setup();
		const threadId = await planned(s);
		const [first, second] = await Promise.all([click(s, threadId, "approve"), click(s, threadId, "execute")]);
		const stale = [first, second].filter(e => e.responses[0]?.type === "reply");
		expect(stale).toHaveLength(1);
		expect(stale[0]!.responses[0]).toMatchObject({ ephemeral: true, msg: { content: STALE_PLAN } });
		expect(fakeRepo(s).issues.size).toBe(1);
		for (const action of ["approve", "execute", "reject", "refine"] as const) {
			expect((await click(s, threadId, action)).responses[0]).toMatchObject({ type: "reply", ephemeral: true, msg: { content: STALE_PLAN } });
		}
		expect((await click(s, threadId, "approve", 7)).responses[0]?.msg?.content).toBe(STALE_PLAN);
	});

	test("Refine asks what should change and re-plans resuming the session; the older revision goes stale", async () => {
		const s = await setup();
		const threadId = await planned(s);
		const opened = await click(s, threadId, "refine");
		const modal = opened.responses[0]!;
		expect(modal.type).toBe("showModal");
		const customId = encodeId({ type: "preq", threadId, rev: 1, action: "refine" });
		expect(modal.modal?.custom_id).toBe(customId);
		expect(JSON.stringify(modal.modal)).toContain("What should change?");

		const review = reviews(s, threadId)[0]!;
		const submitted = await s.h.discord.emitModal({
			customId,
			fields: { feedback: "Cap the retries at five." },
			message: { channelId: threadId, messageId: review.id },
			actor: s.alice,
		});
		expect(submitted.responses[0]!.type).toBe("deferUpdate");
		expect(review.content).toContain("✏️ Refine requested by @alice");
		await until(() => reviews(s, threadId).length === 2, "the second revision");
		const call = s.dispatcher.calls.at(-1)!;
		expect(call.req.resume).toBe(true);
		expect(call.req.session).toBe(`plan-${threadId}`);
		expect(call.req.prompt).toContain("Cap the retries at five.");
		expect(call.req.prompt).toContain(OUTPUT.planMarkdown);
		expect(reviews(s, threadId)[1]!.files[0]!.name).toBe("plan-rev2.md");
		await until(() => s.h.db.getPlan(threadId)?.rev === 2 && s.h.db.getPlan(threadId)?.state === "awaiting", "rev 2 awaiting");
		expect((await click(s, threadId, "approve", 1)).responses[0]?.msg?.content).toBe(STALE_PLAN);
		// A second submit of the same modal is stale too.
		const again = await s.h.discord.emitModal({ customId, fields: { feedback: "x" }, message: { channelId: threadId, messageId: review.id }, actor: s.alice });
		expect(again.responses[0]?.msg?.content).toBe(STALE_PLAN);
	});

	test("Reject deletes the plan session and archives the thread", async () => {
		const s = await setup();
		const threadId = await planned(s);
		mkdirSync(s.h.deps.sessionDir, { recursive: true });
		const sessionFile = join(s.h.deps.sessionDir, `plan-${threadId}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		await click(s, threadId, "reject");
		const row = s.h.db.getPlan(threadId)!;
		expect(row.state).toBe("rejected");
		expect(row.session_file).toBeNull();
		expect(existsSync(sessionFile)).toBe(false);
		expect(reviews(s, threadId)[0]!.content).toContain("⏹️ Rejected by @alice");
		expect(posted(s, threadId, "**Plan rejected.**")).toBeDefined();
		await s.h.discord.settled();
		expect(s.h.discord.channels().find(c => c.id === threadId)?.archived).toBe(true);
		expect(fakeRepo(s).issues.size).toBe(0);
	});
});

describe("plan thread replies (DSC-27)", () => {
	test("planning: a reply steers the run, or answers its waiting question", async () => {
		const s = await setup();
		s.dispatcher.once({ kind: "plan" }, { hold: true, output: OUTPUT });
		const { threadId } = await plan(s);
		await until(() => !!s.dispatcher.run({ kind: "plan", threadId })?.registered, "the run to register");
		const sent = await s.h.discord.emitMessage({ channelId: threadId, content: "Also cover the CLI.", actor: s.alice });
		expect(handled.at(-1)).toBe(true);
		const run = s.dispatcher.run({ kind: "plan", threadId })!;
		await until(() => s.h.discord.message(sent.ref!.messageId)!.reactions.includes("👀"), "the steer acknowledgement");
		expect(run.steers).toEqual([{ text: "Also cover the CLI.", from: "alice" }]);

		const answer = s.h.deps.replies.next(threadId, 5000);
		await s.h.discord.emitMessage({ channelId: threadId, content: "Option 2", actor: s.alice });
		expect(await answer).toBe("Option 2");
		expect(run.steers).toHaveLength(1);
		run.finish();
		await until(() => reviews(s, threadId).length === 1, "the review");
	});

	test("awaiting, approved and rejected plans point to what to do next", async () => {
		const s = await setup();
		const threadId = await planned(s);
		const reply = async (text: string) => {
			const sent = await s.h.discord.emitMessage({ channelId: threadId, content: text, actor: s.alice });
			expect(handled.at(-1)).toBe(true);
			await s.h.discord.settled();
			return thread(s, threadId).find(m => m.replyTo === sent.ref!.messageId)?.content ?? "";
		};
		expect(await reply("hello?")).toContain("waiting for your decision");
		await click(s, threadId, "approve");
		const n = s.h.db.getPlan(threadId)!.issue_number;
		expect(await reply("now what?")).toContain(`/work start repo:o/r issue:${n}`);

		const other = await planned(s);
		await click(s, other, "reject");
		const sent = await s.h.discord.emitMessage({ channelId: other, content: "wait", actor: s.alice });
		await s.h.discord.settled();
		expect(thread(s, other).find(m => m.replyTo === sent.ref!.messageId)?.content).toContain("`/work plan`");
	});

	test("failed: the reply re-plans with itself as feedback", async () => {
		const s = await setup();
		s.dispatcher.once({ kind: "plan" }, { error: "boom" });
		const { threadId } = await plan(s);
		await until(() => s.h.db.getPlan(threadId)?.state === "failed", "the failure");
		await s.h.discord.emitMessage({ channelId: threadId, content: "Try the async loader instead.", actor: s.alice });
		expect(handled.at(-1)).toBe(true);
		await until(() => reviews(s, threadId).length === 1, "the plan");
		expect(s.dispatcher.calls.at(-1)!.req.prompt).toContain("Try the async loader instead.");
		expect(s.h.db.getPlan(threadId)?.state).toBe("awaiting");
	});

	test("messages outside plan threads are not handled", async () => {
		const s = await setup();
		const other = s.h.discord.addChannel({ name: "elsewhere", kind: "thread", parentId: s.h.workChannelId, guildId: "g1" });
		await s.h.discord.emitMessage({ channelId: other.id, content: "hi", actor: s.alice });
		expect(handled.at(-1)).toBe(false);
	});
});

describe("restarts (DSC-28, RUN-14)", () => {
	test("decisions that never reached GitHub reopen; lost planning runs fail and say so", async () => {
		const s = await setup();
		const approved = await planned(s);
		const executing = await planned(s);
		s.h.db.claimPlan(approved, 1, "awaiting", "approved");
		s.h.db.claimPlan(executing, 1, "awaiting", "executing");
		s.h.db.insertPlan("999000111", "o/r", "Lost one", "alice");
		const lostThread = s.h.discord.addChannel({ id: "999000111", name: "lost", kind: "thread", parentId: s.h.workChannelId, guildId: "g1" });
		// Its worker was lost while no orchestrator was attached (RUN-04).
		s.dispatcher.markLost({ kind: "plan", threadId: lostThread.id });
		await s.restart();
		await until(() => s.h.db.getPlan(lostThread.id)?.state === "failed", "the lost plan to fail");
		expect(s.h.db.getPlan(approved)?.state).toBe("awaiting");
		expect(s.h.db.getPlan(executing)?.state).toBe("awaiting");
		await until(() => !!posted(s, lostThread.id, "the worker running this was lost"), "the thread to be told");
		// The reopened buttons work again.
		await click(s, approved, "approve");
		expect(s.h.db.getPlan(approved)?.state).toBe("approved");
	});

	test("a planning turn that never reached a worker before the restart is started again, not reported lost", async () => {
		const s = await setup();
		s.h.db.insertPlan("999000222", "o/r", "Plan a thing", "alice");
		s.h.discord.addChannel({ id: "999000222", name: "unstarted", kind: "thread", parentId: s.h.workChannelId, guildId: "g1" });
		await s.restart();
		await until(() => reviews(s, "999000222").length === 1, "the plan");
		expect(s.dispatcher.calls.find(c => c.req.owner.kind === "plan")?.req).toMatchObject({ resume: false });
		expect(posted(s, "999000222", "the worker running this was lost")).toBeFalsy();
		expect(s.h.db.getPlan("999000222")?.state).toBe("awaiting");
	});

	test("a planning run re-attaches after a restart, keeps its status message and posts the plan", async () => {
		const s = await setup();
		s.dispatcher.once({ kind: "plan" }, { hold: true, output: OUTPUT });
		const { threadId } = await plan(s);
		await until(() => !!s.dispatcher.run({ kind: "plan", threadId })?.registered, "the run to register");
		await s.h.discord.settled();
		const statusBefore = thread(s, threadId).filter(m => m.content.includes("Planning"));
		expect(statusBefore).toHaveLength(1);

		const planner = await s.restart();
		await until(() => s.dispatcher.calls.some(c => c.attached), "the re-attach");
		expect(planner.active()).toEqual([threadId]);
		expect(s.h.deps.chatSlots.has(`plan:${threadId}`)).toBe(true);
		s.dispatcher.run({ kind: "plan", threadId })!.finish();
		await until(() => reviews(s, threadId).length === 1, "the review");
		expect(thread(s, threadId).filter(m => m.content.includes("Planning") && !m.content.includes("review"))).toHaveLength(1);
		expect(s.h.db.getPlan(threadId)?.state).toBe("awaiting");
	});

	test("a plan stored as awaiting whose review was never posted is posted at start", async () => {
		const s = await setup();
		const threadId = await planned(s);
		s.h.db.updatePlan(threadId, { review_message_id: null });
		await s.restart();
		await until(() => reviews(s, threadId).length === 2 && s.h.db.getPlan(threadId)?.review_message_id === reviews(s, threadId)[1]!.id, "the review to be reposted");
	});
});

describe("/work cancel in a plan thread", () => {
	test("stops a planning run, rejects an awaiting plan, and ignores other threads", async () => {
		const s = await setup();
		s.dispatcher.once({ kind: "plan" }, { hold: true, output: OUTPUT });
		const { threadId } = await plan(s);
		await until(() => !!s.dispatcher.run({ kind: "plan", threadId })?.registered, "the run to register");
		expect(await s.planner.cancel(threadId, "@alice")).toContain("Stopping planning");
		await until(() => !!posted(s, threadId, "⏹️ **Planning stopped.**"), "the stopped message");
		expect(s.h.db.getPlan(threadId)?.state).toBe("failed");
		expect(await s.planner.cancel(threadId, "@alice")).toBe("Nothing to cancel: this plan is failed.");

		const awaiting = await planned(s);
		expect(await s.planner.cancel(awaiting, "@alice")).toBe("⏹️ Rejected by @alice");
		expect(s.h.db.getPlan(awaiting)?.state).toBe("rejected");
		expect(reviews(s, awaiting)[0]!.components).toEqual([]);
		await s.h.discord.settled();
		expect(s.h.discord.channels().find(c => c.id === awaiting)?.archived).toBe(true);

		expect(await s.planner.cancel("123456", "@alice")).toBeUndefined();
		const executed = await planned(s);
		await click(s, executed, "execute");
		expect(await s.planner.cancel(executed, "@alice")).toBeUndefined();
	});
});
