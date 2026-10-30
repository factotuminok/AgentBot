import { randomBytes } from "node:crypto";

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

/** One-shot message shown on the next page render; `error` renders it as a failure. */
export interface Flash {
	text: string;
	error?: boolean;
	/** Extra lines under the text (warnings of a settings save). */
	details?: string[];
}

export interface Session {
	readonly token: string;
	/** The admin this login belongs to; sent to the orchestrator as `X-Agentbot-Admin` on writes. */
	username: string;
	flash?: Flash;
}

export interface SessionStore {
	create(username: string): Session;
	/** Returns the live session for the token and refreshes its idle timer; expired sessions are dropped. */
	get(token: string | undefined): Session | undefined;
	delete(token: string): void;
	/** Drops every session except the given one (after a credential change, WEB-04). */
	deleteOthers(token: string): void;
}

/** In-memory sessions keyed by a random 32-byte token (WEB-05), expiring after `idleMs` without a request. */
export function createSessionStore(idleMs = SESSION_IDLE_MS, now: () => number = Date.now): SessionStore {
	const sessions = new Map<string, { session: Session; lastSeen: number }>();

	function prune(): void {
		const cutoff = now() - idleMs;
		for (const [token, entry] of sessions) if (entry.lastSeen < cutoff) sessions.delete(token);
	}

	return {
		create(username) {
			prune();
			const session: Session = { token: randomBytes(32).toString("base64url"), username };
			sessions.set(session.token, { session, lastSeen: now() });
			return session;
		},
		get(token) {
			if (!token) return undefined;
			const entry = sessions.get(token);
			if (!entry) return undefined;
			if (now() - entry.lastSeen > idleMs) {
				sessions.delete(token);
				return undefined;
			}
			entry.lastSeen = now();
			return entry.session;
		},
		delete(token) {
			sessions.delete(token);
		},
		deleteOthers(token) {
			for (const key of sessions.keys()) if (key !== token) sessions.delete(key);
		},
	};
}
