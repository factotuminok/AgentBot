import type { Loadout } from "./agent";
import type { Config } from "./config";
import type { RunUsage } from "./transcript";
import type { WorkerPhase } from "./wire";

/**
 * Web ↔ orchestrator admin API (architecture §4.5 `/internal/admin/*`). The web pod holds no database or vault: every
 * read and write goes through these routes. Auth: `Authorization: Bearer <web-api-token>` (SEC-14, constant-time compare).
 * The admin acting is passed as `X-Agentbot-Admin: <username>` on writes so the orchestrator can log it (WEB-29).
 * Errors: non-2xx with `{ error: string }`; 400 = validation (message is shown to the admin), 401 = bad web token,
 * 409 = wrong vault state (e.g. setup after setup), 429 never (the login throttle lives in web, WEB-03).
 *
 * Phase 2 routes; later phases add more under the same prefix.
 */
export const ADMIN_PREFIX = "/internal/admin";

export type EnginePhase = "setup" | "locked" | "unconfigured" | "starting" | "running" | "stopping" | "error";

/** GET /internal/admin/state */
export interface AdminState {
	phase: EnginePhase;
	/** Startup error of the last apply (shown to the admin; never in health bodies). */
	error?: string;
	since: string;
	/** An admin account exists (else web serves /setup). */
	initialized: boolean;
	unlocked: boolean;
	username?: string;
	version: string;
	/** Home page facts (§9.3 `/`). */
	home: HomeFacts;
}

/**
 * Counts and getting-started progress for the home page (§9.3 `/`). Counts are absent while they can't be read (the
 * vault is locked, or no reader is wired); a step whose data can't be read is not done.
 */
export interface HomeFacts {
	modelAccounts?: number;
	mcpServers?: number;
	checklist: {
		/** The admin account exists (WEB-02). */
		setup: boolean;
		/** Discord bot token, GitHub App id and private key are saved. */
		credentials: boolean;
		/** `discord.workChannelId` is set (DSC-33). */
		workChannel: boolean;
		/** At least one repository is watched (DSC-35). */
		watchedRepo: boolean;
		/** A model sign-in or a provider API key exists. */
		modelAccess: boolean;
	};
}

/** POST /internal/admin/setup — WEB-02. 400 on a bad token/username/password, 409 once an admin exists. */
export interface SetupRequest {
	token: string;
	username: string;
	password: string;
}

/** POST /internal/admin/login — WEB-03 (the vault always pays the scrypt cost). Unlocks the vault, enrols a master key (SEC-05), applies settings. */
export interface LoginRequest {
	username: string;
	password: string;
}
export interface LoginResponse {
	ok: boolean;
}

/** POST /internal/admin/credentials — WEB-04. 400 `{error}` when the current password is wrong. Web ends the other sessions. */
export interface CredentialsRequest {
	currentPassword: string;
	username: string;
	password: string;
}

/** Secrets as the admin sees them: only whether each is set (write-only, §9.3 `/admin`). */
export interface SecretsView {
	discordToken: boolean;
	githubAppPrivateKey: boolean;
	/** Provider ids that have a key. */
	providerKeys: string[];
}

/** GET /internal/admin/settings — 409 while locked. `config` is undefined until settings are saved. */
export interface SettingsView {
	config?: Config;
	secrets: SecretsView;
}

/**
 * PUT /internal/admin/settings — validated as a whole (§13, GH-02); a blank or absent secret keeps the stored value;
 * `providerKeys` entries with an empty value delete that key. On success the orchestrator applies the settings (ENG-02)
 * and answers with the resulting phase. 400 `{error}` on validation failure, nothing stored.
 */
export interface SettingsSaveRequest {
	config: unknown;
	secrets: { discordToken?: string; githubAppPrivateKey?: string; providerKeys?: Record<string, string> };
}
export interface SettingsSaveResponse {
	phase: EnginePhase;
	error?: string;
	warnings: string[];
}

export type UsageWindow = "24h" | "7d" | "30d" | "all";

/** A connected worker (§9.3, architecture §6: every connected worker is listed, so an unknown one stands out). */
export interface WorkerStatus {
	/** Pod or container name. */
	id: string;
	address: string;
	version: string;
	/** omp version of its run (after `run-info`), else of its image. */
	ompVersion: string;
	runId?: string;
	phase?: WorkerPhase;
	connectedAt: string;
}

/**
 * A run that has not finished (§9.3: pending runs and their age, runs in progress). Setup time is the time from the
 * claim to the agent starting — worker start, downloads, checkout and `setupCommand` (NFR-06).
 */
export interface RunStatus {
	id: string;
	/** `RunKind`, or `ask` for the public `/ask` chat. */
	kind: string;
	state: "pending" | "assigned" | "running" | "finishing";
	/** `owner/name`; absent for `/ask` runs. */
	repo?: string;
	/** Owner key: `job:<id>`, `chat:<thread>`, `plan:<thread>` or `draft:<id>`. */
	owner: string;
	/** Discord thread the run reports into. */
	threadId?: string;
	workerId?: string;
	/** When the run became pending. */
	createdAt: string;
	/** The latest claim by a worker. */
	claimedAt?: string;
	/** The agent started (the host `registered`). */
	startedAt?: string;
	/** `startedAt − claimedAt`; absent until the agent started. */
	setupMs?: number;
	/** The tool of the latest progress report. */
	lastTool?: string;
	/** Live usage (latest progress report); zero until the first one. */
	usage: RunUsage;
	/** The run's loadout once the agent reported it (AGT-27). */
	loadout?: Loadout;
}

/** GET /internal/admin/status?window=7d — the status page and `/status.json` (§9.3). */
export interface StatusReport {
	state: AdminState;
	engine?: {
		startedAt: string;
		discord: { ready: boolean; user?: string; pingMs?: number; nicknameWarning?: string };
		githubApp: string;
		/** DSC-32. */
		discordQueue: { length: number; oldestAgeMs: number | null };
		watches: { repo: string; channelId: string | null; state: "watching" | "unwatched" | "suspended"; lastPollAt?: string; lastError?: string }[];
		queuedJobs: number;
	};
	runs: { pending: number; running: number; oldestPendingMs: number | null };
	/** Unfinished runs, oldest first: pending ones with their age, and runs in progress (§9.3, NFR-06). */
	activeRuns: RunStatus[];
	workers: WorkerStatus[];
	limits: {
		maxConcurrentJobs: number;
		maxChatSessions: number;
		maxConcurrentRuns: number;
		workerCapacity: number;
		effectiveConcurrency: number;
	} | null;
	warnings: string[];
	issues: {
		counts: Record<string, number>;
		open: { repo: string; number: number; title: string; state: string; job?: string; threadId: string | null }[];
	};
	usage: {
		window: UsageWindow;
		since?: string;
		totals: { runs: number; costUsd: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number };
		byKind: { kind: string; runs: number; costUsd: number }[];
		byRepo: { repo: string; runs: number; costUsd: number }[];
		jobs: { kind: string; succeeded: number; failed: number; cancelled: number; avgDurationMs: number | null }[];
		daily: { day: string; costUsd: number }[];
		/** NFR-06: setup time (claim → agent start) of runs started in the window, per repository, slowest average first. */
		setup: { repo: string; runs: number; avgMs: number; maxMs: number }[];
	};
	/** The latest loadout per profile, in plan/implement/chat/draft/ask order (AGT-27). */
	loadouts: Loadout[];
}
