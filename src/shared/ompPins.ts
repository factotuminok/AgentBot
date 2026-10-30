import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which omp the app depends on, and how to install and check a copy of it. Shared by the image build step
 * (`scripts/omp-latest.ts`, UPD-01) and the in-place worker updates (`src/orchestrator/omp`, architecture §8). The
 * Dockerfile copies this file before `src/`, so it imports only `node:` modules.
 */

/** omp's SDK. */
export const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";
/** Released in lockstep with the SDK and pinned to the same version. */
export const PINNED_PACKAGES = [OMP_PACKAGE, "@oh-my-pi/pi-utils"] as const;
/** Plain `major.minor.patch[-prerelease]`; also the guard for versions that end up in paths, pins and Discord custom ids. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
/** The app's entry modules that load omp (image build): Bun fails at link time on a missing export. The web role has no omp. */
export const APP_SMOKE_SCRIPT =
	'await import("./src/orchestrator/main.ts"); await import("./src/worker/main.ts"); await import("./src/worker/host/session.ts"); await import("./src/worker/host/serve.ts")';
/** The worker's entry modules (UPD-06 step 2): what a runtime copy must load, since only workers run it. */
export const WORKER_SMOKE_SCRIPT = 'await import("./src/worker/main.ts"); await import("./src/worker/host/session.ts"); await import("./src/worker/host/serve.ts")';
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
export const SMOKE_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_TAIL_CHARS = 4096;

export type RunCommand = (
	cmd: string[],
	opts: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> },
) => Promise<{ exitCode: number; output: string }>;

export const runCommand: RunCommand = async (cmd, { cwd, timeoutMs, env }) => {
	const proc = Bun.spawn(cmd, { cwd, env: env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { exitCode, output: `${out}${err}` };
};

/** The last 4 KiB of a command's output. */
export function outputTail(text: string): string {
	return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

/** Version of the omp SDK installed under `appDir/node_modules`, or "unknown". */
export function installedOmpVersion(appDir: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(appDir, "node_modules", OMP_PACKAGE, "package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

/** Points every omp package in the `package.json` at `pkgJsonPath` to exactly `version`. */
export function pinOmp(pkgJsonPath: string, version: string): void {
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { dependencies?: Record<string, string> };
	pkg.dependencies ??= {};
	for (const name of PINNED_PACKAGES) pkg.dependencies[name] = version;
	writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
