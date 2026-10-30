import { describe, expect, test } from "bun:test";
import { startProgress } from "../../src/orchestrator/discord/progress";
import type { InteractionResponder, OutMessage } from "../../src/orchestrator/discord/surface";
import { ISSUE_ICONS, setTopIcon } from "../../src/orchestrator/discord/topMessage";
import { createFakeDiscord } from "../fakes/discord";

const steps = (statuses: ("pending" | "in_progress" | "completed" | "failed")[]) => statuses.map((status, i) => ({ content: `Step ${i + 1}`, status }));

function setup() {
	const fake = createFakeDiscord({ channels: [{ id: "thread-1", name: "t" }] });
	return { fake, messages: () => fake.messages("thread-1") };
}

test("progress shows waiting and the final state, and ignores activity after finishing", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Planning #3", "Preparing the workspace…");
	expect(messages()[0]!.content).toContain("↳ Preparing the workspace…");
	expect(progress.ref()).toEqual({ channelId: "thread-1", messageId: messages()[0]!.id });
	progress.waiting(true);
	await fake.settled();
	expect(messages()[0]!.content).toStartWith("⏸️ **Planning #3** · waiting for your answer below");
	await progress.finish("done");
	expect(messages()[0]!.content).toStartWith("✅ **Planning #3**");
	progress.activity("late", 9);
	progress.waiting(true);
	await progress.finish("failed");
	await fake.settled();
	expect(messages()[0]!.content).toStartWith("✅ **Planning #3**");
	expect(messages()).toHaveLength(1);
});

test("activity right after a change waits for the throttle; phases show at once (DSC-11)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
	progress.activity("Reading (`read`)", 0.5);
	await fake.settled();
	expect(messages()[0]!.edits).toBe(0);
	progress.phase("Pushing…");
	await fake.settled();
	expect(messages()[0]!.edits).toBe(1);
	expect(messages()[0]!.content).toContain("$0.50\n↳ Pushing…");
	await progress.finish("cancelled");
});

test("progress edits of one message coalesce in the queue: only the latest state is written", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
	fake.pause();
	progress.phase("one");
	progress.phase("two");
	progress.waiting(true);
	expect(fake.queueStats().length).toBe(1);
	fake.resume();
	await fake.settled();
	expect(messages()[0]!.edits).toBe(1);
	expect(messages()[0]!.content).toStartWith("⏸️");
	await progress.finish("done");
});

test("stop ends updates without writing a final state (engine detach)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Planning #3", "Thinking…");
	progress.stop();
	progress.phase("late");
	progress.waiting(true);
	await progress.finish("done");
	await fake.settled();
	expect(messages()[0]!.edits).toBe(0);
	expect(messages()[0]!.content).toStartWith("🛠️ **Planning #3** · working");
});

test("progress edits that fail never fail the run", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
	fake.deleteMessage({ channelId: "thread-1", messageId: messages()[0]!.id });
	progress.phase("next");
	await progress.finish("done");
});

describe("progress todo list", () => {
	test("the first list is posted as its own message and later lists edit it", async () => {
		const { fake, messages } = setup();
		const progress = await startProgress(fake, "thread-1", "Implementing #3", "Starting…");
		progress.todos([]);
		await fake.settled();
		expect(messages()).toHaveLength(1);
		progress.todos(steps(["pending", "pending"]));
		progress.todos(steps(["in_progress", "pending"]));
		progress.todos(steps(["completed", "in_progress"]));
		await fake.settled();
		expect(messages()).toHaveLength(2);
		expect(messages()[1]!.content).toBe("📝 **To-do** · 1/2 done\n✅ Step 1\n🔄 Step 2");
		await progress.finish("done");
		expect(messages()[0]!.content).toStartWith("✅ **Implementing #3**");
		progress.todos(steps(["failed", "failed"]));
		await fake.settled();
		expect(messages()[1]!.content).toBe("📝 **To-do** · 2/2 done\n✅ Step 1\n✅ Step 2");
	});

	test("a step the agent reports as failed shows the failed icon and count", async () => {
		const { fake, messages } = setup();
		const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
		progress.todos(steps(["completed", "failed", "failed", "in_progress"]));
		await fake.settled();
		expect(messages()[1]!.content).toBe("📝 **To-do** · 1/4 done · 2 failed\n✅ Step 1\n❌ Step 2\n❌ Step 3\n🔄 Step 4");
		await progress.finish("cancelled");
	});

	test("a failed run marks every step it had not finished as failed", async () => {
		const { fake, messages } = setup();
		const progress = await startProgress(fake, "thread-1", "Fixing CI #3", "Starting…");
		progress.todos(steps(["completed", "failed", "in_progress", "pending"]));
		await progress.finish("failed");
		await fake.settled();
		expect(messages()[1]!.content).toBe("📝 **To-do** · 1/4 done · 3 failed\n✅ Step 1\n❌ Step 2\n❌ Step 3\n❌ Step 4");
	});

	test("a successful run completes the step in progress and leaves untouched steps", async () => {
		const { fake, messages } = setup();
		const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
		progress.todos(steps(["failed", "in_progress", "pending"]));
		await progress.finish("done");
		await fake.settled();
		expect(messages()[1]!.content).toBe("📝 **To-do** · 1/3 done · 1 failed\n❌ Step 1\n✅ Step 2\n⬜ Step 3");
	});

	test("a cancelled run keeps the list as the agent left it", async () => {
		const { fake, messages } = setup();
		const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
		progress.todos(steps(["completed", "in_progress", "pending"]));
		await progress.finish("cancelled");
		await fake.settled();
		expect(messages()[1]!.content).toBe("📝 **To-do** · 1/3 done\n✅ Step 1\n🔄 Step 2\n⬜ Step 3");
	});

	test("a command reply target shows the list under the progress line, in one message", async () => {
		const { fake } = setup();
		const edits: OutMessage[] = [];
		const fail = async () => {
			throw new Error("unused");
		};
		const responder: InteractionResponder = { reply: fail, defer: fail, followUp: fail, editReply: async msg => void edits.push(msg) };
		const progress = await startProgress(fake, { responder }, "Drafting an issue", "Starting…");
		expect(progress.ref()).toBeNull();
		progress.todos(steps(["in_progress", "pending"]));
		await progress.finish("failed");
		const [line, ...todo] = edits.at(-1)!.content.split("\n");
		expect(line).toStartWith("❌ **Drafting an issue**");
		expect(todo).toEqual(["📝 **To-do** · 0/2 done · 2 failed", "❌ Step 1", "❌ Step 2"]);
		expect(fake.channels().flatMap(c => fake.messages(c.id))).toEqual([]);
	});

	test("messages are sent without mentions", async () => {
		const { fake, messages } = setup();
		const progress = await startProgress(fake, "thread-1", "Chat", "Starting…");
		progress.todos(steps(["pending"]));
		await progress.finish("done");
		await fake.settled();
		for (const message of messages()) expect(message.mentions).toBeUndefined();
	});
});

describe("thread top message icon", () => {
	async function threadWithTop(content: string, byUser = false) {
		const fake = createFakeDiscord({ channels: [{ id: "work", name: "work" }] });
		const top = byUser ? (await fake.emitMessage({ channelId: "work", content, actor: fake.actor("someone") })).ref! : await fake.send("work", { content });
		const threadId = await fake.startThread(top, { name: "t", autoArchiveMinutes: 1440 });
		return { fake, threadId, top: () => fake.message(top.messageId)!.content };
	}

	test("replaces only the leading icon", async () => {
		const { fake, threadId, top } = await threadWithTop("📥 **#12 Add dark mode** — <https://github.com/o/r/issues/12>");
		await setTopIcon(fake, threadId, ISSUE_ICONS.done);
		expect(top()).toBe("✅ **#12 Add dark mode** — <https://github.com/o/r/issues/12>");
	});

	test("threads without a top message, or one the bot can't edit, are left alone without failing", async () => {
		const missing = createFakeDiscord();
		await setTopIcon(missing, "no-such-thread", "✅");
		const { fake, threadId, top } = await threadWithTop("📥 someone else's message", true);
		await setTopIcon(fake, threadId, "✅");
		expect(top()).toBe("📥 someone else's message");
	});
});
