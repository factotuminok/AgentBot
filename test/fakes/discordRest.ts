import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord-api-types/v10";
import { basePermissions, channelPermissions, type OverwriteData } from "../../src/orchestrator/discord/permissions";

/**
 * A small fake of Discord's REST API: one guild with roles, channels and the bot's member record, plus the writes
 * watch channels make (create channel, patch channel, post message). Point `createDiscordRest({ api })` (or a route
 * factory's `discordApi`) at `api`. Errors carry Discord's JSON codes, so the client's error mapping is exercised.
 */

export interface FakeChannel {
	id: string;
	type: ChannelType;
	name: string;
	position: number;
	parent_id: string | null;
	topic: string | null;
	permission_overwrites: OverwriteData[];
}

export interface FakeDiscordRest {
	/** `REST` `api` option: `http://127.0.0.1:<port>/api`. */
	api: string;
	token: string;
	botUserId: string;
	guildId: string;
	channels: Map<string, FakeChannel>;
	/** Messages posted, oldest first, with the `allowed_mentions` they were sent with (DSC-07). */
	messages: { channelId: string; content: string; allowedMentions: unknown }[];
	/** Every request as `METHOD /path` (without `/api/v10`). */
	requests: string[];
	/** The bot's guild roles (besides @everyone). */
	botRoles: string[];
	/** False: the bot is not in the guild (guild routes answer 403 Missing Access). */
	member: boolean;
	setEveryone(permissions: bigint): void;
	addRole(permissions: bigint, opts?: { bot?: boolean }): string;
	addChannel(c: { name: string; type?: ChannelType; parentId?: string; position?: number; overwrites?: { id: string; member?: boolean; allow?: bigint; deny?: bigint }[] }): FakeChannel;
	stop(): Promise<void>;
}

/** The permissions a bot invited with the WEB-21 link has, as @everyone gets them in a fresh guild. */
export const ALL_CHANNEL_PERMISSIONS =
	PermissionFlagsBits.ViewChannel |
	PermissionFlagsBits.SendMessages |
	PermissionFlagsBits.CreatePublicThreads |
	PermissionFlagsBits.SendMessagesInThreads |
	PermissionFlagsBits.ReadMessageHistory |
	PermissionFlagsBits.AttachFiles |
	PermissionFlagsBits.AddReactions;

export function startFakeDiscordRest(opts: { token?: string } = {}): FakeDiscordRest {
	let nextId = 900_000_000_000_000_000n;
	const id = () => String(nextId++);
	const guildId = id();
	const botUserId = id();
	const roles = new Map<string, { id: string; permissions: string; position: number }>([[guildId, { id: guildId, permissions: String(ALL_CHANNEL_PERMISSIONS), position: 0 }]]);

	const json = (data: unknown, status = 200) => Response.json(data, { status });
	const error = (status: number, code: number, message: string) => json({ message, code }, status);

	const fake: FakeDiscordRest = {
		api: "",
		token: opts.token ?? "fake-bot-token",
		botUserId,
		guildId,
		channels: new Map(),
		messages: [],
		requests: [],
		botRoles: [],
		member: true,
		setEveryone(permissions) {
			roles.get(guildId)!.permissions = String(permissions);
		},
		addRole(permissions, o = {}) {
			const roleId = id();
			roles.set(roleId, { id: roleId, permissions: String(permissions), position: roles.size });
			if (o.bot) fake.botRoles.push(roleId);
			return roleId;
		},
		addChannel(c) {
			const channel: FakeChannel = {
				id: id(),
				type: c.type ?? ChannelType.GuildText,
				name: c.name,
				position: c.position ?? fake.channels.size,
				parent_id: c.parentId ?? null,
				topic: null,
				permission_overwrites: (c.overwrites ?? []).map(o => ({
					id: o.id,
					type: o.member ? OverwriteType.Member : OverwriteType.Role,
					allow: String(o.allow ?? 0n),
					deny: String(o.deny ?? 0n),
				})),
			};
			fake.channels.set(channel.id, channel);
			return channel;
		},
		stop: async () => {},
	};

	const guildData = () => ({ id: guildId, ownerId: "owner-user", roles: [...roles.values()] });
	const memberData = () => ({ userId: botUserId, roleIds: fake.botRoles });
	const channelJson = (c: FakeChannel) => ({ ...c, guild_id: guildId });

	async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname.replace(/^\/api\/v\d+/, "");
		fake.requests.push(`${req.method} ${path}`);
		if (req.headers.get("authorization") !== `Bot ${fake.token}`) return error(401, 0, "401: Unauthorized");
		const body = req.method === "GET" ? undefined : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
		let m: RegExpExecArray | null;
		if (req.method === "GET" && path === "/users/@me") return json({ id: botUserId, username: "agentbot", bot: true });

		if ((m = /^\/guilds\/([^/]+)(\/.*)?$/.exec(path))) {
			if (m[1] !== guildId) return error(404, 10004, "Unknown Guild");
			if (!fake.member) return error(403, 50001, "Missing Access");
			const rest = m[2] ?? "";
			if (req.method === "GET" && rest === "") return json({ id: guildId, name: "Fake guild", owner_id: "owner-user", roles: [...roles.values()] });
			if (req.method === "GET" && rest === "/roles") return json([...roles.values()]);
			if (req.method === "GET" && rest === "/channels") return json([...fake.channels.values()].map(channelJson));
			const member = /^\/members\/([^/]+)$/.exec(rest);
			if (req.method === "GET" && member) {
				if (member[1] !== botUserId && member[1] !== "@me") return error(404, 10007, "Unknown Member");
				return json({ user: { id: botUserId, username: "agentbot" }, roles: fake.botRoles, joined_at: new Date(0).toISOString() });
			}
			if (req.method === "POST" && rest === "/channels") {
				const parentId = typeof body?.parent_id === "string" ? body.parent_id : undefined;
				const parent = parentId ? fake.channels.get(parentId) : undefined;
				const permissions = parent ? channelPermissions(guildData(), memberData(), parent.permission_overwrites) : basePermissions(guildData(), memberData());
				if (!(permissions & PermissionFlagsBits.ManageChannels)) return error(403, 50013, "Missing Permissions");
				const created = fake.addChannel({ name: String(body?.name), parentId });
				created.topic = typeof body?.topic === "string" ? body.topic : null;
				return json(channelJson(created), 201);
			}
		}

		if ((m = /^\/channels\/([^/]+)(\/messages)?$/.exec(path))) {
			const channel = fake.channels.get(m[1]!);
			if (!channel) return error(404, 10003, "Unknown Channel");
			if (m[2]) {
				if (req.method !== "POST") return error(405, 0, "405: Method Not Allowed");
				fake.messages.push({ channelId: channel.id, content: String(body?.content ?? ""), allowedMentions: body?.allowed_mentions });
				return json({ id: id(), channel_id: channel.id, content: body?.content });
			}
			if (req.method === "GET") return json(channelJson(channel));
			if (req.method === "PATCH") {
				if (typeof body?.name === "string") channel.name = body.name;
				if (typeof body?.topic === "string") channel.topic = body.topic;
				return json(channelJson(channel));
			}
		}
		return error(404, 0, "404: Not Found");
	}

	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
	fake.api = `http://127.0.0.1:${server.port}/api`;
	fake.stop = () => server.stop(true);
	return fake;
}
