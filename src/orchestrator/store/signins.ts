import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type AuthStorage, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { errorMessage, log } from "../../shared/log";
import type { CredentialSnapshot } from "../../shared/wire";

/**
 * The orchestrator's model sign-ins (architecture §6.1, spike S1): omp's own SQLite auth store at
 * `<state>/omp-agent/agent.db` (CRED-01). Only this process holds refresh tokens and only it refreshes: runs get a
 * snapshot with refresh tokens replaced by omp's `__remote__` placeholder (CRED-02), and a worker's refresh arrives as
 * a `credential-request` answered here (CRED-03). Signing out refuses later requests for that sign-in (CRED-05).
 */

/** CRED-02: sign-ins expiring within this window are refreshed before a run's snapshot is taken. */
export const PRE_DISPATCH_REFRESH_MS = 10 * 60_000;
/** A stored access token newer than the worker's is handed out without a refresh while it has this much life left. */
export const FRESH_FOR_MS = 5 * 60_000;
/**
 * omp gives a refresh 10 s (S1); the worker's hook waits for the whole round trip, so the orchestrator answers
 * earlier. A refresh still running then keeps going, stores its result, and the worker's next request joins it.
 */
export const ANSWER_WITHIN_MS = 8_000;

/** A worker's `credential-request` (wire.ts): the orchestrator's row id from the snapshot and the worker's token. */
export interface CredentialRequest {
	provider: string;
	credentialId: string | number;
	accessToken?: string;
}

export type CredentialAnswer = { ok: true; accessToken: string; expiresAt: number } | { ok: false; error: string };

export interface Signins {
	/** The master store, for the sign-in page (phase 6) and a `ModelRegistry`. */
	readonly authStorage: AuthStorage;
	/** CRED-02: refreshes sign-ins expiring within 10 min, then returns every sign-in with refresh tokens redacted. */
	snapshotForRun(): Promise<CredentialSnapshot[]>;
	/** CRED-03/CRED-05: answers a worker's refresh request; never throws. */
	handleCredentialRequest(req: CredentialRequest): Promise<CredentialAnswer>;
	/** CRED-05: removes every sign-in for `provider`; false when there was none. */
	signOut(provider: string): Promise<boolean>;
	close(): void;
}

export interface SigninsOptions {
	/** Overrides {@link ANSWER_WITHIN_MS} (tests). */
	answerWithinMs?: number;
}

/** `<state>/omp-agent`, omp's agent dir for the orchestrator's store (mode 0700). */
export function signinsDir(stateDir: string): string {
	return join(stateDir, "omp-agent");
}

export async function openSignins(stateDir: string, opts: SigninsOptions = {}): Promise<Signins> {
	const answerWithinMs = opts.answerWithinMs ?? ANSWER_WITHIN_MS;
	const agentDir = signinsDir(stateDir);
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await chmod(agentDir, 0o700);
	// `cwd` is the agent dir so omp reads no project config from the process's working directory.
	const authStorage = await discoverAuthStorage(agentDir, { cwd: agentDir });

	async function refresh(id: number, provider: string, signal?: AbortSignal) {
		const entry = await authStorage.oauth.refresh(id, signal);
		log("info", "model sign-in refreshed", { provider, credentialId: id });
		return entry;
	}

	return {
		authStorage,

		async snapshotForRun() {
			await authStorage.credentials.reload();
			const expiring = authStorage.credentials
				.list()
				.filter(row => row.credential.type === "oauth" && row.credential.expires < Date.now() + PRE_DISPATCH_REFRESH_MS);
			await Promise.all(
				expiring.map(row =>
					refresh(row.id, row.provider).catch(err => {
						// The run still gets the old token; its first refresh request retries through handleCredentialRequest.
						log("warn", "model sign-in refresh before dispatch failed", { provider: row.provider, credentialId: row.id, error: errorMessage(err) });
					}),
				),
			);
			return authStorage.credentials.snapshot().credentials.map(entry => ({
				id: entry.id,
				provider: entry.provider,
				credential: entry.credential,
				identityKey: entry.identityKey,
			}));
		},

		async handleCredentialRequest(req) {
			const id = Number(req.credentialId);
			const row = authStorage.credentials.list(req.provider).find(r => r.id === id);
			if (!row) return { ok: false, error: `revoked: sign-in for ${req.provider} was removed` };
			if (row.credential.type !== "oauth") return { ok: false, error: `revoked: ${req.provider} credential ${id} is not an OAuth sign-in` };
			const stored = row.credential;
			if (stored.access !== req.accessToken && stored.expires > Date.now() + FRESH_FOR_MS) {
				return { ok: true, accessToken: stored.access, expiresAt: stored.expires };
			}
			try {
				// omp single-flights per row: concurrent requests share one token exchange.
				const entry = await refresh(id, req.provider, AbortSignal.timeout(answerWithinMs));
				if (entry.credential.type !== "oauth") return { ok: false, error: `revoked: ${req.provider} credential ${id} is not an OAuth sign-in` };
				return { ok: true, accessToken: entry.credential.access, expiresAt: entry.credential.expires };
			} catch (err) {
				log("warn", "model sign-in refresh for a run failed", { provider: req.provider, credentialId: id, error: errorMessage(err) });
				return { ok: false, error: errorMessage(err) };
			}
		},

		async signOut(provider) {
			if (authStorage.credentials.list(provider).length === 0) return false;
			await authStorage.credentials.remove(provider);
			log("info", "model sign-in removed", { provider });
			return true;
		},

		close() {
			authStorage.close();
		},
	};
}
