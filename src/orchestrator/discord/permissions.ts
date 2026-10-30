import { OverwriteType, PermissionFlagsBits } from "discord-api-types/v10";

/**
 * The bot's effective permissions in a channel (WEB-21), computed from REST data the way Discord does
 * (https://discord.com/developers/docs/topics/permissions#permission-overwrites): the guild owner and Administrator get
 * everything; otherwise @everyone's permissions OR the member's roles, then the channel's @everyone overwrite, then the
 * member's role overwrites (all denies, then all allows), then the member's own overwrite.
 */

export interface RoleData {
	id: string;
	/** Bitfield as Discord sends it (a decimal string). */
	permissions: string;
}

export interface OverwriteData {
	id: string;
	type: OverwriteType;
	allow: string;
	deny: string;
}

export interface MemberData {
	userId: string;
	roleIds: readonly string[];
}

export interface GuildData {
	id: string;
	ownerId: string;
	roles: readonly RoleData[];
}

const ALL = (1n << 64n) - 1n;

/** Guild-level permissions: owner and Administrator get every bit. */
export function basePermissions(guild: GuildData, member: MemberData): bigint {
	if (guild.ownerId === member.userId) return ALL;
	const byId = new Map(guild.roles.map(role => [role.id, BigInt(role.permissions)]));
	// The @everyone role has the guild's id.
	let permissions = byId.get(guild.id) ?? 0n;
	for (const roleId of member.roleIds) permissions |= byId.get(roleId) ?? 0n;
	return permissions & PermissionFlagsBits.Administrator ? ALL : permissions;
}

/** Channel-level permissions from `base` and the channel's (or category's) overwrites. */
export function channelPermissions(guild: GuildData, member: MemberData, overwrites: readonly OverwriteData[]): bigint {
	let permissions = basePermissions(guild, member);
	if (permissions === ALL) return ALL;
	const everyone = overwrites.find(o => o.type === OverwriteType.Role && o.id === guild.id);
	if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
	let allow = 0n;
	let deny = 0n;
	const roles = new Set(member.roleIds);
	for (const o of overwrites) {
		if (o.type !== OverwriteType.Role || o.id === guild.id || !roles.has(o.id)) continue;
		allow |= BigInt(o.allow);
		deny |= BigInt(o.deny);
	}
	permissions = (permissions & ~deny) | allow;
	const own = overwrites.find(o => o.type === OverwriteType.Member && o.id === member.userId);
	if (own) permissions = (permissions & ~BigInt(own.deny)) | BigInt(own.allow);
	return permissions;
}

/** WEB-21: what the work channel and ask-only channels need, with the names Discord's UI uses. */
export const CHANNEL_PERMISSIONS: readonly (readonly [bigint, string])[] = [
	[PermissionFlagsBits.ViewChannel, "View Channel"],
	[PermissionFlagsBits.SendMessages, "Send Messages"],
	[PermissionFlagsBits.CreatePublicThreads, "Create Public Threads"],
	[PermissionFlagsBits.SendMessagesInThreads, "Send Messages in Threads"],
	[PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
	[PermissionFlagsBits.AttachFiles, "Attach Files"],
	[PermissionFlagsBits.AddReactions, "Add Reactions"],
];

/** WEB-21: the watch category needs the channel permissions plus Manage Channels (DSC-38). */
export const CATEGORY_PERMISSIONS: readonly (readonly [bigint, string])[] = [...CHANNEL_PERMISSIONS, [PermissionFlagsBits.ManageChannels, "Manage Channels"]];

/** Whether `permissions` include View Channel, and the names of the other `required` permissions it lacks. */
export function permissionGaps(permissions: bigint, required: readonly (readonly [bigint, string])[]): { viewable: boolean; missing: string[] } {
	return {
		viewable: (permissions & PermissionFlagsBits.ViewChannel) !== 0n,
		missing: required.filter(([bit]) => bit !== PermissionFlagsBits.ViewChannel && (permissions & bit) === 0n).map(([, name]) => name),
	};
}
