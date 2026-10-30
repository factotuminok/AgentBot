import { describe, expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord-api-types/v10";
import type { AvailableRepo } from "../../src/orchestrator/github/types";
import { openDb } from "../../src/orchestrator/store/db";
import {
	botInviteLink,
	UNWATCHED_TOPIC,
	unwatchRepo,
	type WatchDeps,
	WatchRefused,
	watchChannelName,
	watchRepo,
	watchTopic,
} from "../../src/orchestrator/engine/watches";
import { parseConfig, resolveLabelNames } from "../../src/shared/config";
import { createFakeDiscord } from "../fakes/discord";

function setup(opts: { category?: boolean } = {}) {
	const discord = createFakeDiscord({ guildId: "g1" });
	const work = discord.addChannel({ name: "work", guildId: "g1" });
	const category = opts.category ? discord.addChannel({ name: "watched", kind: "category", guildId: "g1" }) : undefined;
	const config = parseConfig({
		discord: { guildId: "g1", allowedUserIds: ["u1"], workChannelId: work.id, watchCategoryId: category?.id },
		github: { appId: 1 },
		labels: { trigger: "bot-me" },
	});
	const db = openDb(":memory:");
	const deps: WatchDeps = { db, discord, config, labels: resolveLabelNames(config) };
	return { deps, db, discord, category };
}

const repo = (over: Partial<AvailableRepo> = {}): AvailableRepo => ({
	id: 42,
	fullName: "Acme/My.App",
	private: false,
	archived: false,
	defaultBranch: "main",
	installationId: 1,
	...over,
});

describe("watchChannelName (DSC-35)", () => {
	test("owner-repo, lowercased, other characters replaced by '-', at most 100 characters", () => {
		expect(watchChannelName("Acme/My.App")).toBe("acme-my-app");
		expect(watchChannelName("o_o/R-2")).toBe("o-o-r-2");
		expect(watchChannelName(`a/${"b".repeat(150)}`)).toHaveLength(100);
	});
});

describe("watchRepo", () => {
	test("creates the channel with its topic, records the watch and replies with a link", async () => {
		const { deps, db, discord } = setup();
		const out = await watchRepo(deps, repo(), "u1");
		expect(out).toMatchObject({ created: true, alreadyWatched: false });
		const channel = discord.channels().find(c => c.id === out.channelId)!;
		expect(channel).toMatchObject({ name: "acme-my-app", topic: "Watching Acme/My.App: issues labelled `bot-me` start here.", parentId: null });
		expect(db.getWatch(42)).toMatchObject({ repo: "Acme/My.App", channel_id: out.channelId, created_by: "u1", state: "watching" });
		expect(out.message).toContain(`<#${out.channelId}>`);
	});

	test("creates the channel in the watch category when one is set", async () => {
		const { deps, discord, category } = setup({ category: true });
		const out = await watchRepo(deps, repo(), "u1");
		expect(discord.channels().find(c => c.id === out.channelId)?.parentId).toBe(category!.id);
	});

	test("an already watched repository replies with its channel and changes nothing", async () => {
		const { deps, discord } = setup();
		const first = await watchRepo(deps, repo(), "u1");
		const count = discord.channels().length;
		const again = await watchRepo(deps, repo(), "u2");
		expect(again).toMatchObject({ channelId: first.channelId, created: false, alreadyWatched: true });
		expect(again.message).toContain(`<#${first.channelId}>`);
		expect(discord.channels()).toHaveLength(count);
	});

	test("re-watching reuses the earlier channel while Discord still has it, and restores its topic", async () => {
		const { deps, db, discord } = setup();
		const first = await watchRepo(deps, repo(), "u1");
		await unwatchRepo(deps, "acme/my.app", "u1");
		expect(discord.channels().find(c => c.id === first.channelId)?.topic).toBe(UNWATCHED_TOPIC);
		const again = await watchRepo(deps, repo(), "u2");
		expect(again).toMatchObject({ channelId: first.channelId, created: false, alreadyWatched: false });
		expect(discord.channels().find(c => c.id === first.channelId)?.topic).toBe(watchTopic("Acme/My.App", "bot-me"));
		expect(db.getWatch(42)).toMatchObject({ state: "watching", created_by: "u2" });
	});

	test("re-watching after the channel was deleted creates a new one", async () => {
		const { deps, db, discord } = setup();
		const first = await watchRepo(deps, repo(), "u1");
		await unwatchRepo(deps, "Acme/My.App", "u1");
		discord.deleteChannel(first.channelId);
		const again = await watchRepo(deps, repo(), "u1");
		expect(again.created).toBe(true);
		expect(again.channelId).not.toBe(first.channelId);
		expect(db.getWatch(42)?.channel_id).toBe(again.channelId);
	});

	test("without Manage Channels it fails naming the permission and the invite link (DSC-38), recording nothing", async () => {
		const { deps, db, discord } = setup();
		discord.deny("ManageChannels");
		const err = await watchRepo(deps, repo(), "u1", "123456").catch(e => e);
		expect(err).toBeInstanceOf(WatchRefused);
		expect(err.message).toContain("Manage Channels");
		expect(err.message).toContain(botInviteLink("123456"));
		expect(db.getWatch(42)).toBeNull();
	});

	test("an archived repository is refused (GH-25)", async () => {
		const { deps, db } = setup();
		const err = await watchRepo(deps, repo({ archived: true }), "u1").catch(e => e);
		expect(err).toBeInstanceOf(WatchRefused);
		expect(err.message).toBe("Acme/My.App is archived (read-only)");
		expect(db.getWatch(42)).toBeNull();
	});
});

describe("unwatchRepo (DSC-36)", () => {
	test("stops the watch, keeps the channel with the 'No longer watched' topic and posts there", async () => {
		const { deps, db, discord } = setup();
		const { channelId } = await watchRepo(deps, repo(), "u1");
		const out = await unwatchRepo(deps, "Acme/My.App", "u1");
		expect(out.channelId).toBe(channelId);
		expect(db.getWatch(42)?.state).toBe("unwatched");
		const channel = discord.channels().find(c => c.id === channelId);
		expect(channel?.topic).toBe(UNWATCHED_TOPIC);
		expect(discord.lastMessage(channelId)?.content).toContain("No longer watching **Acme/My.App**");
	});

	test("a repository that is not watched gets a message and nothing changes", async () => {
		const { deps } = setup();
		expect(await unwatchRepo(deps, "o/r", "u1")).toEqual({ channelId: null, message: "**o/r** is not watched." });
	});
});

describe("botInviteLink", () => {
	test("grants the WEB-21 channel permissions plus Change Nickname and Manage Channels", () => {
		const url = new URL(botInviteLink("999"));
		expect(url.searchParams.get("client_id")).toBe("999");
		expect(url.searchParams.get("scope")).toBe("bot applications.commands");
		const bits = BigInt(url.searchParams.get("permissions")!);
		for (const flag of [
			"ViewChannel",
			"SendMessages",
			"CreatePublicThreads",
			"SendMessagesInThreads",
			"ReadMessageHistory",
			"AttachFiles",
			"AddReactions",
			"ChangeNickname",
			"ManageChannels",
		] as const) {
			expect(bits & PermissionFlagsBits[flag]).toBe(PermissionFlagsBits[flag]);
		}
		expect(bits & PermissionFlagsBits.Administrator).toBe(0n);
	});
});
