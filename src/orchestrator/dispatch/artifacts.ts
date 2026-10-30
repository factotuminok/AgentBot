import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, log } from "../../shared/log";
import { ARTIFACTS } from "../../shared/wire";
import type { Db, RunRow } from "../store/db";
import { sessionPath } from "../store/sessions";
import { holdsLease } from "./leases";
import { sessionDir } from "./spec";

/**
 * Run artifact endpoints, `/internal/runs/<runId>/…` (architecture §4.5): the session file, the skills bundle and the ask
 * scratch files. Each request needs that run's live lease token (`Authorization: Bearer <lease>`, SEC-14); a lease token
 * opens nothing but its own run.
 */

export const RUNS_PREFIX = "/internal/runs/";
/** CHAT-10: the largest scratch output accepted per file, and per run in total. */
export const MAX_SCRATCH_OUTPUT_BYTES = 25 * 1024 * 1024;
export const MAX_SCRATCH_OUTPUTS_PER_RUN = 100 * 1024 * 1024;

export interface ArtifactDeps {
	db: Db;
	stateDir: string;
	/** The skills and agents tar and its content hash (AGT-24). */
	skills(): Promise<{ hash: string; tar: Uint8Array }>;
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

/** Streams `body` into `path` through a temporary file in the same directory; false when it exceeded `limit` bytes. */
async function writeAtomically(path: string, dir: string, body: ReadableStream<Uint8Array> | null, limit: number): Promise<boolean> {
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.upload-${crypto.randomUUID()}.tmp`);
	const writer = Bun.file(tmp).writer();
	let size = 0;
	try {
		if (body) {
			for await (const chunk of body) {
				size += chunk.byteLength;
				if (size > limit) {
					await writer.end();
					await rm(tmp, { force: true });
					return false;
				}
				writer.write(chunk);
			}
		}
		await writer.end();
		await rename(tmp, path);
		return true;
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
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

	async function putOutput(req: Request, row: RunRow, name: string): Promise<Response> {
		if (!row.scratch_dir) return text(404, "this run has no scratch directory");
		const dir = join(row.scratch_dir, "outputs");
		const used = outputBytes.get(row.id) ?? 0;
		const limit = Math.min(MAX_SCRATCH_OUTPUT_BYTES, MAX_SCRATCH_OUTPUTS_PER_RUN - used);
		const declared = Number(req.headers.get("content-length") ?? "0");
		if (declared > limit) return text(413, "output too large");
		// Written next to the target first, so an identical re-upload leaves the file (and its mtime) alone.
		const staged = join(dir, `.staged-${crypto.randomUUID()}`);
		if (!(await writeAtomically(staged, dir, req.body, limit))) return text(413, "output too large");
		const target = join(dir, name);
		const size = Bun.file(staged).size;
		const existing = await lstat(target).catch(() => undefined);
		if (existing && !existing.isFile()) {
			await rm(staged, { force: true });
			return text(409, "an output with that name is not a regular file");
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
				if (!row.session_key) return text(404, "this run has no session");
				const path = sessionPath(sessionDir(deps.stateDir), row.session_key);
				if (req.method === "GET") return existsSync(path) ? new Response(Bun.file(path)) : text(404, "no session yet");
				if (req.method === "PUT") {
					await writeAtomically(path, sessionDir(deps.stateDir), req.body, Number.POSITIVE_INFINITY);
					return new Response(null, { status: 204 });
				}
			} else if (artifact.length === 1 && artifact[0] === ARTIFACTS.skills) {
				if (req.method === "GET") {
					const bundle = await deps.skills();
					const body = bundle.tar as Uint8Array<ArrayBuffer>;
					return new Response(body, { headers: { "content-type": "application/x-tar", etag: `"${bundle.hash}"` } });
				}
			} else if (artifact.length === 3 && artifact[0] === "scratch") {
				const name = artifact[2]!;
				if (!isPlainFileName(name)) return text(400, "invalid file name");
				if (artifact[1] === "inputs" && req.method === "GET") return await getInput(row, name);
				if (artifact[1] === "outputs" && req.method === "PUT") return await putOutput(req, row, name);
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
