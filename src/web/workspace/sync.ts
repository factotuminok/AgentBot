import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { WORKSPACE_OMP, WORKSPACE_SETTINGS, type WorkspaceSchemas } from "../../shared/adminWorkspace";
import { errorMessage, log } from "../../shared/log";
import {
	REMOTE_SUFFIX,
	SYNC_COMMANDS_DIR,
	SYNC_DIR,
	SYNC_STATUS_FILE,
	type SyncCommand,
	type SyncNotice,
	type SyncProblem,
	type SyncState,
	type SyncStatus,
	WORKSPACE_DIR,
} from "../../shared/workspaceSync";
import { type AdminClient, OrchestratorUnavailable } from "../adminClient";
import { settingsSavedText } from "../forms";
import { fetchFile, fetchManifest, saveFile } from "./api";
import { jsonPathLine } from "./jsonLine";
import { FORBIDDEN_FILES, README, README_FILE, VSCODE_SETTINGS_FILE, vscodeSettings } from "./owned";

/**
 * Keeps `<home>/config-workspace` in step with the orchestrator's config workspace (WEB-25 to WEB-28, architecture
 * §2.5) and reports to the bundled extension through `<home>/.agentbot/sync` (`src/shared/workspaceSync.ts`).
 *
 * Two loops share the bookkeeping below:
 * - the local loop (every `scanMs`) enforces the owned files, picks up extension commands and scans the tree. A file
 *   is queued once two scans in a row see the same mtime, size and inode, so a save is never read half-written;
 * - the network loop polls the manifest every `pollMs`, then runs commands and sends the queue in order. While the
 *   orchestrator is unreachable it only retries at the poll pace; the queue lives in `web-state.json`, so a restart
 *   loses nothing.
 *
 * A path's last-synced state is the orchestrator revision it was based on plus the sha256 of the local bytes at that
 * point: local content differing from it is an unsent save, and a remote revision differing from it is a remote
 * change, which overwrites the file only while the local content is unchanged (WEB-27).
 */

export interface WorkspaceSyncOptions {
	admin: AdminClient;
	/** `AGENTBOT_HOME`. */
	home: string;
	/** Local scan interval; a save goes out within 2 × `scanMs` plus the request (WEB-26: 1 s). Default 300 ms. */
	scanMs?: number;
	/** Manifest poll interval, and the retry pace while the orchestrator is unreachable (WEB-27: 5 s). Default 1000 ms. */
	pollMs?: number;
}

export interface WorkspaceSync {
	/** Ends both loops and aborts requests in flight; unsent saves stay queued on disk. */
	stop(): Promise<void>;
}

/** The sync's private state next to `status.json`: last-synced revisions, conflicts, rejections and the save queue. */
const STATE_FILE = "web-state.json";
const TMP_PREFIX = ".agentbot-tmp-";
const LOCKED_MESSAGE = "Settings are locked: log in to the web UI";
const OUTSIDE_LAYOUT = "Not synced: the workspace holds settings.json, omp.json, skills/<name>/… and agents/<name>.md.";
const NOT_A_FILE = "Not synced: only plain files are saved (no symlinks).";
const MAX_NOTICES = 20;
const REQUEST_TIMEOUT_MS = 15_000;
/** A settings.json save waits for the engine to apply it (ENG-02), as the Settings page's save does. */
const SETTINGS_SAVE_TIMEOUT_MS = 120_000;
/** Left out of the manifest and refused while the vault is locked. */
const LOCKABLE = new Set([WORKSPACE_SETTINGS, WORKSPACE_OMP]);
const LAYOUT = /^(?:settings\.json|omp\.json|skills\/[^/]+\/.+|agents\/[^/]+)$/;
/** Editor scratch files (Emacs locks and backups, vim swap files, temp files, macOS metadata) and this module's temp files. */
const SCRATCH = /(?:^|\/)(?:\.#[^/]*|[^/]*~|[^/]*\.sw[a-p]|[^/]*\.tmp|\.DS_Store|\.agentbot-tmp-[^/]*)$/;

/** Workspace files that never reach the orchestrator: the owned ones, `.remote` copies and editor scratch files. */
function ignored(path: string): boolean {
	return path === README_FILE || path === ".vscode" || path.startsWith(".vscode/") || path.endsWith(REMOTE_SUFFIX) || SCRATCH.test(path);
}

/** A path the orchestrator may name (manifest, commands) that is safe to write here. */
function syncable(path: string): boolean {
	return LAYOUT.test(path) && !ignored(path) && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && !part.includes("\\"));
}

/** A new skill's SKILL.md goes before its other files, which the orchestrator refuses without it. */
const pushOrder = (path: string) => path.replace(/\/SKILL\.md$/, "/\u0000");

/** mtime, size and inode: equal in two scans means nothing is writing the file. */
const signature = (info: Stats) => `${info.mtimeMs}:${info.size}:${info.ino}`;

/** The skill folder (`skills/<name>/`) a path is in. */
const skillFolder = (path: string) => (path.startsWith("skills/") ? `${path.split("/", 2).join("/")}/` : undefined);

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `${TMP_PREFIX}${randomUUID()}`);
	try {
		await writeFile(tmp, data);
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

interface LocalFile {
	bytes: Uint8Array<ArrayBuffer>;
	hash: string;
	sig: string;
}

/** The file's bytes, sha256 and signature; null when there is no plain file at `path`. */
async function readLocal(root: string, path: string): Promise<LocalFile | null> {
	let bytes: Uint8Array<ArrayBuffer>;
	let info: Stats;
	try {
		info = await lstat(join(root, path));
		if (!info.isFile()) return null;
		bytes = await readFile(join(root, path));
	} catch (err) {
		const code = err instanceof Error && "code" in err ? err.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		throw err;
	}
	return { bytes, hash: createHash("sha256").update(bytes).digest("hex"), sig: signature(info) };
}

interface SyncedFile {
	revision: string;
	hash: string;
}

interface Conflict {
	/** The orchestrator revision in `<path>.remote` ("" = deleted there): a merged save is based on it. */
	revision: string;
	/**
	 * Signature of the local file when the conflict was found (null = no file). The admin's next save, even of the same
	 * content (keeping their version), is the merge.
	 */
	seen: string | null;
}

interface Rejection {
	/** The local hash the orchestrator refused (null = a delete); the same content is not sent again. */
	hash: string | null;
	problems: SyncProblem[];
}

const problemSchema = z.object({ path: z.string(), message: z.string(), line: z.number().optional() });
const persistedSchema = z.object({
	files: z.record(z.string(), z.object({ revision: z.string(), hash: z.string() })),
	conflicts: z.record(z.string(), z.object({ revision: z.string(), seen: z.string().nullable() })),
	rejected: z.record(z.string(), z.object({ hash: z.string().nullable(), problems: z.array(problemSchema) })),
	/** Unsent saves in save order: file paths, and `skills/<name>/` for a deleted skill folder (WEB-27). */
	queue: z.array(z.string()),
});
const commandSchema: z.ZodType<SyncCommand> = z.object({ command: z.enum(["reload", "accept"]), path: z.string().optional() });

export async function startWorkspaceSync(opts: WorkspaceSyncOptions): Promise<WorkspaceSync> {
	const { admin } = opts;
	const scanMs = opts.scanMs ?? 300;
	const pollMs = opts.pollMs ?? 1000;
	const root = join(opts.home, WORKSPACE_DIR);
	const syncDir = join(opts.home, SYNC_DIR);
	const commandsDir = join(syncDir, SYNC_COMMANDS_DIR);
	const statePath = join(syncDir, STATE_FILE);
	/** `skills/` and `agents/` so the admin can add to them, and the extension's command folder. */
	const ensureDirs = async () => {
		for (const dir of [join(root, "skills"), join(root, "agents"), commandsDir]) await mkdir(dir, { recursive: true });
	};
	await ensureDirs();

	const files = new Map<string, SyncedFile>();
	const conflicts = new Map<string, Conflict>();
	const rejected = new Map<string, Rejection>();
	const queue: string[] = [];
	let savedState = "";
	try {
		savedState = await readFile(statePath, "utf8");
		const state = persistedSchema.parse(JSON.parse(savedState));
		for (const [path, file] of Object.entries(state.files)) files.set(path, file);
		for (const [path, conflict] of Object.entries(state.conflicts)) conflicts.set(path, conflict);
		for (const [path, rejection] of Object.entries(state.rejected)) rejected.set(path, rejection);
		queue.push(...state.queue);
	} catch (err) {
		// Without it the first poll treats every differing local file as a conflict, so no edit is lost.
		if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) log("warn", "workspace sync state unreadable, starting afresh", { error: errorMessage(err) });
	}

	/** Why the orchestrator can't be reached; undefined while it can. */
	let unavailable: string | undefined;
	let locked = false;
	/** Settings/omp saves refused as locked; sent again once the manifest says unlocked. */
	const held = new Set<string>();
	let saving: string | undefined;
	let etag: string | undefined;
	/** `.vscode/settings.json` as it must read: with the orchestrator's schemas once they are fetched. */
	let vscodeText = vscodeSettings(undefined);
	let schemasFresh = false;
	const notices: SyncNotice[] = [];
	let localProblems: SyncProblem[] = [];
	const commands: SyncCommand[] = [];
	/** Signatures seen by the last scan: every plain file in the layout. */
	let seen = new Map<string, string>();
	const hashes = new Map<string, { sig: string; hash: string }>();
	/** What this process last wrote to each owned file. */
	const owned = new Map<string, { sig: string; text: string }>();
	let publishedStatus = "";
	/** Status and state writes, one at a time so the newest always lands last. */
	let writes = Promise.resolve();
	const stopper = new AbortController();
	let stopped = false;
	let kicked = false;
	let wake: (() => void) | undefined;

	const signal = (ms: number) => AbortSignal.any([stopper.signal, AbortSignal.timeout(ms)]);

	function notice(level: SyncNotice["level"], text: string): void {
		notices.push({ id: randomUUID(), level, text });
		notices.splice(0, notices.length - MAX_NOTICES);
	}

	function status(): Omit<SyncStatus, "updatedAt"> {
		const problems = [...localProblems, ...[...rejected.values()].flatMap(rejection => rejection.problems)];
		const conflicted = [...conflicts.keys()].sort();
		let state: SyncState = "synced";
		let message: string | undefined;
		if (unavailable !== undefined) {
			state = "unavailable";
			message = `Orchestrator unavailable: ${unavailable}${queue.length ? ` (${queue.length} unsent)` : ""}`;
		} else if (held.size) {
			state = "unavailable";
			message = LOCKED_MESSAGE;
		} else if (conflicted.length) {
			state = "conflict";
			message = `Conflict: compare with the ${REMOTE_SUFFIX} file, then save a merged file or accept the server version`;
		} else if (problems.length) {
			state = "rejected";
			message = "Not saved: see the Problems panel";
		} else if (saving !== undefined || queue.length) {
			state = "saving";
			message = saving && `Saving ${saving}`;
		}
		return { state, message, problems, conflicts: conflicted, notices };
	}

	function publish(): Promise<void> {
		writes = writes
			.then(async () => {
				const current = status();
				const text = JSON.stringify(current);
				if (text === publishedStatus) return;
				await writeAtomic(join(syncDir, SYNC_STATUS_FILE), `${JSON.stringify({ ...current, updatedAt: new Date().toISOString() }, null, "\t")}\n`);
				publishedStatus = text;
			})
			.catch(err => log("error", "workspace sync status not written", { error: errorMessage(err) }));
		return writes;
	}

	function persist(): Promise<void> {
		writes = writes
			.then(async () => {
				const text = JSON.stringify({
					files: Object.fromEntries(files),
					conflicts: Object.fromEntries(conflicts),
					rejected: Object.fromEntries(rejected),
					queue,
				});
				if (text === savedState) return;
				await writeAtomic(statePath, text);
				savedState = text;
			})
			.catch(err => log("error", "workspace sync state not written", { error: errorMessage(err) }));
		return writes;
	}

	function kick(): void {
		kicked = true;
		if (unavailable === undefined) wake?.();
	}

	function dropQueued(path: string): void {
		const index = queue.indexOf(path);
		if (index >= 0) queue.splice(index, 1);
	}

	/** True when the local file (`hash` and `sig`, null = none) is a save that hasn't been sent yet. */
	function unsent(path: string, hash: string | null, sig: string | null): boolean {
		const conflict = conflicts.get(path);
		if (conflict) return sig !== conflict.seen;
		if (rejected.get(path)?.hash === hash) return false;
		return hash !== (files.get(path)?.hash ?? null);
	}

	async function removeLocal(path: string): Promise<void> {
		await rm(join(root, path), { force: true });
		// An emptied skill folder goes with its last file; `skills/` and `agents/` stay.
		for (let dir = dirname(path); dir.includes("/"); dir = dirname(dir)) {
			try {
				await rmdir(join(root, dir));
			} catch {
				return;
			}
		}
	}

	async function clearConflict(path: string): Promise<void> {
		if (conflicts.delete(path)) await rm(join(root, path + REMOTE_SUFFIX), { force: true });
	}

	/** Writes the orchestrator's version to `<path>.remote` (empty when it has none) and reports the conflict (WEB-27). */
	async function enterConflict(path: string, seen: string | null): Promise<void> {
		const remote = await fetchFile(admin, path, signal(REQUEST_TIMEOUT_MS));
		await writeAtomic(join(root, path + REMOTE_SUFFIX), remote?.bytes ?? new Uint8Array());
		conflicts.set(path, { revision: remote?.revision ?? "", seen });
		dropQueued(path);
		log("warn", "workspace conflict", { path, deletedThere: !remote });
		notice(
			"warning",
			remote
				? `${path} was also changed elsewhere; that version is in ${path}${REMOTE_SUFFIX}. Save a merged ${path}, or run "AgentBot: Accept server version".`
				: `${path} was deleted elsewhere. Save it to keep it, or run "AgentBot: Accept server version" to delete it here too.`,
		);
	}

	// ── local loop ────────────────────────────────────────────────────────────────────────────────────────────────

	/** Rewrites an owned file that differs from `text`; a change this process didn't make is reverted with a notice. */
	async function enforce(path: string, text: string): Promise<void> {
		const file = join(root, path);
		const info = await lstat(file).catch(() => undefined);
		const known = owned.get(path);
		if (known && info && known.sig === signature(info) && known.text === text) return;
		const current = info?.isFile() ? await readFile(file, "utf8") : undefined;
		if (current !== text) {
			if (info && !info.isFile()) await rm(file, { recursive: true, force: true });
			await writeAtomic(file, text);
			if (known && current !== known.text) {
				log("warn", "workspace file restored", { path });
				notice("warning", `${path} is maintained by AgentBot; your change was reverted.`);
			}
		}
		owned.set(path, { sig: signature(await lstat(file)), text });
	}

	async function guardOwned(): Promise<void> {
		for (const path of FORBIDDEN_FILES) {
			if (!(await lstat(join(root, path)).catch(() => undefined))) continue;
			await rm(join(root, path), { recursive: true, force: true });
			log("warn", "workspace file deleted: tasks and debugging are disabled", { path });
			notice("warning", `${path} was deleted: tasks and debugging are disabled in this editor.`);
		}
		await enforce(README_FILE, README);
		await enforce(VSCODE_SETTINGS_FILE, vscodeText);
	}

	/** Takes every command file (WEB-28); they run on the network loop. */
	async function takeCommands(): Promise<void> {
		for (const name of (await readdir(commandsDir)).filter(name => name.endsWith(".json")).sort()) {
			const file = join(commandsDir, name);
			const parsed = commandSchema.safeParse(await readFile(file, "utf8").then(JSON.parse).catch(() => undefined));
			await rm(file, { force: true });
			if (!parsed.success || (parsed.data.path !== undefined && !syncable(parsed.data.path))) {
				log("warn", "workspace sync command ignored", { file: name });
				continue;
			}
			commands.push(parsed.data);
			kick();
		}
	}

	/** Every plain file in the layout with its signature, plus problems for files that can't be synced. */
	async function walk(): Promise<{ present: Map<string, string>; problems: SyncProblem[] }> {
		const present = new Map<string, string>();
		const problems: SyncProblem[] = [];
		const visit = async (dir: string): Promise<void> => {
			const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				const path = dir ? `${dir}/${entry.name}` : entry.name;
				if (ignored(path)) continue;
				if (entry.isDirectory()) await visit(path);
				else if (!entry.isFile()) problems.push({ path, message: NOT_A_FILE });
				else if (!syncable(path)) problems.push({ path, message: OUTSIDE_LAYOUT });
				else {
					const info = await lstat(join(root, path)).catch(() => undefined);
					if (info) present.set(path, signature(info));
				}
			}
		};
		await visit("");
		return { present, problems };
	}

	/** Queues every settled local change (WEB-26); a skill folder deleted as a whole is one entry. */
	async function scan(): Promise<void> {
		const { present, problems } = await walk();
		localProblems = problems;
		const before = seen;
		seen = present;
		const folders = new Set([...present.keys()].map(skillFolder));
		const candidates = [...new Set([...present.keys(), ...files.keys(), ...conflicts.keys(), ...rejected.keys()])];
		candidates.sort((a, b) => (pushOrder(a) < pushOrder(b) ? -1 : 1));
		for (const path of candidates) {
			const sig = present.get(path);
			// Still being written (or just deleted): wait for a scan that sees the same.
			if (sig !== before.get(path)) continue;
			if (path.endsWith("/")) {
				// A refused folder delete: void once the folder has files again.
				if (folders.has(path)) rejected.delete(path);
				continue;
			}
			let hash: string | null = null;
			if (sig !== undefined) {
				const cached = hashes.get(path);
				if (cached?.sig === sig) hash = cached.hash;
				else {
					const local = await readLocal(root, path);
					if (!local) continue;
					hash = local.hash;
					hashes.set(path, { sig, hash });
				}
			}
			// Problems belong to the refused content; anything else (a fix, a revert, a delete) voids them.
			const rejection = rejected.get(path);
			if (rejection && rejection.hash !== hash) rejected.delete(path);
			if (!unsent(path, hash, sig ?? null)) continue;
			const folder = hash === null ? skillFolder(path) : undefined;
			const entry = folder && !folders.has(folder) ? folder : path;
			if (entry === folder && rejected.has(folder)) continue;
			if (!queue.includes(entry)) {
				queue.push(entry);
				kick();
			}
		}
		for (const path of hashes.keys()) if (!present.has(path)) hashes.delete(path);
	}

	async function localLoop(): Promise<void> {
		while (!stopped) {
			try {
				if (!(await lstat(root).catch(() => undefined))) {
					// A vanished workspace is not the admin deleting every file: forget the sync state and pull it all again.
					log("warn", "workspace folder missing, pulling it again", { workspace: root });
					for (const map of [files, conflicts, rejected]) map.clear();
					queue.length = 0;
					held.clear();
					seen = new Map();
					etag = undefined;
				}
				await ensureDirs();
				await guardOwned();
				await takeCommands();
				await scan();
			} catch (err) {
				log("error", "workspace scan failed", { error: errorMessage(err) });
			}
			await persist();
			await publish();
			await Bun.sleep(scanMs);
		}
	}

	// ── network loop ──────────────────────────────────────────────────────────────────────────────────────────────

	/** Applies one manifest entry (`revision` "" = not on the orchestrator) to the local copy (WEB-27). */
	async function pull(path: string, revision: string): Promise<void> {
		const file = await readLocal(root, path);
		const hash = file?.hash ?? null;
		if (hash === (revision || null)) {
			// Same content on both sides (a revision is the content's sha256), or gone from both.
			if (revision) files.set(path, { revision, hash: revision });
			else files.delete(path);
			rejected.delete(path);
			dropQueued(path);
			await clearConflict(path);
			return;
		}
		const conflict = conflicts.get(path);
		if (conflict) {
			// Changed there again: refresh `.remote` so the merge is based on the newest version.
			if (conflict.revision !== revision) await enterConflict(path, conflict.seen);
			return;
		}
		const synced = files.get(path);
		if ((synced?.revision ?? "") === revision) return;
		if (hash !== (synced?.hash ?? null)) {
			await enterConflict(path, file?.sig ?? null);
			return;
		}
		if (!revision) {
			await removeLocal(path);
			files.delete(path);
			log("info", "workspace file deleted by the orchestrator", { path });
			return;
		}
		const remote = await fetchFile(admin, path, signal(REQUEST_TIMEOUT_MS));
		// Deleted meanwhile, or saved here while it downloaded: the next poll or scan carries on from there.
		if (!remote || ((await readLocal(root, path))?.hash ?? null) !== hash) return;
		await writeAtomic(join(root, path), remote.bytes);
		files.set(path, { revision: remote.revision, hash: remote.hash });
		log("info", "workspace file pulled", { path });
	}

	async function poll(): Promise<void> {
		const manifest = await fetchManifest(admin, etag, signal(REQUEST_TIMEOUT_MS));
		if (unavailable !== undefined) {
			log("info", "workspace sync: orchestrator reachable again", { unsent: queue.length });
			unavailable = undefined;
		}
		if (!schemasFresh) {
			vscodeText = vscodeSettings(await admin.call<WorkspaceSchemas>("GET", "/workspace/schemas"));
			schemasFresh = true;
		}
		if (!manifest) return;
		locked = manifest.locked;
		if (!locked) held.clear();
		const remote = new Map<string, string>();
		for (const file of manifest.files) {
			if (syncable(file.path)) remote.set(file.path, file.revision);
			else log("warn", "workspace manifest path ignored", { path: file.path });
		}
		for (const [path, revision] of remote) await pull(path, revision);
		for (const path of new Set([...files.keys(), ...conflicts.keys()])) {
			// Locked settings are left out of the manifest, not deleted.
			if (!remote.has(path) && !(locked && LOCKABLE.has(path))) await pull(path, "");
		}
		etag = manifest.etag;
	}

	/** After a rewritten save (settings.json, omp.json), the orchestrator's rendering replaces the sent file. */
	async function takeRewritten(path: string, sent: string): Promise<void> {
		const remote = await fetchFile(admin, path, signal(REQUEST_TIMEOUT_MS));
		// A save made during the request wins: it goes out next, based on the new revision.
		if (!remote || ((await readLocal(root, path))?.hash ?? null) !== sent) return;
		await writeAtomic(join(root, path), remote.bytes);
		files.set(path, { revision: remote.revision, hash: remote.hash });
	}

	/** Sends one queued file (WEB-26). True when it stays queued: a settings save held while locked. */
	async function push(path: string, username: string | undefined): Promise<boolean> {
		const local = await readLocal(root, path);
		const hash = local?.hash ?? null;
		if (!unsent(path, hash, local?.sig ?? null)) return false;
		const base = conflicts.get(path)?.revision ?? files.get(path)?.revision ?? "";
		if (!local && !base) {
			// Deleted here and there (a conflict over a remote delete): nothing to send.
			await clearConflict(path);
			files.delete(path);
			rejected.delete(path);
			return false;
		}
		const timeout = path === WORKSPACE_SETTINGS ? SETTINGS_SAVE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
		const outcome = await saveFile(admin, path, base, local?.bytes, username, signal(timeout));
		if (outcome.ok) {
			await clearConflict(path);
			rejected.delete(path);
			if (local) {
				files.set(path, { revision: outcome.revision, hash: local.hash });
				if (outcome.rewritten) await takeRewritten(path, local.hash);
			} else files.delete(path);
			log("info", "workspace file saved", { path, deleted: !local, rewritten: outcome.rewritten, admin: username });
			if (path === WORKSPACE_SETTINGS && outcome.phase) {
				notice(outcome.phase === "error" ? "error" : "info", settingsSavedText({ phase: outcome.phase, error: outcome.error }));
				for (const warning of outcome.warnings ?? []) notice("warning", warning);
			}
			const folder = skillFolder(path);
			if (local && folder && path === `${folder}SKILL.md`) {
				// Supporting files refused while the skill had no SKILL.md may go in now.
				for (const [other, rejection] of rejected) {
					if (!other.startsWith(folder) || rejection.hash === null) continue;
					rejected.delete(other);
					if (!queue.includes(other)) queue.push(other);
				}
			}
			return false;
		}
		if (outcome.reason === "locked") {
			if (!held.has(path)) log("info", "workspace save held until the settings are unlocked", { path });
			held.add(path);
			return true;
		}
		rejected.delete(path);
		if (outcome.reason === "conflict") {
			await enterConflict(path, local?.sig ?? null);
			return false;
		}
		const text = local && path.endsWith(".json") ? new TextDecoder().decode(local.bytes) : undefined;
		const problems = outcome.problems.map(problem => ({
			path,
			message: problem.message,
			line: problem.line ?? (text !== undefined && problem.jsonPath ? jsonPathLine(text, problem.jsonPath) : undefined),
		}));
		rejected.set(path, { hash, problems: problems.length ? problems : [{ path, message: "Refused by the orchestrator." }] });
		log("warn", "workspace file rejected", { path, problems: problems.length });
		return false;
	}

	/** Deletes a skill folder removed as a whole: one request instead of a refused SKILL.md delete. */
	async function deleteFolder(folder: string, username: string | undefined): Promise<void> {
		if ([...seen.keys()].some(path => path.startsWith(folder))) return;
		const outcome = await saveFile(admin, folder, "", undefined, username, signal(REQUEST_TIMEOUT_MS));
		if (!outcome.ok) {
			const messages = outcome.reason === "invalid" ? outcome.problems.map(problem => problem.message) : [`Not deleted (${outcome.reason}).`];
			rejected.set(folder, { hash: null, problems: messages.map(message => ({ path: folder, message })) });
			log("warn", "workspace skill folder delete rejected", { path: folder });
			return;
		}
		for (const path of [...files.keys()]) if (path.startsWith(folder)) files.delete(path);
		for (const path of [...rejected.keys()]) if (path.startsWith(folder)) rejected.delete(path);
		for (const path of [...conflicts.keys()]) if (path.startsWith(folder)) await clearConflict(path);
		for (const path of [...queue]) if (path !== folder && path.startsWith(folder)) dropQueued(path);
		log("info", "workspace skill folder deleted", { path: folder, admin: username });
	}

	/** Sends the queue in order; held settings saves are skipped, the rest go on (skills work while locked). */
	async function drain(): Promise<void> {
		const skipped = new Set<string>();
		let username: string | undefined;
		let knowsUser = false;
		for (;;) {
			const entry = queue.find(path => !skipped.has(path));
			if (entry === undefined || stopped) return;
			if (held.has(entry)) {
				skipped.add(entry);
				continue;
			}
			if (!knowsUser) {
				// WEB-29: the orchestrator logs every applied change with the admin's name.
				username = (await admin.state()).username;
				knowsUser = true;
			}
			saving = entry;
			void publish();
			let keep = false;
			try {
				if (entry.endsWith("/")) await deleteFolder(entry, username);
				else keep = await push(entry, username);
			} finally {
				saving = undefined;
			}
			if (keep) skipped.add(entry);
			else dropQueued(entry);
			await persist();
		}
	}

	/** Replaces `path` with the orchestrator's version (`revision` "" = it has none; undefined = ask), dropping local edits. */
	async function reload(path: string, revision: string | undefined): Promise<void> {
		if (path.endsWith("/")) {
			rejected.delete(path);
			return;
		}
		if (locked && LOCKABLE.has(path)) {
			notice("warning", `${path} was not reloaded: ${LOCKED_MESSAGE}.`);
			return;
		}
		if (revision === undefined || (await readLocal(root, path))?.hash !== revision) {
			const remote = revision === "" ? undefined : await fetchFile(admin, path, signal(REQUEST_TIMEOUT_MS));
			if (remote) {
				await writeAtomic(join(root, path), remote.bytes);
				files.set(path, { revision: remote.revision, hash: remote.hash });
			} else {
				await removeLocal(path);
				files.delete(path);
			}
		} else files.set(path, { revision, hash: revision });
		await clearConflict(path);
		rejected.delete(path);
		dropQueued(path);
		held.delete(path);
	}

	/** WEB-28's two commands. */
	async function runCommand(command: SyncCommand): Promise<void> {
		if (command.command === "accept") {
			const paths = command.path === undefined ? [...conflicts.keys()] : conflicts.has(command.path) ? [command.path] : [];
			for (const path of paths) await reload(path, undefined);
			log("info", "workspace server version accepted", { paths });
			return;
		}
		if (command.path !== undefined) {
			await reload(command.path, undefined);
			log("info", "workspace file reloaded", { path: command.path });
			return;
		}
		const manifest = await fetchManifest(admin, undefined, signal(REQUEST_TIMEOUT_MS));
		if (!manifest) return;
		locked = manifest.locked;
		const remote = new Map(manifest.files.filter(file => syncable(file.path)).map(file => [file.path, file.revision]));
		for (const [path, revision] of remote) await reload(path, revision);
		const { present } = await walk();
		for (const path of new Set([...present.keys(), ...files.keys(), ...conflicts.keys(), ...rejected.keys()])) {
			if (!remote.has(path)) await reload(path, "");
		}
		etag = manifest.etag;
		log("info", "workspace reloaded", { files: remote.size });
	}

	/** Sleeps `ms`, or less when `kick` reports work while the orchestrator is reachable (or on stop). */
	function nap(ms: number): Promise<void> {
		if (kicked && unavailable === undefined) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(() => wake?.(), ms);
		wake = () => {
			clearTimeout(timer);
			wake = undefined;
			resolve();
		};
		return promise;
	}

	async function networkLoop(): Promise<void> {
		let nextPoll = 0;
		while (!stopped) {
			kicked = false;
			try {
				if (Date.now() >= nextPoll) {
					nextPoll = Date.now() + pollMs;
					await poll();
				}
				if (unavailable === undefined) {
					while (commands.length) {
						await runCommand(commands[0]!);
						commands.shift();
					}
					await drain();
				}
			} catch (err) {
				if (stopped) break;
				const reason = err instanceof OrchestratorUnavailable ? err.reason : errorMessage(err);
				if (unavailable === undefined) log("warn", "workspace sync: orchestrator unavailable", { error: reason, unsent: queue.length });
				unavailable = reason;
				// It may come back as another version: re-read schemas and the whole manifest.
				schemasFresh = false;
				etag = undefined;
			}
			await persist();
			await publish();
			await nap(unavailable === undefined ? Math.max(0, nextPoll - Date.now()) : pollMs);
		}
	}

	const loops = Promise.all([localLoop(), networkLoop()]);
	log("info", "workspace sync started", { workspace: root, unsent: queue.length });
	return {
		async stop() {
			stopped = true;
			stopper.abort();
			wake?.();
			await loops;
			await writes;
		},
	};
}
