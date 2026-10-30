import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminApi } from "../../src/orchestrator/api/admin";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import type { AdminState, SettingsSaveResponse, SettingsView, StatusReport } from "../../src/shared/adminApi";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const WEB_TOKEN = "web-api-token-for-tests";
const SETUP_TOKEN = "setup-token-for-tests";
const PASSWORD = "correct horse battery";

interface Orchestrator {
	db: Db;
	vault: Vault;
	controller: Controller;
	api: InternalApi;
	/** Admin API call with the web token. */
	call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
	close(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-admin-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fakeGitHub(): FakeGitHub {
	const github = startFakeGitHub();
	cleanups.push(() => github.stop());
	return github;
}

/** One orchestrator process over `stateDir`: what main.ts wires, with the fake Discord and GitHub. */
async function orchestrator(stateDir: string, github: FakeGitHub, opts: { webToken?: string | null; setupToken?: string } = {}): Promise<Orchestrator> {
	const db = openDb(dbPath(stateDir));
	const vault = await openVault(db);
	const agentLog = await openAgentLog({ dir: join(stateDir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const dispatcher = createFakeDispatcher();
	const controller = createController({
		stateDir,
		db,
		vault,
		agentLog,
		dispatcher,
		connectDiscord: () => createFakeDiscord(),
		connectGitHub: gh => createGitHub({ ...gh, baseUrl: github.url }),
	});
	const admin = createAdminApi({
		db,
		vault,
		controller,
		dispatcher,
		version: "0.0.0-test",
		workerCapacity: 4,
		webToken: opts.webToken === null ? undefined : (opts.webToken ?? WEB_TOKEN),
		setupToken: vault.isInitialized() ? undefined : (opts.setupToken ?? SETUP_TOKEN),
	});
	const api = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir,
		db,
		version: "0.0.0-test",
		workerCapacity: 4,
		phase: () => controller.status().phase,
		config: () => (vault.isUnlocked() ? vault.readSettings()?.config : undefined),
		dispatcher,
		admin,
	});
	await controller.apply();
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await api.stop();
		await controller.stop();
		db.close();
	};
	cleanups.push(close);
	return {
		db,
		vault,
		controller,
		api,
		close,
		call: (method, path, body, headers = {}) =>
			fetch(`${api.url}/internal/admin${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${WEB_TOKEN}`,
					"X-Agentbot-Admin": "admin",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
					...headers,
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
	};
}

async function state(o: Orchestrator): Promise<AdminState> {
	return (await (await o.call("GET", "/state")).json()) as AdminState;
}

async function setUp(o: Orchestrator): Promise<void> {
	const res = await o.call("POST", "/setup", { token: SETUP_TOKEN, username: "admin", password: PASSWORD });
	expect(res.status).toBe(200);
}

function config(github: FakeGitHub, extra: Record<string, unknown> = {}) {
	return { discord: { guildId: "g", allowedUserIds: ["u"], workChannelId: "w" }, github: { appId: github.appId }, ...extra };
}

/** The `{ error }` message of a refused request. */
async function errorOf(res: Response): Promise<string> {
	const body: unknown = await res.json();
	if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
	throw new Error(`no error message in ${JSON.stringify(body)}`);
}

describe("web token (SEC-14)", () => {
	test("missing or wrong tokens are refused; the right one is accepted", async () => {
		const o = await orchestrator(tempStateDir(), fakeGitHub());
		expect((await fetch(`${o.api.url}/internal/admin/state`)).status).toBe(401);
		expect((await o.call("GET", "/state", undefined, { Authorization: "Bearer wrong" })).status).toBe(401);
		expect((await o.call("GET", "/state", undefined, { Authorization: WEB_TOKEN })).status).toBe(401);
		const ok = await o.call("GET", "/state");
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ phase: "setup", initialized: false, unlocked: false, version: "0.0.0-test" });
		// Unknown admin routes are behind the token too.
		expect((await fetch(`${o.api.url}/internal/admin/nope`)).status).toBe(401);
		expect((await o.call("GET", "/nope")).status).toBe(404);
		expect((await o.call("DELETE", "/state")).status).toBe(405);
	});

	test("without a token file the admin API refuses everything", async () => {
		const o = await orchestrator(tempStateDir(), fakeGitHub(), { webToken: null });
		expect((await o.call("GET", "/state")).status).toBe(401);
		expect((await o.call("POST", "/setup", { token: SETUP_TOKEN, username: "admin", password: PASSWORD })).status).toBe(401);
		// Health stays unauthenticated.
		expect((await fetch(`${o.api.url}/readyz`)).status).toBe(200);
	});
});

describe("setup (WEB-02)", () => {
	test("validates the token and credentials, then refuses a second setup", async () => {
		const o = await orchestrator(tempStateDir(), fakeGitHub());
		const wrong = await o.call("POST", "/setup", { token: "nope", username: "admin", password: PASSWORD });
		expect(wrong.status).toBe(400);
		expect(await wrong.json()).toEqual({ error: "Invalid setup token." });
		const short = await o.call("POST", "/setup", { token: SETUP_TOKEN, username: "admin", password: "short" });
		expect(short.status).toBe(400);
		expect(await errorOf(short)).toContain("at least 12");
		const longName = await o.call("POST", "/setup", { token: SETUP_TOKEN, username: "x".repeat(65), password: PASSWORD });
		expect(longName.status).toBe(400);
		expect((await o.call("POST", "/setup", "not an object")).status).toBe(400);
		expect(o.vault.isInitialized()).toBe(false);

		await setUp(o);
		expect(await state(o)).toMatchObject({ phase: "unconfigured", initialized: true, unlocked: true, username: "admin" });
		const again = await o.call("POST", "/setup", { token: SETUP_TOKEN, username: "other", password: PASSWORD });
		expect(again.status).toBe(409);
	});
});

describe("login and credentials (WEB-03, WEB-04)", () => {
	test("login unlocks a locked vault and applies; credentials change needs the current password", async () => {
		const stateDir = tempStateDir();
		const github = fakeGitHub();
		const first = await orchestrator(stateDir, github);
		await setUp(first);
		await first.close();

		const o = await orchestrator(stateDir, github);
		expect(await state(o)).toMatchObject({ phase: "locked", initialized: true, unlocked: false });
		expect((await o.call("GET", "/settings")).status).toBe(409);
		expect(await (await o.call("POST", "/login", { username: "admin", password: "wrong password!" })).json()).toEqual({ ok: false });
		expect(await (await o.call("POST", "/login", { username: "nobody", password: PASSWORD })).json()).toEqual({ ok: false });
		expect(await (await o.call("POST", "/login", { username: "admin", password: PASSWORD })).json()).toEqual({ ok: true });
		await o.controller.apply(); // waits for the background apply the login queued
		expect(await state(o)).toMatchObject({ phase: "unconfigured", unlocked: true });

		const wrong = await o.call("POST", "/credentials", { currentPassword: "not it at all", username: "root", password: "a new long password" });
		expect(wrong.status).toBe(400);
		expect(await wrong.json()).toEqual({ error: "Current password is incorrect." });
		const weak = await o.call("POST", "/credentials", { currentPassword: PASSWORD, username: "root", password: "short" });
		expect(weak.status).toBe(400);
		const changed = await o.call("POST", "/credentials", { currentPassword: PASSWORD, username: "root", password: "a new long password" });
		expect(changed.status).toBe(200);
		expect(await (await o.call("POST", "/login", { username: "root", password: "a new long password" })).json()).toEqual({ ok: true });
		expect(await (await o.call("POST", "/login", { username: "admin", password: PASSWORD })).json()).toEqual({ ok: false });
	});
});

describe("settings", () => {
	test("save validates as a whole, applies, masks secrets and keeps blank ones", async () => {
		const github = fakeGitHub();
		const o = await orchestrator(tempStateDir(), github);
		await setUp(o);

		const badPem = await o.call("PUT", "/settings", { config: config(github), secrets: { discordToken: "discord-token", githubAppPrivateKey: "not a pem" } });
		expect(badPem.status).toBe(400);
		expect(await errorOf(badPem)).toStartWith("GitHub App private key: ");
		expect(o.vault.readSettings()).toBeUndefined();

		const badConfig = await o.call("PUT", "/settings", {
			config: { ...config(github), discord: { guildId: "g", workChannelId: "w" } },
			secrets: { discordToken: "discord-token", githubAppPrivateKey: github.privateKey },
		});
		expect(badConfig.status).toBe(400);
		expect(await errorOf(badConfig)).toStartWith("Invalid config: discord");
		const missingSecret = await o.call("PUT", "/settings", { config: config(github), secrets: { githubAppPrivateKey: github.privateKey } });
		expect(missingSecret.status).toBe(400);
		expect(await errorOf(missingSecret)).toStartWith("Invalid config: secrets.discordToken");
		expect(o.vault.readSettings()).toBeUndefined();

		const saved = await o.call("PUT", "/settings", {
			config: config(github, { limits: { maxConcurrentJobs: 1, maxChatSessions: 1 } }),
			secrets: { discordToken: "discord-token", githubAppPrivateKey: github.privateKey, providerKeys: { anthropic: "sk-1", openai: "sk-2" } },
		});
		expect(saved.status).toBe(200);
		const result = (await saved.json()) as SettingsSaveResponse;
		expect(result.phase).toBe("running");
		expect(result.error).toBeUndefined();
		expect(result.warnings).toEqual([expect.stringContaining("is below worker capacity (4)")]);

		const viewRes = await o.call("GET", "/settings");
		const text = await viewRes.text();
		expect(text).not.toContain("discord-token");
		expect(text).not.toContain("PRIVATE KEY");
		expect(text).not.toContain("sk-1");
		const view = JSON.parse(text) as SettingsView;
		expect(view.secrets).toEqual({ discordToken: true, githubAppPrivateKey: true, providerKeys: ["anthropic", "openai"] });
		expect(view.config?.discord.workChannelId).toBe("w");

		// Blank secrets keep the stored values; an empty provider key deletes that key.
		const resaved = await o.call("PUT", "/settings", {
			config: config(github, { agent: { name: "Robo" } }),
			secrets: { discordToken: "", providerKeys: { openai: "" } },
		});
		expect(resaved.status).toBe(200);
		expect(((await resaved.json()) as SettingsSaveResponse).phase).toBe("running");
		const stored = o.vault.readSettings()!;
		expect(stored.config.agent.name).toBe("Robo");
		expect(stored.secrets).toEqual({ discordToken: "discord-token", githubAppPrivateKey: github.privateKey.trim(), providerKeys: { anthropic: "sk-1" } });
	});

	test("settings routes answer 409 before setup", async () => {
		const o = await orchestrator(tempStateDir(), fakeGitHub());
		expect((await o.call("GET", "/settings")).status).toBe(409);
		expect((await o.call("PUT", "/settings", { config: {}, secrets: {} })).status).toBe(409);
	});
});

describe("status", () => {
	test("reports state, engine snapshot, runs, limits, issues and usage", async () => {
		const github = fakeGitHub();
		const o = await orchestrator(tempStateDir(), github);
		await setUp(o);
		const before = (await (await o.call("GET", "/status")).json()) as StatusReport;
		expect(before).toMatchObject({ state: { phase: "unconfigured" }, limits: null, warnings: [], runs: { pending: 0, running: 0 } });
		expect(before.engine).toBeUndefined();
		expect(before.usage.window).toBe("7d");

		await o.call("PUT", "/settings", { config: config(github), secrets: { discordToken: "discord-token", githubAppPrivateKey: github.privateKey } });
		o.db.insertIssue("o/r", 7, "Fix it");
		const report = (await (await o.call("GET", "/status?window=24h")).json()) as StatusReport;
		expect(report.state).toMatchObject({ phase: "running", initialized: true, unlocked: true });
		expect(report.engine).toMatchObject({ githubApp: `${github.slug}[bot]`, discord: { ready: true }, queuedJobs: 0, watches: [] });
		expect(report.engine!.discordQueue).toMatchObject({ length: 0 });
		expect(report.limits).toEqual({ maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 4, workerCapacity: 4, effectiveConcurrency: 4 });
		expect(report.issues.counts.queued).toBe(1);
		expect(report.issues.open).toEqual([{ repo: "o/r", number: 7, title: "Fix it", state: "queued", threadId: null }]);
		expect(report.usage).toMatchObject({ window: "24h", totals: { runs: 0, costUsd: 0 } });
		expect(report.usage.daily).toHaveLength(14);

		const health = (await (await fetch(`${o.api.url}/readyz`)).json()) as { phase: string; runs: unknown };
		expect(health).toMatchObject({ phase: "running", runs: { pending: 0, running: 0 } });
	});
});
