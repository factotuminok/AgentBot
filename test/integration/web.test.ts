import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { AdminState, EnginePhase, SettingsSaveResponse, StatusReport, UsageWindow } from "../../src/shared/adminApi";
import { ConfigError, parseSettings, type Settings } from "../../src/shared/config";
import { versionInfo } from "../../src/shared/version";
import { createAdminClient } from "../../src/web/adminClient";
import { CONFIG_FIELDS } from "../../src/web/forms";
import { formatCount, formatDuration, formatUsd } from "../../src/web/live";
import { createLoginThrottle, createSessionStore } from "../../src/web/sessions";
import { startWebServer, type WebHealth, type WebServer } from "../../src/web/server";
import { THEME_KEY } from "../../src/web/views";

const WEB_TOKEN = "web-api-token-for-tests";
const SETUP_TOKEN = "setup-token-0123456789";
const USERNAME = "admin";
const PASSWORD = "correct horse battery";
const DISCORD_TOKEN = "discord-secret-token-xyz";
const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nPEMBODYsecretvalue123\n-----END RSA PRIVATE KEY-----";
const OPENAI_KEY = "sk-openai-secret-value";
const ORCHESTRATOR_VERSION = "9.9.9-orchestrator";
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------------------------------------------------
// Stub admin API: the `src/shared/adminApi.ts` contract in memory, so these tests don't depend on the orchestrator.
// ---------------------------------------------------------------------------------------------------------------------

interface StubCall {
	method: string;
	path: string;
	admin?: string;
}

interface Stub {
	url: string;
	initialized: boolean;
	unlocked: boolean;
	username?: string;
	password?: string;
	phase: EnginePhase;
	error?: string;
	settings?: Settings;
	/** What the next settings save reports instead of `running`. */
	nextSave?: Partial<SettingsSaveResponse>;
	/** Body for GET /status (state and usage.window are filled in). */
	report: StatusReport;
	/** Makes GET /status fail with a 500 carrying internal detail. */
	failStatus: boolean;
	calls: StubCall[];
	/** Last raw PUT /settings body. */
	lastSave?: { config: unknown; secrets: Record<string, unknown> };
	stop(): Promise<void>;
}

function emptyReport(): StatusReport {
	return {
		state: {} as AdminState, // replaced per request
		runs: { pending: 0, running: 0, oldestPendingMs: null },
		workers: [],
		limits: null,
		warnings: [],
		issues: { counts: {}, open: [] },
		usage: {
			window: "7d",
			totals: { runs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 },
			byKind: [],
			byRepo: [],
			jobs: [],
			daily: [],
		},
	};
}

function startStub(): Stub {
	const stub: Stub = {
		url: "",
		initialized: false,
		unlocked: false,
		phase: "setup",
		report: emptyReport(),
		failStatus: false,
		calls: [],
		stop: async () => {},
	};
	const since = new Date(0).toISOString();
	const state = (): AdminState => ({
		phase: stub.phase,
		...(stub.error ? { error: stub.error } : {}),
		since,
		initialized: stub.initialized,
		unlocked: stub.unlocked,
		username: stub.username,
		version: ORCHESTRATOR_VERSION,
	});
	const fail = (status: number, error: string) => Response.json({ error }, { status });

	const server: Server<undefined> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/readyz") {
				return Response.json({
					status: "ok",
					version: ORCHESTRATOR_VERSION,
					phase: stub.phase,
					runs: { pending: 0, running: 0 },
					limits: stub.settings ? { maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 4, workerCapacity: 4, effectiveConcurrency: 4 } : null,
					warnings: [],
					// Not part of the health body; must never be relayed.
					error: "secret failure detail acme/private-repo",
				});
			}
			if (req.headers.get("authorization") !== `Bearer ${WEB_TOKEN}`) return fail(401, "unauthorized");
			const header = req.headers.get("x-agentbot-admin");
			const path = url.pathname.replace(/^\/internal\/admin/, "");
			stub.calls.push({ method: req.method, path, ...(header === null ? {} : { admin: decodeURIComponent(header) }) });
			const body = req.method === "GET" ? undefined : ((await req.json()) as Record<string, unknown>);
			switch (`${req.method} ${path}`) {
				case "GET /state":
					return Response.json(state());
				case "POST /setup": {
					if (stub.initialized) return fail(409, "already set up");
					if (body!.token !== SETUP_TOKEN) return fail(400, "Invalid setup token.");
					const username = String(body!.username);
					const password = String(body!.password);
					if (username.length < 1 || username.length > 64) return fail(400, "Username must be 1-64 characters.");
					if (password.length < 12) return fail(400, "Password must be at least 12 characters.");
					Object.assign(stub, { initialized: true, unlocked: true, username, password, phase: "unconfigured" });
					return Response.json({ ok: true });
				}
				case "POST /login": {
					if (!stub.initialized) return fail(409, "not set up");
					const ok = body!.username === stub.username && body!.password === stub.password;
					if (ok) stub.unlocked = true;
					return Response.json({ ok });
				}
				case "POST /credentials": {
					if (body!.currentPassword !== stub.password) return fail(400, "Current password is incorrect.");
					stub.username = String(body!.username);
					stub.password = String(body!.password);
					return Response.json({ ok: true });
				}
				case "GET /settings": {
					if (!stub.unlocked) return fail(409, "locked");
					const secrets = stub.settings?.secrets;
					return Response.json({
						config: stub.settings?.config,
						secrets: { discordToken: !!secrets?.discordToken, githubAppPrivateKey: !!secrets?.githubAppPrivateKey, providerKeys: Object.keys(secrets?.providerKeys ?? {}) },
					});
				}
				case "PUT /settings": {
					if (!stub.unlocked) return fail(409, "locked");
					const save = body as { config: unknown; secrets: Record<string, unknown> };
					stub.lastSave = save;
					const previous = stub.settings?.secrets;
					const providerKeys: Record<string, string> = { ...previous?.providerKeys };
					for (const [name, key] of Object.entries((save.secrets.providerKeys ?? {}) as Record<string, string>)) {
						if (key) providerKeys[name] = key;
						else delete providerKeys[name];
					}
					let settings: Settings;
					try {
						settings = parseSettings({
							config: save.config,
							secrets: {
								discordToken: save.secrets.discordToken ?? previous?.discordToken,
								githubAppPrivateKey: save.secrets.githubAppPrivateKey ?? previous?.githubAppPrivateKey,
								providerKeys,
							},
						});
					} catch (err) {
						if (err instanceof ConfigError) return fail(400, err.message);
						throw err;
					}
					stub.settings = settings;
					const result: SettingsSaveResponse = { phase: "running", warnings: [], ...stub.nextSave };
					stub.phase = result.phase;
					stub.error = result.error;
					return Response.json(result);
				}
				case "GET /status": {
					if (stub.failStatus) return fail(500, "database exploded at /state/agentbot.db");
					const window = (url.searchParams.get("window") ?? "7d") as UsageWindow;
					return Response.json({ ...stub.report, state: state(), usage: { ...stub.report.usage, window } });
				}
				default:
					return fail(404, "not found");
			}
		},
	});
	stub.url = `http://127.0.0.1:${server.port}`;
	stub.stop = () => server.stop(true);
	return stub;
}

// ---------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------

interface Harness {
	server: WebServer;
	stub: Stub;
	cookie: string;
	/** Advances the web's clock (sessions and login throttle). */
	advance(ms: number): void;
	get(path: string, headers?: Record<string, string>): Promise<Response>;
	post(path: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<Response>;
}

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.map(fn => fn()));
	cleanups = [];
});

function start(opts: { token?: string } = {}): Harness {
	const stub = startStub();
	let clock = Date.now();
	const server = startWebServer({
		admin: createAdminClient({ baseUrl: stub.url, token: opts.token ?? WEB_TOKEN, timeoutMs: 2_000, healthTimeoutMs: 1_000 }),
		host: "127.0.0.1",
		port: 0,
		now: () => clock,
	});
	cleanups.push(() => server.stop(), () => stub.stop());
	const h: Harness = {
		server,
		stub,
		cookie: "",
		advance(ms) {
			clock += ms;
		},
		async get(path, headers = {}) {
			return track(await fetch(server.url + path, { redirect: "manual", headers: { cookie: h.cookie, ...headers } }));
		},
		async post(path, fields, headers = { origin: server.url }) {
			return track(
				await fetch(server.url + path, {
					method: "POST",
					redirect: "manual",
					headers: { cookie: h.cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
					body: new URLSearchParams(fields).toString(),
				}),
			);
		},
	};
	function track(res: Response): Response {
		const setCookie = res.headers.get("set-cookie");
		if (setCookie) h.cookie = setCookie.split(";")[0]!;
		return res;
	}
	return h;
}

async function setUp(h: Harness): Promise<void> {
	const res = await h.post("/setup", { token: SETUP_TOKEN, username: USERNAME, password: PASSWORD, confirm: PASSWORD });
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/");
}

/** Logs in from a fresh browser (no cookie) and returns that browser's cookie; `h.cookie` is left unchanged. */
async function secondLogin(h: Harness, username = USERNAME, password = PASSWORD): Promise<string> {
	const res = await fetch(`${h.server.url}/login`, {
		method: "POST",
		redirect: "manual",
		headers: { origin: h.server.url, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ username, password }).toString(),
	});
	expect(res.status).toBe(303);
	return res.headers.get("set-cookie")!.split(";")[0]!;
}

function expectSecurityHeaders(res: Response): void {
	expect(res.headers.get("content-security-policy")).toBe(
		"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
	);
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	expect(res.headers.get("referrer-policy")).toBe("same-origin");
	expect(res.headers.get("cache-control")).toBe("no-store");
}

function scripts(page: string): string[] {
	return [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
}

/** The page's own inline script, skipping the shared layout scripts every page carries. */
function pageScript(page: string): string {
	const own = scripts(page).find(script => !script.includes(THEME_KEY));
	if (own === undefined) throw new Error("page has no script of its own");
	return own;
}

const VALID_FORM: Record<string, string> = {
	"secrets.discordToken": DISCORD_TOKEN,
	"secrets.githubAppPrivateKey": PRIVATE_KEY,
	"provider.0.name": "openai",
	"provider.0.key": OPENAI_KEY,
	"discord.guildId": "guild-1",
	"discord.allowedUserIds": "111, 222\n333",
	"discord.allowedRoleIds": "",
	"discord.workChannelId": "work-1",
	"github.appId": "42",
	"github.pollIntervalSeconds": "",
	"limits.maxConcurrentJobs": "3",
};

// ---------------------------------------------------------------------------------------------------------------------

describe("setup (WEB-02)", () => {
	test("requires the token, forwards the account, and disappears once an admin exists", async () => {
		const h = start();
		expect((await h.get("/")).headers.get("location")).toBe("/setup");
		expect((await h.get("/login")).headers.get("location")).toBe("/setup");
		const page = await h.get("/setup");
		expect(page.status).toBe(200);
		expectSecurityHeaders(page);

		const wrong = await h.post("/setup", { token: "nope", username: USERNAME, password: PASSWORD, confirm: PASSWORD });
		expect(wrong.status).toBe(400);
		expect(await wrong.text()).toContain("Invalid setup token.");
		expect(h.stub.initialized).toBe(false);

		// Checked in web before anything is forwarded.
		const calls = h.stub.calls.length;
		for (const [username, password, confirm] of [
			[USERNAME, "short", "short"],
			[USERNAME, PASSWORD, `${PASSWORD}!`],
			["", PASSWORD, PASSWORD],
			["x".repeat(65), PASSWORD, PASSWORD],
		]) {
			expect((await h.post("/setup", { token: SETUP_TOKEN, username: username!, password: password!, confirm: confirm! })).status).toBe(400);
		}
		expect(h.stub.calls.slice(calls).filter(c => c.path === "/setup")).toEqual([]);

		await setUp(h);
		expect(h.stub.username).toBe(USERNAME);
		expect(h.stub.password).toBe(PASSWORD);
		expect(h.stub.calls.find(c => c.method === "POST" && c.path === "/setup" && c.admin === USERNAME)).toBeDefined();

		// The session cookie: 32 random bytes.
		const [name, value] = h.cookie.split("=");
		expect(name).toBe("agentbot_session");
		expect(Buffer.from(value!, "base64url").length).toBe(32);
		expect((await h.get("/admin")).status).toBe(200);

		expect((await h.get("/setup")).headers.get("location")).toBe("/");
		const again = await h.post("/setup", { token: SETUP_TOKEN, username: "other", password: PASSWORD, confirm: PASSWORD });
		expect(again.status).toBe(404);
		expect(h.stub.username).toBe(USERNAME);
	});
});

describe("sessions (WEB-03, WEB-05, WEB-09)", () => {
	test("unauthenticated requests redirect to /login, JSON gets 401, and nothing is forwarded", async () => {
		const h = start();
		await setUp(h);
		h.cookie = "";
		for (const path of ["/", "/status", "/admin"]) {
			const res = await h.get(path);
			expect([path, res.status, res.headers.get("location")]).toEqual([path, 303, "/login"]);
			expectSecurityHeaders(res);
		}
		for (const path of ["/status.json", "/admin/status"]) {
			const res = await h.get(path);
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ error: "unauthorized" });
			expectSecurityHeaders(res);
		}
		expect((await h.get("/admin", { accept: "application/json" })).status).toBe(401);
		const save = await h.post("/admin/settings", VALID_FORM);
		expect(save.status).toBe(303);
		expect(save.headers.get("location")).toBe("/login");
		expect(h.stub.settings).toBeUndefined();
		const unknown = await h.get("/nope");
		expect(unknown.status).toBe(404);
		expectSecurityHeaders(unknown);
	});

	test("login creates a session cookie, logout ends it", async () => {
		const h = start();
		await setUp(h);
		h.cookie = "";
		expect((await h.get("/login")).status).toBe(200);
		const ok = await h.post("/login", { username: USERNAME, password: PASSWORD });
		expect(ok.status).toBe(303);
		expect(ok.headers.get("location")).toBe("/");
		const setCookie = ok.headers.get("set-cookie")!;
		expect(setCookie).toStartWith("agentbot_session=");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).not.toContain("Secure");
		expect(await (await h.get("/admin/status")).json()).toEqual({ phase: "unconfigured", since: new Date(0).toISOString() });

		const session = h.cookie;
		const logout = await h.post("/logout", {});
		expect(logout.headers.get("location")).toBe("/login");
		expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
		h.cookie = session;
		expect((await h.get("/admin")).headers.get("location")).toBe("/login");
	});

	test("the cookie is Secure behind HTTPS, judged by the first X-Forwarded-Proto", async () => {
		const h = start();
		await setUp(h);
		const login = (proto: string) =>
			fetch(`${h.server.url}/login`, {
				method: "POST",
				redirect: "manual",
				headers: { origin: h.server.url, "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": proto },
				body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString(),
			});
		expect((await login("https, http")).headers.get("set-cookie")).toContain("Secure");
		expect((await login("http, https")).headers.get("set-cookie")).not.toContain("Secure");
	});

	test("an unknown username and a wrong password fail the same way", async () => {
		const h = start();
		await setUp(h);
		h.cookie = "";
		const unknown = await h.post("/login", { username: "nobody", password: PASSWORD });
		const wrong = await h.post("/login", { username: "nobody", password: "wrong password!" });
		expect(unknown.status).toBe(401);
		expect(wrong.status).toBe(401);
		const unknownText = await unknown.text();
		expect(unknownText).toContain("Invalid username or password.");
		expect(unknownText).toBe(await wrong.text());
		expect(h.cookie).toBe("");
	});

	test("sessions expire after 12 h idle; activity keeps them alive", async () => {
		const h = start();
		await setUp(h);
		h.advance(11 * HOUR);
		expect((await h.get("/admin")).status).toBe(200);
		h.advance(11 * HOUR);
		expect((await h.get("/admin")).status).toBe(200);
		h.advance(12 * HOUR + 1);
		expect((await h.get("/admin")).headers.get("location")).toBe("/login");
	});

	test("5 failures in 15 minutes block the IP for 15 minutes with 429 and the remaining time", async () => {
		const h = start();
		await setUp(h);
		h.cookie = "";
		for (let i = 0; i < 5; i++) {
			expect((await h.post("/login", { username: USERNAME, password: `wrong password ${i}` })).status).toBe(401);
		}
		const blocked = await h.post("/login", { username: USERNAME, password: PASSWORD });
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("retry-after")).toBe("900");
		expect(await blocked.text()).toContain("Try again in 15 minutes.");
		expect(h.cookie).toBe("");

		h.advance(14 * 60_000);
		const later = await h.post("/login", { username: USERNAME, password: PASSWORD });
		expect(later.status).toBe(429);
		expect(await later.text()).toContain("Try again in 1 minute.");

		h.advance(60_000);
		expect((await h.post("/login", { username: USERNAME, password: PASSWORD })).status).toBe(303);
	});

	test("failures spread over more than 15 minutes don't block", () => {
		let now = 0;
		const throttle = createLoginThrottle(() => now);
		for (let i = 0; i < 4; i++) throttle.fail("1.2.3.4");
		now += 16 * 60_000;
		throttle.fail("1.2.3.4");
		expect(throttle.retryAfterMs("1.2.3.4")).toBe(0);
		for (let i = 0; i < 4; i++) throttle.fail("1.2.3.4");
		expect(throttle.retryAfterMs("1.2.3.4")).toBe(15 * 60_000);
		expect(throttle.retryAfterMs("5.6.7.8")).toBe(0);
		throttle.succeed("1.2.3.4");
		expect(throttle.retryAfterMs("1.2.3.4")).toBe(0);
	});

	test("the session store drops idle sessions and can end all others", () => {
		let now = 0;
		const store = createSessionStore(1000, () => now);
		const a = store.create("a");
		const b = store.create("b");
		expect(store.get(a.token)?.username).toBe("a");
		store.deleteOthers(a.token);
		expect(store.get(b.token)).toBeUndefined();
		now += 1001;
		expect(store.get(a.token)).toBeUndefined();
		expect(store.get(undefined)).toBeUndefined();
	});
});

describe("request security (WEB-06, WEB-07)", () => {
	test("a POST from another origin, or with no Origin or Referer, is rejected with 403", async () => {
		const h = start();
		await setUp(h);
		const cases: Record<string, string>[] = [{ origin: "https://evil.example" }, {}, { referer: "https://evil.example/admin" }, { origin: "not a url" }];
		for (const headers of cases) {
			const res = await h.post("/admin/settings", VALID_FORM, headers);
			expect(res.status).toBe(403);
			expectSecurityHeaders(res);
		}
		expect((await h.post("/login", { username: USERNAME, password: PASSWORD }, {})).status).toBe(403);
		expect(h.stub.settings).toBeUndefined();

		expect((await h.post("/admin/settings", VALID_FORM, { referer: `${h.server.url}/admin` })).status).toBe(303);
		expect(h.stub.settings).toBeDefined();
	});

	test("unhandled errors return 500 without details", async () => {
		const h = start();
		await setUp(h);
		h.stub.failStatus = true;
		const res = await h.get("/status");
		expect(res.status).toBe(500);
		expectSecurityHeaders(res);
		const body = await res.text();
		expect(body).not.toContain("exploded");
		expect(body).not.toContain("agentbot.db");
	});
});

describe("account (WEB-04)", () => {
	test("requires the current password and ends every other session", async () => {
		const h = start();
		await setUp(h);
		const other = await secondLogin(h);
		const newUser = "Zoë Admin";
		const newPassword = "another long password";

		const mismatch = await h.post("/admin/account", { currentPassword: PASSWORD, username: newUser, password: newPassword, confirm: "different password!" });
		expect(mismatch.status).toBe(400);
		const wrong = await h.post("/admin/account", { currentPassword: "not the password", username: newUser, password: newPassword, confirm: newPassword });
		expect(wrong.status).toBe(400);
		expect(await wrong.text()).toContain("Current password is incorrect.");
		expect(h.stub.username).toBe(USERNAME);

		const ok = await h.post("/admin/account", { currentPassword: PASSWORD, username: newUser, password: newPassword, confirm: newPassword });
		expect(ok.status).toBe(303);
		expect(h.stub.username).toBe(newUser);
		expect(h.stub.password).toBe(newPassword);
		expect(h.stub.calls.find(c => c.path === "/credentials")?.admin).toBe(USERNAME);

		// This login stays, as the new user; the other one ended.
		const page = await (await h.get("/admin")).text();
		expect(page).toContain("Account updated.");
		expect(page).toContain('value="Zoë Admin"');
		const otherRes = await fetch(`${h.server.url}/admin`, { redirect: "manual", headers: { cookie: other } });
		expect(otherRes.headers.get("location")).toBe("/login");

		// Writes now name the new admin (non-ASCII survives the header).
		await h.post("/admin/settings", VALID_FORM);
		expect(h.stub.calls.findLast(c => c.path === "/settings" && c.method === "PUT")?.admin).toBe(newUser);
	});
});

describe("settings (/admin)", () => {
	test("saving forwards the form, reports the phase, and the page never shows secrets", async () => {
		const h = start();
		await setUp(h);
		const before = await (await h.get("/admin")).text();
		expect(before.match(/<span class="hint">not set<\/span>/g)?.length).toBe(2);

		const save = await h.post("/admin/settings", VALID_FORM);
		expect(save.status).toBe(303);
		expect(save.headers.get("location")).toBe("/admin");
		expect(h.stub.calls.find(c => c.method === "PUT" && c.path === "/settings")?.admin).toBe(USERNAME);

		const settings = h.stub.settings!;
		expect(settings.secrets).toEqual({ discordToken: DISCORD_TOKEN, githubAppPrivateKey: PRIVATE_KEY, providerKeys: { openai: OPENAI_KEY } });
		expect(settings.config.discord.allowedUserIds).toEqual(["111", "222", "333"]);
		expect(settings.config.discord.workChannelId).toBe("work-1");
		expect(settings.config.github).toEqual({ appId: 42, pollIntervalSeconds: 60, mentionKeyword: "/agentbot" });
		expect(settings.config.limits.maxConcurrentJobs).toBe(3);

		const page = await (await h.get("/admin")).text();
		expect(page).toContain("Settings saved. Engine is running.");
		expect(page).toContain('name="discord.workChannelId" value="work-1"');
		expect(page).toContain('name="discord.allowedUserIds" value="111, 222, 333"');
		expect(page).toContain('value="openai"');
		expect(page.match(/<span class="hint">set<\/span>/g)?.length).toBe(3);
		for (const secret of [DISCORD_TOKEN, "PEMBODYsecretvalue123", OPENAI_KEY]) expect(page).not.toContain(secret);
		// The flash is shown once.
		expect(await (await h.get("/admin")).text()).not.toContain("Settings saved.");
	});

	test("blank secrets are not sent and keep the stored values; removed providers are deleted", async () => {
		const h = start();
		await setUp(h);
		await h.post("/admin/settings", VALID_FORM);
		const res = await h.post("/admin/settings", {
			...VALID_FORM,
			"secrets.discordToken": "",
			"secrets.githubAppPrivateKey": "  ",
			"provider.0.key": "",
			"provider.1.name": "anthropic",
			"provider.1.key": "sk-ant",
			"provider.2.name": "mistral",
			"provider.2.key": "",
		});
		expect(res.status).toBe(303);
		expect(h.stub.lastSave!.secrets).toEqual({ providerKeys: { anthropic: "sk-ant" } });
		expect(h.stub.settings!.secrets).toEqual({ discordToken: DISCORD_TOKEN, githubAppPrivateKey: PRIVATE_KEY, providerKeys: { openai: OPENAI_KEY, anthropic: "sk-ant" } });

		await h.post("/admin/settings", { ...VALID_FORM, "secrets.discordToken": "", "provider.0.name": "openai", "provider.0.remove": "on" });
		expect(h.stub.lastSave!.secrets.providerKeys).toEqual({ openai: "" });
		expect(h.stub.settings!.secrets.providerKeys).toEqual({ anthropic: "sk-ant" });
	});

	test("optional channel and list fields round-trip", async () => {
		const h = start();
		await setUp(h);
		const form = { ...VALID_FORM, "discord.askChannelIds": "ask-1, ask-2", "discord.watchCategoryId": "cat-1", "logs.maxGiB": "1.5", "workers.maxConcurrentRuns": "" };
		expect((await h.post("/admin/settings", form)).status).toBe(303);
		const { config } = h.stub.settings!;
		expect(config.discord.askChannelIds).toEqual(["ask-1", "ask-2"]);
		expect(config.discord.watchCategoryId).toBe("cat-1");
		expect(config.logs.maxGiB).toBe(1.5);
		expect(config.workers.maxConcurrentRuns).toBeUndefined();
		const page = await (await h.get("/admin")).text();
		expect(page).toContain('name="discord.askChannelIds" value="ask-1, ask-2"');
		expect(page).toContain('name="discord.watchCategoryId" value="cat-1"');
		expect(page).toContain('name="logs.maxGiB" value="1.5"');
	});

	test("a rejected save re-renders the submission with the orchestrator's error and without secrets", async () => {
		const h = start();
		await setUp(h);
		const res = await h.post("/admin/settings", { ...VALID_FORM, "limits.maxConcurrentJobs": "abc", "discord.guildId": "<b>guild" });
		expect(res.status).toBe(400);
		const page = await res.text();
		expect(page).toContain("Invalid config: limits.maxConcurrentJobs:");
		expect(page).toContain('name="limits.maxConcurrentJobs" value="abc"');
		expect(page).toContain("&lt;b&gt;guild");
		expect(page).not.toContain("<b>guild");
		expect(page).toContain('value="openai"');
		for (const secret of [DISCORD_TOKEN, "PEMBODYsecretvalue123", OPENAI_KEY]) expect(page).not.toContain(secret);
		expect(h.stub.settings).toBeUndefined();

		const clash = await h.post("/admin/settings", { ...VALID_FORM, "discord.askChannelIds": "work-1" });
		expect(clash.status).toBe(400);
		expect(await clash.text()).toContain("is already the work channel");
	});

	test("a startup error and warnings are reported with the save", async () => {
		const h = start();
		await setUp(h);
		h.stub.nextSave = { phase: "error", error: "Discord login failed: invalid token", warnings: ["channel work-1 lacks Add Reactions"] };
		expect((await h.post("/admin/settings", VALID_FORM)).status).toBe(303);
		const page = await (await h.get("/admin")).text();
		expect(page).toContain('<div class="error" role="status">Settings saved. Engine is error: Discord login failed: invalid token.<ul><li>channel work-1 lacks Add Reactions</li></ul></div>');
		expect(page).toContain('<span id="status-phase">error</span>');
	});

	test("locked settings are not shown and cannot be overwritten blindly", async () => {
		const h = start();
		await setUp(h);
		await h.post("/admin/settings", VALID_FORM);
		h.stub.unlocked = false;
		const page = await (await h.get("/admin")).text();
		expect(page).toContain("The settings are locked.");
		expect(page).not.toContain('action="/admin/settings"');
		expect(page).toContain('action="/admin/account"');
		const save = await h.post("/admin/settings", VALID_FORM);
		expect(save.status).toBe(409);
	});

	test("every settings field has hover help with an example and the schema default; the examples are valid", async () => {
		const h = start();
		await setUp(h);
		const page = await (await h.get("/admin")).text();
		const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
		const re = (s: string) => s.replaceAll(".", "\\.");
		for (const def of CONFIG_FIELDS) {
			expect(page).toMatch(new RegExp(`name="${re(def.name)}" value="[^"]*" aria-describedby="help-${re(def.name)}"`));
			const tip = new RegExp(`<span class="info" aria-hidden="true">i<span class="tip" id="help-${re(def.name)}" role="tooltip">([^]*?)</span></span>`).exec(page);
			expect([def.name, tip?.[1]]).toEqual([def.name, expect.stringContaining(`Example: <code>${esc(def.example)}</code>`)]);
		}
		expect(page).toMatch(/id="help-github\.pollIntervalSeconds" role="tooltip">[^<]*<span class="tip-line">Example: <code>30<\/code><\/span><span class="tip-line">Default: <code>60<\/code>/);
		expect(page).toMatch(/id="help-labels\.states\.planning" role="tooltip">[^<]*<span class="tip-line">Example: <code>ai:planning<\/code><\/span><span class="tip-line">Default: <code>&lt;trigger&gt;:planning<\/code>/);
		for (const name of ["discord.guildId", "discord.workChannelId", "github.appId"]) {
			const tip = new RegExp(`id="help-${re(name)}" role="tooltip">([^]*?)</span></span>`).exec(page);
			expect([name, tip?.[1]]).toEqual([name, expect.not.stringContaining("Default:")]);
		}
		for (const id of ["help-secrets.discordToken", "help-secrets.githubAppPrivateKey", "help-provider-name", "help-provider-key", "help-currentPassword", "help-password"]) {
			expect(page).toContain(`aria-describedby="${id}"`);
			expect(page).toContain(`id="${id}" role="tooltip"`);
		}

		const form: Record<string, string> = { ...VALID_FORM };
		for (const def of CONFIG_FIELDS) form[def.name] = def.example;
		expect((await h.post("/admin/settings", form)).status).toBe(303);
		expect(h.stub.settings!.config.limits.maxCostUsdPerJob).toBe(7.5);
		expect(h.stub.settings!.config.labels.states.inReview).toBe("ai:in-review");
	});
});

// ---------------------------------------------------------------------------------------------------------------------

function liveReport(title: string): StatusReport {
	const now = Date.now();
	return {
		...emptyReport(),
		engine: {
			// 1h 5m 30s before now; the web's clock was frozen a little earlier, so the page shows 1h 5m.
			startedAt: new Date(now - 3_930_000).toISOString(),
			discord: { ready: true, user: "AgentBot#0001", pingMs: 42, nicknameWarning: "missing Change Nickname" },
			githubApp: "agentbot-app",
			discordQueue: { length: 7, oldestAgeMs: 12_000 },
			watches: [
				{ repo: "acme/widgets", channelId: "chan-9", state: "watching", lastPollAt: new Date(now).toISOString(), lastError: "rate limited <b>" },
				{ repo: "acme/gone", channelId: null, state: "suspended", lastError: "App not installed" },
			],
			queuedJobs: 3,
		},
		runs: { pending: 2, running: 1, oldestPendingMs: 95_000 },
		workers: [
			{ id: "agentbot-worker-x7k2p", address: "10.0.0.7", version: "0.4.12", ompVersion: "18.12.1", runId: "run-1", phase: "running", connectedAt: new Date(now - 125_000).toISOString() },
		],
		limits: { maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 10, workerCapacity: 10, effectiveConcurrency: 4 },
		warnings: ["maxConcurrentJobs + maxChatSessions (4) is below worker capacity (10): at most 4 workers will be used"],
		issues: {
			counts: { planning: 1, queued: 2 },
			open: [{ repo: "acme/widgets", number: 8, title, state: "planning", job: "plan", threadId: "thread-9" }],
		},
		usage: {
			window: "7d",
			totals: { runs: 2, costUsd: 0.005, tokensIn: 1_234_567, tokensOut: 89, cacheRead: 0, cacheWrite: 0 },
			byKind: [{ kind: "plan", runs: 2, costUsd: 0.005 }],
			byRepo: [{ repo: "acme/widgets", runs: 2, costUsd: 0.005 }],
			jobs: [{ kind: "plan", succeeded: 1, failed: 1, cancelled: 0, avgDurationMs: 192_000 }],
			daily: [
				{ day: "2026-10-28", costUsd: 0.001 },
				{ day: "2026-10-29", costUsd: 0.004 },
			],
		},
	};
}

describe("formatting", () => {
	test("money, counts and durations", () => {
		expect([formatUsd(1.234), formatUsd(0.0042), formatUsd(0), formatUsd(12)]).toEqual(["$1.23", "$0.0042", "$0.00", "$12.00"]);
		expect(formatCount(1_234_567)).toBe("1,234,567");
		expect([formatDuration(45_000), formatDuration(192_000), formatDuration(3_900_000), formatDuration(97_200_000)]).toEqual(["45s", "3m 12s", "1h 5m", "1d 3h"]);
	});
});

describe("status", () => {
	test("status.json relays the orchestrator's report and its window (default 7d)", async () => {
		const h = start();
		await setUp(h);
		h.stub.report = liveReport("Fix the widget");
		const week = (await (await h.get("/status.json")).json()) as StatusReport;
		expect(week.usage.window).toBe("7d");
		expect(week.engine?.watches.map(w => w.repo)).toEqual(["acme/widgets", "acme/gone"]);
		expect(week.state.phase).toBe("unconfigured");
		expect(week.runs.oldestPendingMs).toBe(95_000);

		expect(((await (await h.get("/status.json?window=30d")).json()) as StatusReport).usage.window).toBe("30d");
		expect(((await (await h.get("/status.json?window=forever")).json()) as StatusReport).usage.window).toBe("7d");
		expect(h.stub.calls.filter(c => c.path === "/status").length).toBe(3);
	});

	test("the page renders every phase 2 section, escapes text, links threads, and its script parses", async () => {
		const h = start();
		await setUp(h);
		await h.post("/admin/settings", VALID_FORM);
		h.stub.report = liveReport(`<script>alert("x")</script>`);

		const res = await h.get("/status?window=24h");
		expect(res.status).toBe(200);
		expectSecurityHeaders(res);
		const page = await res.text();
		expect(page).toContain('<a href="/status" aria-current="page">Status</a>');
		expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
		expect(page).not.toContain("<script>alert(");
		expect(page).toContain("rate limited &lt;b&gt;");
		expect(page).toContain("<td>Uptime</td><td>1h 5m</td>");
		expect(page).toContain("ready · as AgentBot#0001 · ping 42 ms");
		expect(page).toContain("missing Change Nickname");
		expect(page).toContain("<td>Discord write queue</td><td>7 queued · oldest 12s</td>");
		expect(page).toContain("<td>Queued jobs</td><td>3</td>");
		expect(page).toContain("<td>Runs</td><td>2 pending (oldest 1m 35s) · 1 running</td>");
		expect(page).toContain("<td>suspended</td>");
		expect(page).toContain("App not installed");
		expect(page).toContain("<td>Worker capacity</td><td>10</td>");
		expect(page).toContain("at most 4 workers will be used");
		// The web's clock was frozen a little before the report was built.
		expect(page).toMatch(/<td>agentbot-worker-x7k2p<\/td><td>10\.0\.0\.7<\/td><td>run-1<\/td><td>running<\/td><td>18\.12\.1<\/td><td>2m \d+s<\/td>/);
		expect(page).toContain('href="https://github.com/acme/widgets/issues/8"');
		expect(page).toContain('href="https://discord.com/channels/guild-1/thread-9"');
		expect(page).toContain('href="https://discord.com/channels/guild-1/chan-9"');
		expect(page).toContain("$0.0050");
		expect(page).toContain("1,234,567");
		expect(page).toContain('<strong aria-current="page">24 hours</strong>');
		expect(page).toMatch(/class="bar" style="height:100\.0%"/);
		expect(h.stub.calls.findLast(c => c.path === "/status")).toBeDefined();
		for (const secret of [DISCORD_TOKEN, "PEMBODYsecretvalue123", OPENAI_KEY]) expect(page).not.toContain(secret);

		const script = pageScript(page);
		expect(() => new Function(script)).not.toThrow();
		expect(script).toContain("function liveView(");
	});

	test("without a running engine the page shows the phase and empty sections", async () => {
		const h = start();
		await setUp(h);
		const page = await (await h.get("/status")).text();
		expect(page).toContain("<td>Engine</td><td>unconfigured</td>");
		expect(page).toContain("No watched repositories.");
		expect(page).toContain("Limits are shown once the settings are saved and unlocked.");
		expect(page).toContain("No open issues.");
	});
});

describe("healthz", () => {
	test("is public, always 200, and relays only the orchestrator's phase and limits", async () => {
		const h = start();
		const setup = await h.get("/healthz");
		expect(setup.status).toBe(200);
		expectSecurityHeaders(setup);
		const version = (await versionInfo()).agentbot;
		expect((await setup.json()) as WebHealth).toEqual({ status: "ok", version, orchestrator: { reachable: true, phase: "setup", limits: null } });

		await setUp(h);
		await h.post("/admin/settings", VALID_FORM);
		h.stub.phase = "error";
		h.stub.error = "GitHub App is not installed on acme/private-repo";
		h.cookie = "";
		const failed = await h.get("/healthz");
		expect(failed.status).toBe(200);
		const body = await failed.text();
		expect(JSON.parse(body)).toEqual({
			status: "ok",
			version,
			orchestrator: { reachable: true, phase: "error", limits: { maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 4, workerCapacity: 4, effectiveConcurrency: 4 } },
		});
		expect(body).not.toContain("private-repo");

		await h.stub.stop();
		const down = await h.get("/healthz");
		expect(down.status).toBe(200);
		expect(await down.json()).toEqual({ status: "ok", version, orchestrator: { reachable: false, phase: null, limits: null } });
	});
});

describe("orchestrator unavailable (architecture §2.2)", () => {
	test("login fails with it, the home page shows it, and the UI keeps serving", async () => {
		const h = start();
		await setUp(h);
		await h.stub.stop();

		const home = await h.get("/");
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("orchestrator unavailable");
		const status = await h.get("/status");
		expect(status.status).toBe(503);
		expect(await status.text()).toContain("orchestrator unavailable");
		const json = await h.get("/status.json");
		expect(json.status).toBe(503);
		expect(await json.json()).toEqual({ error: "orchestrator unavailable" });

		h.cookie = "";
		expect((await h.get("/")).headers.get("location")).toBe("/login");
		const loginPage = await h.get("/login");
		expect(loginPage.status).toBe(200);
		expect(await loginPage.text()).toContain("orchestrator unavailable");
		const login = await h.post("/login", { username: USERNAME, password: PASSWORD });
		expect(login.status).toBe(503);
		expect(await login.text()).toContain("orchestrator unavailable");
		expect(h.cookie).toBe("");
		// Not counted as failed logins.
		for (let i = 0; i < 6; i++) expect((await h.post("/login", { username: USERNAME, password: PASSWORD })).status).toBe(503);
	});

	test("a rejected web API token reads as unavailable", async () => {
		const h = start({ token: "wrong-token" });
		const login = await h.post("/login", { username: USERNAME, password: PASSWORD });
		expect(login.status).toBe(503);
		expect(await login.text()).toContain("orchestrator unavailable");
		expect(h.stub.calls).toEqual([]);
	});
});

describe("home and navigation (WEB-10, WEB-11)", () => {
	test("home shows the engine phase, a card per page and both versions; the menu lists the same pages", async () => {
		const h = start();
		await setUp(h);
		await h.post("/admin/settings", VALID_FORM);
		const res = await h.get("/");
		expect(res.status).toBe(200);
		const page = await res.text();
		expect(page).toContain('<span class="badge ok">running</span>');
		const cards = [...page.matchAll(/<h3><a href="([^"]+)">/g)].map(m => m[1]);
		expect(cards).toEqual(["/status", "/admin", "/status.json", "/healthz"]);
		const menu = [...page.matchAll(/<li><a href="([^"]+)"/g)].map(m => m[1]);
		expect(menu).toEqual(["/", ...cards]);
		expect(page).toContain('<a href="/" aria-current="page">Home</a>');
		for (const later of ["/logs", "/admin/omp", "/admin/models", "/admin/skills", "/admin/repos", "/admin/vscode"]) expect(page).not.toContain(`href="${later}`);

		const info = await versionInfo();
		expect(page).toContain(`<td>AgentBot (web)</td><td>${info.agentbot}</td>`);
		expect(page).toContain(`<td>AgentBot (orchestrator)</td><td>${ORCHESTRATOR_VERSION}</td>`);
		expect(page).toContain(`<td>Bun</td><td>${Bun.version}</td>`);
		expect(page).toContain(`<td>zod</td><td>${info.dependencies.zod}</td>`);
		expect(page).toContain("different AgentBot versions");

		h.stub.nextSave = { phase: "error", error: "Discord <login> failed" };
		await h.post("/admin/settings", VALID_FORM);
		const failed = await (await h.get("/")).text();
		expect(failed).toContain('<span class="badge bad">error</span>');
		expect(failed).toContain("Discord &lt;login&gt; failed");
	});

	test("every page offers the light/dark/auto switch once, applied before first paint, and the menu where logged in", async () => {
		const h = start();
		const pages = [await (await h.get("/setup")).text()];
		await setUp(h);
		const loggedIn = [await (await h.get("/")).text(), await (await h.get("/status")).text(), await (await h.get("/admin")).text()];
		h.cookie = "";
		pages.push(await (await h.get("/login")).text(), await (await h.get("/nope")).text());
		for (const page of [...pages, ...loggedIn]) {
			expect(page.match(/class="theme-select"/g)?.length).toBe(1);
			expect(page).toContain('<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>');
			expect(page.indexOf(THEME_KEY)).toBeLessThan(page.indexOf("<style>"));
			expect(page).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])');
			expect(page).toContain(':root[data-theme="dark"]');
			for (const script of scripts(page)) expect(() => new Function(script)).not.toThrow();
		}
		for (const page of loggedIn) {
			expect(page).toContain('<button type="button" class="menu-toggle" aria-expanded="false" aria-controls="site-menu"><span aria-hidden="true">☰</span> Menu</button>');
			expect(page).toContain('<form method="post" action="/logout">');
			expect(page).toContain('event.key === "Escape"');
		}
		for (const page of pages) expect(page).not.toContain('class="menu-toggle"');
	});
});
