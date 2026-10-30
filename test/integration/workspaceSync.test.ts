/**
 * The web process's config workspace sync (WEB-25 to WEB-28, WEB-31 layer 3) against the real orchestrator admin API:
 * vault, controller and every feature route as `main.ts` mounts them, behind an HTTP front that can be taken down
 * (orchestrator unreachable) and pointed at another admin API instance (orchestrator restarted, vault locked). The
 * workspace and the extension contract files (`status.json`, `commands/`) are read and written the way code-server and
 * the extension do. Discord's REST API and GitHub are faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdminApi, createAdminApi } from "../../src/orchestrator/api/admin";
import { createAdminFeatures } from "../../src/orchestrator/api/features";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { type AgentLog, openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import { openSignins, type Signins } from "../../src/orchestrator/store/signins";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { ADMIN_PREFIX } from "../../src/shared/adminApi";
import type { WorkspaceSchemas } from "../../src/shared/adminWorkspace";
import { openRollingFiles, type RollingFiles } from "../../src/shared/rollinglog";
import { SYNC_COMMANDS_DIR, SYNC_DIR, SYNC_STATUS_FILE, type SyncCommand, type SyncStatus, WORKSPACE_DIR } from "../../src/shared/workspaceSync";
import { createAdminClient } from "../../src/web/adminClient";
import { README } from "../../src/web/workspace/owned";
import { startWorkspaceSync, type WorkspaceSync } from "../../src/web/workspace/sync";
import { eventually } from "../fakes/adminPages";
import { outsideImageUpdater } from "../fakes/ompUpdates";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeDiscordRest, startFakeDiscordRest } from "../fakes/discordRest";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const WEB_TOKEN = "web-token-for-workspace-sync";
const ADMIN = "admin";
const PASSWORD = "correct horse battery";
const ADMIN_DISCORD_USER = "234567890123456789";
/** Sped-up loops; production uses 300 ms and 1 s. */
const SCAN_MS = 20;
const POLL_MS = 50;
const LOCKED = "Settings are locked: log in to the web UI";

interface Base {
	stateDir: string;
	ompDir: string;
	home: string;
	db: Db;
	vault: Vault;
	signins: Signins;
	agentLog: AgentLog;
	processLog: RollingFiles;
	controller: Controller;
	discord: FakeDiscordRest;
	github: FakeGitHub;
}

interface Stack extends Base {
	/** The admin API the front answers with. */
	admin: AdminApi;
	front: Server<undefined>;
	port: number;
	sync?: WorkspaceSync;
}

let s: Stack;

/** The admin API with every feature route, as `main.ts` mounts it, over `vault`. */
function adminFor(base: Base, vault: Vault): AdminApi {
	const features = createAdminFeatures({
		db: base.db,
		vault,
		signins: base.signins,
		dispatcher: createFakeDispatcher(),
		agentLog: base.agentLog,
		processLog: base.processLog,
		stateDir: base.stateDir,
		ompDir: base.ompDir,
		controller: base.controller,
		workerCapacity: 4,
		ompUpdates: outsideImageUpdater(base.db),
		discordApi: base.discord.api,
	});
	return createAdminApi({
		db: base.db,
		vault,
		controller: base.controller,
		dispatcher: createFakeDispatcher(),
		version: "0.0.0-test",
		workerCapacity: 4,
		webToken: WEB_TOKEN,
		setupToken: undefined,
		routes: features.routes,
		checkChannels: features.checkChannels,
	});
}

/** The orchestrator's HTTP endpoint as the web process sees it; `port` keeps it at one address across restarts. */
function startFront(port: number): Server<undefined> {
	return Bun.serve({ hostname: "127.0.0.1", port, fetch: req => s.admin.handle(req) });
}

const startSync = () => startWorkspaceSync({ admin: createAdminClient({ baseUrl: `http://127.0.0.1:${s.port}`, token: WEB_TOKEN, timeoutMs: 5_000 }), home: s.home, scanMs: SCAN_MS, pollMs: POLL_MS });

/** Another admin's change, straight to the admin API (a web page or another editor). */
function call(method: string, path: string, init: { body?: BodyInit; json?: unknown } = {}): Promise<Response> {
	const headers: Record<string, string> = { authorization: `Bearer ${WEB_TOKEN}`, "x-agentbot-admin": ADMIN };
	if (init.json !== undefined) headers["content-type"] = "application/json";
	return s.admin.handle(new Request(`http://orchestrator${ADMIN_PREFIX}${path}`, { method, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) }));
}

async function remote(path: string): Promise<{ text: string; revision: string } | undefined> {
	const res = await call("GET", `/workspace/file?path=${encodeURIComponent(path)}`);
	if (res.status === 404) return undefined;
	expect(res.status).toBe(200);
	return { text: await res.text(), revision: res.headers.get("x-revision")! };
}

async function putRemote(path: string, text: string): Promise<void> {
	const base = (await remote(path))?.revision ?? "";
	const res = await call("PUT", `/workspace/file?path=${encodeURIComponent(path)}&base=${base}`, { body: text });
	expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 200, body: { ok: true } });
}

/** Saves settings as the Settings page does, changing `maxConcurrentJobs`. */
async function settingsPageSave(maxConcurrentJobs: number): Promise<void> {
	const { config } = s.vault.readSettings()!;
	const res = await call("PUT", "/settings", { json: { config: { ...config, limits: { ...config.limits, maxConcurrentJobs } }, secrets: {} } });
	expect(res.status).toBe(200);
}

const local = (path: string) => join(s.home, WORKSPACE_DIR, path);
const readLocal = (path: string) => readFileSync(local(path), "utf8");
const render = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;
const skill = (name: string, description = "Reviews code.") => `---\nname: ${name}\ndescription: ${description}\n---\n\nRead the diff.\n`;
const agent = (name: string) => `---\nname: ${name}\ndescription: Helps out.\n---\n\nHelp.\n`;

function status(): SyncStatus | undefined {
	try {
		return JSON.parse(readFileSync(join(s.home, SYNC_DIR, SYNC_STATUS_FILE), "utf8")) as SyncStatus;
	} catch {
		return undefined;
	}
}

const statusWhere = (check: (status: SyncStatus) => boolean, what: string) =>
	eventually(async () => {
		const current = status();
		return current && check(current) ? current : undefined;
	}, what);

const synced = () => statusWhere(st => st.state === "synced", "status synced");

/** Written the way the extension writes a command: complete, then renamed into place. */
function command(id: string, cmd: SyncCommand): void {
	const dir = join(s.home, SYNC_DIR, SYNC_COMMANDS_DIR);
	writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(cmd));
	renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
}

/** The orchestrator goes away and the sync notices. */
async function offline(): Promise<void> {
	await s.front.stop(true);
	await statusWhere(st => st.state === "unavailable", "status unavailable");
}

function online(): void {
	s.front = startFront(s.port);
}

/** A conflict on `path`: changed locally while the orchestrator was unreachable, and there meanwhile. */
async function conflictOn(path: string, mine: string, theirs: string): Promise<SyncStatus> {
	await offline();
	writeFileSync(local(path), mine);
	await putRemote(path, theirs);
	online();
	return statusWhere(st => st.state === "conflict" && st.conflicts.includes(path), `conflict on ${path}`);
}

beforeAll(async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-wssync-"));
	mkdirSync(join(stateDir, "logs", "orchestrator"), { recursive: true });
	const db = openDb(dbPath(stateDir));
	const vault = await openVault(db);
	const agentLog = await openAgentLog({ dir: join(stateDir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const processLog = openRollingFiles({ dir: join(stateDir, "logs", "orchestrator"), prefix: "orchestrator", maxBytes: 1024 ** 3 });
	const github = startFakeGitHub();
	const discord = startFakeDiscordRest({ token: "real-bot-token" });
	const controller = createController({
		stateDir,
		db,
		vault,
		agentLog,
		dispatcher: createFakeDispatcher(),
		connectDiscord: () => createFakeDiscord({ guildId: discord.guildId }),
		connectGitHub: gh => createGitHub({ ...gh, baseUrl: github.url, throttle: false }),
	});
	const base: Base = {
		stateDir,
		ompDir: join(stateDir, "omp"),
		home: join(stateDir, "home"),
		db,
		vault,
		signins: await openSignins(stateDir),
		agentLog,
		processLog,
		controller,
		discord,
		github,
	};
	// The front reads `s.admin` per request, so it can be started before `s` is complete.
	const front = startFront(0);
	s = { ...base, admin: adminFor(base, vault), front, port: front.port! };
	await vault.initialize(ADMIN, PASSWORD);
	await ensureOmpAssetsDir(s.ompDir);
	await controller.apply();

	// What the orchestrator holds before the web process first starts.
	const page = await call("PUT", "/settings", {
		json: {
			config: { discord: { guildId: discord.guildId, allowedUserIds: [ADMIN_DISCORD_USER] }, github: { appId: github.appId } },
			secrets: { discordToken: "real-bot-token", githubAppPrivateKey: github.privateKey },
		},
	});
	expect(page.status).toBe(200);
	await putRemote("skills/review/SKILL.md", skill("review"));
	await putRemote("skills/review/docs/guide.txt", "Look for bugs.\n");
	await putRemote("agents/helper.md", agent("helper"));
	s.sync = await startSync();
});

afterAll(async () => {
	await s.sync?.stop();
	await s.front.stop(true);
	await s.controller.stop();
	await s.github.stop();
	await s.discord.stop();
	s.signins.close();
	s.db.close();
	rmSync(s.stateDir, { recursive: true, force: true });
});

describe("workspace sync", () => {
	test("first start on an empty workspace pulls everything, with the README and the schema mapping", async () => {
		const paths = ["settings.json", "omp.json", "skills/review/SKILL.md", "skills/review/docs/guide.txt", "agents/helper.md"];
		const remotes = await Promise.all(paths.map(async path => (await remote(path))!.text));
		await eventually(async () => (paths.every((path, i) => existsSync(local(path)) && readLocal(path) === remotes[i]) ? true : undefined), "every file pulled");
		expect(readLocal("settings.json")).toContain(`"discordToken": "<set>"`);
		expect(readLocal("README.md")).toBe(README);
		const schemas = (await (await call("GET", "/workspace/schemas")).json()) as WorkspaceSchemas;
		const mapping = [
			{ fileMatch: ["/settings.json"], schema: schemas.settings },
			{ fileMatch: ["/omp.json"], schema: schemas.omp },
		];
		await eventually(async () => (Bun.deepEquals(JSON.parse(readLocal(".vscode/settings.json"))["json.schemas"], mapping) ? true : undefined), "schema mapping");
		const done = await synced();
		expect(done).toMatchObject({ problems: [], conflicts: [], notices: [] });
	});

	test("a saved skill reaches the orchestrator within a second and is in the next run's bundle", async () => {
		const bundle = (await skillsBundle(s.ompDir)).hash;
		const savedAt = Date.now();
		writeFileSync(local("skills/review/SKILL.md"), skill("review", "Reviews code carefully."));
		await eventually(async () => ((await remote("skills/review/SKILL.md"))?.text.includes("carefully") ? true : undefined), "skill pushed");
		expect(Date.now() - savedAt).toBeLessThan(1_000);
		expect((await skillsBundle(s.ompDir)).hash).not.toBe(bundle);
		await synced();
	});

	test("a new skill folder: a file refused before SKILL.md goes in after it; deleting the folder deletes the skill", async () => {
		mkdirSync(local("skills/lint/docs"), { recursive: true });
		writeFileSync(local("skills/lint/docs/rules.txt"), "No tabs.\n");
		const refused = await statusWhere(st => st.state === "rejected", "rules.txt refused without SKILL.md");
		expect(refused.problems.map(p => p.path)).toEqual(["skills/lint/docs/rules.txt"]);

		writeFileSync(local("skills/lint/SKILL.md"), skill("lint"));
		await synced();
		expect((await remote("skills/lint/SKILL.md"))?.text).toBe(skill("lint"));
		expect((await remote("skills/lint/docs/rules.txt"))?.text).toBe("No tabs.\n");

		rmSync(local("skills/lint"), { recursive: true });
		await eventually(async () => (existsSync(join(s.ompDir, "skills", "lint")) ? undefined : true), "skill folder deleted");
		await synced();
		expect(await remote("skills/lint/SKILL.md")).toBeUndefined();
	});

	test("settings.json is applied like a Settings page save; the re-rendered file replaces the local one", async () => {
		const edited = JSON.parse(readLocal("settings.json"));
		edited.limits.maxConcurrentJobs = 3;
		// Two-space indentation: the orchestrator stores the same settings and renders them its own way.
		writeFileSync(local("settings.json"), JSON.stringify(edited, null, 2));
		const done = await statusWhere(st => st.state === "synced" && st.notices.some(n => n.text.startsWith("Settings saved. Engine is ")), "settings notice");
		expect(s.vault.readSettings()!.config.limits.maxConcurrentJobs).toBe(3);
		expect(readLocal("settings.json")).toBe((await remote("settings.json"))!.text);
		expect(readLocal("settings.json")).toContain('\t"limits": {');
		const notice = done.notices.find(n => n.text.startsWith("Settings saved."))!;
		expect(notice.text).toMatch(/^Settings saved\. Engine is [a-z]+(: .+)?\.$/);
	});

	test("an invalid settings.json shows its errors at the line, changes nothing, and keeps the edit", async () => {
		const valid = readLocal("settings.json");
		const invalid = valid.replace('"maxConcurrentJobs": 3', '"maxConcurrentJobs": "lots"');
		expect(invalid).not.toBe(valid);
		writeFileSync(local("settings.json"), invalid);
		const refused = await statusWhere(st => st.state === "rejected", "settings rejected");
		const line = invalid.slice(0, invalid.indexOf('"maxConcurrentJobs"', invalid.indexOf('"limits"'))).split("\n").length;
		expect(refused.problems).toEqual([{ path: "settings.json", message: expect.any(String), line }]);
		expect(s.vault.readSettings()!.config.limits.maxConcurrentJobs).toBe(3);
		expect(readLocal("settings.json")).toBe(invalid);

		// Putting it right clears the problem; the content is what the orchestrator has, so nothing is sent.
		writeFileSync(local("settings.json"), valid);
		const fixed = await synced();
		expect(fixed.problems).toEqual([]);
	});

	test("changes made elsewhere are pulled, deletes too", async () => {
		await putRemote("skills/review/SKILL.md", skill("review", "Reviews code twice."));
		await eventually(async () => (readLocal("skills/review/SKILL.md").includes("twice") ? true : undefined), "remote change pulled");

		const { revision } = (await remote("agents/helper.md"))!;
		expect((await call("DELETE", `/workspace/file?path=agents/helper.md&base=${revision}`)).status).toBe(200);
		await eventually(async () => (existsSync(local("agents/helper.md")) ? undefined : true), "remote delete pulled");
		await synced();
	});

	test("the same setting edited on the Settings page and here: .remote and a conflict; a merged save resolves it", async () => {
		const mine = JSON.parse(readLocal("settings.json"));
		mine.limits.maxConcurrentJobs = 6;
		await offline();
		writeFileSync(local("settings.json"), render(mine));
		await settingsPageSave(5);
		online();
		const conflict = await statusWhere(st => st.state === "conflict", "settings conflict");
		expect(conflict.conflicts).toEqual(["settings.json"]);
		expect(JSON.parse(readLocal("settings.json.remote")).limits.maxConcurrentJobs).toBe(5);
		expect(JSON.parse(readLocal("settings.json")).limits.maxConcurrentJobs).toBe(6);
		expect(s.vault.readSettings()!.config.limits.maxConcurrentJobs).toBe(5);

		const merged = JSON.parse(readLocal("settings.json.remote"));
		merged.limits.maxConcurrentJobs = 6;
		writeFileSync(local("settings.json"), render(merged));
		await synced();
		expect(existsSync(local("settings.json.remote"))).toBe(false);
		expect(s.vault.readSettings()!.config.limits.maxConcurrentJobs).toBe(6);
	});

	test("Accept server version replaces the conflicting file and removes its .remote", async () => {
		await conflictOn("skills/review/SKILL.md", skill("review", "Mine."), skill("review", "Theirs."));
		expect(readLocal("skills/review/SKILL.md.remote")).toBe(skill("review", "Theirs."));
		command("0001-accept", { command: "accept", path: "skills/review/SKILL.md" });
		await synced();
		expect(readLocal("skills/review/SKILL.md")).toBe(skill("review", "Theirs."));
		expect(existsSync(local("skills/review/SKILL.md.remote"))).toBe(false);
		expect(existsSync(join(s.home, SYNC_DIR, SYNC_COMMANDS_DIR, "0001-accept.json"))).toBe(false);
	});

	test("Reload from server drops local edits: one file, or every file", async () => {
		writeFileSync(local("skills/review/SKILL.md"), "no frontmatter\n");
		await statusWhere(st => st.problems.some(p => p.path === "skills/review/SKILL.md"), "broken skill rejected");
		command("0002-reload", { command: "reload", path: "skills/review/SKILL.md" });
		const reloaded = await synced();
		expect(reloaded.problems).toEqual([]);
		expect(readLocal("skills/review/SKILL.md")).toBe((await remote("skills/review/SKILL.md"))!.text);

		writeFileSync(local("agents/junk.md"), "no frontmatter\n");
		writeFileSync(local("skills/review/docs/guide.txt"), "Edited here.\n");
		await statusWhere(st => st.problems.some(p => p.path === "agents/junk.md"), "junk agent rejected");
		await eventually(async () => ((await remote("skills/review/docs/guide.txt"))?.text === "Edited here.\n" ? true : undefined), "guide pushed");
		command("0003-reload", { command: "reload" });
		await synced();
		expect(existsSync(local("agents/junk.md"))).toBe(false);
		expect(readLocal("skills/review/docs/guide.txt")).toBe("Edited here.\n");
		expect(readLocal("settings.json")).toBe((await remote("settings.json"))!.text);
	});

	test(".vscode/tasks.json and launch.json are deleted, and .vscode/settings.json edits are reverted", async () => {
		const owned = readLocal(".vscode/settings.json");
		writeFileSync(local(".vscode/tasks.json"), JSON.stringify({ version: "2.0.0", tasks: [{ label: "x", type: "shell", command: "id" }] }));
		writeFileSync(local(".vscode/launch.json"), JSON.stringify({ version: "0.2.0", configurations: [] }));
		writeFileSync(local(".vscode/settings.json"), JSON.stringify({ "terminal.integrated.profiles.linux": { evil: { path: "/bin/dash" } } }));
		const after = await statusWhere(
			st => [".vscode/tasks.json", ".vscode/launch.json", ".vscode/settings.json"].every(path => st.notices.some(n => n.text.startsWith(path))),
			"owned-file notices",
		);
		expect(existsSync(local(".vscode/tasks.json"))).toBe(false);
		expect(existsSync(local(".vscode/launch.json"))).toBe(false);
		expect(readLocal(".vscode/settings.json")).toBe(owned);
		expect(after.notices.every(n => n.level !== "error")).toBe(true);
	});

	test("saves made while the orchestrator is unreachable survive a web restart and go in once it is back", async () => {
		await offline();
		writeFileSync(local("skills/review/SKILL.md"), skill("review", "Queued while offline."));
		await statusWhere(st => st.state === "unavailable" && (st.message ?? "").includes("1 unsent"), "save queued");
		await s.sync?.stop();

		s.sync = await startSync();
		await statusWhere(st => st.state === "unavailable" && (st.message ?? "").includes("1 unsent"), "queue restored after restart");
		expect((await remote("skills/review/SKILL.md"))?.text).not.toContain("Queued");
		online();
		await synced();
		expect((await remote("skills/review/SKILL.md"))?.text).toBe(skill("review", "Queued while offline."));
	});

	test("a vanished workspace folder is pulled again; nothing is deleted on the orchestrator", async () => {
		const skillText = (await remote("skills/review/SKILL.md"))!.text;
		rmSync(join(s.home, WORKSPACE_DIR), { recursive: true });
		await eventually(async () => (existsSync(local("skills/review/SKILL.md")) && existsSync(local("settings.json")) ? true : undefined), "workspace pulled again");
		await synced();
		expect(readLocal("skills/review/SKILL.md")).toBe(skillText);
		expect((await remote("skills/review/SKILL.md"))?.text).toBe(skillText);
		expect(readLocal("README.md")).toBe(README);
	});

	test("locked settings: saves are held (skills keep working) and sent once an admin logs in", async () => {
		// The orchestrator restarted and nobody has logged in yet.
		s.admin = adminFor(s, await openVault(s.db));
		const omp = JSON.parse(readLocal("omp.json"));
		omp.settings["git.enabled"] = false;
		writeFileSync(local("omp.json"), render(omp));
		const held = await statusWhere(st => st.state === "unavailable" && st.message === LOCKED, "omp save held");
		expect(held.problems).toEqual([]);

		writeFileSync(local("agents/locked.md"), agent("locked"));
		await eventually(async () => ((await remote("agents/locked.md")) ? true : undefined), "agent saved while locked");
		// Left out of the locked manifest, not deleted.
		expect(existsSync(local("settings.json"))).toBe(true);
		expect(existsSync(local("omp.json"))).toBe(true);

		const login = await call("POST", "/login", { json: { username: ADMIN, password: PASSWORD } });
		expect(login.status).toBe(200);
		await synced();
		expect(JSON.parse((await remote("omp.json"))!.text).settings["git.enabled"]).toBe(false);
		expect(existsSync(local("settings.json"))).toBe(true);
	});
});
