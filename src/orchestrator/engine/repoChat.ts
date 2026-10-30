import { errorMessage, log } from "../../shared/log";
import { allowedMentions, memberAllowed } from "../discord/access";
import { type Progress, startProgress } from "../discord/progress";
import { acknowledgeSteer, createDiscordUI } from "../discord/questions";
import { activityText, chunkText, handoffMessage } from "../discord/render";
import type { CommandEvent, MessageEvent } from "../discord/surface";
import { CHAT_ICONS, setTopIcon } from "../discord/topMessage";
import { type CheckoutRequest, RunDetached, type RunHandle, RunLost, type RunOwner } from "../dispatch/dispatcher";
import type { AvailableRepo } from "../github/types";
import type { ChatRow } from "../store/db";
import { createRunUiStore } from "../store/runUi";
import { chatSessionKey } from "../store/sessions";
import { loadoutKey } from "../store/stats";
import { CHAT_MINUTES } from "./chat";
import { CAPACITY_REACHED } from "./chatSlots";
import type { EngineDeps } from "./deps";
import { CHAT_SCHEMA, type ChatOutput, chatPrompt, runPrompt } from "./prompts";

/**
 * `/work ask` repo chats (CHAT-01 to CHAT-06, AGT-10), ported from the repo-chat parts of DevForge `src/engine/chat.ts`
 * onto the surface and the dispatcher, in the shape of `engine/chat.ts`: each turn is a `chat` run on a worker with a
 * private read-only checkout of the base branch (WS-04). Runs outlive the engine: stopping it detaches (RUN-09), and
 * starting it re-attaches to unfinished runs, editing the same messages (RUN-14). Nothing is kept between turns except
 * the omp session (CHAT-06).
 */

const MAX_MESSAGE = 2000;
/** Sent instead of a prompt when a re-attached turn's run is gone (its result was never posted). */
const RESTARTED_NOTE = "The orchestrator restarted before your answer could be posted. Answer the last message again.";

export interface RepoChat {
	/**
	 * `/work ask repo prompt`: access checked, repo resolved, interaction already deferred ephemerally. Refused up front
	 * when every chat slot is taken (requirements §20 item 1); otherwise posts the starter message, starts a one-day thread,
	 * records the chat, replies with the link and runs the first turn.
	 */
	command(e: CommandEvent, repo: AvailableRepo): Promise<void>;
	/**
	 * A human message in a thread. False when it is not a repo-chat thread; otherwise handled: an answer to a waiting
	 * question (DSC-18), steering for the live run (👀/⏳), or a new run resuming the session (CHAT-03, CHAT-04).
	 */
	message(e: MessageEvent): Promise<boolean>;
	/** `/work cancel` (requirements §20 item 2): undefined when the thread is not a repo chat; else the reply text. */
	cancel(threadId: string, by: string): Promise<string | undefined>;
	/** Engine start: re-attaches to unfinished chat runs (RUN-14). */
	start(): void;
	/** Engine stop: detaches from live runs, which keep going (RUN-09). */
	stop(): Promise<void>;
	/** Threads with a run this engine is attached to (`/work status`). */
	active(): string[];
}

/** The read-only checkout of `repo`'s base branch that plan, chat and draft runs use (WS-04, RUN-17). */
export function baseCheckout(deps: Pick<EngineDeps, "github">, repo: string): CheckoutRequest {
	const { github } = deps;
	return {
		repo,
		defaultBranch: async () => (await github.repo(repo)).defaultBranch,
		identity: { name: github.identity.name, email: github.identity.email },
		gitToken: () => github.gitToken(repo),
	};
}

/** A new question or a follow-up; absent when re-attaching to a run after a restart (the prompt is not resent). */
interface Turn {
	prompt: string;
	resume: boolean;
}

export function createRepoChat(deps: EngineDeps): RepoChat {
	const { config, db, discord, dispatcher, github } = deps;
	const agentName = config.agent.name;
	const runUi = createRunUiStore(db);
	const allRepoChats = db.raw.query<ChatRow, []>(
		"SELECT c.* FROM chats c LEFT JOIN ask_chats a ON a.thread_id = c.thread_id WHERE a.thread_id IS NULL",
	);
	/** threadId → settle promise of a run this engine is attached to. */
	const live = new Map<string, Promise<void>>();
	/** threadId → handle of the live run (from `register`). */
	const handles = new Map<string, RunHandle>();
	/** Aborted by `stop()`; every run's signal also follows the engine's. */
	const detaching = new AbortController();
	const signal = AbortSignal.any([deps.signal, detaching.signal]);

	const chatOwner = (threadId: string): RunOwner => ({ kind: "chat", threadId });

	/** The thread's repo chat, or null (not a chat, or an `/ask` chat). */
	function repoChatOf(threadId: string): ChatRow | null {
		const chat = db.getChat(threadId);
		return chat && !db.getAskChat(threadId) ? chat : null;
	}

	/** A plain thread message (mentions off, DSC-07). Never throws. */
	async function notify(threadId: string, content: string): Promise<void> {
		await discord.send(threadId, { content: content.slice(0, MAX_MESSAGE) }, "high").catch(err => {
			log("warn", "repo chat message failed", { thread: threadId, error: errorMessage(err) });
		});
	}

	/** CHAT-04: why a new run may not start in `threadId` now, or undefined. */
	function refusal(threadId: string): string | undefined {
		if (live.has(threadId) || dispatcher.hasUnfinishedRun(chatOwner(threadId))) return "Still starting the previous request; send that again in a moment.";
		if (deps.chatSlots.full()) return CAPACITY_REACHED;
		return undefined;
	}

	/** Runs one turn (or re-attaches to the live one) and tracks it until it settles. */
	function launch(chat: ChatRow, turn: Turn | undefined): Promise<void> {
		const threadId = chat.thread_id;
		const done = run(threadId, chat.repo, turn)
			.catch(err => log("error", "repo chat run failed", { repo: chat.repo, thread: threadId, error: errorMessage(err) }))
			.finally(() => {
				live.delete(threadId);
				handles.delete(threadId);
			});
		live.set(threadId, done);
		void deps.chatSlots.track(`chat:${threadId}`, done);
		return done;
	}

	async function run(threadId: string, repo: string, turn: Turn | undefined): Promise<void> {
		const owner = chatOwner(threadId);
		// Only a re-attach continues the stored messages; a new turn posts its own (DSC-12) and overwrites the state.
		const restore = turn ? undefined : runUi.get(owner);
		const logRun = { run: `chat-${threadId}`, kind: "chat", repo, thread: threadId };
		const startedAt = new Date().toISOString();
		let progress: Progress | undefined;
		try {
			progress = await startProgress(discord, threadId, "Working on your request", "Preparing the workspace…", {
				restore,
				persist: state => runUi.set(owner, state),
			});
			await setTopIcon(discord, threadId, CHAT_ICONS.working);
			if (!restore) progress.phase("Starting the agent…");
			const current = progress;
			const ui = createDiscordUI(discord, threadId, {
				jobId: `chat-${threadId}`,
				askTimeoutMs: config.limits.askTimeoutHours * 3_600_000,
				isAllowed: actor => memberAllowed(config, actor),
				replies: deps.replies,
				interactions: deps.interactions,
				mention: allowedMentions(config),
				onWaiting: on => current.waiting(on),
			});
			const result = await dispatcher.runAgent(
				{
					owner,
					kind: "chat",
					profile: "chat",
					prompt: runPrompt(agentName, turn?.prompt ?? RESTARTED_NOTE),
					outputSchema: CHAT_SCHEMA,
					model: config.models.chat,
					thinking: config.models.thinking,
					limits: { minutes: CHAT_MINUTES, costUsd: config.limits.maxCostUsdPerJob },
					session: chatSessionKey(threadId),
					resume: turn?.resume ?? true,
					checkout: baseCheckout(deps, repo),
					threadId,
					// AGT-10: filed without the trigger label; the hand-off button hands it to the pipeline.
					createIssue: {
						repo,
						file: async (title, body) => {
							const issue = await github.createIssue(repo, title, body);
							log("info", "issue filed from repo chat", { repo, issue: issue.number, thread: threadId });
							await discord.send(threadId, handoffMessage({ agentName, repo, number: issue.number, url: issue.url }), "high");
							return issue;
						},
					},
				},
				{
					ui,
					register: handle => handles.set(threadId, handle),
					onWaitingForWorker: () => current.phase("Waiting for a worker…"),
					onProgress: p => current.activity(activityText(p.tool, p.intent), p.usage.costUsd),
					onTodos: todos => current.todos(todos),
					onTranscript: event => deps.agentLog.append(logRun, event),
					onLoadout: loadout => db.kvSet(loadoutKey(loadout.profile), JSON.stringify(loadout)),
					onUsage: usage => db.recordRun({ kind: "chat", repo, threadId, startedAt, usage }),
				},
				signal,
			);
			db.updateChat(threadId, { last_active_at: new Date().toISOString(), ...(result.hasSession ? { session_file: chatSessionKey(threadId) } : {}) });
			progress.phase("Posting the answer…", result.usage.costUsd);
			if (result.aborted === "user") {
				await progress.finish("cancelled");
				await setTopIcon(discord, threadId, CHAT_ICONS.stopped);
				await notify(threadId, "⏹️ **Stopped.** Send another message to continue.");
			} else if (result.aborted) {
				await progress.finish("failed");
				await setTopIcon(discord, threadId, CHAT_ICONS.limit);
				const limit = result.aborted === "time" ? `${CHAT_MINUTES} minute time limit` : `$${config.limits.maxCostUsdPerJob} cost limit`;
				await notify(threadId, `⚠️ **Stopped at the ${limit}** before finishing. Send another message to continue where it left off.`);
			} else {
				for (const chunk of chunkText((result.output as ChatOutput).answer)) await discord.send(threadId, { content: chunk }, "high");
				await progress.finish("done");
				await setTopIcon(discord, threadId, CHAT_ICONS.done);
				await notify(threadId, "✅ **Done.** Reply in this thread to follow up.");
			}
			runUi.clear(owner);
		} catch (err) {
			if (err instanceof RunDetached || signal.aborted) {
				// The run keeps going; the next engine re-attaches and keeps editing the same messages (RUN-14).
				progress?.stop();
				log("info", "repo chat detached", { repo, thread: threadId });
				return;
			}
			log("error", "repo chat failed", { repo, thread: threadId, error: errorMessage(err) });
			db.updateChat(threadId, { last_active_at: new Date().toISOString() });
			await progress?.finish("failed");
			await setTopIcon(discord, threadId, CHAT_ICONS.failed);
			const reason = err instanceof RunLost ? err.message : errorMessage(err);
			await notify(threadId, `❌ **Chat failed:** ${reason.slice(0, 1500)}\nSend another message to try again.`);
			runUi.clear(owner);
		}
	}

	/** CHAT-03: steers the live run, or starts a new run resuming the session. */
	async function followUp(e: MessageEvent, chat: ChatRow): Promise<void> {
		const threadId = chat.thread_id;
		const text = e.content.trim();
		if (!text) return;
		const handle = handles.get(threadId);
		if (handle) {
			// Delivery can wait for the worker (RUN-15); the message handler does not.
			void acknowledgeSteer(discord, e.ref, onQueued => handle.steer(text, e.actor.username, { onQueued })).catch(err =>
				log("warn", "repo chat steer failed", { thread: threadId, error: errorMessage(err) }),
			);
			return;
		}
		const refused = refusal(threadId);
		if (refused) {
			await notify(threadId, refused);
			return;
		}
		db.updateChat(threadId, { last_active_at: new Date().toISOString() });
		void launch(chat, { prompt: text, resume: chat.session_file !== null });
	}

	return {
		active: () => [...live.keys()],
		async command(e, repo) {
			const prompt = String(e.options.prompt ?? "").trim();
			if (!prompt) {
				await e.editReply({ content: "Ask a question with the `prompt` option." });
				return;
			}
			// Requirements §20 item 1: refused before any message or thread exists.
			if (deps.chatSlots.full()) {
				await e.editReply({ content: CAPACITY_REACHED });
				return;
			}
			const top = await discord.send(
				e.where.channelId,
				{ content: `💬 **${e.actor.username}** asked about \`${repo.fullName}\`:\n${prompt}`.slice(0, MAX_MESSAGE) },
				"high",
			);
			const threadId = await discord.startThread(top, { name: prompt.slice(0, 100), autoArchiveMinutes: 1440 });
			const chat = db.insertChat(threadId, repo.fullName);
			log("info", "repo chat started", { repo: repo.fullName, thread: threadId, user: e.actor.userId });
			await e.editReply({ content: `Started <#${threadId}>. Progress, any questions and the answer will appear there; reply in the thread to follow up.` });
			void launch(chat, { prompt: chatPrompt(prompt), resume: false });
		},
		async message(e) {
			const chat = repoChatOf(e.where.channelId);
			if (!chat) return false;
			if (!memberAllowed(config, e.actor)) return true;
			try {
				// A question is waiting: the message is its answer, not steering (DSC-18).
				if (deps.replies.deliver(chat.thread_id, e.content)) return true;
				await followUp(e, chat);
			} catch (err) {
				log("error", "repo chat message failed", { thread: chat.thread_id, error: errorMessage(err) });
			}
			return true;
		},
		async cancel(threadId, by) {
			if (!repoChatOf(threadId)) return undefined;
			const handle = handles.get(threadId);
			if (handle) {
				log("info", "repo chat stopped", { thread: threadId, by });
				await handle.abort("user");
				return `Stopping the current run (requested by ${by})…`;
			}
			if (live.has(threadId) || dispatcher.hasUnfinishedRun(chatOwner(threadId))) return "The run is still starting; try again in a moment.";
			return "Nothing is running in this chat.";
		},
		start() {
			for (const chat of allRepoChats.all()) {
				const owner = chatOwner(chat.thread_id);
				// A turn whose answer was never posted has stored UI state; its run may have finished meanwhile (NFR-03).
				if (live.has(chat.thread_id) || (!dispatcher.hasUnfinishedRun(owner) && !runUi.get(owner))) continue;
				log("info", "repo chat re-attached after start", { repo: chat.repo, thread: chat.thread_id });
				void launch(chat, undefined);
			}
		},
		async stop() {
			detaching.abort();
			await Promise.allSettled([...live.values()]);
		},
	};
}
