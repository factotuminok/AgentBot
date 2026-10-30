import { describe, expect, test } from "bun:test";
import { OverwriteType, PermissionFlagsBits as P } from "discord-api-types/v10";
import {
	basePermissions,
	CATEGORY_PERMISSIONS,
	CHANNEL_PERMISSIONS,
	channelPermissions,
	type GuildData,
	permissionGaps,
} from "../../src/orchestrator/discord/permissions";

const GUILD = "g";
const BOT = "bot";

function guild(everyone: bigint, roles: Record<string, bigint> = {}, ownerId = "someone"): GuildData {
	return { id: GUILD, ownerId, roles: [{ id: GUILD, permissions: String(everyone) }, ...Object.entries(roles).map(([id, p]) => ({ id, permissions: String(p) }))] };
}

const role = (id: string, allow = 0n, deny = 0n) => ({ id, type: OverwriteType.Role, allow: String(allow), deny: String(deny) });
const member = (allow = 0n, deny = 0n) => ({ id: BOT, type: OverwriteType.Member, allow: String(allow), deny: String(deny) });
const has = (permissions: bigint, bit: bigint) => (permissions & bit) !== 0n;

describe("basePermissions (WEB-21)", () => {
	test("@everyone OR the member's roles", () => {
		const g = guild(P.ViewChannel, { r1: P.SendMessages, r2: P.AttachFiles });
		const p = basePermissions(g, { userId: BOT, roleIds: ["r1"] });
		expect(has(p, P.ViewChannel)).toBe(true);
		expect(has(p, P.SendMessages)).toBe(true);
		expect(has(p, P.AttachFiles)).toBe(false);
	});

	test("Administrator on any role grants everything, and channel overwrites can't take it away", () => {
		const g = guild(0n, { admin: P.Administrator });
		const m = { userId: BOT, roleIds: ["admin"] };
		expect(has(basePermissions(g, m), P.ManageChannels)).toBe(true);
		const p = channelPermissions(g, m, [role(GUILD, 0n, P.ViewChannel), member(0n, P.ViewChannel)]);
		expect(has(p, P.ViewChannel)).toBe(true);
	});

	test("the guild owner has everything", () => {
		expect(has(basePermissions(guild(0n, {}, BOT), { userId: BOT, roleIds: [] }), P.ManageChannels)).toBe(true);
	});
});

describe("channelPermissions (WEB-21)", () => {
	const g = guild(P.ViewChannel | P.SendMessages, { r1: 0n, r2: 0n });
	const m = { userId: BOT, roleIds: ["r1", "r2"] };

	test("the @everyone overwrite denies and allows first", () => {
		const p = channelPermissions(g, m, [role(GUILD, P.AttachFiles, P.ViewChannel)]);
		expect(has(p, P.ViewChannel)).toBe(false);
		expect(has(p, P.AttachFiles)).toBe(true);
	});

	test("role overwrites: an allow on any role beats a deny on another", () => {
		const p = channelPermissions(g, m, [role(GUILD, 0n, P.ViewChannel), role("r1", 0n, P.ViewChannel), role("r2", P.ViewChannel)]);
		expect(has(p, P.ViewChannel)).toBe(true);
	});

	test("overwrites of roles the bot doesn't have are ignored", () => {
		expect(has(channelPermissions(g, m, [role("other", 0n, P.ViewChannel)]), P.ViewChannel)).toBe(true);
	});

	test("the member overwrite applies last, over role overwrites", () => {
		expect(has(channelPermissions(g, m, [role("r1", P.ReadMessageHistory), member(0n, P.ReadMessageHistory)]), P.ReadMessageHistory)).toBe(false);
		expect(has(channelPermissions(g, m, [role("r1", 0n, P.SendMessages), member(P.SendMessages)]), P.SendMessages)).toBe(true);
	});
});

describe("permissionGaps", () => {
	test("names the missing channel permissions, View Channel reported separately", () => {
		const gaps = permissionGaps(P.ViewChannel | P.SendMessages | P.ReadMessageHistory, CHANNEL_PERMISSIONS);
		expect(gaps).toEqual({ viewable: true, missing: ["Create Public Threads", "Send Messages in Threads", "Attach Files", "Add Reactions"] });
		expect(permissionGaps(P.SendMessages, CHANNEL_PERMISSIONS).viewable).toBe(false);
	});

	test("the watch category also needs Manage Channels", () => {
		const all = CHANNEL_PERMISSIONS.reduce((bits, [bit]) => bits | bit, 0n);
		expect(permissionGaps(all, CATEGORY_PERMISSIONS).missing).toEqual(["Manage Channels"]);
		expect(permissionGaps(all | P.ManageChannels, CATEGORY_PERMISSIONS).missing).toEqual([]);
	});
});
