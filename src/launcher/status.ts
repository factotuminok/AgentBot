import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * The launcher's status file, read by `agentbot health` in the launcher container (architecture §4.5, LCH-04). The
 * launcher rewrites it after every tick that reached the Podman socket; health passes while that is recent.
 */

/** Health fails once the socket has not been reached for this long (15 ticks). */
export const LAUNCHER_STALE_MS = 30_000;

const statusSchema = z.object({
	version: z.string(),
	rootless: z.boolean(),
	workers: z.number(),
	capacity: z.number(),
	/** Last time the Podman socket answered (ISO). */
	socketOkAt: z.string(),
});

export type LauncherStatus = z.infer<typeof statusSchema>;

/** `<tmpdir>/agentbot-launcher/status.json`: one launcher per container. */
export function launcherStatusPath(): string {
	return join(tmpdir(), "agentbot-launcher", "status.json");
}

/** True in a container where a launcher has run: `agentbot health` then reports the launcher, not a worker. */
export function hasLauncherStatus(path: string = launcherStatusPath()): boolean {
	return existsSync(path);
}

/** Writes the status file atomically. A failed write is ignored: health then reports the launcher stale. */
export function writeLauncherStatus(path: string, status: LauncherStatus): void {
	const tmp = `${path}.tmp`;
	try {
		mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
		writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		// Reported through health.
	}
}

/**
 * `agentbot health` for the launcher: prints `{status, version, rootless, workers, capacity}` and exits 0 while the
 * launcher reached the Podman socket within `LAUNCHER_STALE_MS`, else 1. Returns the exit code.
 */
export function runLauncherHealth(path: string = launcherStatusPath(), now: number = Date.now(), out: (line: string) => void = line => process.stdout.write(line)): number {
	let status: LauncherStatus;
	try {
		status = statusSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		out(`${JSON.stringify({ status: "down" })}\n`);
		return 1;
	}
	const fresh = now - Date.parse(status.socketOkAt) <= LAUNCHER_STALE_MS;
	const { version, rootless, workers, capacity } = status;
	out(`${JSON.stringify({ status: fresh ? "ok" : "stale", version, rootless, workers, capacity })}\n`);
	return fresh ? 0 : 1;
}
