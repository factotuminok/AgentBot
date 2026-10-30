import {
	type APIChannel,
	type APIMessage,
	type APIInteractionGuildMember,
	ApplicationCommandOptionType,
	type AutocompleteInteraction,
	type ButtonInteraction,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	type CommandInteractionOption,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	type GuildMember,
	type InteractionReplyOptions,
	type Message,
	MessageFlags,
	type ModalSubmitInteraction,
	type RateLimitData,
	RateLimitError,
	RESTEvents,
	Routes,
	type StringSelectMenuInteraction,
	type TextBasedChannel,
} from "discord.js";
import { errorMessage, log } from "../../shared/log";
import { createOutboundQueue } from "./queue";
import {
	type Actor,
	type ChannelInfo,
	type ChannelKind,
	type DiscordConnection,
	type InAttachment,
	type InboundEvent,
	type InteractionResponder,
	MissingPermission,
	type MsgRef,
	type OutMessage,
	type Priority,
	type ReplyOptions,
	type Where,
} from "./surface";

/**
 * The only module that imports discord.js: `DiscordConnection` over a discord.js `Client`. Writes go to Discord's REST
 * API through the outbound queue (DSC-32); discord.js is told to reject, not wait, when a queued route is rate-limited,
 * so the queue owns the retry-after. Interaction responses and reads are not queued.
 */

/** Discord answers an interaction within 3 s or fails it; slower handlers are deferred automatically. */
const AUTO_DEFER_MS = 2_500;

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function apiCode(err: unknown): number | undefined {
	return err instanceof DiscordAPIError && typeof err.code === "number" ? err.code : undefined;
}

/** Writes the queue performs: everything except reads under /channels and /guilds (interaction callbacks are excluded). */
function isQueuedRoute(data: Pick<RateLimitData, "route" | "method">): boolean {
	return data.method.toUpperCase() !== "GET" && (data.route.startsWith("/channels") || data.route.startsWith("/guilds"));
}

function allowedMentions(msg: OutMessage) {
	return { parse: [], users: msg.mentions?.users ?? [], roles: msg.mentions?.roles ?? [] };
}

/** REST body and files of a message create or edit. */
function restMessage(msg: OutMessage, extra: Record<string, unknown> = {}) {
	const files = msg.files?.map((file, index) => ({ key: `files[${index}]`, name: file.name, data: file.data }));
	return {
		body: {
			content: msg.content,
			allowed_mentions: allowedMentions(msg),
			...(msg.components ? { components: msg.components } : {}),
			...(files ? { attachments: files.map((file, index) => ({ id: index, filename: file.name })) } : {}),
			...extra,
		},
		...(files ? { files } : {}),
	};
}

/** Payload of an interaction edit or update (no flags). */
function editPayload(msg: OutMessage) {
	return {
		content: msg.content,
		allowedMentions: allowedMentions(msg),
		...(msg.components ? { components: msg.components } : {}),
		...(msg.files ? { files: msg.files.map(file => ({ attachment: Buffer.from(file.data), name: file.name })) } : {}),
	};
}

function replyPayload(msg: ReplyOptions): InteractionReplyOptions {
	return { ...editPayload(msg), ...(msg.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) };
}

function channelKind(type: ChannelType): ChannelKind {
	switch (type) {
		case ChannelType.GuildText:
		case ChannelType.GuildAnnouncement:
			return "text";
		case ChannelType.GuildCategory:
			return "category";
		case ChannelType.PublicThread:
		case ChannelType.PrivateThread:
		case ChannelType.AnnouncementThread:
			return "thread";
		default:
			return "other";
	}
}

function actorOf(user: { id: string; username: string; bot: boolean }, member: GuildMember | APIInteractionGuildMember | null | undefined): Actor {
	const roleIds = !member ? [] : Array.isArray(member.roles) ? [...member.roles] : [...(member as GuildMember).roles.cache.keys()];
	return { userId: user.id, username: user.username, roleIds, isBot: user.bot };
}

function whereOf(guildId: string | null, channelId: string, channel: TextBasedChannel | null): Where {
	const isThread = !!channel?.isThread();
	return { guildId, channelId, parentId: isThread && channel?.isThread() ? channel.parentId : null, isThread };
}

function attachmentOf(a: { name: string; url: string; size: number; contentType: string | null }): InAttachment {
	return { name: a.name, url: a.url, size: a.size, ...(a.contentType ? { contentType: a.contentType } : {}) };
}

type Repliable = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/**
 * Interaction responses with the 3 s rule handled here (DSC-08 keeps it out of engine code): if the handler has not
 * responded after `autoDeferMs`, the interaction is deferred — silently (deferUpdate) for components and modals from a
 * message, as a public "thinking" reply for commands — and later responses are mapped onto the deferred one.
 */
function responder(i: Repliable, autoDeferMs: number) {
	const silent = !i.isChatInputCommand() && (!i.isModalSubmit() || i.isFromMessage());
	let acked = false;
	let deferring: Promise<unknown> | undefined;
	const timer = setTimeout(() => {
		if (acked) return;
		acked = true;
		const update = i.isModalSubmit() && i.isFromMessage() ? i.deferUpdate() : i.isMessageComponent() ? i.deferUpdate() : i.deferReply();
		deferring = update.catch(err => log("warn", "interaction auto-defer failed", { error: errorMessage(err) }));
	}, autoDeferMs);
	const take = async (): Promise<boolean> => {
		clearTimeout(timer);
		if (!deferring) {
			acked = true;
			return false;
		}
		await deferring;
		return true;
	};

	const base: InteractionResponder = {
		async reply(msg) {
			if (!(await take())) return void (await i.reply(replyPayload(msg)));
			if (silent || msg.ephemeral) {
				await i.followUp(replyPayload(msg));
				if (!silent) await i.deleteReply().catch(() => {});
			} else {
				await i.editReply(editPayload(msg));
			}
		},
		async defer(opts) {
			if (await take()) return;
			await i.deferReply(opts?.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
		},
		async editReply(msg) {
			await take();
			await i.editReply(editPayload(msg));
		},
		async followUp(msg) {
			await take();
			await i.followUp(replyPayload(msg));
		},
	};
	return {
		base,
		get acked() {
			return acked;
		},
		done: () => clearTimeout(timer),
		async update(msg: OutMessage) {
			if (i.isChatInputCommand() || (i.isModalSubmit() && !i.isFromMessage())) throw new Error("this interaction has no message to update");
			const deferred = await take();
			if (deferred) await i.editReply(editPayload(msg));
			else await i.update(editPayload(msg));
		},
		async deferUpdate() {
			if (i.isChatInputCommand() || (i.isModalSubmit() && !i.isFromMessage())) throw new Error("this interaction has no message to update");
			if (await take()) return;
			await i.deferUpdate();
		},
		async showModal(modal: Parameters<ButtonInteraction["showModal"]>[0]) {
			if (!i.isMessageComponent()) throw new Error("only a component interaction can open a modal");
			if (await take()) throw new Error("the interaction was already deferred; a modal can no longer be shown");
			await i.showModal(modal);
		},
	};
}

/** Command options as name → value, from the top level or the subcommand; attachment options are returned separately. */
function commandOptions(data: readonly CommandInteractionOption[]): { options: Record<string, string | number | boolean>; attachments: InAttachment[] } {
	const options: Record<string, string | number | boolean> = {};
	const attachments: InAttachment[] = [];
	const leaves = data.length === 1 && data[0]!.type === ApplicationCommandOptionType.Subcommand ? (data[0]!.options ?? []) : data;
	for (const option of leaves) {
		if (option.type === ApplicationCommandOptionType.Attachment) {
			if (option.attachment) attachments.push(attachmentOf(option.attachment));
		} else if (option.value !== undefined) {
			options[option.name] = option.value;
		}
	}
	return { options, attachments };
}

export interface DiscordJsOptions {
	/** Default 2500 ms. */
	autoDeferMs?: number;
}

export function createDiscordJsConnection(opts: DiscordJsOptions = {}): DiscordConnection {
	const autoDeferMs = opts.autoDeferMs ?? AUTO_DEFER_MS;
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		allowedMentions: { parse: [] },
		rest: { rejectOnRateLimit: data => isQueuedRoute(data) },
	});
	const queue = createOutboundQueue({
		rateLimitOf: err => (err instanceof RateLimitError ? { retryAfterMs: err.retryAfter > 0 ? err.retryAfter : err.timeToReset, global: err.global } : undefined),
	});
	client.rest.on(RESTEvents.RateLimited, data => {
		if (data.global) queue.limited(null, data.retryAfter);
		else if (data.route.startsWith("/channels")) queue.limited(data.majorParameter, data.retryAfter);
	});
	const eventHandlers = new Set<(event: InboundEvent) => void | Promise<void>>();
	const readyHandlers = new Set<() => void | Promise<void>>();

	function write<T>(priority: Priority, bucket: string, run: () => Promise<T>, coalesce?: string): Promise<T> {
		return queue.push({ priority, bucket, coalesce, run }) as Promise<T>;
	}

	async function getChannel(id: string): Promise<APIChannel | null> {
		try {
			return (await client.rest.get(Routes.channel(id))) as APIChannel;
		} catch (err) {
			const code = apiCode(err);
			if (code === UNKNOWN_CHANNEL || code === MISSING_ACCESS) return null;
			throw err;
		}
	}

	async function getMessage(ref: MsgRef): Promise<APIMessage | null> {
		try {
			return (await client.rest.get(Routes.channelMessage(ref.channelId, ref.messageId))) as APIMessage;
		} catch (err) {
			const code = apiCode(err);
			if (code === UNKNOWN_MESSAGE || code === UNKNOWN_CHANNEL || code === MISSING_ACCESS) return null;
			throw err;
		}
	}

	async function fire(): Promise<void> {
		for (const handler of readyHandlers) {
			try {
				await handler();
			} catch (err) {
				log("error", "discord ready handler failed", { error: errorMessage(err) });
			}
		}
	}

	/** Runs every handler; an unhandled error is logged and, for an interaction, answered `Error: <message>` (DSC-08). */
	async function deliver(event: InboundEvent, r?: ReturnType<typeof responder>): Promise<void> {
		try {
			for (const handler of eventHandlers) {
				try {
					await handler(event);
				} catch (err) {
					log("error", "discord event handler failed", { event: event.type, error: errorMessage(err) });
					if (!r) continue;
					const answer = { content: `Error: ${errorMessage(err)}`, ephemeral: true };
					await (r.acked ? r.base.followUp(answer) : r.base.reply(answer)).catch(e => log("warn", "error reply failed", { error: errorMessage(e) }));
				}
			}
		} finally {
			r?.done();
		}
	}

	client.on(Events.InteractionCreate, async interaction => {
		const where = whereOf(interaction.guildId, interaction.channelId ?? "", interaction.channel);
		const actor = actorOf(interaction.user, interaction.member);
		if (interaction.isChatInputCommand()) {
			if (interaction.commandName !== "work" && interaction.commandName !== "ask") return;
			const r = responder(interaction, autoDeferMs);
			const { options, attachments } = commandOptions(interaction.options.data);
			await deliver(
				{ type: "command", command: interaction.commandName, subcommand: interaction.options.getSubcommand(false), options, attachments, actor, where, ...r.base },
				r,
			);
		} else if (interaction.isAutocomplete()) {
			const i: AutocompleteInteraction = interaction;
			if (i.commandName !== "work" && i.commandName !== "ask") return;
			const focused = i.options.getFocused(true);
			await deliver({
				type: "autocomplete",
				command: i.commandName,
				subcommand: i.options.getSubcommand(false),
				focused: { name: focused.name, value: String(focused.value) },
				actor,
				where,
				respond: async choices => void (await i.respond(choices)),
			});
		} else if (interaction.isButton() || interaction.isStringSelectMenu()) {
			const r = responder(interaction, autoDeferMs);
			await deliver(
				{
					type: "component",
					customId: interaction.customId,
					values: interaction.isStringSelectMenu() ? [...interaction.values] : [],
					message: { channelId: interaction.message.channelId, messageId: interaction.message.id },
					actor,
					where,
					...r.base,
					update: r.update,
					deferUpdate: r.deferUpdate,
					showModal: r.showModal,
				},
				r,
			);
		} else if (interaction.isModalSubmit()) {
			const r = responder(interaction, autoDeferMs);
			const fields: Record<string, string> = {};
			for (const [id, field] of interaction.fields.fields) if ("value" in field && typeof field.value === "string") fields[id] = field.value;
			await deliver(
				{
					type: "modal",
					customId: interaction.customId,
					fields,
					message: interaction.message ? { channelId: interaction.message.channelId, messageId: interaction.message.id } : null,
					actor,
					where,
					...r.base,
					update: r.update,
					deferUpdate: r.deferUpdate,
				},
				r,
			);
		}
	});

	client.on(Events.MessageCreate, async (message: Message) => {
		// DSC-08: bot authors and direct messages are ignored; messages outside threads go to the bot, which decides.
		if (message.author.bot || !message.inGuild()) return;
		await deliver({
			type: "message",
			ref: { channelId: message.channelId, messageId: message.id },
			content: message.content,
			attachments: [...message.attachments.values()].map(attachmentOf),
			actor: actorOf(message.author, message.member),
			where: whereOf(message.guildId, message.channelId, message.channel),
		});
	});

	// The first ready fires on ClientReady; later READYs (a reconnect with a new session) arrive as ShardReady.
	client.once(Events.ClientReady, () => void fire());
	client.on(Events.ShardReady, () => {
		if (client.isReady()) void fire();
	});
	client.on(Events.Error, err => log("error", "discord client error", { error: errorMessage(err) }));

	return {
		send(channelId, msg, priority = "high") {
			return write(priority, channelId, async () => {
				const sent = (await client.rest.post(Routes.channelMessages(channelId), restMessage(msg))) as APIMessage;
				return { channelId, messageId: sent.id };
			});
		},
		reply(to, msg, priority = "high") {
			return write(priority, to.channelId, async () => {
				const sent = (await client.rest.post(
					Routes.channelMessages(to.channelId),
					restMessage(msg, { message_reference: { message_id: to.messageId, fail_if_not_exists: false } }),
				)) as APIMessage;
				return { channelId: to.channelId, messageId: sent.id };
			});
		},
		async edit(ref, msg, priority) {
			await write(
				priority,
				ref.channelId,
				async () => {
					await client.rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), restMessage(msg));
				},
				`edit:${ref.messageId}`,
			);
		},
		startThread(from, o) {
			return write("high", from.channelId, async () => {
				const thread = (await client.rest.post(Routes.threads(from.channelId, from.messageId), {
					body: { name: o.name, auto_archive_duration: o.autoArchiveMinutes },
				})) as APIChannel;
				return thread.id;
			});
		},
		archiveThread(threadId) {
			return write("state", threadId, async () => {
				await client.rest.patch(Routes.channel(threadId), { body: { archived: true } });
			});
		},
		react(ref, emoji) {
			return write("high", ref.channelId, async () => {
				await client.rest.put(Routes.channelMessageOwnReaction(ref.channelId, ref.messageId, encodeURIComponent(emoji)));
			});
		},
		unreact(ref, emoji) {
			return write("high", ref.channelId, async () => {
				await client.rest.delete(Routes.channelMessageOwnReaction(ref.channelId, ref.messageId, encodeURIComponent(emoji)));
			});
		},
		async fetchMessage(ref) {
			const message = await getMessage(ref);
			return message ? { content: message.content } : null;
		},
		async starterMessage(threadId) {
			const thread = await getChannel(threadId);
			if (!thread || channelKind(thread.type) !== "thread" || !("parent_id" in thread) || !thread.parent_id) return null;
			// A thread started from a message has that message's id.
			const ref = { channelId: thread.parent_id, messageId: threadId };
			const message = await getMessage(ref);
			return message ? { ...ref, content: message.content } : null;
		},
		async channel(id) {
			const channel = await getChannel(id);
			if (!channel) return null;
			const info: ChannelInfo = {
				id: channel.id,
				name: "name" in channel && channel.name ? channel.name : "",
				kind: channelKind(channel.type),
				parentId: "parent_id" in channel ? (channel.parent_id ?? null) : null,
			};
			if ("topic" in channel && channel.topic) info.topic = channel.topic;
			if ("thread_metadata" in channel && channel.thread_metadata) info.archived = channel.thread_metadata.archived;
			return info;
		},
		createTextChannel(guildId, o) {
			return write("high", `guild:${guildId}`, async () => {
				try {
					const created = (await client.rest.post(Routes.guildChannels(guildId), {
						body: { name: o.name, type: ChannelType.GuildText, topic: o.topic, ...(o.parentId ? { parent_id: o.parentId } : {}) },
					})) as APIChannel;
					return created.id;
				} catch (err) {
					if (apiCode(err) === MISSING_PERMISSIONS) throw new MissingPermission("ManageChannels");
					throw err;
				}
			});
		},
		setChannel(id, patch) {
			return write("state", id, async () => {
				await client.rest.patch(Routes.channel(id), { body: patch });
			});
		},
		setNickname(guildId, nickname) {
			return write("state", `guild:${guildId}`, async () => {
				try {
					await client.rest.patch(Routes.guildMember(guildId, "@me"), { body: { nick: nickname } });
				} catch (err) {
					if (apiCode(err) === MISSING_PERMISSIONS) throw new MissingPermission("ChangeNickname");
					throw err;
				}
			});
		},
		queueStats: () => queue.stats(),

		onEvent(handler) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		onReady(handler) {
			readyHandlers.add(handler);
			return () => readyHandlers.delete(handler);
		},
		async registerCommands(guildId, commands) {
			const guild = await client.guilds.fetch(guildId);
			await guild.commands.set(commands);
		},
		status() {
			if (!client.isReady()) return { ready: false };
			const ping = client.ws.ping;
			return { ready: true, user: client.user.tag, userId: client.user.id, ...(ping >= 0 ? { pingMs: ping } : {}) };
		},
		async login(token) {
			await client.login(token);
		},
		async destroy() {
			queue.close(new Error("Discord connection closed"));
			await client.destroy();
		},
	};
}
