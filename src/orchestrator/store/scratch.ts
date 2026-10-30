import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage, log } from "../../shared/log";

/**
 * Per-thread scratch directories of `/ask` chats (`<state>/scratch/<threadId>/{inputs,outputs}`, CHAT-07): the files users
 * attach go to `inputs/`, files the agent produces for the user come back into `outputs/`. Pure filesystem helpers,
 * ported from DevForge `src/engine/scratch.ts`.
 */

/** Largest input attachment downloaded (CHAT-08); Discord allows more on boosted servers and for Nitro users. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
/** Most attachments saved from one `/ask` command (CHAT-08). */
export const MAX_COMMAND_FILES = 3;
/** Most attachments saved from one thread message (CHAT-08); Discord allows 10 per message. */
export const MAX_INPUT_FILES = 10;
/** Largest upload to a thread, per file and per message (CHAT-10): the floor of Discord's limit for unboosted servers. */
export const UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

const NAME_MAX = 100;
const EXTENSION_MAX = 20;

export interface ScratchPaths {
	root: string;
	inputs: string;
	outputs: string;
}

export function scratchPaths(scratchRoot: string, threadId: string): ScratchPaths {
	const root = join(scratchRoot, threadId);
	return { root, inputs: join(root, "inputs"), outputs: join(root, "outputs") };
}

/** Creates the thread's scratch directory with its `inputs` and `outputs`; safe to call again. */
export async function ensureScratchDirs(scratchRoot: string, threadId: string): Promise<ScratchPaths> {
	const paths = scratchPaths(scratchRoot, threadId);
	await mkdir(paths.inputs, { recursive: true });
	await mkdir(paths.outputs, { recursive: true });
	return paths;
}

/** CHAT-09: a file name that is safe to create inside a directory: no path parts, no control characters, no leading dot. */
export function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	let clean = base
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replaceAll("..", "_")
		.replace(/[^A-Za-z0-9._ -]/g, "_")
		.trim()
		.replace(/^[.\s]+/, "");
	if (clean.length > NAME_MAX) {
		const ext = extname(clean);
		const keep = ext.length > 0 && ext.length <= EXTENSION_MAX ? ext : "";
		clean = clean.slice(0, NAME_MAX - keep.length) + keep;
	}
	return clean || "file";
}

export interface InputAttachment {
	name: string;
	url: string;
	/** Size Discord reports; checked before downloading. */
	size: number;
}

export interface SavedAttachments {
	/** Paths relative to the scratch root, e.g. `inputs/data.csv`. */
	saved: string[];
	skipped: { name: string; reason: string }[];
}

export interface SaveOptions {
	fetch: (url: string) => Promise<Response>;
	maxBytes: number;
	maxFiles: number;
}

export function sizeText(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MiB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
	return `${bytes} bytes`;
}

/** Downloads `url` into memory, giving up as soon as more than `maxBytes` arrived. Returns the reason on failure. */
async function download(url: string, fetchFn: SaveOptions["fetch"], maxBytes: number): Promise<Uint8Array | string> {
	const res = await fetchFn(url);
	if (!res.ok) return `download failed (HTTP ${res.status})`;
	if (!res.body) {
		const bytes = new Uint8Array(await res.arrayBuffer());
		return bytes.byteLength > maxBytes ? `larger than ${sizeText(maxBytes)}` : bytes;
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = res.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				return `larger than ${sizeText(maxBytes)}`;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

/** Writes `bytes` to a new file named after `name` in `dir`, adding `-1`, `-2`, … on a collision. Returns the file name used. */
async function writeUnique(dir: string, name: string, bytes: Uint8Array): Promise<string> {
	const ext = extname(name);
	const stem = name.slice(0, name.length - ext.length);
	for (let n = 0; ; n++) {
		const candidate = n === 0 ? name : `${stem}-${n}${ext}`;
		try {
			await writeFile(join(dir, candidate), bytes, { flag: "wx" });
			return candidate;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}
}

/**
 * Saves Discord attachments into `<root>/inputs` (CHAT-08). A file that is too big, over the count limit or cannot be
 * downloaded is reported in `skipped` and the others still go through.
 */
export async function saveAttachments(root: string, items: InputAttachment[], opts: SaveOptions): Promise<SavedAttachments> {
	const saved: string[] = [];
	const skipped: SavedAttachments["skipped"] = [];
	const inputs = join(root, "inputs");
	await mkdir(inputs, { recursive: true });
	for (const [i, item] of items.entries()) {
		if (i >= opts.maxFiles) {
			skipped.push({ name: item.name, reason: `more than ${opts.maxFiles} files at once` });
			continue;
		}
		if (item.size > opts.maxBytes) {
			skipped.push({ name: item.name, reason: `larger than ${sizeText(opts.maxBytes)}` });
			continue;
		}
		try {
			const bytes = await download(item.url, opts.fetch, opts.maxBytes);
			if (typeof bytes === "string") {
				skipped.push({ name: item.name, reason: bytes });
				continue;
			}
			saved.push(`inputs/${await writeUnique(inputs, safeFileName(item.name), bytes)}`);
		} catch (err) {
			log("warn", "attachment download failed", { name: item.name, error: errorMessage(err) });
			skipped.push({ name: item.name, reason: "download failed" });
		}
	}
	return { saved, skipped };
}

export type FileSnapshot = Map<string, { size: number; mtimeMs: number }>;

/** Regular files under `dir` (recursive; symlinks and other entries are skipped), keyed by path relative to `dir`. */
export async function snapshotFiles(dir: string): Promise<FileSnapshot> {
	const out: FileSnapshot = new Map();
	async function walk(current: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) {
				const stat = await lstat(path);
				out.set(relative(dir, path).split(sep).join("/"), { size: stat.size, mtimeMs: stat.mtimeMs });
			}
		}
	}
	await walk(dir);
	return out;
}

export interface ProducedFile {
	/** Upload name: the path relative to the directory, with `/` replaced by `_`. */
	name: string;
	path: string;
	size: number;
}

/** CHAT-10: files in `dir` that are new or modified since `before` was taken, by name. */
export async function changedFiles(dir: string, before: FileSnapshot): Promise<ProducedFile[]> {
	const after = await snapshotFiles(dir);
	const out: ProducedFile[] = [];
	for (const [rel, stat] of after) {
		const old = before.get(rel);
		if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) continue;
		out.push({ name: rel.replaceAll("/", "_"), path: join(dir, rel), size: stat.size });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The regular files `names` (paths relative to `dir`, as the dispatcher reports them in `RunResult.outputs`) that exist
 * inside `dir`; symlinks, other entries, missing files and names escaping `dir` are skipped.
 */
export async function listedFiles(dir: string, names: readonly string[]): Promise<ProducedFile[]> {
	const out: ProducedFile[] = [];
	for (const rel of new Set(names)) {
		const path = resolve(dir, rel);
		if (!insideRoot(dir, path)) continue;
		const stat = await lstat(path).catch(() => undefined);
		if (!stat?.isFile()) continue;
		out.push({ name: relative(resolve(dir), path).split(sep).join("_"), path, size: stat.size });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

function insideRoot(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return !(rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** CHAT-11: deletes `path` recursively, but only when it is strictly inside `root`. Returns whether it deleted. */
export async function removeScratch(root: string, path: string): Promise<boolean> {
	if (!insideRoot(root, path)) {
		log("warn", "scratch path outside scratch dir skipped", { root, path });
		return false;
	}
	await rm(path, { recursive: true, force: true });
	return true;
}
