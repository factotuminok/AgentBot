import { type Config, isAllowedMember, isAskChannel } from "../../shared/config";
import type { Actor, Where } from "./surface";

/** Authorization for interactions and thread messages (DSC-02). */
export function memberAllowed(config: Config, actor: Actor | null): boolean {
	if (!actor || actor.isBot) return false;
	return isAllowedMember(config, actor.userId, actor.roleIds);
}

/** Who a message notifies: `text` is prepended to the content, `users` goes into `OutMessage.mentions.users` (DSC-07). */
export interface Mention {
	text: string;
	users: string[];
}

/** Mentions of the allowed users, for messages that wait on them (questions, plan review, DSC-16); empty when none. */
export function allowedMentions(config: Config): Mention {
	const users = config.discord.allowedUserIds;
	return { text: users.map(id => `<@${id}> `).join(""), users: [...users] };
}

export type AccessRefusal = "not-allowed" | "not-a-work-channel" | "ask-in-thread" | "ask-elsewhere" | "ask-unconfigured";
export type CommandAccess = { ok: true } | { ok: false; reason: AccessRefusal };

/** `/work` subcommands accepted only in the work channel or a watch channel (DSC-33); the others work anywhere. */
const WORK_CHANNEL_SUBCOMMANDS: Record<string, true> = { start: true, issue: true, plan: true, ask: true, watch: true, unwatch: true };

export interface CommandRequest {
	command: "work" | "ask";
	subcommand: string | null;
	actor: Actor | null;
	where: Where;
	/** `where.channelId` is a watch channel (DSC-35), watched or not. */
	isWatchChannel: boolean;
}

/**
 * Who may run a slash command where (DSC-02 to DSC-05, DSC-33). `/work` needs an allowed member; its repository
 * subcommands also need the work channel or a watch channel. `/ask` is open to everyone directly in an ask-only channel
 * and refused everywhere else, for allowed members too, because it starts a thread from the channel itself.
 */
export function commandAccess(config: Config, req: CommandRequest): CommandAccess {
	if (req.command === "work") {
		if (!memberAllowed(config, req.actor)) return { ok: false, reason: "not-allowed" };
		if (req.subcommand && Object.hasOwn(WORK_CHANNEL_SUBCOMMANDS, req.subcommand)) {
			const inWorkChannel = req.where.channelId === config.discord.workChannelId;
			if (!inWorkChannel && !req.isWatchChannel) return { ok: false, reason: "not-a-work-channel" };
		}
		return { ok: true };
	}
	if (!req.where.isThread && isAskChannel(config, req.where.channelId)) return { ok: true };
	if (config.discord.askChannelIds.length === 0) return { ok: false, reason: "ask-unconfigured" };
	return { ok: false, reason: req.where.isThread && isAskChannel(config, req.where.parentId) ? "ask-in-thread" : "ask-elsewhere" };
}

/** The ephemeral reply that tells a refused user why (DSC-04). */
export function refusalMessage(config: Config, reason: AccessRefusal, where: Pick<Where, "channelId" | "parentId">): string {
	switch (reason) {
		case "not-allowed":
			return isAskChannel(config, where.channelId) ? "Not authorized. Use `/ask` in this channel." : "Not authorized.";
		case "not-a-work-channel":
			return `This command only works in <#${config.discord.workChannelId}> or in a repository's watch channel.`;
		case "ask-in-thread":
			return `\`/ask\` starts a new thread: run it in <#${where.parentId}>, not inside a thread. To follow up here, reply in this thread (only the person who started it can).`;
		case "ask-elsewhere":
			return `\`/ask\` only works in ${config.discord.askChannelIds.map(id => `<#${id}>`).join(", ")}. For a repository, use \`/work ask\`.`;
		case "ask-unconfigured":
			return "No ask-only channel is set up on this server.";
	}
}

/** Messages in an ask-only thread: the person who started it, or an allowed member (DSC-06). Everyone else is ignored. */
export function askThreadAllowed(config: Config, actor: Actor, ownerId: string): boolean {
	return actor.userId === ownerId || memberAllowed(config, actor);
}
