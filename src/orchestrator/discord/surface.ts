import type {
	APIActionRowComponent,
	APIApplicationCommandOptionChoice,
	APIComponentInMessageActionRow,
	APIModalInteractionResponseCallbackData,
	RESTPostAPIApplicationCommandsJSONBody,
} from "discord-api-types/v10";

/**
 * The boundary between the engine and discord.js (implementation.md phase 2). The engine, poller, scheduler and bot logic
 * use only these types; `createDiscordJsConnection` implements them over discord.js, and `createFakeDiscord` (test/fakes)
 * records and drives them in tests. Components and modals use Discord's API JSON, so builders' `.toJSON()` output fits.
 */

/** DSC-32 priorities, highest first. */
export type Priority =
	/** New messages, questions, delivery reactions, results and failures. */
	| "high"
	/** State-change edits. */
	| "state"
	/** Activity and heartbeat edits; skipped (not queued) while their channel is rate-limited. */
	| "activity";

export interface MsgRef {
	channelId: string;
	messageId: string;
}

export interface OutFile {
	name: string;
	data: Uint8Array | string;
}

export type MessageRow = APIActionRowComponent<APIComponentInMessageActionRow>;

export interface OutMessage {
	/** At most 2000 characters (DSC-14); callers split longer text. */
	content: string;
	/** Replaces all components on edit; `[]` removes them. */
	components?: MessageRow[];
	files?: OutFile[];
	/** Mentions are disabled unless listed here (DSC-07). */
	mentions?: { users?: string[]; roles?: string[] };
}

export type ChannelKind = "text" | "category" | "thread" | "other";

export interface ChannelInfo {
	id: string;
	name: string;
	kind: ChannelKind;
	/** Category of a channel, or the parent channel of a thread. */
	parentId: string | null;
	topic?: string;
	archived?: boolean;
}

/** Outbound operations. Every write goes through the one outbound queue (DSC-32): coalescing, priorities, rate limits. */
export interface DiscordSurface {
	send(channelId: string, msg: OutMessage, priority?: Priority): Promise<MsgRef>;
	/** Reply to a message (e.g. an idle-thread reply, DSC-23). */
	reply(to: MsgRef, msg: OutMessage, priority?: Priority): Promise<MsgRef>;
	/**
	 * At most one pending edit per message; a newer edit replaces an unsent one (latest state wins). Resolves when the edit
	 * was applied, superseded or skipped; rejects only when Discord refuses it (e.g. the message was deleted: code 10008).
	 */
	edit(ref: MsgRef, msg: OutMessage, priority: Priority): Promise<void>;
	startThread(from: MsgRef, opts: { name: string; autoArchiveMinutes: 60 | 1440 | 4320 | 10080 }): Promise<string>;
	archiveThread(threadId: string): Promise<void>;
	react(ref: MsgRef, emoji: string): Promise<void>;
	/** Removes the bot's own reaction. */
	unreact(ref: MsgRef, emoji: string): Promise<void>;
	/** null when the message no longer exists. */
	fetchMessage(ref: MsgRef): Promise<{ content: string } | null>;
	/** The channel message a thread was started from (its "top message"), or null. */
	starterMessage(threadId: string): Promise<(MsgRef & { content: string }) | null>;
	/** null when the channel does not exist or the bot cannot see it. */
	channel(id: string): Promise<ChannelInfo | null>;
	/** DSC-35. Throws `MissingPermission` without Manage Channels (DSC-38). */
	createTextChannel(guildId: string, opts: { name: string; topic: string; parentId?: string }): Promise<string>;
	setChannel(id: string, patch: { name?: string; topic?: string }): Promise<void>;
	/** DSC-29. Throws `MissingPermission` without Change Nickname. */
	setNickname(guildId: string, nickname: string): Promise<void>;
	/** DSC-32 visibility on the status page. */
	queueStats(): { length: number; oldestAgeMs: number | null };
}

export class MissingPermission extends Error {
	override name = "MissingPermission";
	constructor(readonly permission: "ManageChannels" | "ChangeNickname" | "ViewChannel" | "SendMessages", message?: string) {
		super(message ?? `missing Discord permission ${permission}`);
	}
}

// ---------------------------------------------------------------------------
// Inbound events

export interface Actor {
	userId: string;
	username: string;
	/** Guild role ids (empty outside a guild). */
	roleIds: string[];
	isBot: boolean;
}

export interface InAttachment {
	name: string;
	url: string;
	size: number;
	contentType?: string;
}

export interface Where {
	guildId: string | null;
	channelId: string;
	/** For a thread: its parent channel. */
	parentId: string | null;
	isThread: boolean;
}

export interface ReplyOptions extends OutMessage {
	ephemeral?: boolean;
}

/** Interaction responses (Discord's 3 s rule is the adapter's concern: it defers when a handler is slow). */
export interface InteractionResponder {
	reply(msg: ReplyOptions): Promise<void>;
	defer(opts?: { ephemeral?: boolean }): Promise<void>;
	editReply(msg: OutMessage): Promise<void>;
	followUp(msg: ReplyOptions): Promise<void>;
}

export interface CommandEvent extends InteractionResponder {
	type: "command";
	command: "work" | "ask";
	subcommand: string | null;
	options: Record<string, string | number | boolean>;
	attachments: InAttachment[];
	actor: Actor;
	where: Where;
}

export interface AutocompleteEvent {
	type: "autocomplete";
	command: "work" | "ask";
	subcommand: string | null;
	focused: { name: string; value: string };
	actor: Actor;
	where: Where;
	respond(choices: APIApplicationCommandOptionChoice<string>[]): Promise<void>;
}

export interface ComponentEvent extends InteractionResponder {
	type: "component";
	customId: string;
	/** Selected values of a select menu; empty for buttons. */
	values: string[];
	message: MsgRef;
	actor: Actor;
	where: Where;
	/** Edits the message the component is on, as the interaction response. */
	update(msg: OutMessage): Promise<void>;
	deferUpdate(): Promise<void>;
	showModal(modal: APIModalInteractionResponseCallbackData): Promise<void>;
}

export interface ModalEvent extends InteractionResponder {
	type: "modal";
	customId: string;
	fields: Record<string, string>;
	/** The message whose component opened the modal, when there is one. */
	message: MsgRef | null;
	actor: Actor;
	/** Only when `message` is set: edits that message as the interaction response (a question answered through "Other…"). */
	update(msg: OutMessage): Promise<void>;
	/** Only when `message` is set: acknowledges without a visible reply. */
	deferUpdate(): Promise<void>;
	where: Where;
}

export interface MessageEvent {
	type: "message";
	ref: MsgRef;
	content: string;
	attachments: InAttachment[];
	actor: Actor;
	where: Where;
}

export type InboundEvent = CommandEvent | AutocompleteEvent | ComponentEvent | ModalEvent | MessageEvent;

/** A logged-in Discord session: the surface plus inbound events and lifecycle (one per engine instance). */
export interface DiscordConnection extends DiscordSurface {
	/** Every inbound event; the handler's errors are logged and answered per DSC-08 by the adapter. */
	onEvent(handler: (event: InboundEvent) => void | Promise<void>): () => void;
	/** Called on every ready event (DSC-01, DSC-29), including reconnects. */
	onReady(handler: () => void | Promise<void>): () => void;
	/** Replaces the guild's commands with exactly `commands` (DSC-01). */
	registerCommands(guildId: string, commands: RESTPostAPIApplicationCommandsJSONBody[]): Promise<void>;
	status(): { ready: boolean; user?: string; userId?: string; pingMs?: number };
	/** Throws on a bad token (ENG-03: a login failure ends the engine start in `error`). */
	login(token: string): Promise<void>;
	destroy(): Promise<void>;
}
