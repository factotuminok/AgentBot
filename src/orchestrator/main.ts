import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { loadEnv } from "../shared/env";
import { errorMessage, log, setLogSink } from "../shared/log";
import { DEFAULT_LOG_MAX_BYTES, logCapBytes, openRollingFiles, splitLogCap } from "../shared/rollinglog";
import { versionInfo } from "../shared/version";
import { createAdminApi, generateSetupToken, loadWebApiToken } from "./api/admin";
import { loadInternalToken, startInternalApi } from "./api/server";
import { createWorkerDispatcher } from "./dispatch/workers";
import { createController } from "./engine/controller";
import { openAgentLog } from "./store/agentlog";
import { dbPath, openDb } from "./store/db";
import { ensureOmpAssetsDir, skillsBundle } from "./store/ompAssets";
import { openSignins } from "./store/signins";
import { loadMasterKey, openVault } from "./store/vault";

/** `kv` key holding the last applied total log budget in bytes (plain text; a size isn't secret). */
const LOG_CAP_KEY = "logs.maxBytes";
/** `workers.reattachGraceSeconds` default, used when the settings are locked at start (RUN-07). */
const DEFAULT_REATTACH_GRACE_S = 90;

export async function runOrchestrator(): Promise<void> {
	const env = loadEnv();
	await mkdir(join(env.stateDir, "logs", "orchestrator"), { recursive: true });
	// Cap unknown until the db is open: nothing is deleted from the process log before then.
	const processLog = openRollingFiles({ dir: join(env.stateDir, "logs", "orchestrator"), prefix: "orchestrator" });
	setLogSink(line => processLog.append(line));

	const db = openDb(dbPath(env.stateDir));
	// Cap order at boot: env override, then the size last applied (settings can't be read while the vault is locked), then the default (OBS-04).
	const storedCap = Number(db.kvGet(LOG_CAP_KEY));
	const total = logCapBytes((Number.isSafeInteger(storedCap) && storedCap >= 1024 ** 2 ? storedCap : DEFAULT_LOG_MAX_BYTES) / 1024 ** 3);
	const split = splitLogCap(total);
	processLog.setMaxBytes(split.process);
	const agentLog = await openAgentLog({ dir: join(env.stateDir, "logs", "agent"), maxBytes: split.agent });
	/** Settings → Logs, applied on every apply once settings are readable; remembered for locked boots (OBS-04). */
	const applyLogCap = (maxGiB: number): void => {
		const cap = logCapBytes(maxGiB);
		const shares = splitLogCap(cap);
		processLog.setMaxBytes(shares.process);
		agentLog.setMaxBytes(shares.agent);
		db.kvSet(LOG_CAP_KEY, String(cap));
	};

	const vault = await openVault(db, await loadMasterKey(env.masterKeyFile));
	const { agentbot: version } = await versionInfo();
	/** Settings, or undefined while locked, unsaved or invalid (the engine reports that itself). */
	const settings = () => {
		try {
			return vault.isUnlocked() ? vault.readSettings() : undefined;
		} catch {
			return undefined;
		}
	};
	const signins = await openSignins(env.stateDir);
	await ensureOmpAssetsDir(env.ompDir);
	// Process-wide: engine restarts never touch runs, and shutdown never aborts them (RUN-09).
	const dispatcher = createWorkerDispatcher({
		db,
		stateDir: env.stateDir,
		limits: () => {
			const config = settings()?.config;
			if (!config) return undefined;
			const { maxConcurrentJobs, maxChatSessions } = config.limits;
			return { maxConcurrentJobs, maxChatSessions, maxConcurrentRuns: config.workers.maxConcurrentRuns ?? env.workerCapacity };
		},
		reattachGraceMs: (settings()?.config.workers.reattachGraceSeconds ?? DEFAULT_REATTACH_GRACE_S) * 1000,
		spec: {
			stateDir: env.stateDir,
			ompConfig: () => vault.readOmpConfig(),
			providerKeys: () => settings()?.secrets.providerKeys ?? {},
			credentials: () => signins.snapshotForRun(),
			skillsHash: async () => (await skillsBundle(env.ompDir)).hash,
		},
		skills: () => skillsBundle(env.ompDir),
		credentialRequest: req => signins.handleCredentialRequest(req),
	});
	const controller = createController({ stateDir: env.stateDir, db, vault, agentLog, dispatcher, applyLogCap });

	// First run: whoever can read the orchestrator log proves it before claiming the admin account (WEB-02).
	const setupToken = vault.isInitialized() ? undefined : generateSetupToken();
	const admin = createAdminApi({
		db,
		vault,
		controller,
		dispatcher,
		version,
		workerCapacity: env.workerCapacity,
		webToken: await loadWebApiToken(env.webApiTokenFile),
		setupToken,
	});
	const api = startInternalApi({
		host: env.internalHost,
		port: env.internalPort,
		stateDir: env.stateDir,
		db,
		version,
		workerCapacity: env.workerCapacity,
		phase: () => controller.status().phase,
		config: () => settings()?.config,
		dispatcher,
		admin,
		workers: dispatcher,
		workerToken: await loadInternalToken(env.workerTokenFile, "AGENTBOT_WORKER_TOKEN_FILE", "the worker WebSocket"),
		scaleToken: await loadInternalToken(env.scaleTokenFile, "AGENTBOT_SCALE_TOKEN_FILE", "the scale endpoint"),
	});
	log("info", "orchestrator started", { url: api.url, version, stateDir: env.stateDir });
	if (setupToken) log("info", "first run: open the web UI's /setup page and enter this setup token to create the admin account", { setupToken });
	else if (!vault.isUnlocked()) log("info", "settings are locked: log in to the web UI to start the engine");

	// omp's SDK installs process-wide SIGINT/SIGTERM handlers that run registered cleanups and then exit;
	// a separate process.on handler would race that exit, so register with it (ENG-04).
	postmortem.register(
		"agentbot-orchestrator-shutdown",
		async reason => {
			log("info", "shutting down", { reason });
			try {
				// RUN-09: stop serving workers and dispatching; runs keep going on their workers and re-attach after the restart.
				await api.stop();
				dispatcher.close();
				await controller.stop();
				signins.close();
				db.close();
			} catch (err) {
				log("error", "shutdown failed", { error: errorMessage(err) });
			}
			log("info", "shutdown complete");
			setLogSink(undefined);
		},
		{ exitOnly: true },
	);

	await controller.apply();
	log("info", "startup complete", { phase: controller.status().phase });
}
