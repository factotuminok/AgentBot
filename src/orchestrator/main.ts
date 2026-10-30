import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { loadEnv } from "../shared/env";
import { errorMessage, log, setLogSink } from "../shared/log";
import { DEFAULT_LOG_MAX_BYTES, logCapBytes, openRollingFiles, splitLogCap } from "../shared/rollinglog";
import { versionInfo } from "../shared/version";
import type { EnginePhase } from "./api/health";
import { startInternalApi } from "./api/server";
import { dbPath, openDb } from "./store/db";
import { loadMasterKey, openVault, type Vault } from "./store/vault";

/** `kv` key holding the last applied total log budget in bytes (plain text; a size isn't secret). */
const LOG_CAP_KEY = "logs.maxBytes";

/**
 * The phase before any engine runs (ENG-02 without the `starting` branch, which the controller owns): `setup` without an admin,
 * `locked` while the vault is locked, `error` when the settings can't be read, `unconfigured` until settings are saved.
 */
function preEnginePhase(vault: Vault): EnginePhase {
	if (!vault.isInitialized()) return "setup";
	if (!vault.isUnlocked()) return "locked";
	try {
		vault.readSettings();
	} catch {
		return "error";
	}
	return "unconfigured";
}

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

	const vault = await openVault(db, await loadMasterKey(env.masterKeyFile));
	const { agentbot: version } = await versionInfo();

	const api = startInternalApi({
		host: env.internalHost,
		port: env.internalPort,
		stateDir: env.stateDir,
		db,
		version,
		workerCapacity: env.workerCapacity,
		phase: () => preEnginePhase(vault),
		config: () => (vault.isUnlocked() ? vault.readSettings()?.config : undefined),
	});
	log("info", "orchestrator started", { url: api.url, version, phase: preEnginePhase(vault), stateDir: env.stateDir });

	// omp's SDK installs process-wide SIGINT/SIGTERM handlers that run registered cleanups and then exit;
	// a separate process.on handler would race that exit, so register with it (ENG-04).
	postmortem.register(
		"agentbot-orchestrator-shutdown",
		async reason => {
			log("info", "shutting down", { reason });
			try {
				await api.stop();
				db.close();
			} catch (err) {
				log("error", "shutdown failed", { error: errorMessage(err) });
			}
			log("info", "shutdown complete");
			setLogSink(undefined);
		},
		{ exitOnly: true },
	);
}
