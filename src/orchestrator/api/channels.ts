import { type APIGuildChannel, type APISortableChannel, ChannelType } from "discord-api-types/v10";
import { type CategoryChoice, CHANNELS_UNCONFIGURED, type ChannelChoice, type ChannelListing } from "../../shared/adminChannels";
import type { Settings, SettingsIssue } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import {
	CATEGORY_PERMISSIONS,
	CHANNEL_PERMISSIONS,
	channelPermissions,
	type GuildData,
	type MemberData,
	permissionGaps,
} from "../discord/permissions";
import { createDiscordRest, DISCORD_API, type DiscordRest, discordErrorCode, discordStatus, MISSING_ACCESS, UNKNOWN_GUILD, UNKNOWN_MEMBER } from "../discord/rest";
import { botInviteLink } from "../engine/watches";
import type { Db } from "../store/db";
import type { Vault } from "../store/vault";
import { type AdminRoutes, HttpError } from "./http";

/**
 * Discord channels for the Settings page (WEB-20 to WEB-23) and the save-time check (WEB-24), over Discord's REST API
 * with the bot token, whether or not the engine runs. Also hands out the REST client the Repositories page watches with.
 */

/** WEB-23: the guild listing is reused for at most this long unless refreshed. */
const LISTING_TTL_MS = 60_000;

export interface ChannelDirectoryOptions {
	db: Pick<Db, "listWatches">;
	vault: Pick<Vault, "isInitialized" | "isUnlocked" | "readSettings">;
	/** Discord's API root; default `DISCORD_API`. Tests point it at `test/fakes/discordRest.ts`. */
	discordApi?: string;
	now?: () => number;
}

export interface ChannelCheck {
	/** Save-blocking problems, each naming the field and the channel (WEB-24), at that field's settings path. */
	errors: SettingsIssue[];
	/** Missing permissions other than View Channel, or why the channels could not be checked. */
	warnings: string[];
}

export interface ChannelDirectory {
	/** WEB-20 to WEB-23 for the stored settings; `refresh` skips the cache. 409 while the vault is locked. */
	listing(refresh?: boolean): Promise<ChannelListing>;
	/** WEB-24: `settings`' channels against the live guild, with its token and guild id. */
	check(settings: Settings): Promise<ChannelCheck>;
	/** The REST client for `token` (one per token). */
	rest(token: string): DiscordRest;
}

/** What `GET /guilds/{id}/channels` returns: guild channels (never threads), each with a position. */
type GuildChannel = APIGuildChannel & APISortableChannel;

/** Everything the permission math needs, read in one go. */
interface GuildSnapshot {
	botUserId: string;
	guild: GuildData;
	member: MemberData;
	channels: GuildChannel[];
}

/** A listing failure as the admin sees it (WEB-23). */
class ListingError extends Error {
	constructor(
		message: string,
		readonly inviteLink?: string,
	) {
		super(message);
	}
}

/** Discord's order: by position, then by id (snowflakes compare as numbers). */
function discordOrder(a: GuildChannel, b: GuildChannel): number {
	if (a.position !== b.position) return a.position - b.position;
	const x = BigInt(a.id);
	const y = BigInt(b.id);
	return x < y ? -1 : x > y ? 1 : 0;
}

/** The bot's View Channel and missing `required` permissions in `channel`, from its own overwrites (WEB-21). */
function gaps(snap: GuildSnapshot, channel: GuildChannel, required: typeof CHANNEL_PERMISSIONS) {
	const own = (channel.permission_overwrites ?? []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
	return permissionGaps(channelPermissions(snap.guild, snap.member, own), required);
}

/** Watch channels (DSC-35: kept after unwatching) by channel id → `owner/name`. */
function watchChannels(db: ChannelDirectoryOptions["db"]): Map<string, string> {
	return new Map(db.listWatches().map(w => [w.channel_id, w.repo]));
}

function choices(snap: GuildSnapshot, watches: Map<string, string>): { categories: CategoryChoice[]; channels: ChannelChoice[] } {
	const categories = snap.channels.filter(c => c.type === ChannelType.GuildCategory).sort(discordOrder);
	const known = new Set(categories.map(c => c.id));
	const text = snap.channels.filter(c => c.type === ChannelType.GuildText).sort(discordOrder);
	const parent = (c: GuildChannel) => (c.parent_id && known.has(c.parent_id) ? c.parent_id : null);
	const ordered = [null, ...categories.map(c => c.id)].flatMap(categoryId => text.filter(c => parent(c) === categoryId));
	return {
		categories: categories.map(c => ({ id: c.id, name: c.name ?? "", ...gaps(snap, c, CATEGORY_PERMISSIONS) })),
		channels: ordered.map(c => {
			const watchOf = watches.get(c.id);
			return { id: c.id, name: c.name ?? "", categoryId: parent(c), ...gaps(snap, c, CHANNEL_PERMISSIONS), ...(watchOf ? { watchOf } : {}) };
		}),
	};
}

export function createChannelDirectory(opts: ChannelDirectoryOptions): ChannelDirectory {
	const api = opts.discordApi ?? DISCORD_API;
	const now = opts.now ?? Date.now;
	let client: { token: string; rest: DiscordRest } | undefined;
	let cached: { key: string; at: number; snapshot: Promise<GuildSnapshot> } | undefined;

	function rest(token: string): DiscordRest {
		if (client?.token !== token) client = { token, rest: createDiscordRest({ token, api }) };
		return client.rest;
	}

	async function read(token: string, guildId: string): Promise<GuildSnapshot> {
		const discord = rest(token);
		let botUserId: string;
		try {
			botUserId = (await discord.me()).id;
		} catch (err) {
			if (discordStatus(err) === 401) throw new ListingError("The Discord bot token is invalid (Discord answered 401 Unauthorized). Reset it in the Developer Portal (your application → Bot → Reset Token) and save it again.");
			throw unreachable(err);
		}
		try {
			const [guild, channels, member] = await Promise.all([discord.guild(guildId), discord.guildChannels(guildId), discord.member(guildId, botUserId)]);
			return {
				botUserId,
				guild: { id: guild.id, ownerId: guild.owner_id, roles: guild.roles.map(r => ({ id: r.id, permissions: r.permissions })) },
				member: { userId: botUserId, roleIds: member.roles },
				// The guild channel listing has guild channels only (no threads, no DMs).
				channels: channels as GuildChannel[],
			};
		} catch (err) {
			const code = discordErrorCode(err);
			if (code === UNKNOWN_GUILD || code === MISSING_ACCESS || code === UNKNOWN_MEMBER || discordStatus(err) === 403 || discordStatus(err) === 404) {
				const link = botInviteLink(botUserId);
				throw new ListingError(`The bot is not a member of the Discord server ${guildId} (or the guild id is wrong). Invite it with ${link}`, link);
			}
			throw unreachable(err);
		}
	}

	function unreachable(err: unknown): ListingError {
		const status = discordStatus(err);
		return new ListingError(status === undefined || status >= 500 ? `Discord is unreachable: ${errorMessage(err)}` : `Discord refused the request (HTTP ${status}): ${errorMessage(err)}`);
	}

	/** The guild, from the cache unless `refresh` or older than 60 s; failures are not cached. */
	function snapshot(token: string, guildId: string, refresh: boolean): Promise<GuildSnapshot> {
		const key = `${token}\0${guildId}`;
		if (!refresh && cached?.key === key && now() - cached.at < LISTING_TTL_MS) return cached.snapshot;
		const entry = { key, at: now(), snapshot: read(token, guildId) };
		cached = entry;
		entry.snapshot.catch(() => {
			if (cached === entry) cached = undefined;
		});
		return entry.snapshot;
	}

	function storedSettings(): Settings | undefined {
		if (!opts.vault.isInitialized() || !opts.vault.isUnlocked()) throw new HttpError(409, "Settings are locked; log in to unlock them.");
		return opts.vault.readSettings();
	}

	return {
		rest,

		async listing(refresh = false) {
			let settings: Settings | undefined;
			try {
				settings = storedSettings();
			} catch (err) {
				if (err instanceof HttpError) throw err;
				return { state: "error", error: `The stored settings cannot be read: ${errorMessage(err)}` };
			}
			if (!settings) return { state: "unconfigured", message: CHANNELS_UNCONFIGURED };
			try {
				const snap = await snapshot(settings.secrets.discordToken, settings.config.discord.guildId, refresh);
				return { state: "ok", ...choices(snap, watchChannels(opts.db)) };
			} catch (err) {
				if (!(err instanceof ListingError)) throw err;
				log("warn", "discord channel listing failed", { error: err.message });
				return { state: "error", error: err.message, ...(err.inviteLink ? { inviteLink: err.inviteLink } : {}) };
			}
		},

		async check(settings) {
			const { discord } = settings.config;
			let snap: GuildSnapshot;
			try {
				snap = await snapshot(settings.secrets.discordToken, discord.guildId, true);
			} catch (err) {
				if (!(err instanceof ListingError)) throw err;
				return { errors: [], warnings: [`The Discord channels were not checked: ${err.message}`] };
			}
			const byId = new Map(snap.channels.map(c => [c.id, c]));
			const watches = watchChannels(opts.db);
			const result: ChannelCheck = { errors: [], warnings: [] };
			const fields: { label: string; id: string; category: boolean; path: (string | number)[] }[] = [
				...(discord.workChannelId ? [{ label: "Work channel (discord.workChannelId)", id: discord.workChannelId, category: false, path: ["discord", "workChannelId"] }] : []),
				...discord.askChannelIds.map((id, i) => ({ label: "Ask-only channel (discord.askChannelIds)", id, category: false, path: ["discord", "askChannelIds", i] })),
				...(discord.watchCategoryId ? [{ label: "Watch category (discord.watchCategoryId)", id: discord.watchCategoryId, category: true, path: ["discord", "watchCategoryId"] }] : []),
			];
			for (const { label, id, category, path } of fields) {
				const found = byId.get(id);
				if (!found) {
					result.errors.push({ path, message: `${label}: ${category ? "category" : "channel"} ${id} no longer exists.` });
					continue;
				}
				const name = category ? `category ${found.name}` : `#${found.name}`;
				if (category ? found.type !== ChannelType.GuildCategory : found.type !== ChannelType.GuildText) {
					result.errors.push({ path, message: `${label}: ${name} is not a ${category ? "category" : "text channel"}.` });
					continue;
				}
				const { viewable, missing } = gaps(snap, found, category ? CATEGORY_PERMISSIONS : CHANNEL_PERMISSIONS);
				const watchOf = category ? undefined : watches.get(id);
				if (!viewable) result.errors.push({ path, message: `${label}: the bot can't see ${name}; add it to the channel.` });
				else if (watchOf) result.errors.push({ path, message: `${label}: ${name} is the watch channel of ${watchOf}.` });
				else if (missing.length) result.warnings.push(`${label}: the bot lacks ${missing.join(", ")} in ${name}.`);
			}
			return result;
		},
	};
}

/** GET /channels[?refresh=1] (WEB-20 to WEB-23). */
export function createChannelsRoutes(directory: ChannelDirectory): AdminRoutes {
	return {
		"/channels": {
			methods: ["GET"],
			handle: async (_req, url) => Response.json(await directory.listing(url.searchParams.has("refresh"))),
		},
	};
}
