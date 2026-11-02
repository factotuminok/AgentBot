import type { StoredAccount } from "../../shared/adminModels";
import { errorMessage, log } from "../../shared/log";
import type { EngineDeps } from "../engine/deps";
import type { OutMessage } from "./surface";

/**
 * Re-login notices (SEC-17): while an engine runs, posts in the work channel (DSC-33, no mentions, DSC-07) when a stored
 * sign-in's re-login deadline (`reloginBy`, SEC-12) is 3 days or less away: at most one notice per 24 h and 3 per
 * deadline. A notice that was due while no engine ran goes out late, at the next check. Sent-notice state lives in `kv`,
 * so it survives engine and orchestrator restarts; one per engine.
 */

/** `kv` key: JSON object from credential id to {@link NoticeState}. */
export const RELOGIN_NOTICE_KEY = "signin.relogin.notices";
export const RELOGIN_NOTICE_WINDOW_MS = 3 * 86_400_000;
export const RELOGIN_NOTICE_SPACING_MS = 86_400_000;
export const RELOGIN_NOTICE_MAX = 3;
/** A notice goes out at most this long after it became due. */
export const RELOGIN_CHECK_INTERVAL_MS = 60 * 60_000;

/** Notices sent for one credential's current deadline. */
interface NoticeState {
	reloginBy: string;
	sent: number;
	lastAt: string;
}

export interface ReloginNoticesOptions {
	/** Current sign-ins (`storedAccounts`). */
	accounts(): StoredAccount[];
	/** Default `Date.now` (tests advance it). */
	now?(): number;
	/** Repeats `fn` every `ms`; returns a cancel function. Default `setInterval` + `unref` (tests fire it by hand). */
	every?(fn: () => void, ms: number): () => void;
}

export interface ReloginNotices {
	/** Checks now, then every {@link RELOGIN_CHECK_INTERVAL_MS}. */
	start(): void;
	/** Cancels the interval; later checks do nothing. Does not wait for a send in flight. */
	stop(): void;
	/** Queues one check behind any running one; resolves when it has run. */
	check(): Promise<void>;
}

function defaultEvery(fn: () => void, ms: number): () => void {
	const timer = setInterval(fn, ms);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Email and org if known, else the provider's account id, else the credential id. */
function accountLabel(a: StoredAccount): string {
	if (a.email && a.orgName) return `${a.email} (${a.orgName})`;
	return a.email ?? a.orgName ?? a.accountId ?? `#${a.credentialId}`;
}

export function reloginMessage(account: StoredAccount, deadlineMs: number): OutMessage {
	const secs = Math.floor(deadlineMs / 1000);
	// Credential text goes in a code span, backticks replaced, so its markdown has no effect.
	const who = `\`${accountLabel(account).replaceAll("`", "'").replace(/\s+/g, " ")}\``;
	return {
		content: `⏳ The **${account.provider}** model sign-in ${who} must be renewed by <t:${secs}:F> (<t:${secs}:R>). Sign in again at /admin/models before runs start failing.`,
	};
}

/** Bad JSON or malformed entries count as no state. */
function readState(raw: string | undefined): Record<string, NoticeState> {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const state: Record<string, NoticeState> = {};
	for (const [id, e] of Object.entries(parsed)) {
		const entry = e as Partial<NoticeState> | null;
		if (entry && typeof entry.reloginBy === "string" && typeof entry.sent === "number" && typeof entry.lastAt === "string") {
			state[id] = { reloginBy: entry.reloginBy, sent: entry.sent, lastAt: entry.lastAt };
		}
	}
	return state;
}

export function createReloginNotices(deps: Pick<EngineDeps, "config" | "discord" | "db">, opts: ReloginNoticesOptions): ReloginNotices {
	const { discord, db } = deps;
	const channelId = deps.config.discord.workChannelId;
	const now = opts.now ?? Date.now;
	const every = opts.every ?? defaultEvery;
	let stopped = false;
	let cancel: (() => void) | undefined;

	async function checkOnce(): Promise<void> {
		if (stopped) return;
		const accounts = opts.accounts();
		const stored = db.kvGet(RELOGIN_NOTICE_KEY);
		const t = now();
		// Keep an entry only while its sign-in exists with the same deadline: a new sign-in restarts the cycle, a sign-out ends it.
		const next: Record<string, NoticeState> = {};
		const previous = readState(stored);
		for (const a of accounts) {
			const e = previous[String(a.credentialId)];
			if (a.reloginBy && e?.reloginBy === a.reloginBy) next[String(a.credentialId)] = e;
		}
		const save = (): void => db.kvSet(RELOGIN_NOTICE_KEY, JSON.stringify(next));
		if (JSON.stringify(next) !== JSON.stringify(previous)) save();

		for (const a of accounts) {
			if (!a.reloginBy) continue;
			const deadline = Date.parse(a.reloginBy);
			if (Number.isNaN(deadline) || t >= deadline || t < deadline - RELOGIN_NOTICE_WINDOW_MS) continue;
			const id = String(a.credentialId);
			const e = next[id];
			if (e && (e.sent >= RELOGIN_NOTICE_MAX || t - Date.parse(e.lastAt) < RELOGIN_NOTICE_SPACING_MS)) continue;
			try {
				await discord.send(channelId, reloginMessage(a, deadline), "high");
			} catch (err) {
				log("warn", "re-login notice failed", { provider: a.provider, credentialId: a.credentialId, error: errorMessage(err) });
				continue;
			}
			// Recorded at once, so a failure later in this check cannot repeat it.
			next[id] = { reloginBy: a.reloginBy, sent: (e?.sent ?? 0) + 1, lastAt: new Date(t).toISOString() };
			save();
			log("info", "re-login notice posted", { provider: a.provider, credentialId: a.credentialId, reloginBy: a.reloginBy, sent: next[id].sent });
		}
	}

	/** Serialized, so an interval tick cannot post a notice a running check is about to post. */
	let chain: Promise<void> = Promise.resolve();
	function check(): Promise<void> {
		chain = chain.then(checkOnce).catch(err => log("warn", "re-login notice check failed", { error: errorMessage(err) }));
		return chain;
	}

	return {
		start() {
			void check();
			cancel = every(() => void check(), RELOGIN_CHECK_INTERVAL_MS);
		},
		stop() {
			stopped = true;
			cancel?.();
			cancel = undefined;
		},
		check,
	};
}
