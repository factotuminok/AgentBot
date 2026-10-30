import {
	type APIChannel,
	type APIGuild,
	type APIGuildMember,
	type APIMessage,
	type APIUser,
	ChannelType,
	DiscordAPIError,
	HTTPError,
	REST,
	Routes,
} from "discord.js";
import type { WatchDeps } from "../engine/watches";
import { channelInfo, restMessage } from "./discordjs";
import { MissingPermission } from "./surface";

/**
 * A REST-only Discord client for the admin API (WEB-20 to WEB-24, WEB-32): channel listings, permission data and watch
 * channel writes work whether or not the engine (and its gateway connection) runs. discord.js's REST handles rate limits.
 */

/** Discord's API root; tests point `api` at `test/fakes/discordRest.ts`. */
export const DISCORD_API = "https://discord.com/api";

export const UNKNOWN_CHANNEL = 10003;
export const UNKNOWN_GUILD = 10004;
export const UNKNOWN_MEMBER = 10007;
export const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

/** The surface operations `engine/watches.ts` needs (DSC-35, DSC-36), plus the reads the channel listing needs (WEB-20). */
export type DiscordRest = WatchDeps["discord"] & {
	/** The bot user (401 when the token is invalid). */
	me(): Promise<APIUser>;
	guild(guildId: string): Promise<APIGuild>;
	guildChannels(guildId: string): Promise<APIChannel[]>;
	member(guildId: string, userId: string): Promise<APIGuildMember>;
};

export interface DiscordRestOptions {
	token: string;
	/** Default `DISCORD_API`. */
	api?: string;
	/** Per-request timeout; default 15 s. */
	timeoutMs?: number;
}

/** Discord's JSON error code of a failed REST call, if it has one. */
export function discordErrorCode(err: unknown): number | undefined {
	return err instanceof DiscordAPIError && typeof err.code === "number" ? err.code : undefined;
}

/** The HTTP status of a failed REST call; undefined when Discord was not reached. */
export function discordStatus(err: unknown): number | undefined {
	return err instanceof DiscordAPIError || err instanceof HTTPError ? err.status : undefined;
}

export function createDiscordRest(opts: DiscordRestOptions): DiscordRest {
	const base = new REST({ api: opts.api ?? DISCORD_API, timeout: opts.timeoutMs ?? 15_000, retries: 1 });
	// discord.js drops the token after a 401; set it on every call so a token that works again (Retry) is used again.
	const rest = () => base.setToken(opts.token);

	return {
		me: async () => (await rest().get(Routes.user())) as APIUser,
		guild: async guildId => (await rest().get(Routes.guild(guildId))) as APIGuild,
		guildChannels: async guildId => (await rest().get(Routes.guildChannels(guildId))) as APIChannel[],
		member: async (guildId, userId) => (await rest().get(Routes.guildMember(guildId, userId))) as APIGuildMember,

		async channel(id) {
			try {
				return channelInfo((await rest().get(Routes.channel(id))) as APIChannel);
			} catch (err) {
				const code = discordErrorCode(err);
				if (code === UNKNOWN_CHANNEL || code === MISSING_ACCESS) return null;
				throw err;
			}
		},
		async createTextChannel(guildId, o) {
			try {
				const created = (await rest().post(Routes.guildChannels(guildId), {
					body: { name: o.name, type: ChannelType.GuildText, topic: o.topic, ...(o.parentId ? { parent_id: o.parentId } : {}) },
				})) as APIChannel;
				return created.id;
			} catch (err) {
				if (discordErrorCode(err) === MISSING_PERMISSIONS) throw new MissingPermission("ManageChannels");
				throw err;
			}
		},
		async setChannel(id, patch) {
			await rest().patch(Routes.channel(id), { body: patch });
		},
		async send(channelId, msg) {
			const sent = (await rest().post(Routes.channelMessages(channelId), restMessage(msg))) as APIMessage;
			return { channelId, messageId: sent.id };
		},
	};
}
