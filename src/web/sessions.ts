import { randomBytes } from "node:crypto";

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const THROTTLE_MAX_FAILURES = 5;
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_PRUNE_ABOVE = 1024;

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

export interface LoginThrottle {
	/** Milliseconds until the IP may try again; 0 when it is not blocked. */
	retryAfterMs(ip: string): number;
	fail(ip: string): void;
	succeed(ip: string): void;
}

/** Blocks an IP for 15 minutes after 5 failures within 15 minutes (WEB-03); held in web memory only. */
export function createLoginThrottle(now: () => number = Date.now): LoginThrottle {
	const entries = new Map<string, { failures: number; firstFailure: number; blockedUntil: number }>();

	function prune(): void {
		const t = now();
		for (const [ip, entry] of entries) {
			if (entry.blockedUntil <= t && t - entry.firstFailure > THROTTLE_WINDOW_MS) entries.delete(ip);
		}
	}

	return {
		retryAfterMs(ip) {
			const entry = entries.get(ip);
			return entry ? Math.max(0, entry.blockedUntil - now()) : 0;
		},
		fail(ip) {
			if (entries.size > THROTTLE_PRUNE_ABOVE) prune();
			const t = now();
			let entry = entries.get(ip);
			if (!entry || t - entry.firstFailure > THROTTLE_WINDOW_MS) {
				entry = { failures: 0, firstFailure: t, blockedUntil: entry?.blockedUntil ?? 0 };
				entries.set(ip, entry);
			}
			entry.failures++;
			if (entry.failures >= THROTTLE_MAX_FAILURES) {
				entry.blockedUntil = t + THROTTLE_WINDOW_MS;
				entry.failures = 0;
				entry.firstFailure = t;
			}
		},
		succeed(ip) {
			entries.delete(ip);
		},
	};
}
