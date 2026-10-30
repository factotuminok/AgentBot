/**
 * Phase 6 exit (implementation §4): a fresh install configured entirely in the browser — setup token → admin account →
 * Discord and GitHub credentials → work channel chosen from the dropdown → repository watched from the Repositories
 * page → model sign-in — with each step's validation errors shown. The real orchestrator admin API (vault, controller,
 * every feature route as `main.ts` mounts them) behind the real web server; Discord's REST API and gateway, GitHub and
 * the provider sign-in are faked. Forms are read from the served HTML and posted back the way a browser submits them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { ChannelType, PermissionFlagsBits as P } from "discord-api-types/v10";
import { createAdminApi } from "../../src/orchestrator/api/admin";
import { createAdminFeatures } from "../../src/orchestrator/api/features";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import type { SigninBackend } from "../../src/orchestrator/store/accounts";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { openSignins, type Signins } from "../../src/orchestrator/store/signins";
import { openVault } from "../../src/orchestrator/store/vault";
import type { LoginState } from "../../src/shared/adminModels";
import { WORK_CHANNEL_MISSING } from "../../src/shared/config";
import { openRollingFiles } from "../../src/shared/rollinglog";
import { createAdminClient } from "../../src/web/adminClient";
import { FEATURE_PAGES } from "../../src/web/pages";
import { startWebServer, type WebServer } from "../../src/web/server";
import { outsideImageUpdater } from "../fakes/ompUpdates";
import { eventually } from "../fakes/adminPages";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeDiscordRest, startFakeDiscordRest } from "../fakes/discordRest";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const WEB_TOKEN = "web-token-for-phase6";
const SETUP_TOKEN = "setup-token-for-phase6";
const PASSWORD = "correct horse battery";
const ADMIN_DISCORD_USER = "234567890123456789";

/** Anthropic-like browser flow: the admin pastes the code from the redirect; only `good-code` is accepted. */
function fakeSignin(signins: Signins): SigninBackend {
	return {
		providers: () => [{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", storedAs: "anthropic" }],
		async login(_providerId: string, ctrl: OAuthLoginCallbacks) {
			ctrl.onAuth({ url: "https://claude.example.com/oauth/authorize?redirect_uri=http://localhost:54545/callback" });
			const pasted = (await ctrl.onManualCodeInput!(ctrl.signal)).trim();
			if (pasted !== "good-code") throw new Error("Token exchange failed: invalid code");
			await signins.authStorage.credentials.upsert("anthropic", {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
				email: "admin@example.com",
				authorizedAt: Date.now(),
			});
			return { email: "admin@example.com" };
		},
		models: () => signins.authStorage.credentials.list().map(row => ({ provider: row.provider, id: `${row.provider}/claude-test`, name: "Claude test" })),
		changed() {},
	};
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'" };
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, e => ENTITIES[e]!);

/** The fields a browser would submit for the form posting to `action`, before any button is pressed. */
async function formFields(page: string, action: string): Promise<Record<string, string>> {
	const fields: [string, string][] = [];
	let inForm = false;
	let select: { name: string; selected?: string; first?: string } | undefined;
	let textarea: { name: string; text: string } | undefined;
	let found = false;
	await new HTMLRewriter()
		.on("form", {
			element(el) {
				inForm = el.getAttribute("action") === action;
				found ||= inForm;
				el.onEndTag(() => {
					inForm = false;
				});
			},
		})
		.on("input", {
			element(el) {
				const name = el.getAttribute("name");
				const type = el.getAttribute("type") ?? "text";
				if (!inForm || !name || ["submit", "button", "file", "reset"].includes(type)) return;
				if ((type === "checkbox" || type === "radio") && !el.hasAttribute("checked")) return;
				fields.push([name, unescape(el.getAttribute("value") ?? (type === "checkbox" ? "on" : ""))]);
			},
		})
		.on("select", {
			element(el) {
				const name = el.getAttribute("name");
				if (!inForm || !name) return;
				select = { name };
				el.onEndTag(() => {
					const value = select!.selected ?? select!.first;
					if (value !== undefined) fields.push([select!.name, value]);
					select = undefined;
				});
			},
		})
		.on("option", {
			element(el) {
				if (!select || el.hasAttribute("disabled")) return;
				const value = unescape(el.getAttribute("value") ?? "");
				if (el.hasAttribute("selected")) select.selected = value;
				select.first ??= value;
			},
		})
		.on("textarea", {
			element(el) {
				const name = el.getAttribute("name");
				if (!inForm || !name) return;
				textarea = { name, text: "" };
				el.onEndTag(() => {
					fields.push([textarea!.name, unescape(textarea!.text).replace(/^\n/, "")]);
					textarea = undefined;
				});
			},
			text(chunk) {
				if (textarea) textarea.text += chunk.text;
			},
		})
		.transform(new Response(page))
		.text();
	if (!found) throw new Error(`no form posting to ${action}`);
	return Object.fromEntries(fields);
}

/** `value → label` of a select's enabled options, and the disabled ones' labels. */
function selectOptions(page: string, name: string): { enabled: Map<string, string>; disabled: string[] } {
	const select = new RegExp(`<select[^>]*name="${name.replaceAll(".", "\\.")}"[^>]*>([\\s\\S]*?)</select>`).exec(page);
	if (!select) throw new Error(`no select ${name}`);
	const enabled = new Map<string, string>();
	const disabled: string[] = [];
	for (const m of select[1]!.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)) {
		const value = /value="([^"]*)"/.exec(m[1]!)?.[1] ?? "";
		if (/\bdisabled\b/.test(m[1]!)) disabled.push(unescape(m[2]!));
		else enabled.set(value, unescape(m[2]!));
	}
	return { enabled, disabled };
}

interface Install {
	stateDir: string;
	db: Db;
	signins: Signins;
	controller: Controller;
	api: InternalApi;
	web: WebServer;
	github: FakeGitHub;
	discord: FakeDiscordRest;
	cookie?: string;
	get(path: string): Promise<Response>;
	post(path: string, fields: Record<string, string>): Promise<Response>;
	/** Follows a POST's redirect like a browser and returns the page shown. */
	submit(path: string, fields: Record<string, string>): Promise<{ status: number; page: string }>;
}

let s: Install;

beforeAll(async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-phase6-"));
	mkdirSync(join(stateDir, "logs", "orchestrator"), { recursive: true });
	const db = openDb(dbPath(stateDir));
	const vault = await openVault(db);
	const agentLog = await openAgentLog({ dir: join(stateDir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const processLog = openRollingFiles({ dir: join(stateDir, "logs", "orchestrator"), prefix: "orchestrator", maxBytes: 1024 ** 3 });
	const signins = await openSignins(stateDir);
	const github = startFakeGitHub();
	const discord = startFakeDiscordRest({ token: "real-bot-token" });
	const dispatcher = createFakeDispatcher();
	const controller = createController({
		stateDir,
		db,
		vault,
		agentLog,
		dispatcher,
		connectDiscord: () => createFakeDiscord({ guildId: discord.guildId }),
		connectGitHub: gh => createGitHub({ ...gh, baseUrl: github.url, throttle: false }),
	});
	const features = createAdminFeatures({
		db,
		vault,
		signins,
		dispatcher,
		agentLog,
		processLog,
		stateDir,
		ompDir: join(stateDir, "omp"),
		controller,
		workerCapacity: 4,
		ompUpdates: outsideImageUpdater(db),
		discordApi: discord.api,
		github: { baseUrl: github.url, throttle: false },
		signinBackend: fakeSignin(signins),
	});
	const admin = createAdminApi({
		db,
		vault,
		controller,
		dispatcher,
		version: "0.0.0-test",
		workerCapacity: 4,
		webToken: WEB_TOKEN,
		setupToken: SETUP_TOKEN,
		routes: features.routes,
		modelAccounts: features.modelAccounts,
		checkChannels: features.checkChannels,
	});
	const api = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir,
		db,
		version: "0.0.0-test",
		workerCapacity: 4,
		phase: () => controller.status().phase,
		config: () => undefined,
		dispatcher,
		admin,
	});
	await controller.apply();
	const web = startWebServer({
		admin: createAdminClient({ baseUrl: api.url, token: WEB_TOKEN, timeoutMs: 5_000 }),
		host: "127.0.0.1",
		port: 0,
		pages: FEATURE_PAGES,
	});
	const headers = (): Record<string, string> => (s.cookie ? { cookie: s.cookie } : {});
	s = {
		stateDir,
		db,
		signins,
		controller,
		api,
		web,
		github,
		discord,
		get: path => fetch(web.url + path, { redirect: "manual", headers: headers() }),
		post: (path, fields) =>
			fetch(web.url + path, {
				method: "POST",
				redirect: "manual",
				headers: { ...headers(), origin: web.url, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(fields).toString(),
			}),
		async submit(path, fields) {
			const res = await s.post(path, fields);
			const cookie = res.headers.get("set-cookie")?.split(";")[0];
			if (cookie) s.cookie = cookie;
			if (res.status !== 303) return { status: res.status, page: await res.text() };
			const next = await s.get(res.headers.get("location")!);
			return { status: next.status, page: await next.text() };
		},
	};
});

afterAll(async () => {
	await s.web.stop();
	await s.api.stop();
	await s.controller.stop();
	await s.github.stop();
	await s.discord.stop();
	s.signins.close();
	s.db.close();
	rmSync(s.stateDir, { recursive: true, force: true });
});

describe("phase 6 exit: a fresh install configured in the browser", () => {
	test("1. setup token and admin account", async () => {
		const home = await s.get("/");
		expect(home.headers.get("location")).toBe("/setup");
		const form = await formFields(await (await s.get("/setup")).text(), "/setup");
		expect(Object.keys(form).sort()).toEqual(["confirm", "password", "token", "username"]);

		const mismatch = await s.submit("/setup", { token: SETUP_TOKEN, username: "admin", password: PASSWORD, confirm: "something else" });
		expect(mismatch.status).toBe(400);
		expect(mismatch.page).toContain('class="error"');

		const wrongToken = await s.submit("/setup", { token: "not-the-token", username: "admin", password: PASSWORD, confirm: PASSWORD });
		expect(wrongToken.status).toBe(400);
		expect(wrongToken.page).toContain('class="error"');
		expect(s.cookie).toBeUndefined();

		const created = await s.submit("/setup", { token: SETUP_TOKEN, username: "admin", password: PASSWORD, confirm: PASSWORD });
		expect(created.status).toBe(200);
		expect(s.cookie).toBeDefined();
		expect(s.controller.status().phase).toBe("unconfigured");
	});

	test("2. Discord and GitHub credentials: invalid input is refused, then saved without a work channel", async () => {
		const admin = await (await s.get("/admin")).text();
		// WEB-23: no dropdowns before the bot token and guild id are stored.
		expect(admin).not.toContain('<select name="discord.workChannelId"');
		const form = await formFields(admin, "/admin/settings");

		const missingApp = await s.submit("/admin/settings", {
			...form,
			"discord.guildId": s.discord.guildId,
			"discord.allowedUserIds": ADMIN_DISCORD_USER,
			"secrets.discordToken": "real-bot-token",
			"secrets.githubAppPrivateKey": s.github.privateKey,
		});
		expect(missingApp.status).toBe(400);
		expect(missingApp.page).toContain("github.appId");

		const saved = await s.submit("/admin/settings", {
			...form,
			"discord.guildId": s.discord.guildId,
			"discord.allowedUserIds": ADMIN_DISCORD_USER,
			"github.appId": String(s.github.appId),
			"secrets.discordToken": "wrong-bot-token",
			"secrets.githubAppPrivateKey": s.github.privateKey,
		});
		expect(saved.status).toBe(200);
		expect(saved.page).toContain(`Settings saved. Engine is unconfigured: ${WORK_CHANNEL_MISSING}`);
		expect(s.controller.status()).toMatchObject({ phase: "unconfigured", error: WORK_CHANNEL_MISSING });
		// A wrong bot token: the channel fields say why and offer Retry.
		expect(saved.page).toContain("Retry");

		const fixed = await s.submit("/admin/settings", { ...(await formFields(saved.page, "/admin/settings")), "secrets.discordToken": "real-bot-token" });
		expect(fixed.status).toBe(200);
		expect(fixed.page).toContain("Settings saved.");
	});

	test("3. the work channel is chosen from the dropdown; a channel deleted meanwhile is refused", async () => {
		const ops = s.discord.addChannel({ name: "ops", type: ChannelType.GuildCategory });
		const work = s.discord.addChannel({ name: "agentbot-work", parentId: ops.id });
		s.discord.addChannel({ name: "voice", type: ChannelType.GuildVoice });
		s.discord.addChannel({ name: "secret", overwrites: [{ id: s.discord.guildId, deny: P.ViewChannel }] });
		const doomed = s.discord.addChannel({ name: "doomed" });

		const page = await (await s.get("/admin?refreshChannels=1")).text();
		const options = selectOptions(page, "discord.workChannelId");
		expect([...options.enabled.values()]).toEqual(expect.arrayContaining(["#agentbot-work", "#doomed"]));
		expect([...options.enabled.values()].join(" ")).not.toContain("voice");
		// The bot can't see #secret: listed, not choosable (WEB-21).
		expect(options.disabled.join(" ")).toContain("#secret");
		const form = await formFields(page, "/admin/settings");

		// WEB-24: the save is checked against the live guild.
		s.discord.channels.delete(doomed.id);
		const refused = await s.submit("/admin/settings", { ...form, "discord.workChannelId": doomed.id });
		expect(refused.status).toBe(400);
		expect(refused.page).toContain(`channel ${doomed.id} no longer exists`);
		expect(s.controller.status().phase).toBe("unconfigured");

		const saved = await s.submit("/admin/settings", { ...form, "discord.workChannelId": work.id });
		expect(saved.status).toBe(200);
		expect(saved.page).toContain("Settings saved. Engine is running.");
		expect(s.controller.status().phase).toBe("running");
		expect(selectOptions(saved.page, "discord.workChannelId").enabled.get(work.id)).toBe("#agentbot-work");
		expect(saved.page).toMatch(new RegExp(`<option value="${work.id}" selected>`));
	});

	test("4. a repository is watched from the Repositories page; an archived one is refused", async () => {
		s.github.addRepo("acme/app");
		s.github.addRepo("acme/old", { archived: true });
		s.discord.addRole(P.ManageChannels, { bot: true });

		const page = await (await s.get("/admin/repos?refresh=1")).text();
		expect(page).toContain("acme/app");
		const watchForm = await formFields(page.slice(page.indexOf("acme/app")), "/admin/repos/watch");
		expect(watchForm).toEqual({ repo: "acme/app" });

		const archived = await s.submit("/admin/repos/watch", { repo: "acme/old" });
		expect(archived.page).toContain("acme/old is archived");
		expect(s.db.listWatches()).toEqual([]);

		const watched = await s.submit("/admin/repos/watch", watchForm);
		expect(watched.status).toBe(200);
		const [watch] = s.db.listWatches();
		expect(watch).toMatchObject({ repo: "acme/app", state: "watching", created_by: "admin" });
		const channel = s.discord.channels.get(watch!.channel_id)!;
		expect(channel.type).toBe(ChannelType.GuildText);
		expect(watched.page).toContain("Unwatch");
	});

	test("5. model sign-in: a wrong code fails with its error, the right one adds the account", async () => {
		const page = await (await s.get("/admin/models")).text();
		expect(page).toContain('value="anthropic"');

		const login = async (code: string): Promise<LoginState> => {
			const started = await s.post("/admin/models/login", { provider: "anthropic" });
			expect(started.status).toBe(303);
			const location = started.headers.get("location")!;
			await eventually(async () => {
				const state = (await (await s.get(`${location}.json`)).json()) as LoginState;
				return state.status === "needs_input" ? state : undefined;
			}, "the paste box");
			const loginPage = await (await s.get(location)).text();
			const input = await formFields(loginPage, `${location}/input`);
			await s.submit(`${location}/input`, { ...input, text: code });
			return eventually(async () => {
				const state = (await (await s.get(`${location}.json`)).json()) as LoginState;
				return state.status === "failed" || state.status === "done" ? state : undefined;
			}, "the sign-in to finish");
		};

		const failed = await login("bad-code");
		expect(failed).toMatchObject({ status: "failed" });
		expect(JSON.stringify(failed)).toContain("Token exchange failed: invalid code");
		expect(s.signins.authStorage.credentials.list()).toHaveLength(0);

		expect(await login("good-code")).toMatchObject({ status: "done" });
		const after = await (await s.get("/admin/models")).text();
		expect(after).toContain("admin@example.com");
		expect(after).toContain("anthropic/claude-test");
	});

	test("the home checklist shows every step done", async () => {
		const home = await (await s.get("/")).text();
		const steps = [...home.matchAll(/<li data-step="(\w+)" class="(\w+)">/g)].map(m => `${m[1]}:${m[2]}`);
		expect(steps).toEqual(["setup:done", "credentials:done", "workChannel:done", "watchedRepo:done", "modelAccess:done"]);
	});
});
