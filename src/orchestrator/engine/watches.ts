import { PermissionFlagsBits } from "discord-api-types/v10";
import { errorMessage, log } from "../../shared/log";
import type { Config } from "../../shared/config";
import { type DiscordSurface, MissingPermission } from "../discord/surface";
import type { AvailableRepo } from "../github/types";
import type { EngineDeps } from "./deps";

/**
 * Watch channels (DSC-35, DSC-36, DSC-38): `/work watch`, `/work unwatch` and (phase 6) the Repositories page call these.
 * Polling of a watched repository is the poller's (GH-10, GH-27); this module only records watches and manages channels.
 */

/** The engine's deps, or the admin API's REST-backed equivalents (WEB-32): only the surface calls watching needs, and no work channel. */
export type WatchDeps = Pick<EngineDeps, "db" | "labels"> & { config: Config; discord: Pick<DiscordSurface, "channel" | "createTextChannel" | "setChannel" | "send"> };

export interface WatchOutcome {
	channelId: string;
	/** A new channel was created (false when an earlier channel was reused or the repository was already watched). */
	created: boolean;
	/** The repository was already watched; nothing changed. */
	alreadyWatched: boolean;
	/** Reply text with a link to the channel. */
	message: string;
}

/** A refused watch; `message` is the user-facing reason (GH-25 archived, DSC-38 missing Manage Channels). */
export class WatchRefused extends Error {
	override name = "WatchRefused";
}

const CHANNEL_NAME_MAX = 100;

/** DSC-35: `owner-repo`, lowercased, every character other than `a-z0-9` replaced by `-`, at most 100 characters. */
export function watchChannelName(fullName: string): string {
	return fullName.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, CHANNEL_NAME_MAX);
}

/** DSC-35 step 2. */
export function watchTopic(fullName: string, trigger: string): string {
	return `Watching ${fullName}: issues labelled \`${trigger}\` start here.`;
}

/** DSC-36. */
export const UNWATCHED_TOPIC = "No longer watched";

/** WEB-21 channel permissions + Change Nickname (DSC-29) + Manage Channels (DSC-38). */
export const BOT_PERMISSIONS =
	PermissionFlagsBits.ViewChannel |
	PermissionFlagsBits.SendMessages |
	PermissionFlagsBits.CreatePublicThreads |
	PermissionFlagsBits.SendMessagesInThreads |
	PermissionFlagsBits.ReadMessageHistory |
	PermissionFlagsBits.AttachFiles |
	PermissionFlagsBits.AddReactions |
	PermissionFlagsBits.ChangeNickname |
	PermissionFlagsBits.ManageChannels;

/** The bot's invite link (DSC-38, WEB-22): the bot and slash-command scopes with `BOT_PERMISSIONS`. */
export function botInviteLink(clientId: string): string {
	const params = new URLSearchParams({ client_id: clientId, scope: "bot applications.commands", permissions: BOT_PERMISSIONS.toString() });
	return `https://discord.com/oauth2/authorize?${params}`;
}

/** DSC-38: the reason a watch channel could not be created, with the invite link when the bot's id is known. */
export function manageChannelsMessage(botUserId?: string): string {
	const base =
		"Cannot create the watch channel: the bot needs the **Manage Channels** permission (server-wide, or on the watch category).";
	return botUserId ? `${base} Re-invite it with this link to grant it: ${botInviteLink(botUserId)}` : base;
}

/**
 * DSC-35: watch `repo`. Creates its channel (in `discord.watchCategoryId` when set), or reuses the channel of an earlier
 * watch while Discord still has it, sets the topic and records the watch (`createdBy`: Discord user id or admin username).
 * Throws `WatchRefused` for an archived repository (GH-25) or without Manage Channels (DSC-38).
 */
export async function watchRepo(deps: WatchDeps, repo: AvailableRepo, createdBy: string, botUserId?: string): Promise<WatchOutcome> {
	if (repo.archived) throw new WatchRefused(`${repo.fullName} is archived (read-only)`);
	const { db, discord, config } = deps;
	const existing = db.getWatch(repo.id);
	const earlier = existing ? await discord.channel(existing.channel_id) : null;
	if (existing?.state === "watching" && earlier) {
		return { channelId: existing.channel_id, created: false, alreadyWatched: true, message: `**${repo.fullName}** is already watched in <#${existing.channel_id}>.` };
	}
	const topic = watchTopic(repo.fullName, deps.labels.trigger);
	let channelId: string;
	let created: boolean;
	try {
		if (earlier) {
			channelId = earlier.id;
			created = false;
			await discord.setChannel(channelId, { topic });
		} else {
			channelId = await discord.createTextChannel(config.discord.guildId, {
				name: watchChannelName(repo.fullName),
				topic,
				parentId: config.discord.watchCategoryId,
			});
			created = true;
		}
	} catch (err) {
		if (err instanceof MissingPermission && err.permission === "ManageChannels") throw new WatchRefused(manageChannelsMessage(botUserId));
		throw err;
	}
	db.watchRepo({ repoId: repo.id, repo: repo.fullName, channelId, createdBy });
	log("info", "repository watched", { repo: repo.fullName, channel: channelId, created, by: createdBy });
	const message = created
		? `👀 Watching **${repo.fullName}** in <#${channelId}>: issues labelled \`${deps.labels.trigger}\` start there.`
		: `👀 Watching **${repo.fullName}** again in <#${channelId}>.`;
	return { channelId, created, alreadyWatched: false, message };
}

/**
 * DSC-36: stop looking for new issues in `repo` (`owner/name`). Tracked issues continue; the channel is kept with the topic
 * "No longer watched" and a message posted there (both best effort). Answers with a message when it was not watched.
 */
export async function unwatchRepo(deps: WatchDeps, repo: string, by: string): Promise<{ channelId: string | null; message: string }> {
	const watch = deps.db.watchByName(repo);
	if (!watch || watch.state === "unwatched") return { channelId: watch?.channel_id ?? null, message: `**${repo}** is not watched.` };
	deps.db.updateWatch(watch.repo_id, { state: "unwatched" });
	log("info", "repository unwatched", { repo: watch.repo, channel: watch.channel_id, by });
	await deps.discord
		.setChannel(watch.channel_id, { topic: UNWATCHED_TOPIC })
		.catch(err => log("warn", "unwatched topic not set", { repo: watch.repo, channel: watch.channel_id, error: errorMessage(err) }));
	await deps.discord
		.send(watch.channel_id, {
			content: `👋 No longer watching **${watch.repo}**. Issues already tracked here continue; newly labelled issues are not picked up.`,
		})
		.catch(err => log("warn", "unwatch message not posted", { repo: watch.repo, channel: watch.channel_id, error: errorMessage(err) }));
	return { channelId: watch.channel_id, message: `Stopped watching **${watch.repo}**. <#${watch.channel_id}> is kept.` };
}
