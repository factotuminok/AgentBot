import { afterEach, describe, expect, test } from "bun:test";
import { encodeId } from "../../src/orchestrator/discord/render";
import type { Actor } from "../../src/orchestrator/discord/surface";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { createRepoChat, type RepoChat } from "../../src/orchestrator/engine/repoChat";
import { runUiKey } from "../../src/orchestrator/store/runUi";
import type { FakeMessage } from "../fakes/discord";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

interface Chat {
	h: EngineHarness;
	chat: RepoChat;
	dispatcher: FakeDispatcher;
	allowed: Actor;
	stranger: Actor;
	/** Swaps the RepoChat the fake Discord delivers to (a restarted engine). */
	use(chat: RepoChat): void;
}

let current: Chat | undefined;

afterEach(async () => {
	if (!current) return;
	await current.chat.stop();
	await current.h.stop();
	current = undefined;
});

async function setup(opts: { limits?: Record<string, unknown> } = {}): Promise<Chat> {
	const dispatcher = createFakeDispatcher();
	const h = await createEngineHarness({ dispatcher, config: opts.limits ? { limits: opts.limits } : {} });
	h.gh.addRepo("o/r");
	let chat = createRepoChat(h.deps);
	h.discord.onEvent(async event => {
		if (event.type === "command" && event.command === "work" && event.subcommand === "ask") {
			// The bot defers and resolves the repository before handing over.
			await event.defer({ ephemeral: true });
			await chat.command(event, await h.deps.github.repo("o/r"));
		}
		if (event.type === "message") await chat.message(event);
	});
	await h.discord.login("token");
	current = {
		h,
		chat,
		dispatcher,
		allowed: h.discord.actor(ALLOWED_USER, { username: "alice" }),
		stranger: h.discord.actor("u-stranger", { username: "mallory" }),
		use(next) {
			chat = next;
			if (current) current.chat = next;
		},
	};
	return current;
}

/** Waits for what the chat reaches in the background (runs and the Discord queue settle off the event handler). */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** Runs `/work ask` in the work channel; returns the new thread's id (the top message's id) and the responses. */
async function ask(c: Chat, prompt: string) {
	const channel = c.h.workChannelId;
	const before = c.h.discord.messages(channel).length;
	const emitted = await c.h.discord.emitCommand({ command: "work", subcommand: "ask", options: { repo: "o/r", prompt }, actor: c.allowed, channelId: channel });
	const top = c.h.discord.messages(channel)[before];
	return { threadId: top?.id, emitted };
}

const thread = (c: Chat, threadId: string): FakeMessage[] => c.h.discord.messages(threadId);
const posted = (c: Chat, threadId: string, prefix: string) => thread(c, threadId).find(m => m.content.startsWith(prefix));
const done = (c: Chat, threadId: string) => until(() => !!posted(c, threadId, "✅ **Done.**"), "the Done message");
const topIcon = (c: Chat, threadId: string) => c.h.discord.message(threadId)?.content.split(" ")[0];

describe("/work ask (CHAT-01, CHAT-02)", () => {
	test("refuses at capacity before any message or thread exists (requirements §20 item 1)", async () => {
		const c = await setup({ limits: { maxChatSessions: 1 } });
		const gate = Promise.withResolvers<void>();
		// A `/work plan` run holds the only slot.
		void c.h.deps.chatSlots.track("plan:t-1", gate.promise);
		const channels = c.h.discord.channels().length;
		const { threadId, emitted } = await ask(c, "How does X work?");
		expect(threadId).toBeUndefined();
		expect(emitted.responses.at(-1)).toMatchObject({ type: "editReply", msg: { content: "Chat capacity reached; try again shortly." } });
		expect(c.h.discord.messages(c.h.workChannelId)).toEqual([]);
		expect(c.h.discord.channels()).toHaveLength(channels);
		expect(c.h.db.raw.query("SELECT * FROM chats").all()).toEqual([]);
		expect(c.dispatcher.runs).toHaveLength(0);
		gate.resolve();
	});

	test("a turn end to end: one-day thread, chat run on the base checkout, answer in chunks, Done, ✅", async () => {
		const c = await setup();
		const answer = ["First paragraph.", "x".repeat(1500), "y".repeat(1500), "Last paragraph."].join("\n\n");
		c.dispatcher.once({ kind: "chat" }, { output: { answer } });
		const { threadId, emitted } = await ask(c, "How does X work?");
		const id = threadId!;
		expect(c.h.discord.message(id)?.content).toStartWith("💬 **alice** asked about `o/r`:\nHow does X work?");
		expect(c.h.discord.channels().find(ch => ch.id === id)?.kind).toBe("thread");
		expect(emitted.responses.at(-1)?.msg?.content).toContain(`<#${id}>`);
		await done(c, id);

		const run = c.dispatcher.runs[0]!;
		expect(run.req).toMatchObject({
			owner: { kind: "chat", threadId: id },
			kind: "chat",
			profile: "chat",
			session: `chat-${id}`,
			resume: false,
			threadId: id,
			limits: { minutes: 20, costUsd: c.h.deps.config.limits.maxCostUsdPerJob },
			checkout: { repo: "o/r", identity: { name: c.h.deps.github.identity.name, email: c.h.deps.github.identity.email } },
			createIssue: { repo: "o/r" },
		});
		expect(run.req.checkout?.issueBranch).toBeUndefined();
		expect(await run.req.checkout!.defaultBranch()).toBe("main");
		expect(run.req.prompt).toContain("How does X work?");
		expect(run.req.prompt).toContain("Do not modify any files");

		const messages = thread(c, id).map(m => m.content);
		const first = messages.findIndex(m => m.startsWith("First paragraph."));
		const doneAt = messages.findIndex(m => m.startsWith("✅ **Done.**"));
		expect(first).toBeGreaterThan(-1);
		const chunks = messages.slice(first, doneAt);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every(m => m.length <= 2000)).toBe(true);
		expect(chunks.join("\n\n")).toBe(answer);
		expect(messages[doneAt]).toBe("✅ **Done.** Reply in this thread to follow up.");
		expect(posted(c, id, "✅ **Working on your request**")).toBeDefined();
		await until(() => topIcon(c, id) === "✅", "✅ top icon");
		expect(c.h.db.getChat(id)).toMatchObject({ repo: "o/r", session_file: `chat-${id}` });
		expect(c.h.db.kvGet(runUiKey({ kind: "chat", threadId: id }))).toBeUndefined();
		expect(c.chat.active()).toEqual([]);
	});
});

describe("follow-ups (CHAT-03, CHAT-04)", () => {
	test("steer the live run (👀), ignore non-members, then resume the session in a new run", async () => {
		const c = await setup();
		c.dispatcher.once({ kind: "chat" }, { hold: true });
		const id = (await ask(c, "Start")).threadId!;
		await until(() => c.dispatcher.runs[0]?.registered === true, "registered run");
		const run = c.dispatcher.runs[0]!;
		expect(c.chat.active()).toEqual([id]);

		const steer = await c.h.discord.emitMessage({ channelId: id, content: "also check Y", actor: c.allowed });
		await until(() => c.h.discord.message(steer.ref!.messageId)?.reactions.includes("👀") === true, "👀");
		expect(run.steers).toEqual([{ text: "also check Y", from: "alice" }]);

		const ignored = await c.h.discord.emitMessage({ channelId: id, content: "let me in", actor: c.stranger });
		await c.h.discord.settled();
		expect(c.h.discord.message(ignored.ref!.messageId)?.reactions).toEqual([]);
		expect(run.steers).toHaveLength(1);

		run.finish();
		await done(c, id);
		await c.h.discord.emitMessage({ channelId: id, content: "and now?", actor: c.allowed });
		await until(() => c.dispatcher.runs.length === 2, "the resumed run");
		const next = c.dispatcher.runs[1]!;
		expect(next.req).toMatchObject({ session: `chat-${id}`, resume: true, owner: { kind: "chat", threadId: id }, kind: "chat" });
		expect(next.req.prompt).toContain("and now?");
		await until(() => thread(c, id).filter(m => m.content.startsWith("✅ **Done.**")).length === 2, "the second Done");
	});

	test("a message while the run is still starting is refused; a full system refuses in the thread", async () => {
		const c = await setup({ limits: { maxChatSessions: 1 } });
		c.dispatcher.once({ kind: "chat" }, { hold: true, registerAt: null });
		const id = (await ask(c, "Slow start")).threadId!;
		await until(() => c.dispatcher.runs.length === 1, "run");
		await c.h.discord.emitMessage({ channelId: id, content: "hello?", actor: c.allowed });
		await until(() => !!posted(c, id, "Still starting the previous request"), "refusal");

		c.dispatcher.runs[0]!.finish();
		await done(c, id);
		const gate = Promise.withResolvers<void>();
		void c.h.deps.chatSlots.track("draft:d-1", gate.promise);
		await c.h.discord.emitMessage({ channelId: id, content: "next", actor: c.allowed });
		await until(() => !!posted(c, id, "Chat capacity reached; try again shortly."), "capacity refusal");
		expect(c.dispatcher.runs).toHaveLength(1);
		gate.resolve();
	});

	test("messages outside repo chats are not handled", async () => {
		const c = await setup();
		const other = c.h.discord.addChannel({ name: "elsewhere", kind: "thread", parentId: c.h.workChannelId, guildId: "g1" });
		c.h.db.insertChat(other.id, "ask-only");
		c.h.db.insertAskChat(other.id, c.h.workChannelId, ALLOWED_USER);
		const handled = await c.chat.message({ type: "message", ref: { channelId: other.id, messageId: "m" }, content: "hi", attachments: [], actor: c.allowed, where: { guildId: "g1", channelId: other.id, parentId: c.h.workChannelId, isThread: true } });
		expect(handled).toBe(false);
	});
});

describe("create_issue (AGT-10)", () => {
	test("files without the trigger label and posts the hand-off message", async () => {
		const c = await setup();
		c.dispatcher.once({ kind: "chat" }, { hold: true });
		const id = (await ask(c, "File it")).threadId!;
		await until(() => c.dispatcher.runs[0]?.registered === true, "registered run");
		const run = c.dispatcher.runs[0]!;
		const filed = await run.req.createIssue!.file("Add Z", "Details of Z");
		expect(filed).toEqual({ number: 1, url: "https://github.com/o/r/issues/1" });
		const issue = c.h.gh.getIssue("o/r", 1);
		expect(issue).toMatchObject({ title: "Add Z", body: "Details of Z", labels: [] });
		const handoff = posted(c, id, "Created https://github.com/o/r/issues/1")!;
		const button = handoff.components[0]!.components[0] as { custom_id: string; label: string };
		expect(button.custom_id).toBe(encodeId({ type: "issue", repo: "o/r", number: 1, action: "handoff" }));
		expect(button.label).toBe(`Hand to ${c.h.deps.config.agent.name}`);
		run.finish();
		await done(c, id);
	});
});

describe("outcomes (CHAT-05, DSC-15)", () => {
	test("time and cost limits name the limit and invite another message", async () => {
		const c = await setup();
		c.dispatcher.once({ kind: "chat" }, { aborted: "time" });
		const timed = (await ask(c, "Long")).threadId!;
		await until(() => !!posted(c, timed, "⚠️ **Stopped at the 20 minute time limit** before finishing."), "time limit message");
		expect(posted(c, timed, "⚠️")!.content).toContain("Send another message to continue where it left off.");
		await until(() => topIcon(c, timed) === "⚠️", "⚠️ top icon");

		c.dispatcher.once({ kind: "chat" }, { aborted: "cost" });
		const costly = (await ask(c, "Pricey")).threadId!;
		await until(() => !!posted(c, costly, `⚠️ **Stopped at the $${c.h.deps.config.limits.maxCostUsdPerJob} cost limit**`), "cost limit message");
		expect(posted(c, costly, "✅ **Done.**")).toBeUndefined();
	});

	test("failures and lost workers post the error and invite a retry", async () => {
		const c = await setup();
		c.dispatcher.once({ kind: "chat" }, { error: "model exploded" });
		const failed = (await ask(c, "Try")).threadId!;
		await until(() => !!posted(c, failed, "❌ **Chat failed:**"), "failure message");
		expect(posted(c, failed, "❌ **Chat")!.content).toBe("❌ **Chat failed:** model exploded\nSend another message to try again.");
		await until(() => topIcon(c, failed) === "❌", "❌ top icon");

		c.dispatcher.once({ kind: "chat" }, { lost: true });
		const lost = (await ask(c, "Again")).threadId!;
		await until(() => !!posted(c, lost, "❌ **Chat failed:**"), "lost message");
		expect(posted(c, lost, "❌ **Chat")!.content).toContain("the worker running this was lost");
	});

	test("/work cancel stops the live run; with nothing running it says so (requirements §20 item 2)", async () => {
		const c = await setup();
		c.dispatcher.once({ kind: "chat" }, { hold: true });
		const id = (await ask(c, "Stop me")).threadId!;
		await until(() => c.dispatcher.runs[0]?.registered === true, "registered run");
		expect(await c.chat.cancel(id, "@alice")).toBe("Stopping the current run (requested by @alice)…");
		await until(() => !!posted(c, id, "⏹️ **Stopped.**"), "Stopped message");
		expect(c.dispatcher.runs[0]!.aborted).toBe("user");
		expect(posted(c, id, "⏹️ **Stopped")!.content).toBe("⏹️ **Stopped.** Send another message to continue.");
		await until(() => topIcon(c, id) === "⏹️", "⏹️ top icon");
		expect(await c.chat.cancel(id, "@alice")).toBe("Nothing is running in this chat.");

		// Not a repo chat: an unknown thread, and an `/ask` thread (the ask chat answers those).
		expect(await c.chat.cancel("nope", "@alice")).toBeUndefined();
		c.h.db.insertChat("ask-thread", "ask-only");
		c.h.db.insertAskChat("ask-thread", c.h.workChannelId, ALLOWED_USER);
		expect(await c.chat.cancel("ask-thread", "@alice")).toBeUndefined();
	});
});

describe("restart (RUN-14, NFR-03)", () => {
	test("a re-attached chat keeps editing the same status message and posts the answer once", async () => {
		const c = await setup();
		const gate = Promise.withResolvers<void>();
		c.dispatcher.once({ kind: "chat" }, { steps: [{ progress: { tool: "grep", intent: "Searching" } }, { until: gate.promise }], output: { answer: "Found it" } });
		const id = (await ask(c, "Find it")).threadId!;
		await until(() => !!posted(c, id, "🛠️ **Working on your request**") && c.dispatcher.runs[0]?.registered === true, "status message and run");
		const owner = { kind: "chat" as const, threadId: id };
		const status = posted(c, id, "🛠️ **Working on your request**")!;
		await until(() => c.h.db.kvGet(runUiKey(owner))?.includes(status.id) === true, "stored run UI state");

		await c.chat.stop();
		expect(c.dispatcher.hasUnfinishedRun(owner)).toBe(true);
		const restarted = createRepoChat(c.h.deps);
		c.use(restarted);
		restarted.start();
		await until(() => restarted.active().includes(id), "re-attached chat");
		expect(c.h.deps.chatSlots.has(`chat:${id}`)).toBe(true);
		gate.resolve();
		await done(c, id);

		const statuses = thread(c, id).filter(m => m.content.includes("**Working on your request**"));
		expect(statuses.map(m => m.id)).toEqual([status.id]);
		expect(statuses[0]!.content).toStartWith("✅");
		expect(thread(c, id).filter(m => m.content === "Found it")).toHaveLength(1);
		expect(c.dispatcher.calls.filter(call => call.attached)).toHaveLength(1);
	});

	test("an answer that finished while no engine was attached is posted after the restart", async () => {
		const c = await setup();
		c.dispatcher.once({ kind: "chat" }, { hold: true, output: { answer: "Late answer" } });
		const id = (await ask(c, "Slow")).threadId!;
		await until(() => c.dispatcher.runs[0]?.registered === true && !!posted(c, id, "🛠️"), "run and status");
		await c.chat.stop();
		c.dispatcher.runs[0]!.finish();
		expect(c.dispatcher.hasUnfinishedRun({ kind: "chat", threadId: id })).toBe(false);

		const restarted = createRepoChat(c.h.deps);
		c.use(restarted);
		restarted.start();
		await done(c, id);
		expect(thread(c, id).filter(m => m.content === "Late answer")).toHaveLength(1);
		expect(c.dispatcher.runs).toHaveLength(1);
	});
});
