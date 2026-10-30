import { describe, expect, test } from "bun:test";
import { createInteractionRouter } from "../../src/orchestrator/discord/interactionRouter";
import { answerFromText, createDiscordUI, type DiscordUIOptions } from "../../src/orchestrator/discord/questions";
import { createThreadReplies, type ThreadReplies } from "../../src/orchestrator/discord/replies";
import type { ComponentEvent, MsgRef } from "../../src/orchestrator/discord/surface";
import { createFakeDiscord, type FakeDiscord } from "../fakes/discord";

describe("thread replies", () => {
	test("a reply resolves the waiting question once; later replies are not consumed", async () => {
		const replies = createThreadReplies();
		expect(replies.deliver("t1", "too early")).toBe(false);
		const answer = replies.next("t1", 60_000);
		expect(replies.deliver("t2", "other thread")).toBe(false);
		expect(replies.deliver("t1", "yes")).toBe(true);
		expect(await answer).toBe("yes");
		expect(replies.deliver("t1", "again")).toBe(false);
	});

	test("abort rejects the wait and frees the thread", async () => {
		const replies = createThreadReplies();
		const controller = new AbortController();
		const answer = replies.next("t1", 60_000, controller.signal);
		controller.abort();
		await expect(answer).rejects.toThrow("aborted");
		expect(replies.deliver("t1", "late")).toBe(false);
	});

	test("a newer wait in the same thread ends the older one with no answer", async () => {
		const replies = createThreadReplies();
		const first = replies.next("t1", 60_000);
		const second = replies.next("t1", 60_000);
		expect(await first).toBeUndefined();
		expect(replies.deliver("t1", "x")).toBe(true);
		expect(await second).toBe("x");
	});
});

describe("typed answers", () => {
	const labels = ["Small", "Medium", "Large"];
	test("an option number or label selects that option", () => {
		expect(answerFromText(" 2 ", labels, false)).toEqual({ selectedOptions: ["Medium"] });
		expect(answerFromText("large", labels, false)).toEqual({ selectedOptions: ["Large"] });
	});
	test("multi-select takes a comma-separated list", () => {
		expect(answerFromText("1, large", labels, true)).toEqual({ selectedOptions: ["Small", "Large"] });
	});
	test("anything else, including an out-of-range number, is a free-text answer", () => {
		expect(answerFromText("4", labels, false)).toEqual({ selectedOptions: [], customInput: "4" });
		expect(answerFromText("1, huge", labels, true)).toEqual({ selectedOptions: [], customInput: "1, huge" });
		expect(answerFromText("make it medium", labels, false)).toEqual({ selectedOptions: [], customInput: "make it medium" });
	});
});

/** Microtask turns only: lets the fake's queue and the UI's continuations run. */
async function turns(n = 50): Promise<void> {
	for (let turn = 0; turn < n; turn++) await Promise.resolve();
}

/** A thread in the fake, with the bot's routing of components, modals and typed replies (DSC-18). */
async function setup(overrides: Partial<DiscordUIOptions> = {}) {
	const fake = createFakeDiscord({ channels: [{ id: "work", name: "work" }] });
	const starter = await fake.send("work", { content: "📥 **#1 Thing**" });
	const threadId = await fake.startThread(starter, { name: "#1 Thing", autoArchiveMinutes: 1440 });
	const replies = createThreadReplies();
	const interactions = createInteractionRouter();
	let claimed = false;
	fake.onEvent(event => {
		if (event.type === "component" || event.type === "modal") claimed = interactions.dispatch(event);
		if (event.type === "message") replies.deliver(event.where.channelId, event.content);
	});
	const waiting: boolean[] = [];
	const answered: MsgRef[] = [];
	const ui = createDiscordUI(fake, threadId, {
		jobId: "job-1",
		askTimeoutMs: 60_000,
		isAllowed: actor => actor.userId === "admin",
		replies,
		interactions,
		mention: { text: "<@admin> ", users: ["admin"] },
		onWaiting: on => waiting.push(on),
		onAnswered: ref => answered.push(ref),
		...overrides,
	});
	const admin = fake.actor("admin");
	return {
		fake,
		threadId,
		replies,
		ui,
		waiting,
		answered,
		admin,
		/** The thread's messages (the starter lives in the parent channel). */
		messages: () => fake.messages(threadId),
		/** Waits until the UI posted its `n`th question in the thread. */
		async asked(n = 1): Promise<MsgRef> {
			for (let turn = 0; turn < 1000 && fake.messages(threadId).length < n; turn++) await Promise.resolve();
			const message = fake.messages(threadId)[n - 1];
			if (!message) throw new Error("the UI never asked");
			return { channelId: threadId, messageId: message.id };
		},
		/** Delivers a typed reply as soon as the UI waits for one. */
		async reply(text: string): Promise<void> {
			for (let turn = 0; turn < 1000; turn++) {
				if (replies.deliver(threadId, text)) return;
				await Promise.resolve();
			}
			throw new Error("the UI never waited for a reply");
		},
		/** Clicks a component on `message` once the UI listens for it. */
		async click(message: MsgRef, customId: string, opts: { values?: string[]; actor?: ReturnType<FakeDiscord["actor"]> } = {}) {
			for (let turn = 0; turn < 1000; turn++) {
				const emitted = await fake.emitComponent({ message, customId, values: opts.values, actor: opts.actor ?? admin });
				if (claimed) {
					await turns();
					return emitted;
				}
				await Promise.resolve();
			}
			throw new Error("the UI never listened for a click");
		},
	};
}

const selectOf = (components: unknown) => (components as { components: { type: number; options?: { default?: boolean }[]; min_values?: number; max_values?: number }[] }[])[0]!.components[0]!;

describe("Discord questions", () => {
	test("a typed reply answers an ask dialog: the question is posted, mentions the approvers, and is marked answered", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "size", question: "How big?", options: [{ label: "Small" }, { label: "Large", description: "everything" }] }]);
		const question = await t.asked();
		const posted = t.fake.message(question.messageId)!;
		expect(posted.content).toStartWith("❓ <@admin> **How big?**");
		expect(posted.mentions).toEqual({ users: ["admin"] });
		await t.reply("2");
		expect(await result).toEqual({
			kind: "submit",
			results: [{ id: "size", question: "How big?", options: ["Small", "Large"], multi: false, selectedOptions: ["Large"] }],
		});
		await t.fake.settled();
		expect(t.messages()).toHaveLength(1);
		expect(t.messages()[0]!.content).toBe("**How big?**\n→ Large");
		expect(t.messages()[0]!.components).toEqual([]);
		expect(t.waiting).toEqual([true, false]);
		expect(t.answered).toEqual([question]);
	});

	test("a typed message in the thread reaches the question through the bot's routing (DSC-18)", async () => {
		const t = await setup();
		const result = t.ui.input("Which branch?", undefined);
		await t.asked();
		await turns();
		await t.fake.emitMessage({ channelId: t.threadId, content: "develop", actor: t.admin });
		expect(await result).toBe("develop");
	});

	test("the question prompt numbers the options and says a reply works; free text is a custom answer", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }] }]);
		const prompt = t.fake.message((await t.asked()).messageId)!.content;
		expect(prompt).toContain("1. A\n2. B");
		expect(prompt).toContain("reply in this thread");
		await t.reply("my own idea");
		const answered = await result;
		expect(answered?.kind === "submit" ? answered.results[0]?.customInput : undefined).toBe("my own idea");
	});

	test("the select menu opens with nothing pre-selected, and the recommended option is marked in the prompt", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 0 }]);
		const posted = t.fake.message((await t.asked()).messageId)!;
		const select = selectOf(posted.components);
		expect(select.options).toHaveLength(2);
		expect(select.options!.some(option => option.default)).toBe(false);
		expect([select.min_values, select.max_values]).toEqual([1, 1]);
		expect(posted.content).toContain("1. A (recommended)\n2. B");
		await t.reply("2");
		await result;
	});

	test("the select menu holds at most 25 options; typed numbers still reach the others", async () => {
		const t = await setup();
		const options = Array.from({ length: 30 }, (_, i) => ({ label: `O${i + 1}` }));
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options }]);
		expect(selectOf(t.fake.message((await t.asked()).messageId)!.components).options).toHaveLength(25);
		await t.reply("30");
		const answered = await result;
		expect(answered?.kind === "submit" ? answered.results[0]?.selectedOptions : undefined).toEqual(["O30"]);
	});

	test("choosing from the menu answers and updates the question message", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }], multi: true }]);
		const question = await t.asked();
		const { responses } = await t.click(question, "ask:job-1:0:sel", { values: ["0", "1"] });
		const answered = await result;
		expect(answered?.kind === "submit" ? answered.results[0]?.selectedOptions : undefined).toEqual(["A", "B"]);
		expect(responses.map(r => r.type)).toEqual(["update"]);
		expect(t.fake.message(question.messageId)!.content).toBe("**Pick**\n→ A, B");
	});

	test("a click by a non-allowed member is refused and the question stays open", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }] }]);
		const question = await t.asked();
		const { responses } = await t.click(question, "ask:job-1:0:sel", { values: ["0"], actor: t.fake.actor("stranger") });
		expect(responses).toEqual([{ type: "reply", msg: { content: "Not authorized.", ephemeral: true }, ephemeral: true }]);
		await t.click(question, "ask:job-1:0:sel", { values: ["1"] });
		const answered = await result;
		expect(answered?.kind === "submit" ? answered.results[0]?.selectedOptions : undefined).toEqual(["B"]);
	});

	test("Other… opens a modal that does not block a typed reply", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }] }]);
		const question = await t.asked();
		const { responses } = await t.click(question, "ask:job-1:0:other");
		expect(responses[0]?.type).toBe("showModal");
		expect(responses[0]?.modal?.custom_id).toBe("ask:job-1:0:modal");
		await t.reply("my own words");
		expect(await result).toEqual({
			kind: "submit",
			results: [{ id: "q", question: "Pick", options: ["A", "B"], multi: false, selectedOptions: [], customInput: "my own words" }],
		});
		await t.fake.settled();
		expect(t.fake.message(question.messageId)!.content).toBe("**Pick**\n→ my own words");
	});

	test("Other… keeps the menu working while the modal is open", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }] }]);
		const question = await t.asked();
		await t.click(question, "ask:job-1:0:other");
		await t.click(question, "ask:job-1:0:sel", { values: ["0"] });
		const answered = await result;
		expect(answered?.kind === "submit" ? answered.results[0]?.selectedOptions : undefined).toEqual(["A"]);
	});

	test("a modal submit answers after Other… was pressed, updating the question as the response", async () => {
		const t = await setup();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }] }]);
		const question = await t.asked();
		await t.click(question, "ask:job-1:0:other");
		const { responses } = await t.fake.emitModal({ customId: "ask:job-1:0:modal", fields: { answer: "from modal" }, message: question, actor: t.admin });
		const answered = await result;
		expect(answered?.kind === "submit" ? answered.results[0]?.customInput : undefined).toBe("from modal");
		await turns();
		expect(responses.map(r => r.type)).toEqual(["update"]);
		expect(t.fake.message(question.messageId)!.content).toBe("**Pick**\n→ from modal");
	});

	test("free-text input waits for the reply and returns it", async () => {
		const t = await setup();
		const answer = t.ui.input("Which branch?", undefined);
		expect(t.fake.message((await t.asked()).messageId)!.content).toBe("❓ <@admin> **Which branch?**\n_Reply in this thread._");
		await t.reply("develop");
		expect(await answer).toBe("develop");
	});

	test("a typed yes/no or a button answers a confirmation", async () => {
		const t = await setup();
		const yes = t.ui.confirm("Delete?", "the temp dir");
		await t.reply("Yes");
		expect(await yes).toBe(true);
		const no = t.ui.confirm("Delete?", "the temp dir");
		await t.reply("nope");
		expect(await no).toBe(false);
		const clicked = t.ui.confirm("Delete?", "the temp dir");
		const { responses } = await t.click(await t.asked(3), "ask:job-1:confirm:yes");
		expect(await clicked).toBe(true);
		expect(responses.map(r => r.type)).toEqual(["update"]);
	});

	describe("timeouts continue with defaults (DSC-19)", () => {
		test("an ask dialog continues with the recommended option", async () => {
			const t = await setup({ askTimeoutMs: 1 });
			const result = await t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 1 }]);
			expect(result?.kind === "submit" ? result.results[0]?.selectedOptions : undefined).toEqual(["B"]);
			await t.fake.settled();
			expect(t.messages().map(m => m.content)).toEqual(["**Pick**\n→ (no answer)", "No answer in 0h; continuing with recommended options."]);
		});

		test("free text proceeds with no answer", async () => {
			const t = await setup({ askTimeoutMs: 1 });
			expect(await t.ui.input("Which branch?", undefined)).toBeUndefined();
			await t.fake.settled();
			expect(t.messages().at(-1)!.content).toBe("No answer in 0h; continuing without one.");
		});

		test("a yes/no question proceeds with No", async () => {
			const t = await setup({ askTimeoutMs: 1 });
			expect(await t.ui.confirm("Delete?", "the temp dir")).toBe(false);
			await t.fake.settled();
			expect(t.messages()[0]!.content).toBe("**Delete?**\nthe temp dir\n→ (no answer: No)");
		});
	});

	test("waits run on the pause clock, once for a select (DSC-20)", async () => {
		let during = 0;
		const t = await setup({
			pauseClock: {
				during: fn => {
					during++;
					return fn();
				},
			},
		});
		const result = t.ui.select("Pick", ["A", "B"]);
		await t.reply("1");
		expect(await result).toBe("A");
		expect(during).toBe(1);
		expect(t.waiting).toEqual([true, false]);
	});

	test("an aborted question rejects and marks the message cancelled", async () => {
		const t = await setup();
		const controller = new AbortController();
		const result = t.ui.askDialog!([{ id: "q", question: "Pick", options: [{ label: "A" }] }], { signal: controller.signal });
		await t.asked();
		await turns();
		controller.abort();
		await expect(result).rejects.toThrow("aborted");
		await t.fake.settled();
		expect(t.messages()[0]!.content).toBe("Cancelled");
	});

	test("notify posts an icon line without mentions", async () => {
		const t = await setup();
		t.ui.notify("careful", "warning");
		await t.fake.settled();
		expect(t.messages()[0]!.content).toBe("⚠️ careful");
		expect(t.messages()[0]!.mentions).toBeUndefined();
	});
});

describe("interaction router", () => {
	const component = (messageId: string, customId = "x"): ComponentEvent & { replies: unknown[] } => {
		const replies: unknown[] = [];
		const fail = async () => {
			throw new Error("unused");
		};
		return {
			type: "component",
			customId,
			values: [],
			message: { channelId: "c", messageId },
			actor: { userId: "u", username: "u", roleIds: [], isBot: false },
			where: { guildId: "g", channelId: "c", parentId: null, isThread: false },
			reply: async msg => void replies.push(msg),
			defer: fail,
			editReply: fail,
			followUp: fail,
			update: fail,
			deferUpdate: fail,
			showModal: fail,
			replies,
		};
	};

	test("unclaimed events return false; a waiter receives the event for its message", async () => {
		const router = createInteractionRouter();
		expect(router.dispatch(component("m1"))).toBe(false);
		const next = router.nextComponent("m1", { timeoutMs: 60_000 });
		expect(router.dispatch(component("m2"))).toBe(false);
		const event = component("m1", "pick");
		expect(router.dispatch(event)).toBe(true);
		expect(await next).toBe(event);
		expect(router.dispatch(component("m1"))).toBe(false);
	});

	test("a filtered-out event is claimed but leaves the waiter waiting", async () => {
		const router = createInteractionRouter();
		const next = router.nextComponent("m1", { timeoutMs: 60_000, filter: e => e.customId === "ok" });
		expect(router.dispatch(component("m1", "no"))).toBe(true);
		await turns();
		const ok = component("m1", "ok");
		router.dispatch(ok);
		expect(await next).toBe(ok);
	});

	test("timeouts resolve undefined and aborts reject", async () => {
		const router = createInteractionRouter();
		expect(await router.nextModal("modal-1", { timeoutMs: 1 })).toBeUndefined();
		const controller = new AbortController();
		const next = router.nextComponent("m1", { timeoutMs: 60_000, signal: controller.signal });
		controller.abort();
		await expect(next).rejects.toThrow("aborted");
		expect(router.dispatch(component("m1"))).toBe(false);
	});
});
