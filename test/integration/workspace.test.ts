/**
 * The config workspace API (`/internal/admin/workspace*`, WEB-25 to WEB-29) over the real orchestrator admin API: vault,
 * controller and every feature route as `main.ts` mounts them. Discord's REST API (the WEB-24 channel check) and GitHub
 * are faked; the Discord gateway is the fake engine connection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { outsideImageUpdater } from "../fakes/ompUpdates";
import { ADMIN_PREFIX } from "../../src/shared/adminApi";
import {
	CREDENTIALS_ON_OMP_PAGE,
	SECRET_NOT_SET,
	SECRET_SET,
	SECRETS_ON_SETTINGS_PAGE,
	type WorkspaceConflict,
	type WorkspaceManifest,
	type WorkspaceRejection,
	type WorkspaceSaveResult,
	type WorkspaceSchemas,
} from "../../src/shared/adminWorkspace";
import { setLogSink } from "../../src/shared/log";
import { openRollingFiles, type RollingFiles } from "../../src/shared/rollinglog";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeDiscordRest, startFakeDiscordRest } from "../fakes/discordRest";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const WEB_TOKEN = "web-token-for-workspace";
const ADMIN = "admin";
const PASSWORD = "correct horse battery";
const ADMIN_DISCORD_USER = "234567890123456789";

interface Base {
	stateDir: string;
	ompDir: string;
	db: Db;
	vault: Vault;
	signins: Signins;
	agentLog: AgentLog;
	processLog: RollingFiles;
	controller: Controller;
	discord: FakeDiscordRest;
	github: FakeGitHub;
	logs: string[];
}

interface Stack extends Base {
	admin: AdminApi;
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

function call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; json?: unknown } = {}, admin = s.admin): Promise<Response> {
	const headers: Record<string, string> = { authorization: `Bearer ${WEB_TOKEN}`, "x-agentbot-admin": ADMIN, ...init.headers };
	if (init.json !== undefined) headers["content-type"] = "application/json";
	return admin.handle(new Request(`http://orchestrator${ADMIN_PREFIX}${path}`, { method, headers, body: init.json === undefined ? init.body : JSON.stringify(init.json) }));
}

const fileUrl = (path: string, base?: string) => `/workspace/file?path=${encodeURIComponent(path)}${base === undefined ? "" : `&base=${base}`}`;
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const render = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

async function manifest(admin = s.admin): Promise<WorkspaceManifest> {
	const res = await call("GET", "/workspace", {}, admin);
	expect(res.status).toBe(200);
	return (await res.json()) as WorkspaceManifest;
}

async function currentRevision(path: string): Promise<string> {
	return (await manifest()).files.find(f => f.path === path)?.revision ?? "";
}

async function getFile(path: string): Promise<{ text: string; revision: string }> {
	const res = await call("GET", fileUrl(path));
	expect(res.status).toBe(200);
	return { text: await res.text(), revision: res.headers.get("x-revision")! };
}

async function getJson(path: string): Promise<{ json: Record<string, any>; revision: string }> {
	const { text, revision } = await getFile(path);
	return { json: JSON.parse(text), revision };
}

function put(path: string, base: string, body: string | Uint8Array<ArrayBuffer>, admin = s.admin): Promise<Response> {
	return call("PUT", fileUrl(path, base), { body }, admin);
}

async function saved(res: Response): Promise<WorkspaceSaveResult> {
	const body = await res.json();
	expect({ status: res.status, body }).toMatchObject({ status: 200, body: { ok: true } });
	return body as WorkspaceSaveResult;
}

async function rejected(res: Response): Promise<WorkspaceRejection["problems"]> {
	const body = (await res.json()) as WorkspaceRejection;
	expect({ status: res.status, reason: body.reason }).toEqual({ status: 400, reason: "invalid" });
	return body.problems;
}

const skill = (name: string, description = "Reviews code.") => `---\nname: ${name}\ndescription: ${description}\n---\n\nRead the diff.\n`;

beforeAll(async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-workspace-"));
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
	const logs: string[] = [];
	setLogSink(line => logs.push(line));
	const base: Base = { stateDir, ompDir: join(stateDir, "omp"), db, vault, signins: await openSignins(stateDir), agentLog, processLog, controller, discord, github, logs };
	s = { ...base, admin: adminFor(base, vault) };
	await vault.initialize(ADMIN, PASSWORD);
	await ensureOmpAssetsDir(base.ompDir);
	await controller.apply();
});

afterAll(async () => {
	setLogSink(undefined);
	await s.controller.stop();
	await s.github.stop();
	await s.discord.stop();
	s.signins.close();
	s.db.close();
	rmSync(s.stateDir, { recursive: true, force: true });
});

describe("settings.json (WEB-25, WEB-26)", () => {
	test("absent until the Settings page saved settings; then rendered with defaults and masked secrets", async () => {
		expect((await manifest()).files.map(f => f.path)).toEqual(["omp.json"]);
		expect((await call("GET", fileUrl("settings.json"))).status).toBe(404);

		const page = await call("PUT", "/settings", {
			json: {
				config: { discord: { guildId: s.discord.guildId, allowedUserIds: [ADMIN_DISCORD_USER] }, github: { appId: s.github.appId } },
				secrets: { discordToken: "real-bot-token", githubAppPrivateKey: s.github.privateKey, providerKeys: { openai: "sk-provider-key" } },
			},
		});
		expect(page.status).toBe(200);

		const listed = await manifest();
		expect(listed.locked).toBe(false);
		expect(listed.files.map(f => f.path)).toEqual(["settings.json", "omp.json"]);
		const { text, revision } = await getFile("settings.json");
		expect(revision).toBe(sha256(text));
		expect(listed.files[0]).toEqual({ path: "settings.json", revision, size: Buffer.byteLength(text) });
		expect(text).not.toContain("real-bot-token");
		expect(text).not.toContain("sk-provider-key");
		const json = JSON.parse(text);
		expect(json.secrets).toEqual({ discordToken: SECRET_SET, githubAppPrivateKey: SECRET_SET, providerKeys: { openai: SECRET_SET } });
		expect(json.limits.maxConcurrentJobs).toBe(2);
		expect(json.labels).toEqual({ trigger: "agentbot", states: {} });
		expect(text).toBe(render(json));
	});

	test("the manifest answers 304 to its etag", async () => {
		const { etag } = await manifest();
		const res = await call("GET", "/workspace", { headers: { "if-none-match": `"${etag}"` } });
		expect(res.status).toBe(304);
		expect(res.headers.get("etag")).toBe(`"${etag}"`);
	});

	test("a valid file is applied like a Settings page save: the engine restarts and the phase is returned", async () => {
		const work = s.discord.addChannel({ name: "agentbot-work" });
		const { json, revision } = await getJson("settings.json");
		json.discord.workChannelId = work.id;
		json.limits.maxConcurrentJobs = 3;
		const result = await saved(await put("settings.json", revision, render(json)));
		// The new key is stored in the schema's place, not at the end where it was typed: the file is re-rendered.
		expect(result).toMatchObject({ phase: "running", rewritten: true, warnings: [] });
		expect(s.controller.status().phase).toBe("running");
		const stored = s.vault.readSettings()!;
		expect(stored.config.limits.maxConcurrentJobs).toBe(3);
		expect(stored.secrets).toEqual({ discordToken: "real-bot-token", githubAppPrivateKey: s.github.privateKey.trim(), providerKeys: { openai: "sk-provider-key" } });
		expect(result.revision).toBe(await currentRevision("settings.json"));
		expect(s.logs.some(line => line.includes('"msg":"workspace change applied"') && line.includes('"file":"settings.json"') && line.includes(`"admin":"${ADMIN}"`))).toBe(true);

		const { json: rendered } = await getJson("settings.json");
		rendered.limits.maxConcurrentJobs = 4;
		const edited = await saved(await put("settings.json", result.revision, render(rendered)));
		expect(edited).toMatchObject({ phase: "running", rewritten: false });
		expect(s.vault.readSettings()!.config.limits.maxConcurrentJobs).toBe(4);

		// Defaults left out and two-space indentation: stored the same, re-rendered, so the web process refreshes its copy.
		const { limits: _limits, agent: _agent, ...shorter } = rendered;
		const again = await saved(await put("settings.json", edited.revision, JSON.stringify({ ...shorter, limits: { maxConcurrentJobs: 4 } }, null, 2)));
		expect(again).toMatchObject({ rewritten: true, revision: edited.revision });

		// "<not set>" deletes a provider key; "<set>" keeps the others.
		const { json: current, revision: base } = await getJson("settings.json");
		current.secrets.providerKeys.openai = SECRET_NOT_SET;
		await saved(await put("settings.json", base, render(current)));
		expect(s.vault.readSettings()!.secrets.providerKeys).toEqual({});
	});

	test("an invalid file shows its problems and changes nothing", async () => {
		const before = s.vault.readSettings();
		const { json, revision } = await getJson("settings.json");
		const attempt = (change: (file: Record<string, any>) => void) => {
			const file = structuredClone(json);
			change(file);
			return put("settings.json", revision, render(file));
		};

		expect(await rejected(await attempt(f => (f.limits.maxConcurrentJobs = "three")))).toEqual([
			{ message: expect.stringContaining("Invalid config: limits.maxConcurrentJobs:"), jsonPath: ["limits", "maxConcurrentJobs"] },
		]);
		const gone = await rejected(await attempt(f => (f.discord.askChannelIds = ["111111111111111111"])));
		expect(gone).toEqual([{ message: expect.stringContaining("channel 111111111111111111 no longer exists"), jsonPath: ["discord", "askChannelIds", 0] }]);
		expect(await rejected(await attempt(f => (f.secrets.discordToken = "a-real-token")))).toEqual([{ message: SECRETS_ON_SETTINGS_PAGE, jsonPath: ["secrets", "discordToken"] }]);
		expect(await rejected(await attempt(f => (f.secrets.providerKeys.anthropic = SECRET_SET)))).toEqual([
			{ message: SECRETS_ON_SETTINGS_PAGE, jsonPath: ["secrets", "providerKeys", "anthropic"] },
		]);
		expect(await rejected(await attempt(f => (f.limits.maxConcurentJobs = 4)))).toEqual([{ message: 'Unknown setting "limits.maxConcurentJobs".', jsonPath: ["limits", "maxConcurentJobs"] }]);
		expect(await rejected(await attempt(f => (f.secrets.githubAppPrivateKey = SECRET_NOT_SET)))).toEqual([
			{ message: expect.stringContaining("secrets.githubAppPrivateKey"), jsonPath: ["secrets", "githubAppPrivateKey"] },
		]);
		const syntax = await rejected(await put("settings.json", revision, render(json).replace('"guildId"', "guildId")));
		expect(syntax).toEqual([{ message: expect.stringContaining("settings.json is not valid JSON"), line: 3 }]);

		expect(s.vault.readSettings()).toEqual(before);
		expect(await currentRevision("settings.json")).toBe(revision);
		expect(s.logs.some(line => line.includes('"msg":"workspace change rejected"'))).toBe(true);
	});

	test("a stale base is a conflict; a Settings page save changes the revision", async () => {
		const { json, revision } = await getJson("settings.json");
		const stale = await put("settings.json", sha256("an older version"), render(json));
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ ok: false, reason: "conflict", revision } satisfies WorkspaceConflict);

		const page = await call("PUT", "/settings", { json: { config: { ...s.vault.readSettings()!.config, agent: { name: "Robo" } }, secrets: {} } });
		expect(page.status).toBe(200);
		const changed = await currentRevision("settings.json");
		expect(changed).not.toBe(revision);
		expect((await getJson("settings.json")).json.agent.name).toBe("Robo");
		const overtaken = await put("settings.json", revision, render(json));
		expect(overtaken.status).toBe(409);
		expect(((await overtaken.json()) as WorkspaceConflict).revision).toBe(changed);
	});

	test("settings.json and omp.json can't be deleted", async () => {
		expect(await rejected(await call("DELETE", fileUrl("settings.json", await currentRevision("settings.json"))))).toEqual([{ message: "settings.json can't be deleted." }]);
	});
});

describe("omp.json (WEB-25, WEB-26)", () => {
	test("credentials and env/header values are masked and survive a round trip", async () => {
		const page = await call("PUT", "/omp", {
			json: {
				settings: [{ id: "searxng.token", value: "searx-secret-token" }],
				servers: [{ name: "search", type: "stdio", command: "npx", env: [{ key: "TOKEN", value: "env-secret" }] }],
			},
		});
		expect(page.status).toBe(200);
		const { text, revision } = await getFile("omp.json");
		expect(text).not.toContain("searx-secret-token");
		expect(text).not.toContain("env-secret");
		expect(JSON.parse(text)).toEqual({ settings: { "searxng.token": SECRET_SET }, mcpServers: { search: { type: "stdio", command: "npx", env: { TOKEN: SECRET_SET } } } });

		const same = await saved(await put("omp.json", revision, text));
		expect(same).toEqual({ ok: true, revision, rewritten: false });

		const edited = JSON.parse(text);
		edited.settings["git.enabled"] = false;
		edited.mcpServers.search.env.REGION = SECRET_NOT_SET;
		await saved(await put("omp.json", revision, render(edited)));
		expect(s.vault.readOmpConfig()).toEqual({
			settings: { "searxng.token": "searx-secret-token", "git.enabled": false },
			mcpServers: { search: { type: "stdio", command: "npx", env: { TOKEN: "env-secret", REGION: "" } } },
		});
	});

	test("real credential values, pinned and invalid settings are refused", async () => {
		const before = s.vault.readOmpConfig();
		const { json, revision } = await getJson("omp.json");
		const attempt = (change: (file: Record<string, any>) => void) => {
			const file = structuredClone(json);
			change(file);
			return put("omp.json", revision, render(file));
		};
		expect(await rejected(await attempt(f => (f.settings["searxng.token"] = "typed-secret")))).toEqual([{ message: CREDENTIALS_ON_OMP_PAGE, jsonPath: ["settings", "searxng.token"] }]);
		expect(await rejected(await attempt(f => (f.mcpServers.search.env.TOKEN = "typed-env")))).toEqual([{ message: CREDENTIALS_ON_OMP_PAGE, jsonPath: ["mcpServers", "search", "env", "TOKEN"] }]);
		expect(await rejected(await attempt(f => (f.settings["async.enabled"] = true)))).toEqual([
			{ message: expect.stringContaining("async.enabled is managed by AgentBot"), jsonPath: ["settings", "async.enabled"] },
		]);
		expect(await rejected(await attempt(f => (f.settings["loop.conditionTimeoutMs"] = "soon")))).toEqual([
			{ message: expect.stringMatching(/^loop\.conditionTimeoutMs: /), jsonPath: ["settings", "loop.conditionTimeoutMs"] },
		]);
		expect(await rejected(await attempt(f => (f.mcpServers.web = { type: "http", url: "ftp://example.com" })))).toEqual([
			{ message: expect.stringContaining("http(s)"), jsonPath: ["mcpServers", "web", "url"] },
		]);
		expect(await rejected(await attempt(f => (f.mcpServers.search.evn = {})))).toEqual([{ message: 'Unknown setting "mcpServers.search.evn".', jsonPath: ["mcpServers", "search", "evn"] }]);
		expect(s.vault.readOmpConfig()).toEqual(before);
	});

	test("credentials in MCP URLs and stdio args are masked, kept on a round trip, and refused in clear (F13)", async () => {
		const page = await call("PUT", "/omp", {
			json: {
				settings: [],
				servers: [
					{ name: "remote", type: "http", url: "https://bot:url-password@mcp.example.com/v1?api_key=query-secret&region=eu" },
					{ name: "local", type: "stdio", command: "npx", args: ["-y", "some-mcp", "--api-key", "arg-secret", "--token=eq-secret", "--verbose"] },
				],
			},
		});
		expect(page.status).toBe(200);
		const { text, revision } = await getFile("omp.json");
		for (const secret of ["url-password", "query-secret", "arg-secret", "eq-secret", "bot:"]) expect(text).not.toContain(secret);
		const file = JSON.parse(text);
		expect(file.mcpServers.remote.url).toBe(`https://${SECRET_SET}:${SECRET_SET}@mcp.example.com/v1?api_key=${SECRET_SET}&region=${SECRET_SET}`);
		expect(file.mcpServers.local.args).toEqual(["-y", "some-mcp", "--api-key", SECRET_SET, `--token=${SECRET_SET}`, "--verbose"]);

		// Sent back with an unrelated change, the stored values stay.
		file.mcpServers.local.args.push("--debug");
		const saved2 = await saved(await put("omp.json", revision, render(file)));
		expect(s.vault.readOmpConfig()).toMatchObject({
			mcpServers: {
				remote: { url: "https://bot:url-password@mcp.example.com/v1?api_key=query-secret&region=eu" },
				local: { args: ["-y", "some-mcp", "--api-key", "arg-secret", "--token=eq-secret", "--verbose", "--debug"] },
			},
		});

		const before = s.vault.readOmpConfig();
		const { json } = await getJson("omp.json");
		const attempt = (change: (f: Record<string, any>) => void) => {
			const copy = structuredClone(json);
			change(copy);
			return put("omp.json", saved2.revision, render(copy));
		};
		const urlPath = ["mcpServers", "remote", "url"];
		expect((await rejected(await attempt(f => (f.mcpServers.remote.url = "https://mcp.example.com/v1?api_key=typed"))))[0]?.jsonPath).toEqual(urlPath);
		expect((await rejected(await attempt(f => (f.mcpServers.remote.url = `https://other.example.com/?k=${SECRET_SET}`))))[0]?.jsonPath).toEqual(urlPath);
		expect((await rejected(await attempt(f => (f.mcpServers.local.args[3] = "typed-secret"))))[0]).toEqual({
			message: expect.stringContaining("pass them through env"),
			jsonPath: ["mcpServers", "local", "args", "3"],
		});
		expect(s.vault.readOmpConfig()).toEqual(before);
	});
});

describe("skills/ and agents/ (WEB-26, AGT-25, AGT-26)", () => {
	test("a skill is created, extended, changed and deleted file by file; the next run's bundle follows", async () => {
		const empty = (await skillsBundle(s.ompDir)).hash;
		const created = await saved(await put("skills/review/SKILL.md", "", skill("review")));
		expect(created).toEqual({ ok: true, revision: sha256(skill("review")), rewritten: false });
		const withSkill = (await skillsBundle(s.ompDir)).hash;
		expect(withSkill).not.toBe(empty);

		await saved(await put("skills/review/docs/guide.txt", "", "Look for bugs.\n"));
		const withGuide = (await skillsBundle(s.ompDir)).hash;
		expect(withGuide).not.toBe(withSkill);
		expect((await getFile("skills/review/docs/guide.txt")).text).toBe("Look for bugs.\n");

		const changed = await saved(await put("skills/review/SKILL.md", created.revision, skill("review", "Reviews code carefully.")));
		expect((await skillsBundle(s.ompDir)).hash).not.toBe(withGuide);
		expect((await manifest()).files.filter(f => f.path.startsWith("skills/"))).toEqual([
			{ path: "skills/review/SKILL.md", revision: changed.revision, size: Buffer.byteLength(skill("review", "Reviews code carefully.")) },
			{ path: "skills/review/docs/guide.txt", revision: sha256("Look for bugs.\n"), size: 15 },
		]);

		// A deleted supporting file takes its emptied folder along.
		await saved(await call("DELETE", fileUrl("skills/review/docs/guide.txt", sha256("Look for bugs.\n"))));
		expect(existsSync(join(s.ompDir, "skills", "review", "docs"))).toBe(false);
		// SKILL.md goes only with its folder.
		expect((await rejected(await call("DELETE", fileUrl("skills/review/SKILL.md", changed.revision))))[0]!.message).toContain("delete the folder skills/review/");
		expect(await saved(await call("DELETE", fileUrl("skills/review/")))).toEqual({ ok: true, revision: "", rewritten: false });
		expect(existsSync(join(s.ompDir, "skills", "review"))).toBe(false);
		expect((await skillsBundle(s.ompDir)).hash).toBe(empty);
	});

	test("AGT-25 rules: folder name, SKILL.md first, no paths outside, no symlinks, 5 MiB per folder", async () => {
		expect(await rejected(await put("skills/review/SKILL.md", "", skill("other")))).toEqual([{ message: 'The frontmatter name "other" must be the folder name "review".', line: 2 }]);
		expect(await rejected(await put("skills/review/SKILL.md", "", "---\nname: review\n---\n"))).toEqual([{ message: expect.stringContaining('non-empty "description"'), line: 1 }]);
		expect((await rejected(await put("skills/review/notes.txt", "", "x")))[0]!.message).toContain("has no SKILL.md");
		expect((await rejected(await put("skills/Review/SKILL.md", "", skill("Review"))))[0]!.message).toContain('Skill folder "Review"');
		expect((await rejected(await put("skills/review/../agents/x.md", "", "x")))[0]!.message).toContain("not a file path inside the skill folder");
		expect((await rejected(await put("tools/x.md", "", "x")))[0]!.message).toContain("is not a workspace file");

		await saved(await put("skills/review/SKILL.md", "", skill("review")));
		const outside = mkdtempSync(join(tmpdir(), "agentbot-outside-"));
		writeFileSync(join(outside, "secret.txt"), "outside");
		symlinkSync(outside, join(s.ompDir, "skills", "review", "linked"));
		expect((await rejected(await put("skills/review/linked/secret.txt", "", "x")))[0]!.message).toContain("is a symlink");
		expect((await manifest()).files.map(f => f.path)).not.toContain("skills/review/linked/secret.txt");
		expect((await call("GET", fileUrl("skills/review/linked/secret.txt"))).status).toBe(404);
		rmSync(join(s.ompDir, "skills", "review", "linked"));
		rmSync(outside, { recursive: true, force: true });

		await saved(await put("skills/review/data.bin", "", new Uint8Array(4 * 1024 ** 2)));
		expect((await rejected(await put("skills/review/more.bin", "", new Uint8Array(1024 ** 2))))[0]!.message).toBe("skills/review/ would be larger than 5 MiB.");
		await saved(await call("DELETE", fileUrl("skills/review/")));
	});

	test("agents: the frontmatter name is the file name; main and sub are reserved", async () => {
		const agent = "---\nname: reviewer\ndescription: Reviews.\n---\nBe thorough.\n";
		const created = await saved(await put("agents/reviewer.md", "", agent));
		expect((await getFile("agents/reviewer.md")).text).toBe(agent);
		expect(await rejected(await put("agents/helper.md", "", agent))).toEqual([{ message: 'The frontmatter name "reviewer" must be the file name "helper".', line: 2 }]);
		expect((await rejected(await put("agents/main.md", "", agent.replace("reviewer", "main"))))[0]).toEqual({ message: '"main" and "sub" are reserved agent names.', line: 2 });
		expect((await rejected(await put("agents/Bad.md", "", agent)))[0]!.message).toContain('Agent file name "Bad"');
		expect(await rejected(await put("agents/big.md", "", `---\nname: big\ndescription: x\n---\n${"x".repeat(256 * 1024)}`))).toEqual([{ message: "big.md is larger than 256 KiB." }]);

		// Stale bases: changed meanwhile, or created by someone else, or deleted meanwhile.
		const stale = await put("agents/reviewer.md", "", agent);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ ok: false, reason: "conflict", revision: created.revision });
		const conflictDelete = await call("DELETE", fileUrl("agents/reviewer.md", sha256("older")));
		expect(conflictDelete.status).toBe(409);
		await saved(await call("DELETE", fileUrl("agents/reviewer.md", created.revision)));
		expect(existsSync(join(s.ompDir, "agents", "reviewer.md"))).toBe(false);
		const recreated = await put("agents/reviewer.md", created.revision, agent);
		expect(recreated.status).toBe(409);
		expect(await recreated.json()).toEqual({ ok: false, reason: "conflict", revision: "" });
		// Deleting what is already gone is no conflict.
		expect(await saved(await call("DELETE", fileUrl("agents/reviewer.md", created.revision)))).toEqual({ ok: true, revision: "", rewritten: false });
	});
});

describe("schemas", () => {
	test("settings and omp JSON Schemas follow the validation rules", async () => {
		const res = await call("GET", "/workspace/schemas");
		expect(res.status).toBe(200);
		const { settings, omp } = (await res.json()) as WorkspaceSchemas & { settings: Record<string, any>; omp: Record<string, any> };
		expect(settings.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(settings.additionalProperties).toBe(false);
		expect(settings.required).toEqual(["discord", "github"]);
		expect(settings.properties.limits.properties.maxConcurrentJobs).toMatchObject({ type: "integer", default: 2 });
		expect(settings.properties.limits.additionalProperties).toBe(false);
		expect(settings.properties.secrets.properties.discordToken).toEqual({ enum: [SECRET_SET, SECRET_NOT_SET] });
		expect(omp.properties.settings.properties["git.enabled"]).toMatchObject({ type: "boolean" });
		expect(omp.properties.settings.properties["searxng.token"]).toMatchObject({ enum: [SECRET_SET, SECRET_NOT_SET] });
		expect(omp.properties.settings.properties["async.enabled"]).toBeUndefined();
		const stdio = omp.properties.mcpServers.additionalProperties.anyOf.find((m: Record<string, any>) => m.properties.command);
		expect(stdio.properties.env.additionalProperties).toEqual({ enum: [SECRET_SET, SECRET_NOT_SET] });
		expect(stdio.additionalProperties).toBe(false);
	});
});

describe("a locked vault", () => {
	test("leaves settings.json and omp.json out and refuses writes to them; skills keep working", async () => {
		const unlocked = await manifest();
		const locked = adminFor(s, await openVault(s.db));
		const listed = await manifest(locked);
		expect(listed.locked).toBe(true);
		expect(listed.etag).not.toBe(unlocked.etag);
		expect(listed.files.map(f => f.path)).not.toContain("settings.json");
		expect(listed.files.map(f => f.path)).not.toContain("omp.json");
		const refused = await put("settings.json", unlocked.files[0]!.revision, "{}", locked);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ ok: false, reason: "locked", message: "Settings are locked; log in to unlock them." });
		expect((await call("GET", fileUrl("omp.json"), {}, locked)).status).toBe(409);
		await saved(await put("skills/locked/SKILL.md", "", skill("locked"), locked));
		expect((await manifest(locked)).files.map(f => f.path)).toEqual(["skills/locked/SKILL.md"]);
	});
});

