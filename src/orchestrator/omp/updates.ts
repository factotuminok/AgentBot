import type { OmpAttempt, OmpUpdateView } from "../../shared/adminOmp";
import { errorMessage, log } from "../../shared/log";
import { OMP_PACKAGE, outputTail, SEMVER } from "../../shared/ompPins";
import type { AppIdentity } from "../../shared/version";
import type { OmpRuntimeSpec, WorkerControl } from "../../shared/wire";
import type { Db } from "../store/db";
import { type CopyInstaller, imageInstaller, type OmpRuntimes, openOmpRuntimes } from "./runtime";

/**
 * In-place omp updates for workers (requirements UPD-02 to UPD-05, architecture UPD-06 to UPD-10; ported from DevForge
 * `ompUpdate.ts`, which updated its own process and restarted). The orchestrator checks npm, and on an approval installs
 * the new omp as a packed runtime copy that new workers download (UPD-07); nothing restarts, and the orchestrator itself
 * keeps the image's omp (UPD-10). Check results, the last attempt and the Discord notice are kept in `kv`.
 */

export const REGISTRY_URL = `https://registry.npmjs.org/${OMP_PACKAGE}/latest`;
export const UNSUPPORTED = "omp updates run only in the container image (AGENTBOT_OMP_RUNTIME_DIR is not set)";

const KEY_LATEST = "omp.update.latest";
const KEY_CHECKED_AT = "omp.update.checkedAt";
const KEY_CHECK_ERROR = "omp.update.checkError";
const KEY_ATTEMPT = "omp.update.attempt";
const KEY_NOTICE = "omp.update.notice";

const CHECK_TIMEOUT_MS = 10_000;

/** The Discord notice (message with the Approve button) most recently posted. */
export interface OmpNotice {
	version: string;
	channelId: string;
	messageId: string;
	/** False once the message was closed (approved or superseded). */
	buttons: boolean;
}

export type InstallResult = { ok: true; copy: string } | { ok: false; error: string; log?: string; refused?: boolean };

/** What the worker dispatcher needs: the copy for a run's spec, its archive, and canary failures (UPD-07, UPD-08). */
export interface OmpRuntimeSource {
	forRun(runId: string): OmpRuntimeSpec | undefined;
	archive(runId: string): { stream: ReadableStream<Uint8Array>; size: number } | undefined;
	canaryFailed(report: Omit<Extract<WorkerControl, { t: "omp-runtime-failed" }>, "t">): void;
}

export interface OmpUpdater extends OmpRuntimeSource {
	status(): OmpUpdateView;
	/** npm's latest when it is newer than the omp new workers would use. */
	updateAvailable(): string | undefined;
	/** Asks the npm registry (10 s timeout); failures are stored as `checkError`. Never throws. */
	check(): Promise<OmpUpdateView>;
	/** Called after every check, install and canary failure. */
	subscribe(listener: () => void): () => void;
	/** UPD-09 cleanup, then a check after `checkDelayMs` and every `checkIntervalMs`. */
	start(): void;
	stop(): void;
	/** UPD-06 for `version`, approved by `by`. Claims the install synchronously, so a second call is refused (UPD-03). */
	install(version: string, by: string): Promise<InstallResult>;
	notice(): OmpNotice | undefined;
	setNotice(notice: OmpNotice | undefined): void;
	/** Marks the last attempt as posted in Discord. */
	markReported(): void;
}

export interface OmpUpdaterOptions {
	db: Pick<Db, "kvGet" | "kvSet" | "runsInState">;
	/** `AGENTBOT_OMP_RUNTIME_DIR`; undefined outside the container image, where updates are refused (UPD-05). */
	runtimeDir?: string;
	/** This orchestrator's app identity, recorded on every copy (`/app/IDENTITY`, architecture §7.1). */
	identity: AppIdentity;
	/** The image's omp version. */
	imageOmpVersion: string;
	/** Makes the copy's app tree; default `imageInstaller` over `imageAppDir`. */
	installer?: CopyInstaller;
	/** The image's app root, copied by the default installer. */
	imageAppDir: string;
	/** npm's `latest` document for omp; tests point it at a fake registry. */
	registryUrl?: string;
	/** UPD-02: first check 60 s after start, then every 6 h. */
	checkDelayMs?: number;
	checkIntervalMs?: number;
}

function parseJson<T>(text: string | undefined): T | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function createOmpUpdater(opts: OmpUpdaterOptions): OmpUpdater {
	const { db, imageOmpVersion: image } = opts;
	const registryUrl = opts.registryUrl ?? REGISTRY_URL;
	const installer = opts.installer ?? imageInstaller({ imageAppDir: opts.imageAppDir });
	const runtimes: OmpRuntimes | undefined = opts.runtimeDir
		? openOmpRuntimes({ dir: opts.runtimeDir, identity: opts.identity, assignedRuns: () => db.runsInState("assigned").map(row => row.id) })
		: undefined;
	const listeners = new Set<() => void>();
	let installing: OmpUpdateView["installing"];
	let firstCheck: ReturnType<typeof setTimeout> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const readAttempt = () => parseJson<OmpAttempt>(db.kvGet(KEY_ATTEMPT));
	const saveAttempt = (attempt: OmpAttempt) => db.kvSet(KEY_ATTEMPT, JSON.stringify(attempt));
	/** The omp new workers use: the active copy's, else the image's. */
	const workerVersion = () => runtimes?.active()?.version ?? image;

	// An install the orchestrator did not live to finish.
	const unfinished = readAttempt();
	if (unfinished?.outcome === "installing") {
		saveAttempt({ ...unfinished, outcome: "failed", error: "the orchestrator restarted during the install", at: new Date().toISOString(), reported: false });
	}

	function notify(): void {
		for (const listener of listeners) {
			try {
				listener();
			} catch (err) {
				log("warn", "omp update listener failed", { error: errorMessage(err) });
			}
		}
	}

	function latest(): string | undefined {
		const value = db.kvGet(KEY_LATEST);
		return value && SEMVER.test(value) ? value : undefined;
	}

	function updateAvailable(): string | undefined {
		const version = latest();
		const current = workerVersion();
		if (!version || !SEMVER.test(current)) return undefined;
		return Bun.semver.order(version, current) > 0 ? version : undefined;
	}

	function status(): OmpUpdateView {
		const active = runtimes?.active();
		const available = updateAvailable();
		return {
			image,
			...(active ? { active: { copy: active.copy, version: active.version, size: active.size, createdAt: active.createdAt, by: active.by } } : {}),
			latest: latest(),
			checkedAt: db.kvGet(KEY_CHECKED_AT) || undefined,
			checkError: db.kvGet(KEY_CHECK_ERROR) || undefined,
			...(available ? { available } : {}),
			supported: runtimes !== undefined,
			...(runtimes ? {} : { unsupportedReason: UNSUPPORTED }),
			...(installing ? { installing: { ...installing } } : {}),
			lastAttempt: readAttempt(),
		};
	}

	async function check(): Promise<OmpUpdateView> {
		try {
			const res = await fetch(registryUrl, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
			const body = (await res.json()) as { version?: unknown };
			if (typeof body.version !== "string" || !SEMVER.test(body.version)) throw new Error("the npm registry returned no valid version");
			db.kvSet(KEY_LATEST, body.version);
			db.kvSet(KEY_CHECKED_AT, new Date().toISOString());
			db.kvSet(KEY_CHECK_ERROR, "");
			log("info", "omp update check", { latest: body.version, workers: workerVersion(), image });
		} catch (err) {
			db.kvSet(KEY_CHECK_ERROR, errorMessage(err));
			log("warn", "omp update check failed", { error: errorMessage(err) });
		}
		notify();
		return status();
	}

	async function install(version: string, by: string): Promise<InstallResult> {
		const refuse = (error: string): InstallResult => ({ ok: false, error, refused: true });
		if (!runtimes) return refuse(UNSUPPORTED);
		if (installing) return refuse(`omp ${installing.version} is already being installed (approved by ${installing.by})`);
		if (version !== updateAvailable()) return refuse(`omp ${version} is no longer the update on offer`);
		const startedAt = new Date().toISOString();
		installing = { version, by, startedAt };
		const base: OmpAttempt = { version, from: workerVersion(), by, outcome: "installing", at: startedAt };
		saveAttempt(base);
		log("info", "omp update started", { version, from: base.from, by });
		notify();
		try {
			const result = await runtimes.create({ version, by, installer });
			const at = new Date().toISOString();
			if (result.ok) {
				saveAttempt({ ...base, outcome: "installed", copy: result.copy.copy, log: outputTail(result.output), at, reported: true });
				log("info", "omp update installed for workers", { version, copy: result.copy.copy, sizeBytes: result.copy.size });
				return { ok: true, copy: result.copy.copy };
			}
			const tail = outputTail(result.output);
			saveAttempt({ ...base, outcome: "failed", error: result.error, log: tail, at, reported: true });
			log("error", "omp update failed", { version, error: result.error });
			return { ok: false, error: result.error, log: tail };
		} finally {
			installing = undefined;
			notify();
		}
	}

	function canaryFailed(report: Omit<Extract<WorkerControl, { t: "omp-runtime-failed" }>, "t">): void {
		const how = report.signal ? `signal ${report.signal}` : `code ${report.exitCode}`;
		const error = `the agent host from omp ${report.version} exited with ${how} before it registered (run ${report.runId}); workers use the image's omp ${image} again`;
		// Several workers may hit a broken copy at once: the first report counts.
		if (!runtimes?.markFailed(report.copy, error)) return;
		const attempt = readAttempt();
		const base: OmpAttempt =
			attempt?.copy === report.copy ? attempt : { version: report.version, from: image, by: "unknown", outcome: "failed", copy: report.copy, at: "" };
		saveAttempt({ ...base, outcome: "failed", error, log: outputTail(report.output), at: new Date().toISOString(), reported: false });
		log("error", "omp runtime copy failed its canary run", { copy: report.copy, version: report.version, run: report.runId, exitCode: report.exitCode, signal: report.signal });
		notify();
	}

	return {
		status,
		updateAvailable,
		check,
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		start() {
			if (firstCheck || interval) return;
			runtimes?.reconcile();
			firstCheck = setTimeout(() => {
				void check();
				interval = setInterval(() => void check(), opts.checkIntervalMs ?? 6 * 3_600_000);
				interval.unref?.();
			}, opts.checkDelayMs ?? 60_000);
			firstCheck.unref?.();
		},
		stop() {
			clearTimeout(firstCheck);
			clearInterval(interval);
			firstCheck = interval = undefined;
			runtimes?.close();
		},
		install,
		forRun: runId => runtimes?.forRun(runId),
		archive: runId => runtimes?.archive(runId),
		canaryFailed,
		notice: () => parseJson<OmpNotice>(db.kvGet(KEY_NOTICE)),
		setNotice: notice => db.kvSet(KEY_NOTICE, notice ? JSON.stringify(notice) : ""),
		markReported() {
			const attempt = readAttempt();
			if (attempt) saveAttempt({ ...attempt, reported: true });
		},
	};
}
