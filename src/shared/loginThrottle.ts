/**
 * Throttling of password checks, held in memory only. Web keys it by client IP (WEB-03: 5 failures in 15 minutes block
 * the IP for 15 minutes); the orchestrator's admin API keys it by surface with a wider budget, because every caller
 * there arrives with the one web token (architecture §6). Checks run one at a time per key, so parallel attempts can't
 * all be checked before the first failures count.
 */

export interface ThrottleLimits {
	/** Failures within `windowMs` that block the key for `windowMs`. */
	maxFailures: number;
	windowMs: number;
}

/** WEB-03, per client IP. */
export const WEB_LOGIN_LIMITS: ThrottleLimits = { maxFailures: 5, windowMs: 15 * 60 * 1000 };
/** `Retry-After` for an attempt refused because another one with the same key is still being checked. */
export const THROTTLE_IN_FLIGHT_RETRY_MS = 1000;
const PRUNE_ABOVE = 1024;

export interface LoginThrottle {
	/** Milliseconds until the key may try again; 0 when it is not blocked. */
	retryAfterMs(key: string): number;
	/**
	 * Starts a password (or setup token) check: 0 when it may go ahead, else the milliseconds to wait, because the key is
	 * blocked or another check of its is still running. Every 0 must be followed by `end`.
	 */
	begin(key: string): number;
	end(key: string): void;
	fail(key: string): void;
	succeed(key: string): void;
}

export function createLoginThrottle(limits: ThrottleLimits, now: () => number = Date.now): LoginThrottle {
	const entries = new Map<string, { failures: number; firstFailure: number; blockedUntil: number }>();
	const checking = new Set<string>();

	function prune(): void {
		const t = now();
		for (const [key, entry] of entries) {
			if (entry.blockedUntil <= t && t - entry.firstFailure > limits.windowMs) entries.delete(key);
		}
	}

	function retryAfterMs(key: string): number {
		const entry = entries.get(key);
		return entry ? Math.max(0, entry.blockedUntil - now()) : 0;
	}

	return {
		retryAfterMs,
		begin(key) {
			const blocked = retryAfterMs(key);
			if (blocked > 0) return blocked;
			if (checking.has(key)) return THROTTLE_IN_FLIGHT_RETRY_MS;
			checking.add(key);
			return 0;
		},
		end(key) {
			checking.delete(key);
		},
		fail(key) {
			if (entries.size > PRUNE_ABOVE) prune();
			const t = now();
			let entry = entries.get(key);
			if (!entry || t - entry.firstFailure > limits.windowMs) {
				entry = { failures: 0, firstFailure: t, blockedUntil: entry?.blockedUntil ?? 0 };
				entries.set(key, entry);
			}
			entry.failures++;
			if (entry.failures >= limits.maxFailures) {
				entry.blockedUntil = t + limits.windowMs;
				entry.failures = 0;
				entry.firstFailure = t;
			}
		},
		succeed(key) {
			entries.delete(key);
		},
	};
}
