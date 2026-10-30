import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../shared/env";
import type { WorkerPhase } from "../shared/wire";

/**
 * The worker's status file, read by `agentbot health` (architecture §4.5). Each worker process keeps it in its own
 * run-local root, `<run dir>/<pid>/status.json`, so the health command finds it without being told where the worker
 * runs; the file goes with the rest of the run-local root at the end of the run (RUN-20).
 */

export interface WorkerStatus {
	pid: number;
	status: "ok";
	version: string;
	phase: WorkerPhase;
	/** Set at the claim; the readiness probe (`health --claimed`) passes from then on (spike S5). */
	runId: string | null;
	connected: boolean;
	updatedAt: string;
}

export const STATUS_FILE = "status.json";

/** Parent of every worker's checkout root on this host: container storage (architecture §5, "worker checkout"). */
export function workerBaseDir(): string {
	return join(tmpdir(), "agentbot-worker");
}

/**
 * Parent of every worker's run-local root (architecture §5, "run-local"): `AGENTBOT_WORKER_RUN_DIR`, which the image
 * points at the launcher's tmpfs or the pod's memory `emptyDir`; outside the image the same parent as the checkout root.
 */
export function workerRunBaseDir(runDir: string | undefined = loadEnv().workerRunDir): string {
	return runDir ?? workerBaseDir();
}

/** This process's root under `base`. */
export function workerRoot(base: string = workerBaseDir(), pid: number = process.pid): string {
	return join(base, String(pid));
}

/** Writes the status file atomically on every change. Sync on purpose: a tiny file, written from event handlers. */
export class StatusFile {
	readonly #path: string;
	#status: WorkerStatus;

	constructor(root: string, version: string) {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		this.#path = join(root, STATUS_FILE);
		this.#status = { pid: process.pid, status: "ok", version, phase: "claiming", runId: null, connected: false, updatedAt: new Date().toISOString() };
		this.#write();
	}

	get current(): Readonly<WorkerStatus> {
		return this.#status;
	}

	update(patch: Partial<Pick<WorkerStatus, "phase" | "runId" | "connected">>): void {
		this.#status = { ...this.#status, ...patch, updatedAt: new Date().toISOString() };
		this.#write();
	}

	#write(): void {
		const tmp = `${this.#path}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(this.#status)}\n`, { mode: 0o600 });
			renameSync(tmp, this.#path);
		} catch {
			// The run-local root is being deleted at the end of the run; health then reports the worker gone.
		}
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The status of the live worker under `base` (the most recently updated one, if several run on this host). */
export function readWorkerStatus(base: string = workerRunBaseDir()): WorkerStatus | undefined {
	let entries: string[];
	try {
		entries = readdirSync(base);
	} catch {
		return undefined;
	}
	let found: WorkerStatus | undefined;
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let status: WorkerStatus;
		try {
			status = JSON.parse(readFileSync(join(base, entry, STATUS_FILE), "utf8")) as WorkerStatus;
		} catch {
			continue;
		}
		if (typeof status.pid !== "number" || !alive(status.pid)) continue;
		if (!found || status.updatedAt > found.updatedAt) found = status;
	}
	return found;
}
