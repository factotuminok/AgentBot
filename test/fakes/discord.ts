import type { APIApplicationCommandOptionChoice, APIModalInteractionResponseCallbackData, RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { errorMessage, log } from "../../src/shared/log";
import { createOutboundQueue, type OutboundQueue, type QueueClock } from "../../src/orchestrator/discord/queue";
import {
	type Actor,
	type AutocompleteEvent,
	type ChannelInfo,
	type ChannelKind,
	type CommandEvent,
	type ComponentEvent,
	type DiscordConnection,
	type InAttachment,
	type InboundEvent,
	type InteractionResponder,
	type MessageEvent,
	type MessageRow,
	MissingPermission,
	type ModalEvent,
	type MsgRef,
	type OutFile,
	type OutMessage,
	type Priority,
	type ReplyOptions,
	type Where,
} from "../../src/orchestrator/discord/surface";

/**
 * An in-memory Discord for tests: implements `DiscordConnection` over a store of channels, messages and reactions, and
 * builds inbound events whose interaction responses are captured. Writes run through the same outbound queue as the
 * discord.js adapter (executing immediately), so priorities and coalescing behave the same.
 */

/** A Discord API error as the fake raises it (codes: 10003 Unknown Channel, 10008 Unknown Message, 50005 not the author). */
export class FakeDiscordError extends Error {
	override name = "FakeDiscordError";
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** A simulated rate-limit response (`FakeDiscordOptions.simulate`): the queue blocks the bucket for `retryAfterMs` and retries. */
export class FakeRateLimitError extends Error {
	override name = "FakeRateLimitError";
	constructor(readonly retryAfterMs: number) {
		super(`rate limited for ${retryAfterMs} ms`);
	}
}

/**
 * Discord's REST behaviour for load tests: every write takes `latencyMs`, and each bucket (channel) allows `perWindow`
 * writes per `windowMs`; a write over that fails with `FakeRateLimitError` (retry-after = the rest of the window), which
 * the outbound queue honours like discord.js's rate-limit errors. Off by default: writes run at once.
 */
export interface SimulatedRest {
	latencyMs?: number;
	perWindow: number;
	windowMs: number;
}

export interface FakeChannel extends ChannelInfo {
	guildId: string;
	/** Created through `createTextChannel`. */
	created: boolean;
}

export interface FakeMessage {
	id: string;
	channelId: string;
	content: string;
	components: MessageRow[];
	files: OutFile[];
	mentions?: OutMessage["mentions"];
	/** The bot's own reactions. */
	reactions: string[];
	authorId: string;
	/** The message this one replies to. */
	replyTo?: string;
	attachments: InAttachment[];
	/** Number of applied edits. */
	edits: number;
}

export type FakeResponseType = "reply" | "defer" | "editReply" | "followUp" | "update" | "deferUpdate" | "showModal" | "respond";

export interface FakeResponse {
	type: FakeResponseType;
	/** reply, editReply, followUp, update. */
	msg?: ReplyOptions;
	ephemeral?: boolean;
	modal?: APIModalInteractionResponseCallbackData;
	choices?: APIApplicationCommandOptionChoice<string>[];
}

export interface Emitted {
	/** Every response to the interaction, in order; keeps growing when handlers respond later. */
	responses: FakeResponse[];
	/** The message a `emitMessage` created. */
	ref?: MsgRef;
}

export interface FakeDiscordOptions {
	/** Default guild of channels and events. Default `guild-1`. */
	guildId?: string;
	/** `login` rejects with this message. */
	loginError?: string;
	botUserId?: string;
	channels?: { id?: string; name: string; kind?: ChannelKind; parentId?: string | null; topic?: string }[];
	/** Clock of the outbound queue (rate-limit waits). */
	clock?: QueueClock;
	simulate?: SimulatedRest;
	/**
	 * Keeps channels, messages and nicknames in this JSON file: loaded at creation, rewritten (atomically, synchronously)
	 * after every write, interaction update and user message, so a process killed and started again sees the same
	 * Discord (test/e2e/chaos). Attached files keep their names only.
	 */
	persistFile?: string;
}

export interface FakeDiscord extends DiscordConnection {
	readonly guildId: string;
	readonly botUserId: string;
	readonly loggedIn: boolean;
	readonly destroyed: boolean;
	readonly loginCount: number;
	/** The last token passed to `login`. */
	readonly token: string | undefined;
	readonly queue: OutboundQueue;
	failLogin(message: string | null): void;
	/** Fires the ready handlers again, as on a reconnect. */
	triggerReady(): Promise<void>;
	addChannel(c: { id?: string; name: string; kind?: ChannelKind; parentId?: string | null; topic?: string; guildId?: string }): FakeChannel;
	channels(): FakeChannel[];
	messages(channelId: string): FakeMessage[];
	message(messageId: string): FakeMessage | undefined;
	lastMessage(channelId: string): FakeMessage | undefined;
	deleteMessage(ref: MsgRef): void;
	deleteChannel(id: string): void;
	/** Makes `createTextChannel` / `setNickname` throw `MissingPermission`. */
	deny(permission: "ManageChannels" | "ChangeNickname", denied?: boolean): void;
	nickname(guildId?: string): string | undefined;
	commands(guildId?: string): RESTPostAPIApplicationCommandsJSONBody[] | undefined;
	actor(userId: string, opts?: { username?: string; roleIds?: string[]; isBot?: boolean }): Actor;
	emitCommand(e: {
		command: "work" | "ask";
		subcommand?: string | null;
		options?: Record<string, string | number | boolean>;
		attachments?: InAttachment[];
		actor: Actor;
		channelId: string;
	}): Promise<Emitted>;
	emitAutocomplete(e: { command: "work" | "ask"; subcommand?: string | null; focused: { name: string; value: string }; actor: Actor; channelId: string }): Promise<Emitted>;
	emitComponent(e: { message: MsgRef; customId: string; values?: string[]; actor: Actor }): Promise<Emitted>;
	emitModal(e: { customId: string; fields: Record<string, string>; message?: MsgRef | null; actor: Actor; channelId?: string }): Promise<Emitted>;
	/**
	 * Posts a user message (stored) and delivers it, unless the author is a bot or the channel is outside a guild (DSC-08).
	 * `unfiltered` delivers it anyway, as if the adapter's filter were missing, with `guildId` overriding the channel's
	 * (null = a direct message): it shows that the bot applies DSC-08 itself.
	 */
	emitMessage(e: { channelId: string; content: string; attachments?: InAttachment[]; actor: Actor; unfiltered?: boolean; guildId?: string | null }): Promise<Emitted>;
	/** Pauses / resumes the outbound queue, so writes pile up and priorities and coalescing show. */
	pause(): void;
	resume(): void;
	/** Reports a rate limit on `channelId` (null = global) for `ms`. */
	rateLimit(channelId: string | null, ms: number): void;
	/** Resolves once the outbound queue is empty and pending callbacks ran. */
	settled(): Promise<void>;
	/** Writes performed and simulated rate-limit responses (`simulate`) so far. */
	restStats(): { writes: number; rateLimited: number };
	/** Turns the REST simulation on (or off with `undefined`) from now on; see `FakeDiscordOptions.simulate`. */
	simulateRest(simulate: SimulatedRest | undefined): void;
}

export function createFakeDiscord(opts: FakeDiscordOptions = {}): FakeDiscord {
	const guildId = opts.guildId ?? "guild-1";
	const botUserId = opts.botUserId ?? "bot-user";
	let nextId = 100_000_000;
	const newId = () => String(nextId++);
	const channelStore = new Map<string, FakeChannel>();
	const messageStore = new Map<string, FakeMessage>();
	const nicknames = new Map<string, string>();
	const commandStore = new Map<string, RESTPostAPIApplicationCommandsJSONBody[]>();
	const denied = new Set<string>();
	const eventHandlers = new Set<(event: InboundEvent) => void | Promise<void>>();
	const readyHandlers = new Set<() => void | Promise<void>>();
	let simulate = opts.simulate;
	const queue = createOutboundQueue({
		clock: opts.clock,
		rateLimitOf: err => (err instanceof FakeRateLimitError ? { retryAfterMs: err.retryAfterMs, global: false } : undefined),
	});
	const windows = new Map<string, { start: number; count: number }>();
	const rest = { writes: 0, rateLimited: 0 };
	let loginError = opts.loginError;
	let loggedIn = false;
	let destroyed = false;
	let loginCount = 0;
	let token: string | undefined;

	function addChannel(c: { id?: string; name: string; kind?: ChannelKind; parentId?: string | null; topic?: string; guildId?: string }, created = false): FakeChannel {
		const channel: FakeChannel = {
			id: c.id ?? newId(),
			name: c.name,
			kind: c.kind ?? "text",
			parentId: c.parentId ?? null,
			guildId: c.guildId ?? guildId,
			created,
			...(c.topic !== undefined ? { topic: c.topic } : {}),
		};
		channelStore.set(channel.id, channel);
		return channel;
	}
	for (const c of opts.channels ?? []) addChannel(c);

	interface Snapshot {
		nextId: number;
		channels: FakeChannel[];
		messages: FakeMessage[];
		nicknames: [string, string][];
	}
	function persist(): void {
		if (!opts.persistFile) return;
		const snapshot: Snapshot = {
			nextId,
			channels: [...channelStore.values()],
			messages: [...messageStore.values()].map(m => ({ ...m, files: m.files.map(f => ({ name: f.name, data: "" })) })),
			nicknames: [...nicknames],
		};
		writeFileSync(`${opts.persistFile}.tmp`, JSON.stringify(snapshot));
		renameSync(`${opts.persistFile}.tmp`, opts.persistFile);
	}
	if (opts.persistFile && existsSync(opts.persistFile)) {
		const snapshot = JSON.parse(readFileSync(opts.persistFile, "utf8")) as Snapshot;
		nextId = snapshot.nextId;
		for (const c of snapshot.channels) channelStore.set(c.id, c);
		for (const m of snapshot.messages) messageStore.set(m.id, m);
		for (const [guild, nickname] of snapshot.nicknames) nicknames.set(guild, nickname);
	}

	function channelOf(id: string): FakeChannel {
		const channel = channelStore.get(id);
		if (!channel) throw new FakeDiscordError(10003, `Unknown Channel ${id}`);
		return channel;
	}

	function messageOf(ref: MsgRef): FakeMessage {
		const message = messageStore.get(ref.messageId);
		if (!message || message.channelId !== ref.channelId) throw new FakeDiscordError(10008, `Unknown Message ${ref.messageId}`);
		return message;
	}

	function store(channelId: string, msg: OutMessage, authorId: string, replyTo?: string): FakeMessage {
		channelOf(channelId);
		const message: FakeMessage = {
			id: newId(),
			channelId,
			content: msg.content,
			components: msg.components ?? [],
			files: msg.files ?? [],
			mentions: msg.mentions,
			reactions: [],
			authorId,
			attachments: [],
			edits: 0,
			...(replyTo ? { replyTo } : {}),
		};
		messageStore.set(message.id, message);
		return message;
	}

	function applyEdit(message: FakeMessage, msg: OutMessage): void {
		message.content = msg.content;
		if (msg.components) message.components = msg.components;
		if (msg.files) message.files = msg.files;
		message.mentions = msg.mentions;
		message.edits++;
	}

	/** One simulated REST call on `bucket` (`simulate`): its latency, then the bucket's window. */
	async function simulated(bucket: string, simulate: SimulatedRest): Promise<void> {
		if (simulate.latencyMs) await Bun.sleep(simulate.latencyMs);
		const now = Date.now();
		let window = windows.get(bucket);
		if (!window || now - window.start >= simulate.windowMs) {
			window = { start: now, count: 0 };
			windows.set(bucket, window);
		}
		if (window.count >= simulate.perWindow) {
			rest.rateLimited++;
			throw new FakeRateLimitError(window.start + simulate.windowMs - now);
		}
		window.count++;
	}

	function write<T>(priority: Priority, bucket: string, run: () => T, coalesce?: string): Promise<T> {
		return queue.push({
			priority,
			bucket,
			coalesce,
			run: async () => {
				if (simulate) await simulated(bucket, simulate);
				rest.writes++;
				const result = run();
				persist();
				return result;
			},
		}) as Promise<T>;
	}

	function where(channelId: string): Where {
		const channel = channelStore.get(channelId);
		const isThread = channel?.kind === "thread";
		return { guildId: channel ? channel.guildId : guildId, channelId, parentId: isThread ? (channel?.parentId ?? null) : null, isThread };
	}

	/** Interaction responses with Discord's acknowledgement rules, recorded in `responses`. */
	function responder(responses: FakeResponse[], target: MsgRef | null) {
		let acked = false;
		const ack = (type: FakeResponseType) => {
			if (acked) throw new Error(`interaction already acknowledged (${type})`);
			acked = true;
		};
		const needAck = (type: FakeResponseType) => {
			if (!acked) throw new Error(`interaction not replied or deferred yet (${type})`);
		};
		const base: InteractionResponder = {
			async reply(msg) {
				ack("reply");
				responses.push({ type: "reply", msg, ephemeral: !!msg.ephemeral });
			},
			async defer(o) {
				ack("defer");
				responses.push({ type: "defer", ephemeral: !!o?.ephemeral });
			},
			async editReply(msg) {
				needAck("editReply");
				responses.push({ type: "editReply", msg });
			},
			async followUp(msg) {
				needAck("followUp");
				responses.push({ type: "followUp", msg, ephemeral: !!msg.ephemeral });
			},
		};
		return {
			base,
			get acked() {
				return acked;
			},
			async update(msg: OutMessage) {
				if (!target) throw new Error("update needs a message");
				ack("update");
				applyEdit(messageOf(target), msg);
				persist();
				responses.push({ type: "update", msg });
			},
			async deferUpdate() {
				if (!target) throw new Error("deferUpdate needs a message");
				ack("deferUpdate");
				responses.push({ type: "deferUpdate" });
			},
			async showModal(modal: APIModalInteractionResponseCallbackData) {
				ack("showModal");
				responses.push({ type: "showModal", modal });
			},
		};
	}

	/** Runs every handler; an unhandled error is logged and answered ephemerally like the adapter does (DSC-08). */
	async function deliver(event: InboundEvent, r?: { acked: boolean; base: InteractionResponder }): Promise<void> {
		for (const handler of eventHandlers) {
			try {
				await handler(event);
			} catch (err) {
				log("error", "discord event handler failed", { event: event.type, error: errorMessage(err) });
				if (!r) continue;
				const answer = { content: `Error: ${errorMessage(err)}`, ephemeral: true };
				await (r.acked ? r.base.followUp(answer) : r.base.reply(answer)).catch(() => {});
			}
		}
	}

	const fake: FakeDiscord = {
		guildId,
		botUserId,
		queue,
		get loggedIn() {
			return loggedIn;
		},
		get destroyed() {
			return destroyed;
		},
		get loginCount() {
			return loginCount;
		},
		get token() {
			return token;
		},

		// Outbound ---------------------------------------------------------------
		send(channelId, msg, priority = "high") {
			return write(priority, channelId, () => {
				const m = store(channelId, msg, botUserId);
				return { channelId, messageId: m.id };
			});
		},
		reply(to, msg, priority = "high") {
			return write(priority, to.channelId, () => {
				messageOf(to);
				const m = store(to.channelId, msg, botUserId, to.messageId);
				return { channelId: to.channelId, messageId: m.id };
			});
		},
		async edit(ref, msg, priority) {
			await write(
				priority,
				ref.channelId,
				() => {
					const message = messageOf(ref);
					if (message.authorId !== botUserId) throw new FakeDiscordError(50005, "Cannot edit a message authored by another user");
					applyEdit(message, msg);
				},
				`edit:${ref.messageId}`,
			);
		},
		startThread(from, o) {
			return write("high", from.channelId, () => {
				messageOf(from);
				const parent = channelOf(from.channelId);
				// A thread started from a message has the message's id (Discord's rule).
				addChannel({ id: from.messageId, name: o.name, kind: "thread", parentId: from.channelId, guildId: parent.guildId });
				return from.messageId;
			});
		},
		archiveThread(threadId) {
			return write("state", threadId, () => {
				channelOf(threadId).archived = true;
			});
		},
		react(ref, emoji) {
			return write("high", ref.channelId, () => {
				const message = messageOf(ref);
				if (!message.reactions.includes(emoji)) message.reactions.push(emoji);
			});
		},
		unreact(ref, emoji) {
			return write("high", ref.channelId, () => {
				const message = messageOf(ref);
				message.reactions = message.reactions.filter(r => r !== emoji);
			});
		},
		async fetchMessage(ref) {
			const message = messageStore.get(ref.messageId);
			return message && message.channelId === ref.channelId ? { content: message.content } : null;
		},
		async starterMessage(threadId) {
			const thread = channelStore.get(threadId);
			if (thread?.kind !== "thread" || !thread.parentId) return null;
			const message = messageStore.get(threadId);
			return message && message.channelId === thread.parentId ? { channelId: thread.parentId, messageId: threadId, content: message.content } : null;
		},
		async channel(id) {
			const channel = channelStore.get(id);
			if (!channel) return null;
			const { guildId: _g, created: _c, ...info } = channel;
			return { ...info };
		},
		createTextChannel(guild, o) {
			return write("high", `guild:${guild}`, () => {
				if (denied.has("ManageChannels")) throw new MissingPermission("ManageChannels");
				return addChannel({ name: o.name, topic: o.topic, parentId: o.parentId ?? null, guildId: guild }, true).id;
			});
		},
		setChannel(id, patch) {
			return write("state", id, () => {
				const channel = channelOf(id);
				if (patch.name !== undefined) channel.name = patch.name;
				if (patch.topic !== undefined) channel.topic = patch.topic;
			});
		},
		setNickname(guild, nickname) {
			return write("state", `guild:${guild}`, () => {
				if (denied.has("ChangeNickname")) throw new MissingPermission("ChangeNickname");
				nicknames.set(guild, nickname);
			});
		},
		queueStats: () => queue.stats(),

		// Connection ---------------------------------------------------------------
		onEvent(handler) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		onReady(handler) {
			readyHandlers.add(handler);
			return () => readyHandlers.delete(handler);
		},
		async registerCommands(guild, commands) {
			commandStore.set(guild, structuredClone(commands));
		},
		status: () => (loggedIn ? { ready: true, user: "AgentBot#0001", userId: botUserId, pingMs: 1 } : { ready: false }),
		async login(t) {
			token = t;
			if (loginError) throw new Error(loginError);
			loggedIn = true;
			destroyed = false;
			loginCount++;
			await fake.triggerReady();
		},
		async destroy() {
			loggedIn = false;
			destroyed = true;
		},

		// Test helpers ---------------------------------------------------------------
		failLogin(message) {
			loginError = message ?? undefined;
		},
		async triggerReady() {
			for (const handler of readyHandlers) await handler();
		},
		addChannel: c => addChannel(c),
		channels: () => [...channelStore.values()],
		messages: channelId => [...messageStore.values()].filter(m => m.channelId === channelId),
		message: id => messageStore.get(id),
		lastMessage: channelId => fake.messages(channelId).at(-1),
		deleteMessage(ref) {
			messageStore.delete(ref.messageId);
		},
		deleteChannel(id) {
			channelStore.delete(id);
		},
		deny(permission, on = true) {
			if (on) denied.add(permission);
			else denied.delete(permission);
		},
		nickname: guild => nicknames.get(guild ?? guildId),
		commands: guild => commandStore.get(guild ?? guildId),
		actor: (userId, o = {}) => ({ userId, username: o.username ?? userId, roleIds: o.roleIds ?? [], isBot: o.isBot ?? false }),

		async emitCommand(e) {
			const responses: FakeResponse[] = [];
			const r = responder(responses, null);
			const event: CommandEvent = {
				type: "command",
				command: e.command,
				subcommand: e.subcommand ?? null,
				options: e.options ?? {},
				attachments: e.attachments ?? [],
				actor: e.actor,
				where: where(e.channelId),
				...r.base,
			};
			await deliver(event, r);
			return { responses };
		},
		async emitAutocomplete(e) {
			const responses: FakeResponse[] = [];
			const event: AutocompleteEvent = {
				type: "autocomplete",
				command: e.command,
				subcommand: e.subcommand ?? null,
				focused: e.focused,
				actor: e.actor,
				where: where(e.channelId),
				async respond(choices) {
					responses.push({ type: "respond", choices });
				},
			};
			await deliver(event);
			return { responses };
		},
		async emitComponent(e) {
			const responses: FakeResponse[] = [];
			const r = responder(responses, e.message);
			const event: ComponentEvent = {
				type: "component",
				customId: e.customId,
				values: e.values ?? [],
				message: e.message,
				actor: e.actor,
				where: where(e.message.channelId),
				...r.base,
				update: r.update,
				deferUpdate: r.deferUpdate,
				showModal: r.showModal,
			};
			await deliver(event, r);
			return { responses };
		},
		async emitModal(e) {
			const responses: FakeResponse[] = [];
			const message = e.message ?? null;
			const r = responder(responses, message);
			const channelId = e.channelId ?? message?.channelId;
			if (!channelId) throw new Error("emitModal needs a message or a channelId");
			const event: ModalEvent = {
				type: "modal",
				customId: e.customId,
				fields: e.fields,
				message,
				actor: e.actor,
				where: where(channelId),
				...r.base,
				update: r.update,
				deferUpdate: r.deferUpdate,
			};
			await deliver(event, r);
			return { responses };
		},
		async emitMessage(e) {
			const m = store(e.channelId, { content: e.content }, e.actor.userId);
			m.attachments = e.attachments ?? [];
			persist();
			const ref = { channelId: e.channelId, messageId: m.id };
			const w = where(e.channelId);
			if (e.guildId !== undefined) w.guildId = e.guildId;
			if (!e.unfiltered && (e.actor.isBot || w.guildId === null)) return { responses: [], ref };
			const event: MessageEvent = { type: "message", ref, content: e.content, attachments: m.attachments, actor: e.actor, where: w };
			await deliver(event);
			return { responses: [], ref };
		},
		pause: () => queue.pause(),
		resume: () => queue.resume(),
		rateLimit: (channelId, ms) => queue.limited(channelId, ms),
		async settled() {
			for (let round = 0; round < 10; round++) {
				await queue.idle();
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				if (queue.stats().length === 0) return;
			}
		},
		restStats: () => ({ ...rest }),
		simulateRest(next) {
			simulate = next;
			windows.clear();
		},
	};
	return fake;
}
