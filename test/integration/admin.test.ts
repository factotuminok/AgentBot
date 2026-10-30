import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminApi } from "../../src/orchestrator/api/admin";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import type { RunRequest, RunUi } from "../../src/orchestrator/dispatch/dispatcher";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { loadoutKey } from "../../src/orchestrator/store/stats";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import type { AdminState, SettingsSaveResponse, SettingsView, StatusReport } from "../../src/shared/adminApi";
import type { Loadout } from "../../src/shared/agent";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";
import type { ThrottleLimits } from "../../src/shared/loginThrottle";

const WEB_TOKEN = "web-api-token-for-tests";
const SETUP_TOKEN = "setup-token-for-tests";
const PASSWORD = "correct horse battery";

interface Orchestrator {
	db: Db;
	vault: Vault;
	controller: Controller;
	api: InternalApi;
	dispatcher: FakeDispatcher;
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
async function orchestrator(
	stateDir: string,
	github: FakeGitHub,
	opts: { webToken?: string | null; setupToken?: string; modelAccounts?: () => number; passwordLimits?: ThrottleLimits } = {},
): Promise<Orchestrator> {
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
		modelAccounts: opts.modelAccounts,
		...(opts.passwordLimits ? { passwordLimits: opts.passwordLimits } : {}),
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
		dispatcher,
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

	test("password checks are throttled for the whole admin API: one at a time, and a failure budget (architecture §6)", async () => {
		const o = await orchestrator(tempStateDir(), fakeGitHub(), { passwordLimits: { maxFailures: 3, windowMs: 60_000 } });
		await setUp(o);
		const wrong = () => o.call("POST", "/login", { username: "admin", password: "wrong password!" });
		// Parallel guesses with the web token are not all checked: each scrypt check runs alone.
		const parallel = (await Promise.all(Array.from({ length: 5 }, wrong))).map(res => res.status);
		expect(parallel).toContain(429);
		const checked = parallel.filter(status => status === 200).length;
		for (let i = checked; i < 3; i++) expect((await wrong()).status).toBe(200);
		// The budget is spent: even the right password waits, and so does a credential change.
		const blocked = await o.call("POST", "/login", { username: "admin", password: PASSWORD });
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("retry-after")).toBe("60");
		expect(await errorOf(blocked)).toBe("Too many failed password checks. Try again in 1 minute.");
		const change = await o.call("POST", "/credentials", { currentPassword: PASSWORD, username: "root", password: "a new long password" });
		expect(change.status).toBe(429);
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

	test("lists pending runs with their age and runs in progress with setup time, last tool and live usage; the latest loadout per profile", async () => {
		const o = await orchestrator(tempStateDir(), fakeGitHub());
		await setUp(o);
		const pendingGate = Promise.withResolvers<void>();
		const setupGate = Promise.withResolvers<void>();
		const progressed = Promise.withResolvers<void>();
		o.dispatcher.once({ owner: { kind: "draft", draftId: "waiting" } }, { pending: pendingGate.promise });
		o.dispatcher.once(
			{ owner: { kind: "draft", draftId: "busy" } },
			{
				// Setup (worker start, checkout, setupCommand) lasts until the gate opens; then the agent registers and reports.
				steps: [{ until: setupGate.promise }, { progress: { tool: "grep", usage: { costUsd: 0.5, input: 1200, output: 30, cacheRead: 0, cacheWrite: 0 } } }],
				registerAt: 1,
				hold: true,
			},
		);
		const hooks = { ui: {} as RunUi, register: () => {} };
		const request = (draftId: string, repo: string): RunRequest => ({
			owner: { kind: "draft", draftId },
			kind: "draft",
			profile: "draft",
			prompt: "p",
			thinking: "high",
			limits: { minutes: 1, costUsd: 1 },
			session: `draft-${draftId}`,
			resume: false,
			threadId: `thread-${draftId}`,
			checkout: { repo, defaultBranch: async () => "main", identity: { name: "a", email: "a@b" }, gitToken: async () => "t" },
		});
		const waiting = o.dispatcher.runAgent(request("waiting", "o/a"), hooks);
		const busy = o.dispatcher.runAgent(request("busy", "o/b"), { ...hooks, onProgress: () => progressed.resolve() });

		// Still setting up: claimed, not started, no setup time yet.
		const settingUp = ((await (await o.call("GET", "/status")).json()) as StatusReport).activeRuns[1]!;
		expect(settingUp).toMatchObject({ owner: "draft:busy", state: "assigned" });
		expect(settingUp.claimedAt).toBeDefined();
		expect(settingUp.startedAt).toBeUndefined();
		expect(settingUp.setupMs).toBeUndefined();
		setupGate.resolve();
		await progressed.promise;
		const loadout: Loadout = { capturedAt: new Date().toISOString(), profile: "implement", tools: ["read"], skills: [], agents: [], mcp: [] };
		o.db.kvSet(loadoutKey("implement"), JSON.stringify(loadout));

		const report = (await (await o.call("GET", "/status")).json()) as StatusReport;
		expect(report.runs).toMatchObject({ pending: 1, running: 1 });
		expect(report.runs.oldestPendingMs).toBeGreaterThanOrEqual(0);
		expect(report.activeRuns.map(r => [r.owner, r.state, r.repo, r.threadId])).toEqual([
			["draft:waiting", "pending", "o/a", "thread-waiting"],
			["draft:busy", "running", "o/b", "thread-busy"],
		]);
		const [pending, running] = report.activeRuns;
		expect(pending!.claimedAt).toBeUndefined();
		expect(pending!.setupMs).toBeUndefined();
		expect(Date.parse(pending!.createdAt)).toBeLessThanOrEqual(Date.now());
		expect(running).toMatchObject({ lastTool: "grep", usage: { costUsd: 0.5, input: 1200, output: 30 }, claimedAt: settingUp.claimedAt });
		expect(running!.setupMs).toBe(Date.parse(running!.startedAt!) - Date.parse(running!.claimedAt!));
		expect(running!.setupMs).toBeGreaterThanOrEqual(0);
		expect(report.loadouts).toEqual([loadout]);
		expect(report.usage.setup).toEqual([]);

		pendingGate.resolve();
		o.dispatcher.run({ kind: "draft", draftId: "busy" })!.finish();
		await Promise.all([waiting, busy]);
		expect(o.dispatcher.activeRuns()).toEqual([]);
	});
});

describe("home facts (§9.3 `/`)", () => {
	test("counts model accounts and MCP servers and tracks the getting-started checklist", async () => {
		const github = fakeGitHub();
		let accounts = 0;
		const o = await orchestrator(tempStateDir(), github, { modelAccounts: () => accounts });
		const none = { setup: false, credentials: false, workChannel: false, watchedRepo: false, modelAccess: false };
		expect((await state(o)).home).toEqual({ modelAccounts: 0, checklist: none });

		await setUp(o);
		expect((await state(o)).home).toEqual({ modelAccounts: 0, mcpServers: 0, checklist: { ...none, setup: true } });

		await o.call("PUT", "/settings", { config: config(github), secrets: { discordToken: "discord-token", githubAppPrivateKey: github.privateKey } });
		expect((await state(o)).home.checklist).toEqual({ ...none, setup: true, credentials: true, workChannel: true });

		accounts = 2;
		o.vault.writeOmpConfig({ settings: {}, mcpServers: { echo: { command: "echo" }, docs: { type: "http", url: "https://mcp.example.com/mcp" } } });
		o.db.watchRepo({ repoId: 1, repo: "o/r", channelId: "c1", createdBy: "u" });
		expect((await state(o)).home).toEqual({
			modelAccounts: 2,
			mcpServers: 2,
			checklist: { setup: true, credentials: true, workChannel: true, watchedRepo: true, modelAccess: true },
		});

		// A provider API key alone also gives model access.
		accounts = 0;
		await o.call("PUT", "/settings", { config: config(github), secrets: { providerKeys: { openai: "sk-1" } } });
		expect((await state(o)).home).toMatchObject({ modelAccounts: 0, checklist: { modelAccess: true } });
	});
});
