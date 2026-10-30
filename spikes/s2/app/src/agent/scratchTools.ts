import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type CustomTool, zod } from "@oh-my-pi/pi-coding-agent";
import { convertFileWithMarkit } from "@oh-my-pi/pi-coding-agent/utils/markit";
import { UPLOAD_LIMIT_BYTES } from "../engine/scratch";

/**
 * File tools of ask-only chats (`ask` profile). omp's own `read`, `grep`, `glob`, `bash` and `write` are not
 * confined to a directory, so a public chat gets these instead: every path is resolved against the thread's scratch
 * directory and anything that leaves it (absolute paths, `..`, symlinks, internal URLs) is refused.
 */

/** Longest text `read_file` returns in one call. */
export const READ_MAX_BYTES = 256 * 1024;
const READ_DEFAULT_LINES = 2000;
const LIST_MAX_ENTRIES = 500;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Document formats omp's markit converts to Markdown. */
const CONVERTIBLE: Record<string, true> = { ".pdf": true, ".docx": true, ".pptx": true, ".xlsx": true, ".epub": true };
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Nearest ancestor of `path` (or `path` itself) that exists, resolved through symlinks. */
async function realExisting(path: string): Promise<string> {
	let current = path;
	for (;;) {
		try {
			return await realpath(current);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			const parent = dirname(current);
			if (parent === current) throw err;
			current = parent;
		}
	}
}

/**
 * Absolute path of `rel` inside `root`. Throws for absolute paths, internal URLs, `..` escapes, a path whose existing
 * part resolves outside `root` through a symlink, and a symlink at the target itself.
 */
export async function resolveInside(root: string, rel: string): Promise<string> {
	if (rel.includes("\0")) throw new Error("Invalid path");
	if (URL_SCHEME.test(rel)) throw new Error(`Only files in your workspace are available, not ${rel}`);
	if (isAbsolute(rel) || rel.startsWith("~")) throw new Error("Use a path relative to your workspace, such as inputs/data.csv");
	const abs = resolve(root, rel);
	if (!isInside(resolve(root), abs)) throw new Error("The path is outside your workspace");
	const realRoot = await realpath(root);
	if (!isInside(realRoot, await realExisting(abs))) throw new Error("The path is outside your workspace");
	try {
		if ((await lstat(abs)).isSymbolicLink()) throw new Error("Symbolic links are not available");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return abs;
}

/** A page of `text`: lines from `offset` (1-based), at most `limit` lines and `maxBytes` bytes, with a note on how to continue. */
export function pageText(text: string, offset: number, limit: number, maxBytes: number): string {
	const lines = text.split("\n");
	const start = Math.max(1, offset);
	if (start > lines.length) return `[The file has ${lines.length} lines; offset ${start} is past the end]`;
	const out: string[] = [];
	let bytes = 0;
	let end = start - 1;
	for (let n = start; n <= lines.length && n < start + limit; n++) {
		const line = lines[n - 1]!;
		const size = Buffer.byteLength(line) + 1;
		if (out.length > 0 && bytes + size > maxBytes) break;
		out.push(size > maxBytes ? line.slice(0, maxBytes) : line);
		bytes += size;
		end = n;
	}
	const body = out.join("\n");
	return end < lines.length ? `${body}\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : body;
}

const listParams = zod.object({
	path: zod.string().optional().describe("Directory to list, relative to your workspace. Default: the whole workspace."),
});

const readParams = zod.object({
	path: zod.string().describe("File to read, relative to your workspace, e.g. inputs/data.csv."),
	offset: zod.number().int().min(1).optional().describe("First line to read (1-based) for text files."),
	limit: zod.number().int().min(1).max(10_000).optional().describe(`Number of lines to read (default ${READ_DEFAULT_LINES}).`),
});

const writeParams = zod.object({
	path: zod.string().describe("File to create or overwrite, relative to your workspace. Files under outputs/ are sent to the user."),
	content: zod.string().describe("The complete text content of the file."),
});

function listFilesTool(root: string): CustomTool<typeof listParams> {
	return {
		name: "list_files",
		label: "List Files",
		description: "List the files in your workspace (recursively) with their sizes. The user's attached files are in inputs/; files you write to outputs/ are sent back to the user.",
		parameters: listParams,
		approval: "read",
		loadMode: "essential",
		async execute(_id, params) {
			const dir = await resolveInside(root, params.path ?? ".");
			const lines: string[] = [];
			let truncated = false;
			async function walk(current: string): Promise<void> {
				for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
					if (lines.length >= LIST_MAX_ENTRIES) {
						truncated = true;
						return;
					}
					const path = join(current, entry.name);
					const rel = relative(root, path).split(sep).join("/");
					if (entry.isDirectory()) {
						lines.push(`${rel}/`);
						await walk(path);
					} else if (entry.isFile()) {
						lines.push(`${rel} (${(await lstat(path)).size} bytes)`);
					}
				}
			}
			await walk(dir);
			if (truncated) lines.push(`[Listing stopped after ${LIST_MAX_ENTRIES} entries]`);
			return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }], details: { entries: lines.length } };
		},
	};
}

function readFileTool(root: string): CustomTool<typeof readParams> {
	return {
		name: "read_file",
		label: "Read File",
		description: `Read a file from your workspace. Text files are returned in pages of up to ${READ_DEFAULT_LINES} lines (use offset and limit to continue); PDF, DOCX, PPTX, XLSX and EPUB files are converted to Markdown; PNG, JPEG, GIF and WebP images are shown to you.`,
		parameters: readParams,
		approval: "read",
		loadMode: "essential",
		async execute(_id, params, _onUpdate, _ctx, signal) {
			const abs = await resolveInside(root, params.path);
			const stat = await lstat(abs).catch(() => undefined);
			if (!stat) throw new Error(`No such file: ${params.path}`);
			if (!stat.isFile()) throw new Error(`${params.path} is not a file; use list_files`);
			const ext = extname(abs).toLowerCase();
			const mimeType = IMAGE_TYPES[ext];
			if (mimeType) {
				if (stat.size > IMAGE_MAX_BYTES) throw new Error(`${params.path} is too large to view (over ${IMAGE_MAX_BYTES / 1024 / 1024} MiB)`);
				const data = (await readFile(abs)).toString("base64");
				return { content: [{ type: "text", text: `Image ${params.path}` }, { type: "image", data, mimeType }], details: { bytes: stat.size } };
			}
			let text: string;
			if (CONVERTIBLE[ext]) {
				const converted = await convertFileWithMarkit(abs, signal);
				if (!converted.ok) throw new Error(`Could not convert ${params.path}: ${converted.error ?? "conversion failed"}`);
				text = converted.content;
			} else {
				const bytes = await readFile(abs);
				if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${params.path} is a binary file that cannot be read as text`);
				text = bytes.toString("utf8");
			}
			return { content: [{ type: "text", text: pageText(text, params.offset ?? 1, params.limit ?? READ_DEFAULT_LINES, READ_MAX_BYTES) }], details: { bytes: stat.size } };
		},
	};
}

function writeFileTool(root: string): CustomTool<typeof writeParams> {
	return {
		name: "write_file",
		label: "Write File",
		description: `Create or overwrite a text file in your workspace (at most ${UPLOAD_LIMIT_BYTES / 1024 / 1024} MiB). Write to outputs/ the files the user asked for besides your answer, such as CSV, JSON, HTML, SVG or a script; every file you create or change there is attached to the thread. Binary formats such as PDF, images or Office files cannot be written.`,
		parameters: writeParams,
		approval: "write",
		loadMode: "essential",
		async execute(_id, params) {
			const size = Buffer.byteLength(params.content);
			if (size > UPLOAD_LIMIT_BYTES) throw new Error(`Content is ${size} bytes; the limit is ${UPLOAD_LIMIT_BYTES} bytes`);
			const abs = await resolveInside(root, params.path);
			if (abs === resolve(root)) throw new Error("Give a file path");
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, params.content);
			return { content: [{ type: "text", text: `Wrote ${size} bytes to ${params.path}` }], details: { bytes: size } };
		},
	};
}

/** `list_files`, `read_file` and `write_file`, confined to `root`. */
export function createScratchTools(root: string): CustomTool[] {
	return [listFilesTool(root), readFileTool(root), writeFileTool(root)];
}
