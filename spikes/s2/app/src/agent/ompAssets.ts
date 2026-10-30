import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { errorMessage } from "../log";

/**
 * The omp volume: the user's skills (`skills/<name>/SKILL.md`) and task agents (`agents/<name>.md`), the only
 * extension root every agent session loads (D-039). `/omp` in the container (`DEVFORGE_OMP_DIR`), `<dataDir>/omp` locally.
 */
export function ompAssetsDir(dataDir: string): string {
	return resolve(process.env.DEVFORGE_OMP_DIR ?? join(dataDir, "omp"));
}

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
	const tmp = `${target}.tmp-${process.pid}`;
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
