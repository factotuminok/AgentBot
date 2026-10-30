import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { errorMessage } from "../../shared/log";

/**
 * The admin's skills (`skills/<name>/SKILL.md`) and task agents (`agents/<name>.md`) in the orchestrator, at
 * `AGENTBOT_OMP_DIR` (`env.ompDir`, default `<state>/omp`). Workers download them as one bundle (`skillsBundle`)
 * and load the copy as the session's only extension root (AGT-24).
 */
export async function ensureOmpAssetsDir(dir: string): Promise<void> {
	await mkdir(join(dir, "skills"), { recursive: true });
	await mkdir(join(dir, "agents"), { recursive: true });
	// Leftovers of an interrupted zip upload (`saveSkillZip`).
	for (const entry of await readdirOrEmpty(dir)) {
		if (STAGING_RE.test(entry.name)) await rm(join(dir, entry.name), { recursive: true, force: true });
	}
}

export type OmpAssetKind = "skill" | "agent";

/** An upload the user must fix; its message is shown on the page. `line` (1-based) locates it in a Markdown file. */
export class OmpAssetError extends Error {
	override name = "OmpAssetError";
	constructor(
		message: string,
		readonly line?: number,
	) {
		super(message);
	}
}

export interface OmpAssetEntry {
	name: string;
	description?: string;
	/** Why omp would skip or misread this entry. */
	problem?: string;
}

export const MAX_ASSET_BYTES = 256 * 1024;

/** Skill and agent names; also the path-traversal guard for every path built from a name. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** omp's `parseAgentFields` drops agents with these names. */
const RESERVED_AGENT_NAMES = ["main", "sub"];
const MISSING_FIELDS = 'Missing "name" or "description" in frontmatter.';

/** Only call with a name that passed `NAME_RE`. */
function assetPath(dir: string, kind: OmpAssetKind, name: string): string {
	return kind === "skill" ? join(dir, "skills", name, "SKILL.md") : join(dir, "agents", `${name}.md`);
}

/** The 1-based line of `key:` in the frontmatter of `content`; 1 (the opening `---`) when it is not there. */
function frontmatterLine(content: string, key: string): number {
	const lines = content.split(/\r\n?|\n/);
	for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
		if (lines[i]!.startsWith(`${key}:`)) return i + 1;
	}
	return 1;
}

/** Validates an uploaded file; its frontmatter `name`, not the file name, decides where it goes. */
export function parseOmpAsset(kind: OmpAssetKind, fileName: string, content: string): { name: string; description: string } {
	if (!fileName.toLowerCase().endsWith(".md")) throw new OmpAssetError(`Only .md files can be uploaded (got "${fileName}").`);
	if (Buffer.byteLength(content) > MAX_ASSET_BYTES) throw new OmpAssetError(`${fileName} is larger than 256 KiB.`);
	if (!content.replace(/\r\n?/g, "\n").startsWith("---\n")) {
		throw new OmpAssetError(`${fileName} has no YAML frontmatter (a block starting with --- that sets name and description).`, 1);
	}
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter(content, { location: fileName, level: "fatal" }).frontmatter;
	} catch (err) {
		throw new OmpAssetError(`${fileName}: invalid YAML frontmatter: ${errorMessage(err)}`, 1);
	}
	const { name, description } = frontmatter;
	if (typeof name !== "string" || typeof description !== "string" || !description.trim()) {
		throw new OmpAssetError(
			`${fileName}: frontmatter needs a string "name" and a non-empty "description".`,
			frontmatterLine(content, typeof name === "string" ? "description" : "name"),
		);
	}
	if (!NAME_RE.test(name)) {
		throw new OmpAssetError(`Name "${name}" must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit.`, frontmatterLine(content, "name"));
	}
	if (kind === "agent" && RESERVED_AGENT_NAMES.includes(name)) throw new OmpAssetError(`"main" and "sub" are reserved agent names.`, frontmatterLine(content, "name"));
	return { name, description: description.trim() };
}

async function readdirOrEmpty(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

async function describe(kind: OmpAssetKind, name: string, path: string): Promise<OmpAssetEntry> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		if (kind === "skill" && (err as NodeJS.ErrnoException).code === "ENOENT") return { name, problem: "No SKILL.md in this folder." };
		return { name, problem: errorMessage(err) };
	}
	const { frontmatter } = parseFrontmatter(text, { location: path, level: "off" });
	const { description } = frontmatter;
	if (typeof description !== "string" || !description.trim() || (kind === "agent" && typeof frontmatter.name !== "string")) {
		return { name, problem: MISSING_FIELDS };
	}
	return { name, description: description.trim() };
}

/** What the volume holds, with a `problem` for entries omp would skip; one bad entry never fails the list. */
export async function listOmpAssets(dir: string): Promise<{ skills: OmpAssetEntry[]; agents: OmpAssetEntry[] }> {
	const skillNames = (await readdirOrEmpty(join(dir, "skills"))).filter(e => e.isDirectory()).map(e => e.name);
	const agentNames = (await readdirOrEmpty(join(dir, "agents")))
		.filter(e => e.isFile() && e.name.endsWith(".md"))
		.map(e => e.name.slice(0, -3));
	const byName = (a: OmpAssetEntry, b: OmpAssetEntry) => a.name.localeCompare(b.name);
	const skills = await Promise.all(skillNames.map(name => describe("skill", name, join(dir, "skills", name, "SKILL.md"))));
	const agents = await Promise.all(agentNames.map(name => describe("agent", name, join(dir, "agents", `${name}.md`))));
	return { skills: skills.sort(byName), agents: agents.sort(byName) };
}

/** Writes an uploaded file atomically, replacing one with the same name; a skill's other files are kept. */
export async function saveOmpAsset(
	dir: string,
	kind: OmpAssetKind,
	fileName: string,
	content: string,
): Promise<{ name: string; replaced: boolean }> {
	const { name } = parseOmpAsset(kind, fileName, content);
	const target = assetPath(dir, kind, name);
	const replaced = existsSync(target);
	await writeAtomic(target, content);
	return { name, replaced };
}

/** Writes `data` to `target` through a temporary file renamed over it, keeping an existing file's mode. */
async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;
	try {
		await writeFile(tmp, data);
		const existing = await lstatOrUndefined(target);
		if (existing?.isFile()) await chmod(tmp, existing.mode & 0o777);
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** Deletes a skill's whole folder or an agent's file; false when the name is invalid or absent. */
export async function removeOmpAsset(dir: string, kind: OmpAssetKind, name: string): Promise<boolean> {
	if (!NAME_RE.test(name)) return false;
	const target = kind === "skill" ? join(dir, "skills", name) : assetPath(dir, kind, name);
	if (!existsSync(target)) return false;
	await rm(target, { recursive: true, force: true });
	return true;
}

/** A file of the skill and agent trees as the config workspace shows it (WEB-25). */
export interface OmpAssetFile {
	/** `skills/<name>/<path…>` or `agents/<name>.md`, relative to the omp directory. */
	path: string;
	size: number;
	mtimeMs: number;
}

/** Every regular file under `skills/<name>/` and every `agents/<name>.md` with a valid name; symlinks are skipped. */
export async function listOmpAssetFiles(dir: string): Promise<OmpAssetFile[]> {
	const entries = [
		...(await scanTree(dir, "skills", (name, isDir) => isDir && NAME_RE.test(name))),
		...(await scanTree(dir, "agents", (name, isDir) => !isDir && name.endsWith(".md") && NAME_RE.test(name.slice(0, -3)))),
	];
	return entries.filter(e => !e.dir).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }));
}

/** Checks a workspace path inside a skill folder; `file` is relative to the folder. */
function checkSkillPath(name: string, file: string): void {
	if (!NAME_RE.test(name)) throw new OmpAssetError(`Skill folder "${name}" must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit.`);
	if (!insideFolder(file) || file.endsWith("/") || TMP_FILE_RE.test(file)) throw new OmpAssetError(`"${file}" is not a file path inside the skill folder.`);
}

/** Refuses a symlink anywhere on the way to `rel` (AGT-25), a file where a folder is needed, and a target that isn't a file. */
async function assertPlainPath(dir: string, rel: string): Promise<void> {
	const parts = rel.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const sub = parts.slice(0, i).join("/");
		const stat = await lstatOrUndefined(join(dir, sub));
		if (!stat) return;
		if (stat.isSymbolicLink()) throw new OmpAssetError(`${sub} is a symlink; symlinks are not allowed.`);
		if (i < parts.length ? !stat.isDirectory() : !stat.isFile()) throw new OmpAssetError(`${sub} is not a ${i < parts.length ? "folder" : "regular file"}.`);
	}
}

/**
 * Writes one file of a skill folder from the config workspace (WEB-26) atomically, under the AGT-25 rules: `SKILL.md`
 * must pass `parseOmpAsset` with the folder's name, any other file needs the skill's `SKILL.md`, and the folder stays
 * within `MAX_SKILL_BYTES`.
 */
export async function saveSkillFile(dir: string, name: string, file: string, data: Uint8Array): Promise<void> {
	checkSkillPath(name, file);
	const rel = `skills/${name}/${file}`;
	await assertPlainPath(dir, rel);
	if (file === "SKILL.md") {
		const content = new TextDecoder().decode(data);
		const parsed = parseOmpAsset("skill", file, content);
		if (parsed.name !== name) throw new OmpAssetError(`The frontmatter name "${parsed.name}" must be the folder name "${name}".`, frontmatterLine(content, "name"));
	} else if (!(await lstatOrUndefined(join(dir, "skills", name, "SKILL.md")))?.isFile()) {
		throw new OmpAssetError(`skills/${name}/ has no SKILL.md; create it first.`);
	}
	const others = (await scanTree(dir, `skills/${name}`, () => true)).filter(e => !e.dir && e.path !== rel);
	if (others.reduce((sum, e) => sum + e.size, 0) + data.length > MAX_SKILL_BYTES) throw new OmpAssetError(`skills/${name}/ would be larger than 5 MiB.`);
	await writeAtomic(join(dir, rel), data);
}

/** Deletes one file of a skill folder and the folders it leaves empty; false when it is absent. `SKILL.md` goes only with its folder. */
export async function removeSkillFile(dir: string, name: string, file: string): Promise<boolean> {
	checkSkillPath(name, file);
	if (file === "SKILL.md") throw new OmpAssetError(`A skill needs its SKILL.md; delete the folder skills/${name}/ to remove the skill.`);
	const rel = `skills/${name}/${file}`;
	await assertPlainPath(dir, rel);
	if (!(await lstatOrUndefined(join(dir, rel)))) return false;
	await rm(join(dir, rel));
	for (let sub = dirname(file); sub !== "."; sub = dirname(sub)) {
		const folder = join(dir, "skills", name, sub);
		if ((await readdirOrEmpty(folder)).length) break;
		await rmdir(folder);
	}
	return true;
}

/** Writes `agents/<name>.md` from the config workspace atomically; its frontmatter name must be `name` (AGT-25). */
export async function saveAgentFile(dir: string, name: string, data: Uint8Array): Promise<void> {
	if (!NAME_RE.test(name)) throw new OmpAssetError(`Agent file name "${name}" must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit.`);
	const content = new TextDecoder().decode(data);
	const parsed = parseOmpAsset("agent", `${name}.md`, content);
	if (parsed.name !== name) throw new OmpAssetError(`The frontmatter name "${parsed.name}" must be the file name "${name}".`, frontmatterLine(content, "name"));
	await assertPlainPath(dir, `agents/${name}.md`);
	await writeAtomic(assetPath(dir, "agent", name), data);
}

/** A skill folder uploaded as a zip, unpacked (AGT-25). */
export const MAX_SKILL_BYTES = 5 * 1024 ** 2;
/** Staging and replaced-folder names of `saveSkillZip`, next to `skills/` so neither is ever listed or bundled. */
const STAGING_RE = /^\.(?:upload|replaced)-[0-9a-f-]{36}$/;

export interface SkillZipFile {
	/** Path inside the skill folder, `/`-separated; directories end in `/`. */
	path: string;
	data: Uint8Array;
	executable: boolean;
}

interface ZipEntry {
	path: string;
	dir: boolean;
	executable: boolean;
	method: number;
	crc: number;
	compressedSize: number;
	size: number;
	localOffset: number;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
/** Finder adds resource forks under this folder; they are not part of the skill. */
const MACOS_METADATA = "__MACOSX/";

/** True for a relative `/`-separated path that stays inside its folder (no `..`, `.`, empty, absolute or drive parts). */
function insideFolder(path: string): boolean {
	if (!path || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return false;
	const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
	return parts.every(part => part !== "" && part !== "." && part !== "..");
}

/** The central directory of a zip; throws `OmpAssetError` for anything a skill upload must not contain. */
function zipEntries(zipName: string, zip: Uint8Array): ZipEntry[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const corrupt = () => new OmpAssetError(`${zipName} is not a valid zip file.`);
	// End of central directory: 22 bytes plus a comment of at most 64 KiB.
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw corrupt();
	const count = view.getUint16(eocd + 10, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	if (count === 0xffff || cdOffset === 0xffffffff) throw new OmpAssetError(`${zipName}: ZIP64 archives are not supported.`);
	const decoder = new TextDecoder();
	const entries: ZipEntry[] = [];
	let pos = cdOffset;
	for (let n = 0; n < count; n++) {
		if (pos + 46 > zip.length || view.getUint32(pos, true) !== 0x02014b50) throw corrupt();
		const madeBy = view.getUint16(pos + 4, true) >> 8;
		const flags = view.getUint16(pos + 8, true);
		const nameLength = view.getUint16(pos + 28, true);
		const external = view.getUint32(pos + 38, true);
		const path = decoder.decode(zip.subarray(pos + 46, pos + 46 + nameLength));
		const entry: ZipEntry = {
			path,
			dir: path.endsWith("/"),
			executable: false,
			method: view.getUint16(pos + 10, true),
			crc: view.getUint32(pos + 16, true),
			compressedSize: view.getUint32(pos + 20, true),
			size: view.getUint32(pos + 24, true),
			localOffset: view.getUint32(pos + 42, true),
		};
		pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
		if (path.startsWith(MACOS_METADATA)) continue;
		if (!insideFolder(path)) throw new OmpAssetError(`${zipName}: "${path}" points outside the skill folder.`);
		// Unix hosts keep the file type and mode in the upper half of the external attributes.
		const mode = madeBy === 3 ? external >>> 16 : 0;
		const type = mode & S_IFMT;
		if (type === S_IFLNK) throw new OmpAssetError(`${zipName}: "${path}" is a symlink; symlinks are not allowed.`);
		if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new OmpAssetError(`${zipName}: "${path}" is not a regular file or folder.`);
		if (type === S_IFDIR) entry.dir = true;
		entry.executable = !entry.dir && (mode & 0o111) !== 0;
		if (flags & 1) throw new OmpAssetError(`${zipName}: "${path}" is encrypted.`);
		if (!entry.dir && entry.method !== 0 && entry.method !== 8) throw new OmpAssetError(`${zipName}: "${path}" uses an unsupported compression method.`);
		entries.push(entry);
	}
	return entries;
}

function inflateEntry(zipName: string, zip: Uint8Array, entry: ZipEntry): Uint8Array {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const corrupt = () => new OmpAssetError(`${zipName}: "${entry.path}" is damaged.`);
	const header = entry.localOffset;
	if (header + 30 > zip.length || view.getUint32(header, true) !== 0x04034b50) throw corrupt();
	const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
	if (start + entry.compressedSize > zip.length) throw corrupt();
	const raw = zip.subarray(start, start + entry.compressedSize);
	let data: Uint8Array;
	if (entry.method === 0) data = raw;
	else {
		try {
			// The declared size is already within the limit; a stream that inflates past it is lying about its size.
			data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
		} catch {
			throw corrupt();
		}
	}
	if (data.length !== entry.size || Bun.hash.crc32(data) !== entry.crc) throw corrupt();
	return data;
}

/**
 * Validates and unpacks a skill folder zip (AGT-25): at most `MAX_SKILL_BYTES` unpacked, `SKILL.md` at the top (of
 * the archive, or of its single top-level folder), no symlinks or other special files, no path outside the folder.
 * The `SKILL.md` frontmatter must pass `parseOmpAsset`; its name decides where the skill goes.
 */
export function readSkillZip(zipName: string, zip: Uint8Array): { name: string; files: SkillZipFile[] } {
	const entries = zipEntries(zipName, zip);
	const total = entries.reduce((sum, entry) => sum + (entry.dir ? 0 : entry.size), 0);
	if (total > MAX_SKILL_BYTES) throw new OmpAssetError(`${zipName} unpacks to more than 5 MiB.`);
	// `SKILL.md` at the archive root, or the archive is the skill folder itself (`<folder>/SKILL.md`, everything inside it).
	let root = "";
	if (!entries.some(e => e.path === "SKILL.md" && !e.dir)) {
		const top = entries[0]?.path.split("/")[0] ?? "";
		const single = entries.every(e => e.path.startsWith(`${top}/`));
		if (!top || !single || !entries.some(e => e.path === `${top}/SKILL.md` && !e.dir)) {
			throw new OmpAssetError(`${zipName} has no SKILL.md at the top of the skill folder.`);
		}
		root = `${top}/`;
	}
	const files: SkillZipFile[] = [];
	const seen = new Map<string, boolean>();
	for (const entry of entries) {
		const path = entry.path.slice(root.length);
		if (!path) continue;
		const key = path.endsWith("/") ? path.slice(0, -1) : path;
		const parts = key.split("/");
		// A file may not share its path with another entry or sit where a folder is needed.
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const isDir = i < parts.length || entry.dir;
			const earlier = seen.get(prefix);
			if (earlier !== undefined && (!earlier || !isDir)) throw new OmpAssetError(`${zipName}: "${path}" appears more than once.`);
			seen.set(prefix, isDir);
		}
		files.push({ path: entry.dir ? `${key}/` : key, data: entry.dir ? new Uint8Array() : inflateEntry(zipName, zip, entry), executable: entry.executable });
	}
	const skillMd = files.find(f => f.path === "SKILL.md")!;
	const { name } = parseOmpAsset("skill", "SKILL.md", new TextDecoder().decode(skillMd.data));
	return { name, files };
}

/**
 * Stores a skill uploaded as a zip of its folder, replacing the whole folder of a skill with the same name. The new
 * folder is staged next to `skills/` and renamed into place, so a session never sees a half-written skill.
 */
export async function saveSkillZip(dir: string, zipName: string, zip: Uint8Array): Promise<{ name: string; replaced: boolean }> {
	const { name, files } = readSkillZip(zipName, zip);
	const staging = join(dir, `.upload-${crypto.randomUUID()}`);
	const target = join(dir, "skills", name);
	try {
		await mkdir(staging, { recursive: true });
		for (const file of files) {
			const path = join(staging, file.path);
			if (file.path.endsWith("/")) {
				await mkdir(path, { recursive: true });
				continue;
			}
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, file.data);
			await chmod(path, file.executable ? 0o755 : 0o644);
		}
		await mkdir(join(dir, "skills"), { recursive: true });
		const replaced = existsSync(target);
		const old = join(dir, `.replaced-${crypto.randomUUID()}`);
		if (replaced) await rename(target, old);
		try {
			await rename(staging, target);
		} catch (err) {
			if (replaced) await rename(old, target);
			throw err;
		}
		if (replaced) await rm(old, { recursive: true, force: true });
		return { name, replaced };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export interface SkillsBundle {
	/** sha256 (hex) of `tar`; the run spec's `skillsHash`. */
	hash: string;
	/** Uncompressed POSIX (pax) tar of `skills/**` and `agents/*.md`, paths relative to `dir`. */
	tar: Uint8Array;
}

interface BundleEntry {
	/** Relative path with `/` separators; directories end in `/`. */
	path: string;
	dir: boolean;
	mode: number;
	size: number;
	mtimeMs: number;
}

/** Interrupted `saveOmpAsset` writes; never part of the bundle. */
const TMP_FILE_RE = /\.tmp-[0-9a-f-]{36}$/;
const bundleCache = new Map<string, { fingerprint: string; bundle: Promise<SkillsBundle> }>();

/**
 * The skills and agents as one deterministic tar (sorted entries, zero mtimes and owners), so equal trees give equal
 * hashes and workers can cache by hash. Rebuilt only when a file or folder under `dir` changed (path, size, mtime or
 * mode); symlinks and other special files are skipped. A missing `dir` gives an empty bundle.
 */
export async function skillsBundle(dir: string): Promise<SkillsBundle> {
	const entries = [...(await scanTree(dir, "skills", () => true)), ...(await scanTree(dir, "agents", (name, isDir) => !isDir && name.endsWith(".md")))];
	const fingerprint = entries.map(e => `${e.path}\0${e.mode}\0${e.size}\0${e.mtimeMs}`).join("\n");
	const cached = bundleCache.get(dir);
	if (cached?.fingerprint === fingerprint) return cached.bundle;
	const bundle = buildTar(dir, entries);
	bundleCache.set(dir, { fingerprint, bundle });
	bundle.catch(() => {
		if (bundleCache.get(dir)?.bundle === bundle) bundleCache.delete(dir);
	});
	return bundle;
}

async function scanTree(root: string, rel: string, include: (name: string, isDir: boolean) => boolean): Promise<BundleEntry[]> {
	let stat: Stats;
	try {
		stat = await lstat(join(root, rel));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	if (!stat.isDirectory()) return [];
	const out: BundleEntry[] = [{ path: `${rel}/`, dir: true, mode: 0o755, size: 0, mtimeMs: stat.mtimeMs }];
	const children = (await readdirOrEmpty(join(root, rel))).map(e => e.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
	for (const name of children) {
		if (TMP_FILE_RE.test(name)) continue;
		const child = `${rel}/${name}`;
		let info: Stats;
		try {
			info = await lstat(join(root, child));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		if (info.isDirectory()) {
			if (include(name, true)) out.push(...(await scanTree(root, child, () => true)));
		} else if (info.isFile() && include(name, false)) {
			out.push({ path: child, dir: false, mode: info.mode & 0o111 ? 0o755 : 0o644, size: info.size, mtimeMs: info.mtimeMs });
		}
	}
	return out;
}

async function buildTar(root: string, entries: BundleEntry[]): Promise<SkillsBundle> {
	const chunks: Uint8Array[] = [];
	for (const entry of entries) {
		let data: Uint8Array = new Uint8Array(0);
		if (!entry.dir) {
			try {
				data = await readFile(join(root, entry.path));
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
		}
		const name = Buffer.from(entry.path);
		if (name.length > 100) {
			const pax = paxRecord("path", entry.path);
			chunks.push(tarHeader(Buffer.from(`PaxHeader/${entry.path.slice(-80)}`).subarray(0, 100), 0o644, pax.length, "x"), ...padded(pax));
		}
		chunks.push(tarHeader(name.subarray(0, 100), entry.mode, data.length, entry.dir ? "5" : "0"), ...padded(data));
	}
	chunks.push(new Uint8Array(1024));
	const tar = Buffer.concat(chunks);
	return { hash: createHash("sha256").update(tar).digest("hex"), tar: new Uint8Array(tar.buffer, tar.byteOffset, tar.length) };
}

/** `"<len> key=value\n"`, where `<len>` counts the whole record including itself. */
function paxRecord(key: string, value: string): Buffer {
	const body = ` ${key}=${value}\n`;
	const bodyLength = Buffer.byteLength(body);
	let length = bodyLength + 1;
	while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
	return Buffer.from(`${length}${body}`);
}

function padded(data: Uint8Array): Uint8Array[] {
	const rest = data.length % 512;
	return rest === 0 ? [data] : [data, new Uint8Array(512 - rest)];
}

function tarHeader(name: Uint8Array, mode: number, size: number, type: string): Uint8Array {
	const header = Buffer.alloc(512);
	const octal = (value: number, offset: number, width: number) => header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, "ascii");
	header.set(name, 0);
	octal(mode, 100, 8);
	octal(0, 108, 8);
	octal(0, 116, 8);
	octal(size, 124, 12);
	octal(0, 136, 12);
	header.write("        ", 148, "ascii");
	header.write(type, 156, "ascii");
	header.write("ustar\0" + "00", 257, "ascii");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return header;
}
