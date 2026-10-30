import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, log } from "../../shared/log";
import { ARTIFACTS } from "../../shared/wire";
import { BundleRejected, type RefKind, type Repos } from "../git/repos";
import type { OmpRuntimeSource } from "../omp/updates";
import type { Db, RunRow } from "../store/db";
import { sessionPath } from "../store/sessions";
import type { RunRefs } from "./checkouts";
import { writesCode } from "./dispatcher";
import { holdsLease } from "./leases";
import { sessionDir } from "./spec";

/**
 * Run artifact endpoints, `/internal/runs/<runId>/…` (architecture §4.5): the session file, the skills bundle, the omp
 * runtime copy, the ask scratch files, and the checkout bundles (a checkpoint to restore, uploaded checkpoints and the
 * result). Each request needs that run's live lease token (`Authorization: Bearer <lease>`, SEC-14); a lease token opens
 * nothing but its own run.
 */

export const RUNS_PREFIX = "/internal/runs/";
/** CHAT-10: the largest scratch output accepted per file, and per run in total. */
export const MAX_SCRATCH_OUTPUT_BYTES = 25 * 1024 * 1024;
export const MAX_SCRATCH_OUTPUTS_PER_RUN = 100 * 1024 * 1024;
/** The largest checkpoint or result bundle accepted (RUN-18, RUN-19); the internal API's request body limit follows it. */
export const MAX_BUNDLE_BYTES = 2 * 1024 ** 3;
/** The largest session file accepted (RUN-18). */
export const MAX_SESSION_BYTES = 256 * 1024 ** 2;
/** Uploads are refused while the state volume has less free space than this, so SQLite keeps room to write. */
export const STATE_FREE_FLOOR_BYTES = 1024 ** 3;
/** How often (in bytes received) an upload checks the free space again. */
const SPACE_CHECK_BYTES = 64 * 1024 ** 2;

export interface ArtifactDeps {
	db: Db;
	stateDir: string;
	/** The skills and agents tar and its content hash (AGT-24). */
	skills(): Promise<{ hash: string; tar: Uint8Array }>;
	repos: Repos;
	refs: RunRefs;
	/** The omp runtime copy archives (UPD-07); none outside the image. */
	ompRuntime?: Pick<OmpRuntimeSource, "archive">;
	/** The largest checkpoint or result bundle: `MAX_BUNDLE_BYTES`, or the worker's checkout limit when smaller (STO-06). */
	bundleLimitBytes: number;
	/** Free space the state volume must keep: uploads that would go below it are refused with 507. */
	freeFloorBytes: number;
}

/** A plain file name: no directory parts, control characters or leading dot (the worker sanitised it, CHAT-09). */
export function isPlainFileName(name: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	return name.length > 0 && name.length <= 255 && !name.startsWith(".") && !/[/\\\u0000-\u001f\u007f]/.test(name);
}

/** Names of regular files in `<scratchDir>/outputs` written since the run was created: its new or changed outputs (CHAT-10). */
export async function changedOutputs(row: RunRow): Promise<string[]> {
	if (!row.scratch_dir) return [];
	const dir = join(row.scratch_dir, "outputs");
	const since = Date.parse(row.created_at);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const changed: string[] = [];
	for (const name of names.sort()) {
		if (!isPlainFileName(name)) continue;
		const stat = await lstat(join(dir, name)).catch(() => undefined);
		if (stat?.isFile() && stat.mtimeMs >= since) changed.push(name);
	}
	return changed;
}

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });

/**
 * Streams `body` into a new temporary file in `dir` and returns its path, or the refusal: 413 past `limit` bytes, 507
 * while the volume's free space is below `floorBytes` (checked first and every `SPACE_CHECK_BYTES`). The caller renames
 * or removes the file.
 */
async function receive(dir: string, body: ReadableStream<Uint8Array> | null, limit: number, floorBytes: number): Promise<string | Response> {
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.upload-${crypto.randomUUID()}.tmp`);
	const roomLeft = async () => {
		const fs = await statfs(dir);
		return fs.bavail * fs.bsize >= floorBytes;
	};
	const noSpace = text(507, "the orchestrator's state volume is nearly full");
	const writer = Bun.file(tmp).writer();
	let refusal: Response | undefined;
	try {
		if (!(await roomLeft())) refusal = noSpace;
		else if (body) {
			let size = 0;
			let checkedAt = 0;
			for await (const chunk of body) {
				size += chunk.byteLength;
				if (size > limit) {
					refusal = text(413, "upload too large");
					break;
				}
				if (size - checkedAt >= SPACE_CHECK_BYTES) {
					checkedAt = size;
					if (!(await roomLeft())) {
						refusal = noSpace;
						break;
					}
				}
				writer.write(chunk);
			}
		}
		await writer.end();
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
	if (!refusal) return tmp;
	await rm(tmp, { force: true });
	return refusal;
}

/** True when `path` holds exactly the bytes of `candidate`. */
async function sameContent(path: string, candidate: string): Promise<boolean> {
	if (!existsSync(path)) return false;
	const [a, b] = [Bun.file(path), Bun.file(candidate)];
	if (a.size !== b.size) return false;
	return Buffer.from(await a.arrayBuffer()).equals(Buffer.from(await b.arrayBuffer()));
}

export interface ArtifactHandler {
	handle(req: Request): Promise<Response>;
	/** Forgets the run's upload accounting once it finished. */
	release(runId: string): void;
}

export function createArtifactHandler(deps: ArtifactDeps): ArtifactHandler {
	/** Bytes of scratch outputs accepted per run (CHAT-10 limit). */
	const outputBytes = new Map<string, number>();
	/** `<run>/<artifact>` uploads in progress: one at a time each, so a lease can't fill the state volume in parallel. */
	const uploading = new Set<string>();

	async function oneAtATime(key: string, upload: () => Promise<Response>): Promise<Response> {
		if (uploading.has(key)) {
			return new Response("another upload of this artifact is in progress", { status: 503, headers: { "content-type": "text/plain", "retry-after": "1" } });
		}
		uploading.add(key);
		try {
			return await upload();
		} finally {
			uploading.delete(key);
		}
	}

	/** The upload may have outlived the run (finished, or its lease expired): nothing may be kept for it then. */
	const stillHeld = (row: RunRow, token: string) => holdsLease(deps.db.getRun(row.id), undefined, token);

	async function putSession(req: Request, row: RunRow, sessionKey: string, token: string): Promise<Response> {
		const dir = sessionDir(deps.stateDir);
		const received = await receive(dir, req.body, MAX_SESSION_BYTES, deps.freeFloorBytes);
		if (received instanceof Response) return received;
		if (!stillHeld(row, token)) {
			await rm(received, { force: true });
			return text(401, "unauthorized");
		}
		await rename(received, sessionPath(dir, sessionKey));
		return new Response(null, { status: 204 });
	}

	async function putOutput(req: Request, row: RunRow, name: string, token: string): Promise<Response> {
		if (!row.scratch_dir) return text(404, "this run has no scratch directory");
		const dir = join(row.scratch_dir, "outputs");
		const used = outputBytes.get(row.id) ?? 0;
		const limit = Math.min(MAX_SCRATCH_OUTPUT_BYTES, MAX_SCRATCH_OUTPUTS_PER_RUN - used);
		const declared = Number(req.headers.get("content-length") ?? "0");
		if (declared > limit) return text(413, "output too large");
		// Written next to the target first, so an identical re-upload leaves the file (and its mtime) alone.
		const staged = await receive(dir, req.body, limit, deps.freeFloorBytes);
		if (staged instanceof Response) return staged;
		const target = join(dir, name);
		const size = Bun.file(staged).size;
		const existing = await lstat(target).catch(() => undefined);
		if (existing && !existing.isFile()) {
			await rm(staged, { force: true });
			return text(409, "an output with that name is not a regular file");
		}
		if (!stillHeld(row, token)) {
			await rm(staged, { force: true });
			return text(401, "unauthorized");
		}
		if (await sameContent(target, staged)) await rm(staged, { force: true });
		else await rename(staged, target);
		outputBytes.set(row.id, used + size);
		return new Response(null, { status: 204 });
	}

	async function getInput(row: RunRow, name: string): Promise<Response> {
		if (!row.scratch_dir) return text(404, "this run has no scratch directory");
		const path = join(row.scratch_dir, "inputs", name);
		const stat = await lstat(path).catch(() => undefined);
		if (!stat?.isFile()) return text(404, "no such input");
		return new Response(Bun.file(path));
	}

	/** RUN-17: the continued run's kept checkpoint, else its unpushed result, as a bundle over this run's start commit. */
	async function getRestore(row: RunRow): Promise<Response> {
		const previous = row.continues_run_id ? deps.db.getRun(row.continues_run_id) : null;
		const kind = previous ? deps.refs.restoreKind(previous) : undefined;
		if (!previous?.repo || !kind || !row.start_commit) return text(404, "nothing to restore");
		const stream = await deps.repos.bundleStream(previous.repo, previous.id, kind, row.start_commit);
		if (!stream) return text(404, "nothing to restore");
		log("info", "restore bundle served", { run: row.id, from: previous.id, ref: kind });
		return new Response(stream, { headers: { "content-type": "application/x-git-bundle" } });
	}

	/** RUN-18, RUN-19: imports an uploaded checkpoint or result into the runs repo (forced; the ref is the run's own). */
	async function putBundle(req: Request, row: RunRow, token: string, kind: RefKind): Promise<Response> {
		if (!row.repo || !row.start_commit) return text(404, "this run has no checkout");
		if (!writesCode(row.kind)) return text(403, "read-only runs keep no checkpoint or result");
		const file = await receive(join(deps.stateDir, "tmp"), req.body, deps.bundleLimitBytes, deps.freeFloorBytes);
		if (file instanceof Response) return file;
		try {
			if (!stillHeld(row, token)) return text(401, "unauthorized");
			const { commits } = await deps.repos.importBundle(row.repo, row.id, kind, file, row.start_commit);
			deps.refs.kept(row.id, kind);
			log("info", `${kind} imported`, { run: row.id, repo: row.repo, commits });
			return Response.json({ commits });
		} catch (err) {
			if (!(err instanceof BundleRejected)) throw err;
			log("warn", `${kind} bundle rejected`, { run: row.id, repo: row.repo, error: err.message });
			return text(422, err.message);
		} finally {
			await rm(file, { force: true });
		}
	}

	async function handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const [rawId, ...rest] = url.pathname.slice(RUNS_PREFIX.length).split("/");
		const runId = decodeURIComponent(rawId ?? "");
		const auth = req.headers.get("authorization") ?? "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
		const row = runId ? deps.db.getRun(runId) : null;
		if (!token || !holdsLease(row, undefined, token)) return text(401, "unauthorized");
		const artifact = rest.map(decodeURIComponent);
		try {
			if (artifact.length === 1 && artifact[0] === ARTIFACTS.session) {
				const key = row.session_key;
				if (!key) return text(404, "this run has no session");
				const path = sessionPath(sessionDir(deps.stateDir), key);
				if (req.method === "GET") return existsSync(path) ? new Response(Bun.file(path)) : text(404, "no session yet");
				if (req.method === "PUT") return await oneAtATime(`${row.id}/session`, () => putSession(req, row, key, token));
			} else if (artifact.length === 1 && artifact[0] === ARTIFACTS.ompRuntime) {
				if (req.method === "GET") {
					const archive = deps.ompRuntime?.archive(row.id);
					if (!archive) return text(404, "no omp runtime copy");
					log("info", "omp runtime copy served", { run: row.id, sizeBytes: archive.size });
					return new Response(archive.stream, { headers: { "content-type": "application/gzip", "content-length": String(archive.size) } });
				}
			} else if (artifact.length === 1 && artifact[0] === ARTIFACTS.skills) {
				if (req.method === "GET") {
					const bundle = await deps.skills();
					const body = bundle.tar as Uint8Array<ArrayBuffer>;
					return new Response(body, { headers: { "content-type": "application/x-tar", etag: `"${bundle.hash}"` } });
				}
			} else if (artifact.length === 1 && artifact[0] === ARTIFACTS.checkpoint) {
				if (req.method === "GET") return await getRestore(row);
				if (req.method === "PUT") return await oneAtATime(`${row.id}/checkpoint`, () => putBundle(req, row, token, "checkpoint"));
			} else if (artifact.length === 1 && artifact[0] === ARTIFACTS.result) {
				if (req.method === "PUT") return await oneAtATime(`${row.id}/result`, () => putBundle(req, row, token, "result"));
			} else if (artifact.length === 3 && artifact[0] === "scratch") {
				const name = artifact[2]!;
				if (!isPlainFileName(name)) return text(400, "invalid file name");
				if (artifact[1] === "inputs" && req.method === "GET") return await getInput(row, name);
				if (artifact[1] === "outputs" && req.method === "PUT") return await oneAtATime(`${row.id}/outputs`, () => putOutput(req, row, name, token));
			} else {
				return text(404, "not found");
			}
			return text(405, "method not allowed");
		} catch (err) {
			log("error", "run artifact request failed", { run: row.id, path: url.pathname, method: req.method, error: errorMessage(err) });
			return text(500, "artifact request failed");
		}
	}

	return { handle, release: runId => void outputBytes.delete(runId) };
}
