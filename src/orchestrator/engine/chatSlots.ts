import { log } from "../../shared/log";

/** The up-front refusal while every chat slot is taken (CHAT-04, DSC-25; requirements §20 item 1). */
export const CAPACITY_REACHED = "Chat capacity reached; try again shortly.";
/**
 * The `maxChatSessions` budget shared by `/ask` and `/work ask` chats, `/work plan` planning runs and `/work issue` drafts
 * (CHAT-04, DSC-25, RUN-01). Each feature tracks the runs it started or re-attached to until they settle, so a new
 * request is refused up front, before any thread is created, while the budget is spent (requirements §20 item 1). The
 * dispatcher's own RUN-01 caps still hold behind this; this only decides whether to accept a new request.
 */
export interface ChatSlots {
	/** Runs tracked now. */
	readonly size: number;
	/** True when `key` (e.g. `chat:<thread>`, `plan:<thread>`, `draft:<id>`) is tracked. */
	has(key: string): boolean;
	/** True when every slot is taken. */
	full(): boolean;
	/** Tracks `done` under `key` until it settles. Returns `done`. */
	track(key: string, done: Promise<void>): Promise<void>;
	/** Keys tracked now, e.g. for `/work status`. */
	keys(): string[];
}

export function createChatSlots(maxChatSessions: number): ChatSlots {
	const live = new Map<string, Promise<void>>();
	return {
		get size() {
			return live.size;
		},
		has: key => live.has(key),
		full: () => live.size >= maxChatSessions,
		track(key, done) {
			if (live.has(key)) log("warn", "chat slot tracked twice", { key });
			live.set(key, done);
			const release = () => {
				if (live.get(key) === done) live.delete(key);
			};
			done.then(release, release);
			return done;
		},
		keys: () => [...live.keys()],
	};
}
