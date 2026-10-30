import { describe, expect, test } from "bun:test";
import { allowedMentions, askThreadAllowed, commandAccess, memberAllowed, refusalMessage } from "../../src/orchestrator/discord/access";
import type { Actor, Where } from "../../src/orchestrator/discord/surface";
import { parseConfig } from "../../src/shared/config";

const config = parseConfig({
	discord: { guildId: "g", allowedUserIds: ["admin"], allowedRoleIds: ["role-ops"], workChannelId: "work-1", askChannelIds: ["ask-1"] },
	github: { appId: 1 },
});

const member = (userId: string, roleIds: string[] = []): Actor => ({ userId, username: userId, roleIds, isBot: false });
const channel = (channelId: string): Where => ({ guildId: "g", channelId, parentId: null, isThread: false });
const thread = (channelId: string, parentId: string): Where => ({ guildId: "g", channelId, parentId, isThread: true });

const REPO_SUBCOMMANDS = ["start", "issue", "plan", "ask", "watch", "unwatch"];
const WORK_SUBCOMMANDS = [...REPO_SUBCOMMANDS, "status", "cancel"];

const work = (who: Actor | null, where: Where, subcommand = "status", isWatchChannel = false) =>
	commandAccess(config, { command: "work", subcommand, actor: who, where, isWatchChannel });
const ask = (who: Actor | null, where: Where) => commandAccess(config, { command: "ask", subcommand: null, actor: who, where, isWatchChannel: false });

describe("commandAccess", () => {
	test("anyone may /ask in an ask-only channel", () => {
		expect(ask(member("stranger"), channel("ask-1"))).toEqual({ ok: true });
		expect(ask(member("admin"), channel("ask-1"))).toEqual({ ok: true });
		expect(ask(null, channel("ask-1"))).toEqual({ ok: true });
	});

	test("/work needs an allowed member, in the ask-only channel and everywhere else", () => {
		for (const where of [channel("ask-1"), channel("work-1"), channel("elsewhere"), thread("t", "work-1")]) {
			for (const sub of WORK_SUBCOMMANDS) {
				expect([where.channelId, sub, work(member("stranger"), where, sub).ok]).toEqual([where.channelId, sub, false]);
				expect(work(member("stranger"), where, sub)).toEqual({ ok: false, reason: "not-allowed" });
				expect(work(null, where, sub)).toEqual({ ok: false, reason: "not-allowed" });
			}
		}
	});

	test("a bot is never an allowed member, even with an allowed id", () => {
		expect(work({ ...member("admin"), isBot: true }, channel("work-1"))).toEqual({ ok: false, reason: "not-allowed" });
	});

	test("repository subcommands work only in the work channel or a watch channel (DSC-33)", () => {
		for (const sub of REPO_SUBCOMMANDS) {
			expect([sub, work(member("admin"), channel("work-1"), sub)]).toEqual([sub, { ok: true }]);
			expect([sub, work(member("admin"), channel("watch-1"), sub, true)]).toEqual([sub, { ok: true }]);
			for (const where of [channel("elsewhere"), channel("ask-1"), thread("t", "work-1")]) {
				expect([sub, where.channelId, work(member("admin"), where, sub)]).toEqual([sub, where.channelId, { ok: false, reason: "not-a-work-channel" }]);
			}
		}
	});

	test("status and cancel work anywhere for allowed members", () => {
		for (const sub of ["status", "cancel"]) {
			for (const where of [channel("elsewhere"), thread("t", "work-1"), channel("work-1")]) {
				expect([sub, where.channelId, work(member("admin"), where, sub)]).toEqual([sub, where.channelId, { ok: true }]);
			}
		}
	});

	test("/ask outside an ask-only channel is refused for everyone, with the reason", () => {
		for (const who of [member("stranger"), member("admin")]) {
			expect(ask(who, channel("work-1"))).toEqual({ ok: false, reason: "ask-elsewhere" });
		}
	});

	test("/ask inside a thread of an ask-only channel is refused as a thread, not as a wrong channel", () => {
		expect(ask(member("stranger"), thread("thread-1", "ask-1"))).toEqual({ ok: false, reason: "ask-in-thread" });
		expect(ask(member("stranger"), thread("thread-2", "work-1"))).toEqual({ ok: false, reason: "ask-elsewhere" });
	});

	test("no ask-only channels configured: /ask is refused as unconfigured", () => {
		const none = parseConfig({ discord: { guildId: "g", allowedUserIds: ["admin"], workChannelId: "work-1" }, github: { appId: 1 } });
		expect(commandAccess(none, { command: "ask", subcommand: null, actor: member("stranger"), where: channel("ask-1"), isWatchChannel: false })).toEqual({
			ok: false,
			reason: "ask-unconfigured",
		});
	});

	test("allowed members are decided by memberAllowed, by user id or role, independent of the channel", () => {
		expect(memberAllowed(config, member("admin"))).toBe(true);
		expect(memberAllowed(config, member("someone", ["role-ops"]))).toBe(true);
		expect(memberAllowed(config, member("stranger", ["role-other"]))).toBe(false);
		expect(memberAllowed(config, null)).toBe(false);
	});
});

describe("refusalMessage", () => {
	test("not-allowed points to /ask only in an ask-only channel", () => {
		expect(refusalMessage(config, "not-allowed", channel("work-1"))).toBe("Not authorized.");
		expect(refusalMessage(config, "not-allowed", channel("ask-1"))).toContain("/ask");
	});

	test("not-a-work-channel names the work channel", () => {
		expect(refusalMessage(config, "not-a-work-channel", channel("elsewhere"))).toContain("<#work-1>");
	});

	test("ask-in-thread names the parent channel; ask-elsewhere lists the ask-only channels and points to /work ask", () => {
		expect(refusalMessage(config, "ask-in-thread", thread("thread-1", "ask-1"))).toContain("<#ask-1>");
		const elsewhere = refusalMessage(config, "ask-elsewhere", channel("work-1"));
		expect(elsewhere).toContain("<#ask-1>");
		expect(elsewhere).toContain("`/work ask`");
	});
});

describe("askThreadAllowed", () => {
	test("the owner and allowed members may post; strangers may not", () => {
		expect(askThreadAllowed(config, member("owner"), "owner")).toBe(true);
		expect(askThreadAllowed(config, member("admin"), "owner")).toBe(true);
		expect(askThreadAllowed(config, member("stranger"), "owner")).toBe(false);
	});
});

test("allowedMentions mentions the allowed users and lists them for the message's mentions", () => {
	expect(allowedMentions(config)).toEqual({ text: "<@admin> ", users: ["admin"] });
	const roleOnly = parseConfig({ discord: { guildId: "g", allowedRoleIds: ["r"], workChannelId: "w" }, github: { appId: 1 } });
	expect(allowedMentions(roleOnly)).toEqual({ text: "", users: [] });
});
