import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
}

export type OmpAssetKind = "skill" | "agent";

/** An upload the user must fix; its message is shown on the page. */
export class OmpAssetError extends Error {
	override name = "OmpAssetError";
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

/** Validates an uploaded file; its frontmatter `name`, not the file name, decides where it goes. */
export function parseOmpAsset(kind: OmpAssetKind, fileName: string, content: string): { name: string; description: string } {
	if (!fileName.toLowerCase().endsWith(".md")) throw new OmpAssetError(`Only .md files can be uploaded (got "${fileName}").`);
	if (Buffer.byteLength(content) > MAX_ASSET_BYTES) throw new OmpAssetError(`${fileName} is larger than 256 KiB.`);
	if (!content.replace(/\r\n?/g, "\n").startsWith("---\n")) {
		throw new OmpAssetError(`${fileName} has no YAML frontmatter (a block starting with --- that sets name and description).`);
	}
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter(content, { location: fileName, level: "fatal" }).frontmatter;
	} catch (err) {
		throw new OmpAssetError(`${fileName}: invalid YAML frontmatter: ${errorMessage(err)}`);
	}
	const { name, description } = frontmatter;
	if (typeof name !== "string" || typeof description !== "string" || !description.trim()) {
		throw new OmpAssetError(`${fileName}: frontmatter needs a string "name" and a non-empty "description".`);
	}
	if (!NAME_RE.test(name)) {
		throw new OmpAssetError(`Name "${name}" must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit.`);
	}
	if (kind === "agent" && RESERVED_AGENT_NAMES.includes(name)) throw new OmpAssetError(`"main" and "sub" are reserved agent names.`);
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
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;
	await writeFile(tmp, content);
	await rename(tmp, target);
	return { name, replaced };
}

/** Deletes a skill's whole folder or an agent's file; false when the name is invalid or absent. */
export async function removeOmpAsset(dir: string, kind: OmpAssetKind, name: string): Promise<boolean> {
	if (!NAME_RE.test(name)) return false;
	const target = kind === "skill" ? join(dir, "skills", name) : assetPath(dir, kind, name);
	if (!existsSync(target)) return false;
	await rm(target, { recursive: true, force: true });
	return true;
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
