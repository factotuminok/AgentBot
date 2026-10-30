import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { attachBot, type BotHandle } from "../../src/orchestrator/discord/bot";
import { encodeId } from "../../src/orchestrator/discord/render";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type AskChat, createAskChat } from "../../src/orchestrator/engine/chat";
import type { Scheduler } from "../../src/orchestrator/engine/deps";
import { createTrackIssue } from "../../src/orchestrator/engine/issues";
import { createScheduler } from "../../src/orchestrator/engine/scheduler";
import { createPoller } from "../../src/orchestrator/github/poller";
import type { Actor } from "../../src/orchestrator/discord/surface";
import type { JobKind } from "../../src/orchestrator/engine/state";
import type { IssueRow, JobRow, JobStatus } from "../../src/orchestrator/store/db";
import type { Emitted, FakeMessage } from "../fakes/discord";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

interface Bot {
	h: EngineHarness;
	bot: BotHandle;
	scheduler: Scheduler;
	askChat: AskChat;
	allowed: Actor;
	stranger: Actor;
}

let current: Bot | undefined;

afterEach(async () => {
	if (!current) return;
	current.bot.detach();
	await current.scheduler.detach();
	await current.askChat.stop();
	await current.h.stop();
	current = undefined;
});

async function setup(opts: { config?: Record<string, unknown>; dispatcher?: FakeDispatcher } = {}): Promise<Bot> {
	const h = await createEngineHarness(opts);
	const scheduler = createScheduler(h.deps);
	const trackIssue = createTrackIssue(h.deps, scheduler);
	const poller = createPoller(h.deps, scheduler, trackIssue);
	const askChat = createAskChat(h.deps, { scratchRoot: join(h.stateDir, "scratch") });
	const bot = attachBot({ deps: h.deps, connection: h.discord, scheduler, trackIssue, poller, askChat });
	await h.discord.login("token");
	current = {
		h,
		bot,
		scheduler,
		askChat,
		allowed: h.discord.actor(ALLOWED_USER, { username: "alice" }),
		stranger: h.discord.actor("u-stranger", { username: "mallory" }),
	};
	return current;
}

/** The ephemeral text of the interaction's final answer (reply or edited deferred reply). */
function answerText(e: Emitted): string {
	const last = e.responses.findLast(r => r.type === "reply" || r.type === "editReply" || r.type === "followUp");
	return last?.msg?.content ?? "";
}

/**
 * Waits for a condition the engine reaches in the background (jobs run off the scheduler and call the fake GitHub over
 * real HTTP), so neither fake timers nor a single promise covers it; the short sleep only yields to that I/O.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

function work(b: Bot, subcommand: string, options: Record<string, string | number> = {}, opts: { actor?: Actor; channelId?: string } = {}): Promise<Emitted> {
	return b.h.discord.emitCommand({ command: "work", subcommand, options, actor: opts.actor ?? b.allowed, channelId: opts.channelId ?? b.h.workChannelId });
}

/** `/work start` on a fresh labelled-or-not issue, then waits for the canned plan to reach "Plan ready for your approval". */
async function issueAwaitingApproval(b: Bot): Promise<{ issue: IssueRow; plan: FakeMessage }> {
	b.h.gh.addRepo("acme/app");
	const gh = b.h.gh.addIssue("acme/app", { title: "Add a thing" });
	await work(b, "start", { repo: "acme/app", issue: gh.number });
	await until(() => b.h.db.findIssue("acme/app", gh.number)?.state === "awaiting_approval", "awaiting_approval");
	const issue = b.h.db.findIssue("acme/app", gh.number)!;
	await until(() => !b.scheduler.isBusy(issue.id), "the plan job to finish");
	await b.h.discord.settled();
	const plan = b.h.discord.messages(issue.thread_id!).findLast(m => m.components.length > 0);
	if (!plan) throw new Error("no plan message with buttons");
	return { issue, plan };
}

const planId = (issue: IssueRow, action: "approve" | "changes" | "reject", rev = issue.plan_rev) => encodeId({ type: "plan", issueId: issue.id, rev, action });

/** The issue's latest job of `kind` in each status (the DB has no "all jobs" query). */
function jobsOf(b: Bot, issueId: number, kind: JobKind): JobRow[] {
	const statuses: JobStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];
	return statuses.flatMap(s => b.h.db.latestJob(issueId, kind, s) ?? []);
}

describe("ready", () => {
	test("registers exactly /work and /ask and sets the nickname (DSC-01, DSC-29)", async () => {
		const b = await setup({ config: { agent: { name: "Forgey" } } });
		await b.h.discord.triggerReady();
		expect(b.h.discord.commands("g1")?.map(c => c.name)).toEqual(["work", "ask"]);
		expect(b.h.discord.nickname("g1")).toBe("Forgey");
		expect(b.bot.nicknameWarning()).toBeUndefined();
	});

	test("without Change Nickname the bot warns and carries on; the warning clears once allowed", async () => {
		const b = await setup();
		b.h.discord.deny("ChangeNickname");
		await b.h.discord.triggerReady();
		expect(b.h.discord.commands("g1")?.length).toBe(2);
		expect(b.bot.nicknameWarning()).toContain("Change Nickname");
		b.h.discord.deny("ChangeNickname", false);
		await b.h.discord.triggerReady();
		expect(b.bot.nicknameWarning()).toBeUndefined();
	});
});

describe("access (DSC-02 to DSC-04, DSC-33)", () => {
	test("a non-allowed member is refused with not-allowed", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/app");
		const e = await work(b, "start", { repo: "acme/app", issue: 1 }, { actor: b.stranger });
		expect(e.responses).toHaveLength(1);
		expect(e.responses[0]).toMatchObject({ type: "reply", ephemeral: true });
		expect(answerText(e)).toContain("Not authorized");
		expect(b.h.db.findIssue("acme/app", 1)).toBeNull();
	});

	test("repository commands outside the work channel and watch channels are refused", async () => {
		const b = await setup();
		const other = b.h.discord.addChannel({ name: "general", guildId: "g1" });
		const before = b.h.gh.requests.length;
		for (const sub of ["start", "issue", "plan", "ask", "watch", "unwatch"]) {
			const e = await work(b, sub, { repo: "acme/app", issue: 1, request: "x", prompt: "x" }, { channelId: other.id });
			expect(e.responses[0]).toMatchObject({ type: "reply", ephemeral: true });
			expect(answerText(e)).not.toBe("");
		}
		expect(b.h.gh.requests.slice(before)).toEqual([]);
	});

	test("buttons from non-allowed members get Not authorized.", async () => {
		const b = await setup();
		const e = await b.h.discord.emitComponent({ message: { channelId: b.h.workChannelId, messageId: "m1" }, customId: "plan:1:1:approve", actor: b.stranger });
		expect(e.responses).toEqual([{ type: "reply", msg: { content: "Not authorized.", ephemeral: true }, ephemeral: true }]);
	});

	test("/ask outside an ask channel is refused; /work issue, plan and ask need workers", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/app");
		const ask = await b.h.discord.emitCommand({ command: "ask", options: { prompt: "hi" }, actor: b.allowed, channelId: b.h.workChannelId });
		expect(ask.responses[0]).toMatchObject({ type: "reply", ephemeral: true });
		for (const sub of ["issue", "plan", "ask"]) {
			const e = await work(b, sub, { repo: "acme/app", request: "x", prompt: "x" });
			expect(answerText(e)).toContain("needs agent workers");
		}
		expect(b.h.db.openIssues()).toEqual([]);
	});
});

describe("/work start", () => {
	test("on an unwatched repo opens the thread in the work channel, labels the issue and links the thread", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/app");
		const gh = b.h.gh.addIssue("acme/app", { title: "Add a thing" });
		const e = await work(b, "start", { repo: "acme/app", issue: gh.number });
		const issue = b.h.db.findIssue("acme/app", gh.number)!;
		expect(issue.thread_id).not.toBeNull();
		expect(answerText(e)).toContain(`<#${issue.thread_id}>`);
		expect(e.responses.every(r => r.type !== "reply" || r.ephemeral)).toBe(true);
		const thread = b.h.discord.channels().find(c => c.id === issue.thread_id)!;
		expect(thread.parentId).toBe(b.h.workChannelId);
		expect(b.h.gh.getIssue("acme/app", gh.number).labels).toContain("agentbot");

		const again = await work(b, "start", { repo: "acme/app", issue: gh.number });
		expect(answerText(again)).toContain("already tracked");
		expect(answerText(again)).toContain(`<#${issue.thread_id}>`);
	});

	test("a closed issue must be reopened first", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/app");
		const gh = b.h.gh.addIssue("acme/app", { title: "Old" });
		b.h.gh.updateIssue("acme/app", gh.number, { state: "closed" });
		const e = await work(b, "start", { repo: "acme/app", issue: gh.number });
		expect(answerText(e)).toContain("reopen");
		expect(b.h.db.findIssue("acme/app", gh.number)).toBeNull();
	});

	test("the repository is required in the work channel and checked against the available ones (DSC-09)", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/old", { archived: true });
		expect(answerText(await work(b, "start", { issue: 1 }))).toContain("`repo`");
		expect(answerText(await work(b, "start", { repo: "acme/nope", issue: 1 }))).toContain("not a repository the GitHub App can access");
		expect(answerText(await work(b, "start", { repo: "acme/old", issue: 1 }))).toContain("archived (read-only)");
		expect(b.h.db.openIssues()).toEqual([]);
	});
});

describe("/work watch and unwatch (DSC-35 to DSC-38)", () => {
	test("watch creates the channel; /work start there defaults the repo and opens the thread in it; unwatch keeps it", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/app");
		const e = await work(b, "watch", { repo: "acme/app" });
		const watch = b.h.db.watchByName("acme/app")!;
		expect(watch.state).toBe("watching");
		expect(answerText(e)).toContain(`<#${watch.channel_id}>`);
		const channel = b.h.discord.channels().find(c => c.id === watch.channel_id)!;
		expect(channel.created).toBe(true);
		expect(channel.name).toBe("acme-app");

		expect(answerText(await work(b, "watch", { repo: "acme/app" }))).toContain(`<#${watch.channel_id}>`);
		expect(b.h.discord.channels().filter(c => c.created && c.kind === "text")).toHaveLength(1);

		const gh = b.h.gh.addIssue("acme/app", { title: "Here" });
		await work(b, "start", { issue: gh.number }, { channelId: watch.channel_id });
		const issue = b.h.db.findIssue("acme/app", gh.number)!;
		expect(b.h.discord.channels().find(c => c.id === issue.thread_id)?.parentId).toBe(watch.channel_id);

		await work(b, "unwatch", {}, { channelId: watch.channel_id });
		expect(b.h.db.watchByName("acme/app")?.state).toBe("unwatched");
		expect(b.h.discord.channels().some(c => c.id === watch.channel_id)).toBe(true);
	});

	test("without Manage Channels watch fails with the reason and the invite link", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/app");
		b.h.discord.deny("ManageChannels");
		const e = await work(b, "watch", { repo: "acme/app" });
		expect(answerText(e)).toContain("Manage Channels");
		expect(answerText(e)).toContain("discord.com/oauth2/authorize");
		expect(b.h.db.watchByName("acme/app")).toBeNull();
	});
});

describe("autocomplete (DSC-09)", () => {
	test("non-archived repos matching the typed text, watched first, at most 25", async () => {
		const b = await setup();
		b.h.gh.addRepo("acme/alpha");
		b.h.gh.addRepo("acme/archived", { archived: true });
		const zeta = b.h.gh.addRepo("acme/zeta");
		b.h.gh.addRepo("other/thing");
		for (let i = 0; i < 30; i++) b.h.gh.addRepo(`many/r${String(i).padStart(2, "0")}`);
		b.h.db.watchRepo({ repoId: zeta.id, repo: "acme/zeta", channelId: "c-zeta", createdBy: ALLOWED_USER });
		const e = await b.h.discord.emitAutocomplete({ command: "work", subcommand: "start", focused: { name: "repo", value: "ACME" }, actor: b.allowed, channelId: b.h.workChannelId });
		expect(e.responses[0]?.choices?.map(c => c.value)).toEqual(["acme/zeta", "acme/alpha"]);

		const many = await b.h.discord.emitAutocomplete({ command: "work", subcommand: "start", focused: { name: "repo", value: "" }, actor: b.allowed, channelId: b.h.workChannelId });
		expect(many.responses[0]?.choices).toHaveLength(25);
		expect(many.responses[0]?.choices?.[0]?.value).toBe("acme/zeta");
	});
});

describe("plan buttons (JOB-17, NFR-05)", () => {
	test("Approve moves on and enqueues implement once; a second click is stale", async () => {
		const b = await setup();
		const { issue, plan } = await issueAwaitingApproval(b);
		const ref = { channelId: plan.channelId, messageId: plan.id };
		const [first, second] = await Promise.all([
			b.h.discord.emitComponent({ message: ref, customId: planId(issue, "approve"), actor: b.allowed }),
			b.h.discord.emitComponent({ message: ref, customId: planId(issue, "approve"), actor: b.allowed }),
		]);
		const texts = [first, second].map(answerText);
		expect(texts.filter(t => t === "This plan is no longer current.")).toHaveLength(1);
		expect(jobsOf(b, issue.id, "implement")).toHaveLength(1);
		await b.h.discord.settled();
		expect(b.h.discord.message(plan.id)?.components).toEqual([]);
		expect(b.h.discord.message(plan.id)?.content).toContain("Approved by @alice");
		const late = await b.h.discord.emitComponent({ message: ref, customId: planId(issue, "approve"), actor: b.allowed });
		expect(answerText(late)).toBe("This plan is no longer current.");
	});

	test("buttons of an older rev are stale", async () => {
		const b = await setup();
		const { issue, plan } = await issueAwaitingApproval(b);
		const e = await b.h.discord.emitComponent({ message: { channelId: plan.channelId, messageId: plan.id }, customId: planId(issue, "approve", issue.plan_rev - 1), actor: b.allowed });
		expect(answerText(e)).toBe("This plan is no longer current.");
		expect(b.h.db.getIssue(issue.id)?.state).toBe("awaiting_approval");
	});

	test("Request changes asks for feedback, then revises the plan with it", async () => {
		const b = await setup();
		const { issue, plan } = await issueAwaitingApproval(b);
		const ref = { channelId: plan.channelId, messageId: plan.id };
		const click = await b.h.discord.emitComponent({ message: ref, customId: planId(issue, "changes"), actor: b.allowed });
		const modal = click.responses[0]?.modal;
		expect(modal?.custom_id).toBe(planId(issue, "changes"));
		const submit = await b.h.discord.emitModal({ customId: modal!.custom_id, fields: { feedback: "Use a map" }, message: ref, actor: b.allowed, channelId: plan.channelId });
		expect(answerText(submit)).toContain("revised");
		const revision = jobsOf(b, issue.id, "plan").map(j => JSON.parse(j.input).revision).find(Boolean);
		expect(revision).toEqual({ feedback: "Use a map" });
		expect(b.h.db.getIssue(issue.id)?.state).not.toBe("awaiting_approval");
		await b.h.discord.settled();
		expect(b.h.discord.message(plan.id)?.content).toContain("Use a map");
		// The same modal submitted twice (double click) is stale.
		const again = await b.h.discord.emitModal({ customId: modal!.custom_id, fields: { feedback: "Again" }, message: ref, actor: b.allowed, channelId: plan.channelId });
		expect(answerText(again)).toBe("This plan is no longer current.");
	});

	test("Reject removes the trigger label, comments and cancels the issue", async () => {
		const b = await setup();
		const { issue, plan } = await issueAwaitingApproval(b);
		await b.h.discord.emitComponent({ message: { channelId: plan.channelId, messageId: plan.id }, customId: planId(issue, "reject"), actor: b.allowed });
		expect(b.h.db.getIssue(issue.id)?.state).toBe("cancelled");
		const gh = b.h.gh.getIssue("acme/app", issue.number);
		expect(gh.labels).not.toContain("agentbot");
		expect(gh.comments.some(c => c.body.includes("Plan rejected by alice"))).toBe(true);
	});
});

describe("thread messages (DSC-18, DSC-23, DSC-24)", () => {
	test("steering is acknowledged with 👀 when delivered and ⏳ when queued; idle threads get a status reply", async () => {
		const dispatcher = createFakeDispatcher();
		dispatcher.script({ kind: "plan" }, { hold: true }, 1);
		const b = await setup({ dispatcher });
		b.h.gh.addRepo("acme/app");
		const gh = b.h.gh.addIssue("acme/app", { title: "Steer me" });
		await work(b, "start", { repo: "acme/app", issue: gh.number });
		const issue = b.h.db.findIssue("acme/app", gh.number)!;
		await until(() => dispatcher.runs.some(r => r.registered), "a registered run");
		const run = dispatcher.runs[0]!;

		const delivered = await b.h.discord.emitMessage({ channelId: issue.thread_id!, content: "use tabs", actor: b.allowed });
		await b.h.discord.settled();
		expect(b.h.discord.message(delivered.ref!.messageId)?.reactions).toEqual(["👀"]);
		expect(run.steers.map(s => s.text)).toEqual(["use tabs"]);

		const ignored = await b.h.discord.emitMessage({ channelId: issue.thread_id!, content: "hi", actor: b.stranger });
		await b.h.discord.settled();
		expect(b.h.discord.message(ignored.ref!.messageId)?.reactions).toEqual([]);
		expect(run.steers).toHaveLength(1);

		// A waiting question takes the message as its answer (DSC-18); the question message, not the reply, shows delivery (RUN-15).
		const answer = b.h.deps.replies.next(issue.thread_id!, 60_000);
		const typed = await b.h.discord.emitMessage({ channelId: issue.thread_id!, content: "yes", actor: b.allowed });
		expect(await answer).toBe("yes");
		await b.h.discord.settled();
		expect(b.h.discord.message(typed.ref!.messageId)?.reactions).toEqual([]);
		expect(run.steers).toHaveLength(1);
	});

	test("a message for a run that cannot take it yet is marked ⏳, then 👀 once delivered (RUN-15)", async () => {
		const dispatcher = createFakeDispatcher();
		dispatcher.script({ kind: "plan" }, { hold: true, steerResult: "queued" }, 1);
		const b = await setup({ dispatcher });
		b.h.gh.addRepo("acme/app");
		const gh = b.h.gh.addIssue("acme/app", { title: "Queue me" });
		await work(b, "start", { repo: "acme/app", issue: gh.number });
		const issue = b.h.db.findIssue("acme/app", gh.number)!;
		await until(() => dispatcher.runs.some(r => r.registered), "a registered run");
		const e = await b.h.discord.emitMessage({ channelId: issue.thread_id!, content: "later", actor: b.allowed });
		await until(() => b.h.discord.message(e.ref!.messageId)?.reactions.includes("⏳") === true, "⏳");
		dispatcher.runs[0]!.deliverSteers();
		await until(() => b.h.discord.message(e.ref!.messageId)?.reactions.join() === "👀", "👀 replacing ⏳");
	});

	test("a message the run ended before reading gets a Not delivered reply", async () => {
		const dispatcher = createFakeDispatcher();
		dispatcher.script({ kind: "plan" }, { hold: true, steerResult: "queued" }, 1);
		const b = await setup({ dispatcher });
		b.h.gh.addRepo("acme/app");
		const gh = b.h.gh.addIssue("acme/app", { title: "Too late" });
		await work(b, "start", { repo: "acme/app", issue: gh.number });
		const issue = b.h.db.findIssue("acme/app", gh.number)!;
		await until(() => dispatcher.runs.some(r => r.registered), "a registered run");
		const e = await b.h.discord.emitMessage({ channelId: issue.thread_id!, content: "later", actor: b.allowed });
		await until(() => b.h.discord.message(e.ref!.messageId)?.reactions.includes("⏳") === true, "⏳");
		dispatcher.runs[0]!.finish();
		await until(() => b.h.discord.messages(issue.thread_id!).some(m => m.replyTo === e.ref!.messageId && m.content.startsWith("Not delivered")), "Not delivered reply");
		expect(b.h.discord.message(e.ref!.messageId)?.reactions).toEqual([]);
	});

	test("an idle issue thread says what it waits on", async () => {
		const b = await setup();
		const { issue } = await issueAwaitingApproval(b);
		const e = await b.h.discord.emitMessage({ channelId: issue.thread_id!, content: "status?", actor: b.allowed });
		await b.h.discord.settled();
		const reply = b.h.discord.messages(issue.thread_id!).find(m => m.replyTo === e.ref!.messageId);
		expect(reply?.content).toContain("waiting for your decision");
	});
});

describe("/work status and cancel", () => {
	test("status lists watches and open issues, or Nothing active.", async () => {
		const b = await setup();
		expect(answerText(await work(b, "status"))).toBe("Nothing active.");
		const { issue } = await issueAwaitingApproval(b);
		const text = answerText(await work(b, "status"));
		expect(text).toContain(`acme/app#${issue.number} awaiting_approval`);
		expect(text).toContain(`<#${issue.thread_id}>`);
	});

	test("cancel works in an issue thread only", async () => {
		const b = await setup();
		expect(answerText(await work(b, "cancel"))).toBe("Use inside an issue or plan thread");
		const { issue } = await issueAwaitingApproval(b);
		await work(b, "cancel", {}, { channelId: issue.thread_id! });
		expect(b.h.db.getIssue(issue.id)?.state).toBe("cancelled");
	});
});
