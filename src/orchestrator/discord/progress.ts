import type { TodoItem } from "../../shared/agent";
import { errorMessage, log } from "../../shared/log";
import type { RunUiState } from "../dispatch/dispatcher";
import { type ProgressState, progressLine, todoList } from "./render";
import type { DiscordSurface, InteractionResponder, MsgRef, Priority } from "./surface";

/**
 * Where the progress message lives: a channel or thread (by id), or the reply of a slash command (`/work issue`). A
 * command reply is one message, edited through the interaction (`editReply`; the caller has replied or deferred), and
 * shows the todo list inside the progress message.
 */
export type ProgressTarget = { channelId: string } | { responder: InteractionResponder };

/** Minimum gap between edits caused by agent activity; state changes edit immediately (DSC-11). */
export const ACTIVITY_EDIT_MS = 5_000;
/** Refreshes the elapsed time while the agent is quiet (long thinking), so the message never looks stuck. */
export const HEARTBEAT_MS = 15_000;
const MAX_MESSAGE = 2000;

/** One live, edited message per job, chat, plan or draft run that shows what the agent is doing right now (DSC-10). */
export interface Progress {
	/** The agent's current action (tool and intent) and cost so far; edits are throttled. */
	activity(text: string, cost?: number): void;
	/** A step the system itself takes (preparing the workspace, pushing, …); shown immediately. */
	phase(text: string, cost?: number): void;
	/** True while a question waits for a human answer in the thread; that time is excluded from the elapsed time. */
	waiting(on: boolean): void;
	/**
	 * The agent's complete todo list (DSC-12). The first non-empty list is posted as its own message, and every later
	 * list edits that message in place.
	 */
	todos(todos: TodoItem[]): void;
	/** Shows the final state, settles steps the agent left open (DSC-13), and stops updating. */
	finish(state: Exclude<ProgressState, "running" | "waiting">): Promise<void>;
	/**
	 * Stops the heartbeat and every later edit without writing a final state: the engine detached from a run that keeps
	 * going (ENG-02), and the next engine re-attaches to it.
	 */
	stop(): void;
	/** The progress message in a channel target (null for a command reply). */
	ref(): MsgRef | null;
}

/**
 * Steps still open when the run ends. A finished run completed the step it was on (agents often yield in the same
 * turn as their last list update); a failed run failed every step it had not finished. A cancelled run's list is kept.
 */
export function settleTodos(todos: TodoItem[], final: Exclude<ProgressState, "running" | "waiting">): TodoItem[] {
	if (final === "done") return todos.map(todo => (todo.status === "in_progress" ? { ...todo, status: "completed" } : todo));
	if (final === "failed") {
		return todos.map(todo => (todo.status === "pending" || todo.status === "in_progress" ? { ...todo, status: "failed" } : todo));
	}
	return todos;
}

/** Edits of one message. Failures are only logged: progress display must never change how a run ends (DSC-11). */
interface MessageEditor {
	edit(priority: Priority): Promise<void>;
	settled(): Promise<void>;
}

/** Channel messages: every edit goes through the outbound queue, which serialises and coalesces them (DSC-32). */
function surfaceEditor(surface: DiscordSurface, ref: MsgRef, render: () => string): MessageEditor {
	let last: Promise<void> = Promise.resolve();
	return {
		edit(priority) {
			last = surface.edit(ref, { content: render() }, priority).catch(err => {
				log("debug", "progress edit failed", { channel: ref.channelId, message: ref.messageId, error: errorMessage(err) });
			});
			return last;
		},
		settled: () => last,
	};
}

/**
 * Command replies (outside the channel queue): serialised edits, each rendering the state current when it runs, so an
 * edit that has not started yet already covers later changes.
 */
function replyEditor(responder: InteractionResponder, render: () => string): MessageEditor {
	let editing: Promise<void> = Promise.resolve();
	let queued = false;
	return {
		edit() {
			if (queued) return editing;
			queued = true;
			editing = editing.then(async () => {
				queued = false;
				try {
					await responder.editReply({ content: render() });
				} catch (err) {
					log("debug", "progress reply edit failed", { error: errorMessage(err) });
				}
			});
			return editing;
		},
		settled: () => editing,
	};
}

export interface ProgressOptions {
	/**
	 * RUN-14: the stored state of a run this progress continues after an orchestrator restart. The status and to-do
	 * messages it names are edited again (re-rendered from the snapshot); one that was deleted is posted anew.
	 */
	restore?: RunUiState;
	/** RUN-14: called with the current state whenever a message id, the snapshot or the to-do list changes. */
	persist?(state: RunUiState): void;
}

const PROGRESS_STATES: Record<string, ProgressState> = { running: "running", waiting: "waiting", done: "done", failed: "failed", cancelled: "cancelled" };

/** A stored message that still exists, or undefined (deleted, or the lookup failed). */
async function existing(surface: DiscordSurface, ref: MsgRef | undefined): Promise<MsgRef | undefined> {
	if (!ref) return undefined;
	try {
		return (await surface.fetchMessage(ref)) ? ref : undefined;
	} catch (err) {
		log("debug", "progress message lookup failed", { channel: ref.channelId, message: ref.messageId, error: errorMessage(err) });
		return undefined;
	}
}

export async function startProgress(
	surface: DiscordSurface,
	target: string | ProgressTarget,
	title: string,
	activity: string,
	opts: ProgressOptions = {},
): Promise<Progress> {
	const where: ProgressTarget = typeof target === "string" ? { channelId: target } : target;
	const singleMessage = "responder" in where;
	const snapshot = singleMessage ? undefined : opts.restore;
	const restoredState = PROGRESS_STATES[snapshot?.progress?.state ?? ""];
	// A restored run keeps its elapsed time (answer waits were already excluded from it).
	const startedAt = Date.now() - (snapshot?.progress?.elapsedMs ?? 0);
	const state = {
		status: (restoredState === "waiting" ? "waiting" : "running") as ProgressState,
		activity: snapshot?.progress?.activity ?? activity,
		cost: snapshot?.progress?.costUsd ?? 0,
		lastEdit: Date.now(),
		todos: snapshot?.todos ?? ([] as TodoItem[]),
		waitedMs: 0,
		waitingSince: restoredState === "waiting" ? Date.now() : (undefined as number | undefined),
	};
	const elapsed = () => Date.now() - startedAt - state.waitedMs - (state.waitingSince === undefined ? 0 : Date.now() - state.waitingSince);
	const render = () => {
		const line = progressLine({ title, state: state.status, elapsedMs: elapsed(), cost: state.cost, activity: state.activity });
		return singleMessage && state.todos.length > 0 ? `${line}\n${todoList(state.todos, MAX_MESSAGE - line.length - 1)}` : line;
	};

	let ref: MsgRef | null = null;
	let todoRef: MsgRef | undefined;
	const persist = () => {
		if (!opts.persist || !ref) return;
		try {
			opts.persist({
				threadId: ref.channelId,
				statusMessage: ref,
				...(todoRef ? { todoMessage: todoRef } : {}),
				progress: { state: state.status, activity: state.activity, elapsedMs: elapsed(), costUsd: state.cost },
				todos: state.todos,
			});
		} catch (err) {
			log("warn", "progress state not stored", { error: errorMessage(err) });
		}
	};

	let progress: MessageEditor;
	if ("responder" in where) {
		progress = replyEditor(where.responder, render);
		await where.responder.editReply({ content: render() });
	} else {
		const kept = await existing(surface, snapshot?.statusMessage);
		if (kept) {
			ref = kept;
			progress = surfaceEditor(surface, ref, render);
			await progress.edit("state");
		} else {
			ref = await surface.send(where.channelId, { content: render() }, "high");
			progress = surfaceEditor(surface, ref, render);
		}
	}
	const edit = (priority: Priority) => {
		state.lastEdit = Date.now();
		persist();
		return progress.edit(priority);
	};
	const heartbeat = setInterval(() => void edit("activity"), HEARTBEAT_MS);
	let finished = false;

	// The separate todo message (channel targets): posted on the first non-empty list, then edited.
	let todoMessage: Promise<MessageEditor | undefined> | undefined;
	const renderTodos = () => todoList(state.todos);
	const postTodos = (channelId: string): Promise<MessageEditor | undefined> =>
		surface.send(channelId, { content: renderTodos() }, "high").then(
			posted => {
				todoRef = posted;
				persist();
				return surfaceEditor(surface, posted, renderTodos);
			},
			err => {
				log("debug", "todo message not posted", { channel: channelId, error: errorMessage(err) });
				return undefined;
			},
		);
	if (ref && snapshot) {
		const channelId = ref.channelId;
		const keptTodo = await existing(surface, snapshot.todoMessage);
		if (keptTodo) {
			todoRef = keptTodo;
			const editor = surfaceEditor(surface, keptTodo, renderTodos);
			await editor.edit("state");
			todoMessage = Promise.resolve(editor);
		} else if (state.todos.length > 0) {
			todoMessage = postTodos(channelId);
			await todoMessage;
		}
	}
	persist();

	return {
		activity(text, cost) {
			if (finished) return;
			state.activity = text;
			if (cost !== undefined) state.cost = cost;
			// Quieter updates are picked up by the next edit or heartbeat.
			if (state.status === "running" && Date.now() - state.lastEdit >= ACTIVITY_EDIT_MS) void edit("activity");
		},
		phase(text, cost) {
			if (finished) return;
			state.activity = text;
			if (cost !== undefined) state.cost = cost;
			if (state.status === "running") void edit("state");
		},
		waiting(on) {
			if (finished) return;
			if (on && state.waitingSince === undefined) state.waitingSince = Date.now();
			if (!on && state.waitingSince !== undefined) {
				state.waitedMs += Date.now() - state.waitingSince;
				state.waitingSince = undefined;
			}
			state.status = on ? "waiting" : "running";
			void edit("state");
		},
		todos(todos) {
			if (finished) return;
			state.todos = todos;
			if (singleMessage) {
				void edit("activity");
				return;
			}
			persist();
			if (todoMessage) {
				void todoMessage.then(message => message?.edit("activity"));
			} else if (todos.length > 0 && ref) {
				// Later lists edit it once it exists (the branch above), so the first send needs no follow-up edit.
				todoMessage = postTodos(ref.channelId);
			}
		},
		async finish(final) {
			if (finished) return;
			finished = true;
			clearInterval(heartbeat);
			if (state.waitingSince !== undefined) {
				state.waitedMs += Date.now() - state.waitingSince;
				state.waitingSince = undefined;
			}
			state.status = final;
			const settled = settleTodos(state.todos, final);
			const todosChanged = settled.some((todo, i) => todo !== state.todos[i]);
			state.todos = settled;
			await edit("state");
			const todoEditor = await todoMessage;
			await (todosChanged ? todoEditor?.edit("state") : todoEditor?.settled());
		},
		stop() {
			finished = true;
			clearInterval(heartbeat);
		},
		ref: () => ref,
	};
}
