import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, log } from "../../shared/log";
import {
	INSTALL_TIMEOUT_MS,
	installedOmpVersion,
	OMP_PACKAGE,
	pinOmp,
	type RunCommand,
	runCommand,
	SMOKE_TIMEOUT_MS,
	WORKER_SMOKE_SCRIPT,
} from "../../shared/ompPins";
import { packRuntime } from "../../shared/ompRuntime";
import type { AppIdentity } from "../../shared/version";
import type { OmpRuntimeSpec } from "../../shared/wire";

/**
 * The packed omp runtime copies in `<state>/omp-runtime/` (`AGENTBOT_OMP_RUNTIME_DIR`, architecture UPD-06 to UPD-09):
 *
 *   active                    the active copy's id (one line, replaced atomically); absent: workers use the image's omp
 *   <version>-<time>/         one copy, `<time>` base-36 milliseconds
 *     app/                    the install tree while it is made: the image's `src/`, `package.json`, `bun.lock` and a
 *                             `bun install --omit=dev` with omp pinned to <version>; deleted once packed
 *     runtime.tar.gz          the packed copy (`RUNTIME_ENTRIES`), what workers download
 *     copy.json               `CopyManifest`; a directory without one is an unfinished install
 *     FAILED                  the copy failed its canary run (UPD-08): why
 *
 * Copies are deleted only once no `assigned` run may still download them (UPD-09).
 */

const ACTIVE = "active";
const APP_DIR = "app";
const ARCHIVE = "runtime.tar.gz";
const MANIFEST = "copy.json";
const FAILED = "FAILED";
/** Files of the image's app tree a copy starts from. */
const APP_FILES = ["src", "package.json", "bun.lock"] as const;
/** How often marked copies are looked at again while some are left (one query for the `assigned` runs). */
const SWEEP_MS = 5_000;

export interface CopyManifest {
	copy: string;
	version: string;
	/** App identity of the image the copy was made from (`/app/IDENTITY`). */
	identity: AppIdentity;
	/** Hex sha256 and size of `runtime.tar.gz`. */
	sha256: string;
	size: number;
	createdAt: string;
	/** Who approved it. */
	by: string;
}

/** Fills `dir` with an app tree whose `node_modules` has omp `version` and checks that the worker modules load. */
export type CopyInstaller = (p: { dir: string; version: string }) => Promise<{ output: string; error?: string }>;

/**
 * The real installer (UPD-06 steps 1 and 2): the image's app files, the omp packages pinned to `version`,
 * `bun install --omit=dev` (10 min), then the worker entry modules imported with the copy's omp (2 min).
 */
export function imageInstaller(opts: { imageAppDir: string; run?: RunCommand }): CopyInstaller {
	const run = opts.run ?? runCommand;
	return async ({ dir, version }) => {
		let output = "";
		// A bun cache inside the tree: same filesystem (hard links), and gone with the tree once it is packed.
		const env = { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, ".bun-cache") };
		const step = async (title: string, cmd: string[], timeoutMs: number): Promise<string | undefined> => {
			const result = await run(cmd, { cwd: dir, timeoutMs, env });
			output += `$ ${title}\n${result.output}\n`;
			return result.exitCode === 0 ? undefined : `${title} failed (exit ${result.exitCode})`;
		};
		try {
			for (const name of APP_FILES) cpSync(join(opts.imageAppDir, name), join(dir, name), { recursive: true });
			pinOmp(join(dir, "package.json"), version);
			// Not `--production`: in Bun 1.4 it implies --frozen-lockfile, which refuses the changed pins.
			const error =
				(await step("bun install --omit=dev", [process.execPath, "install", "--omit=dev"], INSTALL_TIMEOUT_MS)) ??
				(await step("smoke import of the worker modules", [process.execPath, "-e", WORKER_SMOKE_SCRIPT], SMOKE_TIMEOUT_MS));
			return error ? { output, error } : { output };
		} catch (err) {
			return { output, error: errorMessage(err) };
		}
	};
}

export type CreateResult = { ok: true; copy: CopyManifest; output: string } | { ok: false; error: string; output: string };

export interface OmpRuntimes {
	readonly dir: string;
	/** The active copy, unless it is marked failed. */
	active(): CopyManifest | undefined;
	/** UPD-06: installs, checks, packs and activates a copy of omp `version`. Never throws. */
	create(p: { version: string; by: string; installer: CopyInstaller }): Promise<CreateResult>;
	/** The copy a run is given (UPD-07), remembered so the copy is not deleted while the run may download it. */
	forRun(runId: string): OmpRuntimeSpec | undefined;
	/** The archive of the copy `forRun` gave the run; undefined when there is none (any more). */
	archive(runId: string): { stream: ReadableStream<Uint8Array>; size: number } | undefined;
	/** UPD-08: marks the copy failed, drops it as active and marks it for deletion; false when it already was or is gone. */
	markFailed(copy: string, reason: string): boolean;
	/** UPD-09 at start: copies of another identity and every copy except the active one are marked for deletion. */
	reconcile(): void;
	/** Deletes the marked copies no `assigned` run may still download. */
	sweep(): void;
	close(): void;
}

export interface OmpRuntimesOptions {
	dir: string;
	/** This orchestrator's app identity (`/app/IDENTITY` in the image). */
	identity: AppIdentity;
	/** Ids of the runs now `assigned` (claimed, not yet registered): they may still be downloading a copy. */
	assignedRuns(): string[];
}

export function openOmpRuntimes(opts: OmpRuntimesOptions): OmpRuntimes {
	const { dir, identity } = opts;
	mkdirSync(dir, { recursive: true });
	/** Copies waiting for deletion. */
	const marked = new Set<string>();
	/** Run id → the copy `forRun` gave it (null: none). Runs assigned before this process started are not here. */
	const given = new Map<string, string | null>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const copyDir = (copy: string) => join(dir, copy);

	function manifest(copy: string): CopyManifest | undefined {
		try {
			return JSON.parse(readFileSync(join(copyDir(copy), MANIFEST), "utf8")) as CopyManifest;
		} catch {
			return undefined;
		}
	}

	function activeId(): string | undefined {
		try {
			return readFileSync(join(dir, ACTIVE), "utf8").trim() || undefined;
		} catch {
			return undefined;
		}
	}

	function setActive(copy: string | undefined): void {
		if (!copy) {
			rmSync(join(dir, ACTIVE), { force: true });
			return;
		}
		const tmp = join(dir, `.${ACTIVE}-${process.pid}`);
		writeFileSync(tmp, `${copy}\n`);
		renameSync(tmp, join(dir, ACTIVE));
	}

	const failed = (copy: string) => existsSync(join(copyDir(copy), FAILED));

	function active(): CopyManifest | undefined {
		const copy = activeId();
		if (!copy || failed(copy)) return undefined;
		return manifest(copy);
	}

	/** Marks copies for deletion and deletes what can go now; the rest is retried every 5 s. */
	function mark(...copies: string[]): void {
		for (const copy of copies) marked.add(copy);
		timer ??= setInterval(sweep, SWEEP_MS);
		timer.unref?.();
		sweep();
	}

	function sweep(): void {
		const current = activeId();
		const assigned = opts.assignedRuns();
		const live = new Set(assigned);
		for (const runId of given.keys()) if (!live.has(runId)) given.delete(runId);
		for (const copy of marked) {
			if (copy === current) {
				marked.delete(copy);
				continue;
			}
			// A run assigned before this process started may have been given any copy.
			if (assigned.some(runId => !given.has(runId) || given.get(runId) === copy)) continue;
			try {
				rmSync(copyDir(copy), { recursive: true, force: true });
				marked.delete(copy);
				log("info", "omp runtime copy deleted", { copy });
			} catch (err) {
				log("warn", "deleting an omp runtime copy failed", { copy, error: errorMessage(err) });
			}
		}
		if (marked.size === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	async function create(p: { version: string; by: string; installer: CopyInstaller }): Promise<CreateResult> {
		const copy = `${p.version}-${Date.now().toString(36)}`;
		const appDir = join(copyDir(copy), APP_DIR);
		let output = "";
		try {
			mkdirSync(appDir, { recursive: true });
			const installed = await p.installer({ dir: appDir, version: p.version });
			output = installed.output;
			if (installed.error) throw new Error(installed.error);
			const version = installedOmpVersion(appDir);
			if (version !== p.version) throw new Error(`the installed ${OMP_PACKAGE} is ${version}, expected ${p.version}`);
			const packed = await packRuntime(appDir, join(copyDir(copy), ARCHIVE));
			const made: CopyManifest = { copy, version, identity, ...packed, createdAt: new Date().toISOString(), by: p.by };
			writeFileSync(join(copyDir(copy), MANIFEST), `${JSON.stringify(made)}\n`);
			rmSync(appDir, { recursive: true, force: true });
			const previous = activeId();
			setActive(copy);
			if (previous && previous !== copy) mark(previous);
			log("info", "omp runtime copy active", { copy, version, sizeBytes: made.size });
			return { ok: true, copy: made, output };
		} catch (err) {
			rmSync(copyDir(copy), { recursive: true, force: true });
			return { ok: false, error: errorMessage(err), output };
		}
	}

	return {
		dir,
		active,
		create,
		forRun(runId) {
			const copy = active();
			given.set(runId, copy?.copy ?? null);
			return copy ? { copy: copy.copy, version: copy.version, identity: copy.identity, sha256: copy.sha256, size: copy.size } : undefined;
		},
		archive(runId) {
			const copy = given.get(runId) ?? activeId();
			if (!copy || !manifest(copy)) return undefined;
			const file = Bun.file(join(copyDir(copy), ARCHIVE));
			return { stream: file.stream(), size: file.size };
		},
		markFailed(copy, reason) {
			if (!manifest(copy) || failed(copy)) return false;
			writeFileSync(join(copyDir(copy), FAILED), `${reason}\n`);
			if (activeId() === copy) setActive(undefined);
			mark(copy);
			return true;
		},
		reconcile() {
			const current = activeId();
			let keep: string | undefined;
			const stale: string[] = [];
			for (const name of readdirSync(dir)) {
				if (name === ACTIVE || name.startsWith(".")) continue;
				const made = manifest(name);
				const sameImage = made?.identity.version === identity.version && made.identity.hash === identity.hash;
				if (name === current && sameImage && !failed(name)) keep = name;
				else stale.push(name);
			}
			if (current && current !== keep) {
				setActive(undefined);
				log("info", "dropped the active omp runtime copy", { copy: current, reason: "made from another image, failed or incomplete" });
			}
			if (stale.length > 0) {
				log("info", "omp runtime copies marked for deletion", { copies: stale });
				mark(...stale);
			}
		},
		sweep,
		close() {
			clearInterval(timer);
			timer = undefined;
		},
	};
}
