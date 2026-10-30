import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnginePhase, StatusReport } from "../../shared/adminApi";
import { type EngineConfig, hasWorkChannel, type LabelNames, resolveLabelNames, type Settings, WORK_CHANNEL_MISSING } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import { attachBot } from "../discord/bot";
import { createDiscordJsConnection } from "../discord/discordjs";
import { createInteractionRouter } from "../discord/interactionRouter";
import { createThreadReplies } from "../discord/replies";
import { createOmpNotices } from "../discord/ompUpdate";
import type { DiscordConnection } from "../discord/surface";
import type { Dispatcher } from "../dispatch/dispatcher";
import { createGitHub } from "../github/app";
import { relabelTrackedIssues } from "../github/labels";
import { createPoller } from "../github/poller";
import type { GitHub } from "../github/types";
import type { OmpUpdater } from "../omp/updates";
import type { AgentLog } from "../store/agentlog";
import type { Db } from "../store/db";
import { sweepSessions } from "../store/sessions";
import type { Vault } from "../store/vault";
import { createAskChat } from "./chat";
import { createIssueDrafter } from "./draft";
import { createPlanner } from "./plans";
import { createRepoChat } from "./repoChat";
import type { EngineDeps } from "./deps";
import { createTrackIssue } from "./issues";
import { createScheduler } from "./scheduler";
import { createChatSlots } from "./chatSlots";

export type { EnginePhase };

export interface EngineStatus {
	phase: EnginePhase;
	/** Startup error of the last apply. */
	error?: string;
	since: string;
}

/** Point-in-time view of a running engine for the status page. */
export type EngineSnapshot = NonNullable<StatusReport["engine"]>;

export interface Controller {
	status(): EngineStatus;
	/** ENG-02: stops any running engine and starts one with the vault's current settings. Never throws; failures land in status(). */
	apply(): Promise<void>;
	/**
	 * Orchestrator shutdown (ENG-04): stops the engine and stays in `stopping` until the process exits; later applies do nothing.
	 * Runs on workers are never aborted.
	 */
	stop(): Promise<void>;
	/** Live view of the running engine; undefined unless the phase is `running`. */
	snapshot(): EngineSnapshot | undefined;
}

export type GitHubFactory = (opts: { appId: number; privateKey: string; labels: LabelNames }) => Promise<GitHub>;

export interface ControllerOptions {
	/** `<state>` (AGENTBOT_STATE_DIR). */
	stateDir: string;
	db: Db;
	vault: Vault;
	agentLog: AgentLog;
	/** Process-wide: outlives every engine instance, so restarts never touch runs (RUN-09). */
	dispatcher: Dispatcher;
	/** Applies Settings → Logs (OBS-04); called on every apply once settings are readable, before the engine starts. */
	applyLogCap?(maxGiB: number): void;
	/** One Discord connection per engine instance; defaults to discord.js. */
	connectDiscord?(): DiscordConnection;
	/** The GitHub App client per engine instance; defaults to `createGitHub` against api.github.com. */
	connectGitHub?: GitHubFactory;
	/** Process-wide in-place omp updates (UPD-02, UPD-03): each engine posts the notices and handles Approve. */
	ompUpdates?: OmpUpdater;
}

/** A running engine instance: everything that must be torn down before settings can be re-applied. */
interface RunningEngine {
	stop(): Promise<void>;
	snapshot(): EngineSnapshot;
}

/** State directories the engine works in (ENG-03 step 1). */
const STATE_DIRS = ["sessions", "scratch", "omp-agent", "repos"] as const;

async function startEngine(opts: ControllerOptions, config: EngineConfig, secrets: Settings["secrets"]): Promise<RunningEngine> {
	const { stateDir, db, agentLog, dispatcher } = opts;
	for (const dir of STATE_DIRS) await mkdir(join(stateDir, dir), { recursive: true });
	const sessionDir = join(stateDir, "sessions");
	// Before the scheduler starts, so no job is touching sessions yet.
	await sweepSessions({ db, sessionDir });

	const labels = resolveLabelNames(config);
	const github = await (opts.connectGitHub ?? createGitHub)({ appId: config.github.appId, privateKey: secrets.githubAppPrivateKey, labels });
	const connection = (opts.connectDiscord ?? createDiscordJsConnection)();
	const lifetime = new AbortController();
	const deps: EngineDeps = {
		config,
		labels,
		db,
		github,
		discord: connection,
		dispatcher,
		replies: createThreadReplies(),
		interactions: createInteractionRouter(),
		agentLog,
		sessionDir,
		chatSlots: createChatSlots(config.limits.maxChatSessions),
		signal: lifetime.signal,
	};
	const scheduler = createScheduler(deps);
	const trackIssue = createTrackIssue(deps, scheduler);
	const poller = createPoller(deps, scheduler, trackIssue);
	const askChat = createAskChat(deps, { scratchRoot: join(stateDir, "scratch") });
	const repoChat = createRepoChat(deps);
	const planner = createPlanner(deps, { scheduler });
	const drafter = createIssueDrafter(deps, { trackIssue });
	/** Run-owning features that outlive the engine: started after login, detached at stop (RUN-09, RUN-14). */
	const features = [
		{ name: "ask chat", feature: askChat },
		{ name: "repo chat", feature: repoChat },
		{ name: "planner", feature: planner },
		{ name: "issue drafter", feature: drafter },
	];
	const detachFeatures = () =>
		Promise.all(
			features.map(({ name, feature }) => feature.stop().catch(err => log("error", `${name} detach failed`, { error: errorMessage(err) }))),
		);
	const ompNotices = opts.ompUpdates ? createOmpNotices(deps, opts.ompUpdates) : undefined;
	// Attached before login: command registration and the nickname run on every ready event (DSC-01, DSC-29).
	const bot = attachBot({ deps, connection, scheduler, trackIssue, poller, askChat, repoChat, planner, drafter, ompNotices });
	try {
		try {
			await connection.login(secrets.discordToken);
		} catch (err) {
			throw new Error(`Discord login failed: ${errorMessage(err)}`);
		}
		// GH-23: before the first poll, so a label rename is applied before new work is looked for.
		await relabelTrackedIssues(deps);
		scheduler.recover();
		scheduler.tick();
		for (const { feature } of features) feature.start();
		poller.start();
		ompNotices?.start();
	} catch (err) {
		poller.stop();
		lifetime.abort();
		await scheduler.detach().catch(detachErr => log("warn", "scheduler detach failed", { error: errorMessage(detachErr) }));
		await detachFeatures();
		bot.detach();
		await connection.destroy().catch(destroyErr => log("warn", "discord destroy failed", { error: errorMessage(destroyErr) }));
		throw err;
	}
	const startedAt = new Date().toISOString();
	log("info", "engine started", { githubApp: github.identity.login, watches: db.listWatches("watching").length });

	return {
		async stop() {
			// ENG-04 order: poller, dispatch (detach from runs; never abort them), then Discord.
			poller.stop();
			ompNotices?.stop();
			lifetime.abort();
			await scheduler.detach().catch(err => log("error", "scheduler detach failed", { error: errorMessage(err) }));
			await detachFeatures();
			bot.detach();
			await connection.destroy();
			log("info", "engine stopped");
		},
		snapshot() {
			const discord = connection.status();
			return {
				startedAt,
				discord: { ready: discord.ready, user: discord.user, pingMs: discord.pingMs, nicknameWarning: bot.nicknameWarning() },
				githubApp: github.identity.login,
				discordQueue: connection.queueStats(),
				watches: poller.status().watches,
				queuedJobs: db.queuedJobCount(),
			};
		},
	};
}

/** Owns the engine lifecycle (ENG-01 to ENG-03): started when the vault is unlocked and holds settings, restarted on every save. */
export function createController(opts: ControllerOptions): Controller {
	const { vault, applyLogCap } = opts;
	let running: RunningEngine | undefined;
	// Until the first apply settles: what the vault alone tells.
	const initial: EnginePhase = !vault.isInitialized() ? "setup" : !vault.isUnlocked() ? "locked" : "starting";
	let current: EngineStatus = { phase: initial, since: new Date().toISOString() };
	/** Set by `stop()`: the orchestrator is shutting down and no engine starts again. */
	let closed = false;
	/** Serialises apply/stop so overlapping admin saves cannot start two engines. */
	let queue: Promise<unknown> = Promise.resolve();

	function set(phase: EnginePhase, error?: string): void {
		current = { phase, error, since: new Date().toISOString() };
		if (error) log("error", "engine status", { phase, error });
		else log("info", "engine status", { phase });
	}

	async function stopRunning(): Promise<void> {
		if (!running) return;
		set("stopping");
		const engine = running;
		running = undefined;
		await engine.stop().catch(err => log("error", "engine stop failed", { error: errorMessage(err) }));
	}

	async function apply(): Promise<void> {
		if (closed) return;
		await stopRunning();
		if (!vault.isInitialized()) return set("setup");
		if (!vault.isUnlocked()) return set("locked");
		let settings: Settings | undefined;
		try {
			settings = vault.readSettings();
		} catch (err) {
			return set("error", errorMessage(err));
		}
		if (!settings) return set("unconfigured");
		// Before the engine starts, so a save takes effect even if the engine then fails to start.
		try {
			applyLogCap?.(settings.config.logs.maxGiB);
		} catch (err) {
			log("error", "applying log size failed", { error: errorMessage(err) });
		}
		if (!hasWorkChannel(settings.config)) return set("unconfigured", WORK_CHANNEL_MISSING);
		set("starting");
		try {
			running = await startEngine(opts, settings.config, settings.secrets);
			set("running");
		} catch (err) {
			set("error", errorMessage(err));
		}
	}

	async function shutdown(): Promise<void> {
		closed = true;
		set("stopping");
		const engine = running;
		running = undefined;
		await engine?.stop().catch(err => log("error", "engine stop failed", { error: errorMessage(err) }));
	}

	function enqueue(step: () => Promise<void>): Promise<void> {
		const next = queue.then(step, step);
		queue = next.catch(() => {});
		return next;
	}

	return {
		status: () => current,
		apply: () => enqueue(apply),
		stop: () => enqueue(shutdown),
		snapshot: () => (current.phase === "running" ? running?.snapshot() : undefined),
	};
}
