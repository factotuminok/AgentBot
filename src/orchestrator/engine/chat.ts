import { readFile } from "node:fs/promises";
import { errorMessage, log } from "../../shared/log";
import { askThreadAllowed, memberAllowed } from "../discord/access";
import { type Progress, startProgress } from "../discord/progress";
import { acknowledgeSteer, createDiscordUI } from "../discord/questions";
import { activityText } from "../discord/render";
import type { CommandEvent, InAttachment, MessageEvent, OutMessage } from "../discord/surface";
import { CHAT_ICONS, setTopIcon } from "../discord/topMessage";
import { RunDetached, type RunHandle, type RunOwner, RunLost, type RunResult } from "../dispatch/dispatcher";
import type { AskChatRow } from "../store/db";
import { createRunUiStore } from "../store/runUi";
import {
	changedFiles,
	ensureScratchDirs,
	type FileSnapshot,
	listedFiles,
	MAX_COMMAND_FILES,
	MAX_INPUT_BYTES,
	MAX_INPUT_FILES,
	type ProducedFile,
	removeScratch,
	type SaveOptions,
	type ScratchPaths,
	saveAttachments,
	scratchPaths,
	snapshotFiles,
	UPLOAD_LIMIT_BYTES,
} from "../store/scratch";
import { chatSessionKey } from "../store/sessions";
import { loadoutKey } from "../store/stats";
import type { EngineDeps } from "./deps";
import { askFollowUp, askPrompt, CHAT_SCHEMA, type ChatOutput, runPrompt } from "./prompts";

/**
 * `/ask` chats (CHAT-03 to CHAT-11, DSC-06), ported from the ask-only parts of DevForge `src/engine/chat.ts` onto the
 * surface and the dispatcher: each turn is an `ask` run on a worker; the thread's scratch directory lives in the
 * orchestrator and the dispatcher copies inputs to the worker and outputs back. Runs outlive the engine: stopping it
 * detaches (RUN-09), and starting it re-attaches to unfinished runs, editing the same messages (RUN-14).
 */

/** AGT-14: the chat time limit. */
export const CHAT_MINUTES = 20;
const SWEEP_INTERVAL_MS = 60_000;
/** The `repo` of ask chats in `chats`, usage and logs; no `/`, so it never collides with `owner/repo`. */
export const ASK_LABEL = "ask-only";
export const SWEPT_NOTE = "files from earlier in this conversation were deleted after inactivity; ask the user to attach them again if you need them.";
export const ANSWER_TRUNCATED = "\n\n_[Answer truncated: it exceeded the upload limit.]_";
/** Most files Discord accepts in one message. */
const MAX_FILES_PER_MESSAGE = 10;
const MAX_MESSAGE = 2000;

export interface AskChatOptions {
	/** `<state>/scratch`. */
	scratchRoot: string;
	/** Downloads attachments; defaults to global `fetch`. */
	fetch?: SaveOptions["fetch"];
}

export interface AskChat {
	/** `/ask`, access already checked (DSC-03 to DSC-05): admits, starts a one-day thread and runs the `ask` profile (CHAT-07). */
	command(e: CommandEvent): Promise<void>;
	/**
	 * A human message in a thread. False when the thread is not an ask thread; otherwise it was handled: ignored (DSC-06),
	 * an answer to a waiting question (DSC-18), steering for the live run, or a new run resuming the session (CHAT-03).
	 */
	message(e: MessageEvent): Promise<boolean>;
	/** Engine start: re-attaches to the ask chats' unfinished runs (RUN-14) and starts the idle sweep (CHAT-06). */
	start(): void;
	/** Engine stop: stops the sweep and detaches from live runs, which keep going (RUN-09). */
	stop(): Promise<void>;
	/** CHAT-06, CHAT-11: removes the scratch directories of ask chats idle longer than `chatIdleMinutes`. */
	sweepIdle(): Promise<void>;
	/** threadId → settle promise of a run this engine is attached to. */
	readonly active: ReadonlyMap<string, Promise<void>>;
}

/** CHAT-10: `text` as UTF-8, cut to at most `limit` bytes with `note` appended; the cut never splits a character. */
export function truncateUtf8(text: string, limit: number, note: string): Uint8Array {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return bytes;
	const tail = Buffer.from(note, "utf8");
	let cut = Math.max(0, limit - tail.length);
	// A continuation byte (10xxxxxx) at the cut means the cut is inside a multi-byte sequence: move back to its start.
	while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
	return Buffer.concat([bytes.subarray(0, cut), tail]);
}

function mibText(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

/** `name` made unique among `taken` (`a.csv`, `a-1.csv`, …) and recorded there. */
function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let candidate = name;
	for (let n = 1; taken.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
	taken.add(candidate);
	return candidate;
}

/**
 * CHAT-10: the messages that deliver an ask run's result: the answer (if any) as an attached `answer.md` with a short
 * pointer, then the produced files in messages of at most 10 files and `limit` bytes, then a line naming the files over
 * `limit` (not attached). Files are read when the messages are built.
 */
export async function deliveryMessages(answer: string | undefined, files: ProducedFile[], limit: number): Promise<OutMessage[]> {
	const taken = new Set(answer === undefined ? [] : ["answer.md"]);
	const tooLarge: string[] = [];
	const batches: ProducedFile[][] = [];
	let batch: ProducedFile[] = [];
	let batchBytes = 0;
	for (const file of files) {
		if (file.size > limit) {
			tooLarge.push(file.name);
			continue;
		}
		if (batch.length === MAX_FILES_PER_MESSAGE || batchBytes + file.size > limit) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(file);
		batchBytes += file.size;
	}
	if (batch.length > 0) batches.push(batch);
	const messages: OutMessage[] = [];
	if (answer !== undefined) {
		const attached = batches.reduce((n, b) => n + b.length, 0);
		const extra = attached > 0 ? ` and ${attached} generated file${attached === 1 ? "" : "s"} below` : "";
		messages.push({
			content: `📄 **Answer attached:** \`answer.md\`${extra}`,
			files: [{ name: "answer.md", data: truncateUtf8(answer, limit, ANSWER_TRUNCATED) }],
		});
	}
	for (const b of batches) {
		messages.push({
			content: `📎 ${b.map(f => `\`${f.name}\``).join(", ")}`.slice(0, MAX_MESSAGE),
			files: await Promise.all(b.map(async f => ({ name: uniqueName(f.name, taken), data: new Uint8Array(await readFile(f.path)) }))),
		});
	}
	if (tooLarge.length > 0) messages.push({ content: `⚠️ Too large to attach (over ${mibText(limit)}): ${tooLarge.join(", ")}`.slice(0, MAX_MESSAGE) });
	return messages;
}

/** A new question or a follow-up; absent when re-attaching to a run after a restart (the prompt is not resent). */
interface Turn {
	prompt: string;
	resume: boolean;
}

export function createAskChat(deps: EngineDeps, opts: AskChatOptions): AskChat {
	const { config, db, discord, dispatcher } = deps;
	const agentName = config.agent.name;
	const runUi = createRunUiStore(db);
	const fetchFn = opts.fetch ?? ((url: string) => fetch(url));
	const askChatsOf = db.raw.query<AskChatRow, [string]>("SELECT * FROM ask_chats WHERE owner_id = ?");
	const allAskChats = db.raw.query<AskChatRow, []>("SELECT * FROM ask_chats");
	const active = new Map<string, Promise<void>>();
	/** threadId → handle of the live run (from `register`). */
	const handles = new Map<string, RunHandle>();
	/** Aborted by `stop()`; every run's signal also follows the engine's. */
	const detaching = new AbortController();
	const signal = AbortSignal.any([deps.signal, detaching.signal]);
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	const chatOwner = (threadId: string): RunOwner => ({ kind: "chat", threadId });

	/** A plain thread message (mentions are off by default, DSC-07). Never throws. */
	async function notify(threadId: string, content: string): Promise<void> {
		await discord.send(threadId, { content: content.slice(0, MAX_MESSAGE) }, "high").catch(err => {
			log("warn", "ask chat message failed", { thread: threadId, error: errorMessage(err) });
		});
	}

	/** Creates the thread's scratch directory (again after a sweep) and records it as the chat's working directory. */
	async function ensureScratch(threadId: string): Promise<ScratchPaths> {
		const paths = await ensureScratchDirs(opts.scratchRoot, threadId);
		db.updateChat(threadId, { worktree: paths.root });
		return paths;
	}

	/** CHAT-08: downloads `attachments` into the thread's scratch directory; rejected files get a ⚠️ reply. Returns the saved paths. */
	async function saveInputs(threadId: string, attachments: InAttachment[], maxFiles: number): Promise<string[]> {
		const paths = await ensureScratch(threadId);
		if (attachments.length === 0) return [];
		const items = attachments.map(a => ({ name: a.name, url: a.url, size: a.size }));
		const { saved, skipped } = await saveAttachments(paths.root, items, { fetch: fetchFn, maxBytes: MAX_INPUT_BYTES, maxFiles });
		if (skipped.length > 0) {
			const lines = skipped.map(s => `- \`${s.name.replaceAll("`", "'").slice(0, 100)}\`: ${s.reason}`);
			await notify(threadId, `⚠️ **Couldn't use ${skipped.length === 1 ? "this file" : "these files"}:**\n${lines.join("\n")}`);
		}
		return saved;
	}

	/** DSC-06: the thread where `userId` already has a live run, counted from the runs (survives restarts). */
	function liveRunOf(userId: string): string | undefined {
		return askChatsOf.all(userId).find(chat => active.has(chat.thread_id) || dispatcher.hasUnfinishedRun(chatOwner(chat.thread_id)))?.thread_id;
	}

	/** CHAT-04: why a new run may not start now, or undefined. */
	function refusal(threadId: string | undefined, userId: string | undefined, allowed: boolean): string | undefined {
		if (threadId && (active.has(threadId) || dispatcher.hasUnfinishedRun(chatOwner(threadId)))) {
			return "Still starting the previous request; send that again in a moment.";
		}
		if (active.size >= config.limits.maxChatSessions) return "Chat capacity reached; try again shortly.";
		if (userId && !allowed) {
			const other = liveRunOf(userId);
			if (other) return `You already have a request running in <#${other}>; wait for it to finish.`;
		}
		return undefined;
	}

	/** Runs one turn (or re-attaches to the live one) and tracks it in `active` until it settles. */
	function launch(threadId: string, ownerId: string, turn: Turn | undefined): Promise<void> {
		const done = run(threadId, ownerId, turn)
			.catch(err => log("error", "ask chat run failed", { thread: threadId, error: errorMessage(err) }))
			.finally(() => {
				active.delete(threadId);
				handles.delete(threadId);
			});
		active.set(threadId, done);
		return done;
	}

	async function deliver(threadId: string, answer: string | undefined, files: ProducedFile[]): Promise<void> {
		for (const message of await deliveryMessages(answer, files, UPLOAD_LIMIT_BYTES)) await discord.send(threadId, message, "high");
	}

	/** The files the run produced (CHAT-10): as the dispatcher reported them, else whatever changed in `outputs/`. */
	async function produced(outputs: string, before: FileSnapshot, result: RunResult | undefined): Promise<ProducedFile[]> {
		try {
			return result?.outputs ? await listedFiles(outputs, result.outputs) : await changedFiles(outputs, before);
		} catch (err) {
			log("warn", "listing produced files failed", { error: errorMessage(err) });
			return [];
		}
	}

	async function run(threadId: string, ownerId: string, turn: Turn | undefined): Promise<void> {
		const owner = chatOwner(threadId);
		// Only a re-attach continues the stored messages; a new turn posts its own (DSC-12) and overwrites the state.
		const restore = turn ? undefined : runUi.get(owner);
		const logRun = { run: `chat-${threadId}`, kind: "chat", repo: ASK_LABEL, thread: threadId };
		const startedAt = new Date().toISOString();
		let progress: Progress | undefined;
		let paths: ScratchPaths | undefined;
		let before: FileSnapshot = new Map();
		let result: RunResult | undefined;
		try {
			progress = await startProgress(discord, threadId, "Answering", "Preparing the workspace…", {
				restore,
				persist: state => runUi.set(owner, state),
			});
			await setTopIcon(discord, threadId, CHAT_ICONS.working);
			paths = await ensureScratch(threadId);
			before = await snapshotFiles(paths.outputs);
			if (!restore) progress.phase("Starting the agent…");
			const current = progress;
			const ui = createDiscordUI(discord, threadId, {
				jobId: `chat-${threadId}`,
				askTimeoutMs: config.limits.askTimeoutHours * 3_600_000,
				isAllowed: actor => askThreadAllowed(config, actor, ownerId),
				replies: deps.replies,
				interactions: deps.interactions,
				mention: { text: "", users: [] },
				onWaiting: on => current.waiting(on),
			});
			result = await dispatcher.runAgent(
				{
					owner,
					kind: "ask",
					profile: "ask",
					prompt: runPrompt(agentName, turn?.prompt ?? ""),
					outputSchema: CHAT_SCHEMA,
					model: config.models.chat,
					thinking: config.models.thinking,
					limits: { minutes: CHAT_MINUTES, costUsd: config.limits.maxCostUsdPerJob },
					session: chatSessionKey(threadId),
					resume: turn?.resume ?? true,
					threadId,
					scratchDir: paths.root,
				},
				{
					ui,
					register: handle => handles.set(threadId, handle),
					onWaitingForWorker: () => current.phase("Waiting for a worker…"),
					onProgress: p => current.activity(activityText(p.tool, p.intent), p.usage.costUsd),
					onTodos: todos => current.todos(todos),
					onTranscript: event => deps.agentLog.append(logRun, event),
					onLoadout: loadout => db.kvSet(loadoutKey(loadout.profile), JSON.stringify(loadout)),
					onUsage: usage => db.recordRun({ kind: "chat", repo: ASK_LABEL, threadId, startedAt, usage }),
				},
				signal,
			);
			db.updateChat(threadId, { last_active_at: new Date().toISOString(), ...(result.hasSession ? { session_file: chatSessionKey(threadId) } : {}) });
			progress.phase("Posting the answer…", result.usage.costUsd);
			const files = await produced(paths.outputs, before, result);
			if (result.aborted === "user") {
				// Files the agent already produced are delivered even when the run did not finish (CHAT-10).
				await deliver(threadId, undefined, files);
				await progress.finish("cancelled");
				await setTopIcon(discord, threadId, CHAT_ICONS.stopped);
				await notify(threadId, "⏹️ **Stopped.** Send another message to continue.");
			} else if (result.aborted) {
				await deliver(threadId, undefined, files);
				await progress.finish("failed");
				await setTopIcon(discord, threadId, CHAT_ICONS.limit);
				const limit = result.aborted === "time" ? `${CHAT_MINUTES} minute time limit` : `$${config.limits.maxCostUsdPerJob} cost limit`;
				await notify(threadId, `⚠️ **Stopped at the ${limit}** before finishing. Send another message to continue where it left off.`);
			} else {
				await deliver(threadId, (result.output as ChatOutput).answer, files);
				await progress.finish("done");
				await setTopIcon(discord, threadId, CHAT_ICONS.done);
				await notify(threadId, "✅ **Done.** Reply in this thread to follow up.");
			}
			runUi.clear(owner);
		} catch (err) {
			if (err instanceof RunDetached || signal.aborted) {
				// The run keeps going; the next engine re-attaches and keeps editing the same messages (RUN-14).
				progress?.stop();
				log("info", "ask chat detached", { thread: threadId });
				return;
			}
			log("error", "ask chat failed", { thread: threadId, error: errorMessage(err) });
			db.updateChat(threadId, { last_active_at: new Date().toISOString() });
			if (paths) await deliver(threadId, undefined, await produced(paths.outputs, before, result)).catch(() => {});
			await progress?.finish("failed");
			await setTopIcon(discord, threadId, CHAT_ICONS.failed);
			const reason = err instanceof RunLost ? err.message : errorMessage(err);
			await notify(threadId, `❌ **Failed:** ${reason.slice(0, 1500)}\nSend another message to try again.`);
			runUi.clear(owner);
		}
	}

	/** CHAT-03: steers the live run with a follow-up, or starts a new run resuming the session. */
	async function followUp(e: MessageEvent, ask: AskChatRow): Promise<void> {
		const threadId = ask.thread_id;
		// After an idle sweep the scratch directory is gone (CHAT-11); saving recreates it.
		const swept = db.getChat(threadId)?.worktree === null;
		let saved: string[];
		try {
			saved = await saveInputs(threadId, e.attachments, MAX_INPUT_FILES);
		} catch (err) {
			log("error", "saving attachments failed", { thread: threadId, error: errorMessage(err) });
			await notify(threadId, `❌ **Couldn't prepare the workspace:** ${errorMessage(err).slice(0, 1500)}`);
			return;
		}
		const text = e.content.trim() || (saved.length > 0 ? "See the attached files." : "");
		if (!text) return;
		const handle = handles.get(threadId);
		if (handle) {
			// Delivery can wait for the worker (RUN-15); the message handler does not.
			void acknowledgeSteer(discord, e.ref, onQueued => handle.steer(askFollowUp(text, saved), e.actor.username, { onQueued, scratchInputs: saved })).catch(
				err => log("warn", "ask steer failed", { thread: threadId, error: errorMessage(err) }),
			);
			return;
		}
		const allowed = memberAllowed(config, e.actor);
		const refused = refusal(threadId, e.actor.userId, allowed);
		if (refused) {
			await notify(threadId, refused);
			return;
		}
		db.updateChat(threadId, { last_active_at: new Date().toISOString() });
		const resume = db.getChat(threadId)?.session_file != null;
		void launch(threadId, ask.owner_id, { prompt: askFollowUp(text, saved, swept ? SWEPT_NOTE : undefined), resume });
	}

	async function sweepIdle(): Promise<void> {
		const cutoff = new Date(Date.now() - config.limits.chatIdleMinutes * 60_000).toISOString();
		for (const chat of db.idleChats(cutoff)) {
			if (!chat.worktree || !db.getAskChat(chat.thread_id)) continue;
			if (active.has(chat.thread_id) || dispatcher.hasUnfinishedRun(chatOwner(chat.thread_id))) continue;
			try {
				// The session is kept so the conversation can resume (CHAT-06).
				if (await removeScratch(opts.scratchRoot, chat.worktree)) {
					db.updateChat(chat.thread_id, { worktree: null });
					log("info", "ask scratch removed", { thread: chat.thread_id });
				}
			} catch (err) {
				log("warn", "ask sweep failed", { thread: chat.thread_id, error: errorMessage(err) });
			}
		}
	}

	return {
		active,
		sweepIdle,
		async command(e) {
			const prompt = String(e.options.prompt ?? "").trim();
			const allowed = memberAllowed(config, e.actor);
			const refused = refusal(undefined, e.actor.userId, allowed);
			if (refused) {
				await e.reply({ content: refused, ephemeral: true });
				return;
			}
			await e.defer({ ephemeral: true });
			const top = await discord.send(e.where.channelId, { content: `💬 **${e.actor.username}** asked:\n${prompt}`.slice(0, MAX_MESSAGE) }, "high");
			const threadId = await discord.startThread(top, { name: prompt.slice(0, 100) || "Question", autoArchiveMinutes: 1440 });
			db.insertChat(threadId, ASK_LABEL);
			db.insertAskChat(threadId, e.where.channelId, e.actor.userId);
			log("info", "ask chat started", { thread: threadId, user: e.actor.userId });
			await e.editReply({ content: `Started <#${threadId}>. Progress and the answer will appear there; reply in the thread to follow up.` });
			let saved: string[];
			try {
				saved = await saveInputs(threadId, e.attachments, MAX_COMMAND_FILES);
			} catch (err) {
				log("error", "saving attachments failed", { thread: threadId, error: errorMessage(err) });
				await notify(threadId, `❌ **Couldn't prepare the workspace:** ${errorMessage(err).slice(0, 1500)}`);
				return;
			}
			// Re-checked: another request may have taken the last slot while the files downloaded.
			const late = refusal(threadId, e.actor.userId, allowed);
			if (late) {
				await notify(threadId, late);
				return;
			}
			void launch(threadId, e.actor.userId, { prompt: askPrompt(agentName, prompt, saved), resume: false });
		},
		async message(e) {
			const ask = db.getAskChat(e.where.channelId);
			if (!ask) return false;
			// DSC-06: only the thread starter or an allowed member; everyone else is ignored silently.
			if (!askThreadAllowed(config, e.actor, ask.owner_id)) return true;
			try {
				// A question is waiting: the message is its answer, not steering (DSC-18).
				if (deps.replies.deliver(ask.thread_id, e.content)) return true;
				await followUp(e, ask);
			} catch (err) {
				log("error", "ask thread message failed", { thread: ask.thread_id, error: errorMessage(err) });
			}
			return true;
		},
		start() {
			for (const ask of allAskChats.all()) {
				if (active.has(ask.thread_id) || !dispatcher.hasUnfinishedRun(chatOwner(ask.thread_id))) continue;
				log("info", "ask chat re-attached after start", { thread: ask.thread_id });
				void launch(ask.thread_id, ask.owner_id, undefined);
			}
			sweepTimer = setInterval(() => {
				sweepIdle().catch(err => log("error", "ask sweep failed", { error: errorMessage(err) }));
			}, SWEEP_INTERVAL_MS);
		},
		async stop() {
			clearInterval(sweepTimer);
			detaching.abort();
			await Promise.allSettled([...active.values()]);
		},
	};
}
