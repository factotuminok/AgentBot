import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "../../src/orchestrator/discord/surface";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, type IssueRow, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { parseSettings } from "../../src/shared/config";
import { createFakeDiscord, type Emitted, type FakeDiscord, type FakeMessage } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

/**
 * Phase 2 exit scenarios (implementation.md §4) end to end through the real controller: vault settings, engine start and
 * restart, the poller, the bot and the plan job, against fake Discord, the fake GitHub server and the fake dispatcher.
 * Only external surfaces are driven: Discord events, GitHub state, the vault and `controller.apply()`.
 */

const WORK = "work-channel";
const ALLOWED = "u-allowed";
const PLAN_MARKER = "<!-- agentbot:plan -->";

interface Harness {
	discord: FakeDiscord;
	gh: FakeGitHub;
	dispatcher: FakeDispatcher;
	db: Db;
	vault: Vault;
	controller: Controller;
	alice: Actor;
	/** Content of each thread's top message at the moment the thread was started from it. */
	topAtStart: Map<string, string>;
	writeSettings(trigger: string): void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(): Promise<Harness> {
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-phase2-"));
	const db = openDb(":memory:");
	const vault = await openVault(db);
	await vault.initialize("admin", "correct horse battery");
	const gh = startFakeGitHub();
	const discord = createFakeDiscord({ guildId: "g1", channels: [{ id: WORK, name: "work" }] });
	// Observation only: remember what the top message said when its thread was started (it is edited right after).
	const topAtStart = new Map<string, string>();
	const startThread = discord.startThread.bind(discord);
	discord.startThread = async (from, o) => {
		const content = discord.message(from.messageId)?.content;
		const threadId = await startThread(from, o);
		if (content !== undefined) topAtStart.set(threadId, content);
		return threadId;
	};
	const dispatcher = createFakeDispatcher();
	const controller = createController({
		stateDir,
		db,
		vault,
		agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
		dispatcher,
		connectDiscord: () => discord,
		connectGitHub: ({ appId, privateKey, labels }) => createGitHub({ appId, privateKey, labels, baseUrl: gh.url, throttle: false }),
	});
	cleanups.push(async () => {
		await controller.stop();
		await gh.stop();
		db.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
	const h: Harness = {
		discord,
		gh,
		dispatcher,
		db,
		vault,
		controller,
		alice: discord.actor(ALLOWED, { username: "alice" }),
		topAtStart,
		writeSettings(trigger) {
			vault.writeSettings(
				parseSettings({
					config: {
						discord: { guildId: "g1", allowedUserIds: [ALLOWED], workChannelId: WORK },
						github: { appId: gh.appId, pollIntervalSeconds: 1 },
						labels: { trigger },
					},
					secrets: { discordToken: "discord-token", githubAppPrivateKey: gh.privateKey },
				}),
			);
		},
	};
	h.writeSettings("agentbot");
	await controller.apply();
	expect(controller.status()).toMatchObject({ phase: "running", error: undefined });
	return h;
}

/**
 * Waits for what the engine does in the background (scheduler jobs, poll cycles over real HTTP to the fake GitHub), so
 * neither fake timers nor a single promise covers it; the short sleep only yields to that I/O.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

function work(h: Harness, subcommand: string, options: Record<string, string | number>): Promise<Emitted> {
	return h.discord.emitCommand({ command: "work", subcommand, options, actor: h.alice, channelId: WORK });
}

function answerText(e: Emitted): string {
	return e.responses.findLast(r => r.type === "reply" || r.type === "editReply" || r.type === "followUp")?.msg?.content ?? "";
}

function buttons(m: FakeMessage): { label?: string; custom_id?: string }[] {
	return m.components.flatMap(row => row.components as { label?: string; custom_id?: string }[]);
}

function planMessages(h: Harness, threadId: string): FakeMessage[] {
	return h.discord.messages(threadId).filter(m => m.content.includes("Plan ready for your approval"));
}

function planComments(h: Harness, repo: string, n: number) {
	return h.gh.getIssue(repo, n).comments.filter(c => c.body.startsWith(PLAN_MARKER));
}

/**
 * Waits until the issue's plan is published and the plan job has finished its last step (the `plan_ready` transition:
 * labels, then the 📋 top-message icon), then returns the plan message.
 */
async function awaitPlan(h: Harness, repo: string, n: number): Promise<{ issue: IssueRow; plan: FakeMessage }> {
	await until(() => h.db.findIssue(repo, n)?.state === "awaiting_approval", `${repo}#${n} awaiting approval`);
	const issue = h.db.findIssue(repo, n)!;
	await until(() => planMessages(h, issue.thread_id!).some(m => m.components.length > 0), "the Plan ready message");
	await until(() => !!h.discord.message(issue.thread_id!)?.content.startsWith("📋"), "the 📋 top-message icon");
	await h.dispatcher.idle();
	await h.discord.settled();
	return { issue, plan: planMessages(h, issue.thread_id!).at(-1)! };
}

/** GET requests for one issue: the poller's per-issue check (GH-13), made once per cycle for each tracked issue. */
function issueChecks(h: Harness, repo: string, n: number): number {
	return h.gh.requests.filter(r => r.method === "GET" && r.path.endsWith(`/repos/${repo}/issues/${n}`)).length;
}

/** Two more poll cycles have checked `repo#n`, so at least one whole cycle (new work first) started after this call. */
async function fullPollCycle(h: Harness, repo: string, n: number): Promise<void> {
	const before = issueChecks(h, repo, n);
	await until(() => issueChecks(h, repo, n) >= before + 2, "a full poll cycle", 4000);
}

async function clickButton(h: Harness, m: FakeMessage, label: string): Promise<Emitted> {
	const id = buttons(m).find(b => b.label === label)?.custom_id;
	if (!id) throw new Error(`no ${label} button`);
	return h.discord.emitComponent({ message: { channelId: m.channelId, messageId: m.id }, customId: id, actor: h.alice });
}

describe("phase 2 exit", () => {
	test("watch → label → thread in the repo channel → canned plan awaiting approval", async () => {
		const h = await boot();
		h.gh.addRepo("acme/app");
		const gh = h.gh.addIssue("acme/app", { title: "Add a thing" });

		const e = await work(h, "watch", { repo: "acme/app" });
		const watch = h.db.watchByName("acme/app")!;
		expect(watch.state).toBe("watching");
		expect(answerText(e)).toContain(`<#${watch.channel_id}>`);
		const channel = h.discord.channels().find(c => c.id === watch.channel_id)!;
		expect(channel).toMatchObject({ name: "acme-app", kind: "text", created: true, topic: "Watching acme/app: issues labelled `agentbot` start here." });

		h.gh.updateIssue("acme/app", gh.number, { labels: ["agentbot"] });
		await until(() => !!h.db.findIssue("acme/app", gh.number)?.thread_id, "the labelled issue to be tracked");
		const tracked = h.db.findIssue("acme/app", gh.number)!;
		const thread = h.discord.channels().find(c => c.id === tracked.thread_id)!;
		expect(thread).toMatchObject({ kind: "thread", parentId: watch.channel_id });
		expect(h.topAtStart.get(thread.id)).toStartWith("📥");
		await until(() => h.discord.messages(thread.id).some(m => m.content.includes("Queued for planning")), "Queued for planning");

		const { plan } = await awaitPlan(h, "acme/app", gh.number);
		expect(buttons(plan).map(b => b.label)).toEqual(["Approve", "Request changes", "Reject"]);
		expect(planComments(h, "acme/app", gh.number)).toHaveLength(1);
		const labels = h.gh.getIssue("acme/app", gh.number).labels;
		expect(labels).toContain("agentbot");
		expect(labels).toContain("agentbot:awaiting-approval");
		expect(labels).not.toContain("agentbot:planning");
		expect(h.discord.message(thread.id)?.content).toStartWith("📋");
	});

	test("/work start on an unwatched repo threads in the work channel; labelling there does nothing", async () => {
		const h = await boot();
		h.gh.addRepo("acme/other");
		const started = h.gh.addIssue("acme/other", { title: "Started by hand" });
		const e = await work(h, "start", { repo: "acme/other", issue: started.number });
		const issue = h.db.findIssue("acme/other", started.number)!;
		expect(answerText(e)).toContain(`<#${issue.thread_id}>`);
		expect(h.discord.channels().find(c => c.id === issue.thread_id)?.parentId).toBe(WORK);
		expect(h.gh.getIssue("acme/other", started.number).labels).toContain("agentbot");
		await awaitPlan(h, "acme/other", started.number);

		const threadsBefore = h.discord.channels().filter(c => c.kind === "thread").length;
		const labelled = h.gh.addIssue("acme/other", { title: "Labelled by hand" });
		h.gh.updateIssue("acme/other", labelled.number, { labels: ["agentbot"] });
		await fullPollCycle(h, "acme/other", started.number);
		expect(h.db.findIssue("acme/other", labelled.number)).toBeNull();
		expect(h.discord.channels().filter(c => c.kind === "thread")).toHaveLength(threadsBefore);
		expect(h.db.watchByName("acme/other")).toBeNull();
	});

	test("Approve enqueues implement, which fails needing worker checkouts with a Retry button", async () => {
		const h = await boot();
		h.gh.addRepo("acme/app");
		const gh = h.gh.addIssue("acme/app", { title: "Add a thing" });
		await work(h, "start", { repo: "acme/app", issue: gh.number });
		const { issue, plan } = await awaitPlan(h, "acme/app", gh.number);

		await clickButton(h, plan, "Approve");
		await until(() => h.db.getIssue(issue.id)?.state === "failed", "the issue to fail");
		await until(() => h.discord.messages(issue.thread_id!).some(m => m.content.startsWith("❌ implement failed")), "the failure message");
		await h.discord.settled();
		const failure = h.discord.messages(issue.thread_id!).find(m => m.content.startsWith("❌ implement failed"))!;
		expect(failure.content).toContain("implement runs need worker checkouts");
		expect(buttons(failure).map(b => b.label)).toEqual(["Retry"]);
		// The top-message icon follows the label sync of the `job_failed` transition.
		await until(() => !!h.discord.message(issue.thread_id!)?.content.startsWith("❌"), "the ❌ top-message icon");
		expect(h.gh.getIssue("acme/app", gh.number).labels.toSorted()).toEqual(["agentbot", "agentbot:failed"]);
	});

	test("renaming the trigger relabels tracked issues without cancelling them; the old trigger no longer picks up work", async () => {
		const h = await boot();
		h.gh.addRepo("acme/app");
		await work(h, "watch", { repo: "acme/app" });
		const waiting = h.gh.addIssue("acme/app", { title: "Awaiting approval" });
		await work(h, "start", { repo: "acme/app", issue: waiting.number });
		await awaitPlan(h, "acme/app", waiting.number);
		const failing = h.gh.addIssue("acme/app", { title: "Will fail" });
		await work(h, "start", { repo: "acme/app", issue: failing.number });
		const { issue: failed, plan } = await awaitPlan(h, "acme/app", failing.number);
		await clickButton(h, plan, "Approve");
		await until(() => h.db.getIssue(failed.id)?.state === "failed", "the second issue to fail");
		await until(() => h.gh.getIssue("acme/app", failing.number).labels.includes("agentbot:failed"), "the failed label");

		h.writeSettings("forge");
		await h.controller.apply();
		expect(h.controller.status().phase).toBe("running");
		const stray = h.gh.addIssue("acme/app", { title: "Old trigger only", labels: ["agentbot"] });
		await fullPollCycle(h, "acme/app", waiting.number);

		expect(h.gh.getIssue("acme/app", waiting.number).labels.toSorted()).toEqual(["forge", "forge:awaiting-approval"]);
		expect(h.gh.getIssue("acme/app", failing.number).labels.toSorted()).toEqual(["forge", "forge:failed"]);
		expect(h.db.findIssue("acme/app", waiting.number)?.state).toBe("awaiting_approval");
		expect(h.db.findIssue("acme/app", failing.number)?.state).toBe("failed");
		expect(h.db.findIssue("acme/app", stray.number)).toBeNull();
	});

	test("an engine restart during a plan run re-attaches without aborting; the plan is published once", async () => {
		const h = await boot();
		h.dispatcher.once({ kind: "plan" }, { hold: true });
		h.gh.addRepo("acme/app");
		const gh = h.gh.addIssue("acme/app", { title: "Long plan" });
		await work(h, "start", { repo: "acme/app", issue: gh.number });
		await until(() => h.dispatcher.runs[0]?.state === "running" && h.dispatcher.runs[0].attached, "the plan run");
		const run = h.dispatcher.runs[0]!;

		await h.controller.apply();
		expect(h.controller.status().phase).toBe("running");
		expect(run.aborted).toBeUndefined();
		expect(run.state).toBe("running");
		await until(() => run.attachCount === 2 && run.attached, "the job to re-attach");

		run.finish();
		const issue = h.db.findIssue("acme/app", gh.number)!;
		await awaitPlan(h, "acme/app", gh.number);
		expect(h.dispatcher.runs).toHaveLength(1);
		expect(run.aborted).toBeUndefined();
		expect(planComments(h, "acme/app", gh.number)).toHaveLength(1);
		expect(planMessages(h, issue.thread_id!)).toHaveLength(1);
	});
});
