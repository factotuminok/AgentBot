import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, PermissionFlagsBits as P } from "discord-api-types/v10";
import { createAdminApi } from "../../src/orchestrator/api/admin";
import { createChannelDirectory, createChannelsRoutes } from "../../src/orchestrator/api/channels";
import { createReposRoutes } from "../../src/orchestrator/api/repos";
import { startInternalApi } from "../../src/orchestrator/api/server";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { botInviteLink, UNWATCHED_TOPIC } from "../../src/orchestrator/engine/watches";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { CANT_SEE_CHANNEL, type ChannelListing, CHANNELS_UNCONFIGURED } from "../../src/shared/adminChannels";
import { REPOS_UNCONFIGURED } from "../../src/shared/adminRepos";
import { parseSettings } from "../../src/shared/config";
import { createAdminClient } from "../../src/web/adminClient";
import { reposPages } from "../../src/web/reposPage";
import { startWebServer } from "../../src/web/server";
import { esc } from "../../src/web/views";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeDiscordRest, startFakeDiscordRest } from "../fakes/discordRest";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

/**
 * WEB-20 to WEB-24 and WEB-32 end to end: the web UI over the orchestrator's admin API, with Discord's REST API and
 * GitHub faked. Settings are written to the vault directly, so the engine stays stopped unless a test saves through the page.
 */

const WEB_TOKEN = "web-token-for-repos-tests";
const SETUP_TOKEN = "setup-token-for-repos-tests";
const PASSWORD = "correct horse battery";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Stack {
	db: Db;
	vault: Vault;
	controller: Controller;
	github: FakeGitHub;
	discord: FakeDiscordRest;
	/** Web request with the admin's session; POSTs are form posts from the same origin. */
	get(path: string): Promise<Response>;
	post(path: string, fields: Record<string, string>): Promise<Response>;
	/** Admin API call with the web token, as the web pod makes it. */
	call(method: string, path: string, body?: unknown): Promise<Response>;
	/** Writes settings straight to the vault (the engine is not restarted). */
	store(discordOver?: Record<string, unknown>, opts?: { privateKey?: string }): void;
}

async function stack(): Promise<Stack> {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-repos-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const github = startFakeGitHub();
	const discord = startFakeDiscordRest();
	cleanups.push(() => github.stop(), () => discord.stop());
	const db = openDb(dbPath(dir));
	const vault = await openVault(db);
	const agentLog = await openAgentLog({ dir: join(dir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const dispatcher = createFakeDispatcher();
	const controller = createController({
		stateDir: dir,
		db,
		vault,
		agentLog,
		dispatcher,
		connectDiscord: () => createFakeDiscord(),
		connectGitHub: gh => createGitHub({ ...gh, baseUrl: github.url, throttle: false }),
	});
	const channels = createChannelDirectory({ db, vault, discordApi: discord.api });
	const admin = createAdminApi({
		db,
		vault,
		controller,
		dispatcher,
		version: "0.0.0-test",
		workerCapacity: 4,
		webToken: WEB_TOKEN,
		setupToken: SETUP_TOKEN,
		routes: { ...createChannelsRoutes(channels), ...createReposRoutes({ db, vault, channels, github: { baseUrl: github.url, throttle: false } }) },
		checkChannels: settings => channels.check(settings),
	});
	const api = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir: dir,
		db,
		version: "0.0.0-test",
		workerCapacity: 4,
		phase: () => controller.status().phase,
		config: () => (vault.isUnlocked() ? vault.readSettings()?.config : undefined),
		dispatcher,
		admin,
	});
	const web = startWebServer({ admin: createAdminClient({ baseUrl: api.url, token: WEB_TOKEN }), host: "127.0.0.1", port: 0, pages: reposPages });
	cleanups.push(
		async () => {
			await web.stop();
			await api.stop();
			await controller.stop();
		},
		() => db.close(),
	);
	await controller.apply();

	let cookie = "";
	const post = async (path: string, fields: Record<string, string>) => {
		const res = await fetch(web.url + path, {
			method: "POST",
			redirect: "manual",
			headers: { cookie, origin: web.url, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		});
		const set = res.headers.get("set-cookie");
		if (set) cookie = set.split(";")[0]!;
		return res;
	};
	expect((await post("/setup", { token: SETUP_TOKEN, username: "admin", password: PASSWORD, confirm: PASSWORD })).status).toBe(303);

	const s: Stack = {
		db,
		vault,
		controller,
		github,
		discord,
		get: path => fetch(web.url + path, { redirect: "manual", headers: { cookie } }),
		post,
		call: (method, path, body) =>
			fetch(`${api.url}/internal/admin${path}`, {
				method,
				headers: { Authorization: `Bearer ${WEB_TOKEN}`, "X-Agentbot-Admin": "admin", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		store(discordOver = {}, opts = {}) {
			vault.writeSettings(
				parseSettings({
					config: { discord: { guildId: discord.guildId, allowedUserIds: ["u1"], workChannelId: "none", ...discordOver }, github: { appId: github.appId } },
					secrets: { discordToken: discord.token, githubAppPrivateKey: opts.privateKey ?? github.privateKey },
				}),
			);
		},
	};
	return s;
}

async function page(s: Stack, path: string): Promise<string> {
	const res = await s.get(path);
	expect(res.status).toBe(200);
	return res.text();
}

/** Follows a form post's redirect and returns the page it lands on. */
async function postAndFollow(s: Stack, path: string, fields: Record<string, string>): Promise<string> {
	const res = await s.post(path, fields);
	expect(res.status).toBe(303);
	return page(s, res.headers.get("location")!);
}

/** The `<select>` named `name`, as HTML. */
function selectOf(html: string, name: string): string {
	const found = new RegExp(`<select[^>]*name="${name.replaceAll(".", "\\.")}"[^]*?</select>`).exec(html);
	if (!found) throw new Error(`no select ${name}`);
	return found[0];
}

describe("channel dropdowns (WEB-20 to WEB-23)", () => {
	test("before the token and guild are stored, channel fields are typed ids with the WEB-23 hint", async () => {
		const s = await stack();
		const html = await page(s, "/admin");
		expect(html).toContain(CHANNELS_UNCONFIGURED);
		expect(html).toMatch(/<input type="text" name="discord\.workChannelId"/);
		expect(await (await s.call("GET", "/channels")).json()).toEqual({ state: "unconfigured", message: CHANNELS_UNCONFIGURED });
	});

	test("text channels grouped by category in Discord's order, with permission states", async () => {
		const s = await stack();
		const d = s.discord;
		const bots = d.addChannel({ name: "Bots", type: ChannelType.GuildCategory, position: 1 });
		const ops = d.addChannel({ name: "Ops", type: ChannelType.GuildCategory, position: 0 });
		const general = d.addChannel({ name: "general", position: 0 });
		const work = d.addChannel({ name: "work", parentId: bots.id, position: 2 });
		const first = d.addChannel({ name: "first", parentId: bots.id, position: 1 });
		const secret = d.addChannel({ name: "secret", parentId: ops.id, overwrites: [{ id: d.guildId, deny: P.ViewChannel }] });
		const limited = d.addChannel({ name: "limited", parentId: ops.id, overwrites: [{ id: d.guildId, deny: P.AttachFiles | P.AddReactions }] });
		d.addChannel({ name: "voice", type: ChannelType.GuildVoice });
		d.addChannel({ name: "news", type: ChannelType.GuildAnnouncement });
		d.addChannel({ name: "forum", type: ChannelType.GuildForum });
		s.store({ workChannelId: work.id });

		const listing = (await (await s.call("GET", "/channels")).json()) as ChannelListing;
		if (listing.state !== "ok") throw new Error(JSON.stringify(listing));
		expect(listing.categories.map(c => c.name)).toEqual(["Ops", "Bots"]);
		expect(listing.channels.map(c => c.name)).toEqual(["general", "secret", "limited", "first", "work"]);
		expect(listing.channels.find(c => c.id === secret.id)).toMatchObject({ viewable: false });
		expect(listing.channels.find(c => c.id === limited.id)).toMatchObject({ viewable: true, missing: ["Attach Files", "Add Reactions"] });
		expect(listing.categories.find(c => c.id === bots.id)).toMatchObject({ viewable: true, missing: ["Manage Channels"] });

		const html = await page(s, "/admin");
		const select = selectOf(html, "discord.workChannelId");
		expect(select).toContain(`<option value="${work.id}" selected>#work</option>`);
		expect(select).toContain(`<option value="${general.id}">#general</option>`);
		expect(select).toMatch(new RegExp(`<optgroup label="Ops"><option value="${secret.id}" disabled data-blocked>#secret — ${esc(CANT_SEE_CHANNEL)}</option>`));
		expect(select).toContain(`#limited — missing Attach Files, Add Reactions</option>`);
		expect(select.indexOf('label="Ops"')).toBeLessThan(select.indexOf('label="Bots"'));
		expect(select).not.toMatch(/voice|news|forum/);
		expect(selectOf(html, "discord.watchCategoryId")).toContain(`<option value="${bots.id}">Bots — missing Manage Channels</option>`);
		expect(html).toContain('form="channels-refresh"');
		expect(html).toContain('<form id="channels-refresh" method="get" action="/admin">');
		// Few channels: no filter box.
		expect(html).not.toContain('aria-label="Filter the list"');
	});

	test("a missing permission in the current channel is a warning under the field", async () => {
		const s = await stack();
		const work = s.discord.addChannel({ name: "work", overwrites: [{ id: s.discord.guildId, deny: P.CreatePublicThreads }] });
		s.store({ workChannelId: work.id });
		expect(await page(s, "/admin")).toContain(`<p class="warning">The bot lacks Create Public Threads in #work.</p>`);
	});

	test("WEB-22: watch channels and channels used elsewhere are not offered; current choices stay visible", async () => {
		const s = await stack();
		const d = s.discord;
		const work = d.addChannel({ name: "work" });
		const ask = d.addChannel({ name: "ask" });
		const free = d.addChannel({ name: "free" });
		const watched = d.addChannel({ name: "acme-app" });
		s.db.watchRepo({ repoId: 1, repo: "acme/app", channelId: watched.id, createdBy: "admin" });
		s.store({ workChannelId: work.id, askChannelIds: [ask.id] });

		const html = await page(s, "/admin");
		const workSelect = selectOf(html, "discord.workChannelId");
		expect(workSelect).toContain(`value="${work.id}" selected`);
		expect(workSelect).toContain(`value="${free.id}"`);
		expect(workSelect).not.toContain(`value="${ask.id}"`);
		expect(workSelect).not.toContain(`value="${watched.id}"`);
		const add = selectOf(html, "discord.askChannelIds.add");
		expect(add).toContain(`value="${free.id}"`);
		for (const id of [work.id, ask.id, watched.id]) expect(add).not.toContain(`value="${id}"`);
		// The current ask-only channel stays listed, with a Remove box.
		expect(html).toContain(`<input type="hidden" name="discord.askChannelIds" value="${ask.id}" data-ask-channel>#ask`);
		expect(html).toContain(`name="discord.askChannelIds.remove" value="${ask.id}"`);
	});

	test("a configured channel that has disappeared shows as unknown channel <id>", async () => {
		const s = await stack();
		s.store({ workChannelId: "123456789" });
		const html = await page(s, "/admin");
		expect(selectOf(html, "discord.workChannelId")).toContain(`<option value="123456789" selected>unknown channel 123456789</option>`);
		expect(html).toContain("unknown channel 123456789: it no longer exists");
	});

	test("the list is cached; Refresh reloads it", async () => {
		const s = await stack();
		const work = s.discord.addChannel({ name: "work" });
		s.store({ workChannelId: work.id });
		await page(s, "/admin");
		const added = s.discord.addChannel({ name: "brand-new" });
		expect(selectOf(await page(s, "/admin"), "discord.workChannelId")).not.toContain(added.id);
		expect(selectOf(await page(s, "/admin?refreshChannels=1"), "discord.workChannelId")).toContain(added.id);
	});

	test("more than 20 channels get a filter box", async () => {
		const s = await stack();
		for (let i = 0; i < 21; i++) s.discord.addChannel({ name: `c${i}` });
		s.store({ workChannelId: "1" });
		expect(await page(s, "/admin")).toContain('data-filter-for="select-discord.workChannelId"');
	});

	test("listing errors show inline with Retry; stored values still save; Retry recovers", async () => {
		const s = await stack();
		const work = s.discord.addChannel({ name: "work" });
		s.store({ workChannelId: work.id });
		s.discord.token = "rotated";
		let html = await page(s, "/admin?refreshChannels=1");
		expect(html).toContain("The Discord bot token is invalid");
		expect(html).toContain('<button type="submit" form="channels-refresh">Retry</button>');
		expect(html).toContain(`<input type="hidden" name="discord.workChannelId" value="${work.id}">`);
		// The rest of the page stays usable.
		expect(html).toContain('name="github.appId"');

		s.discord.token = "fake-bot-token";
		s.discord.member = false;
		html = await page(s, "/admin?refreshChannels=1");
		const link = botInviteLink(s.discord.botUserId);
		expect(html).toContain("The bot is not a member of the Discord server");
		expect(html).toContain(`<a href="${link.replaceAll("&", "&amp;")}">Invite the bot</a>`);
		const listing = (await (await s.call("GET", "/channels?refresh=1")).json()) as ChannelListing;
		expect(listing).toMatchObject({ state: "error", inviteLink: link });

		s.discord.member = true;
		expect(await page(s, "/admin?refreshChannels=1")).toContain(`<option value="${work.id}" selected>#work</option>`);
	});

	test("Discord unreachable is reported as such", async () => {
		const s = await stack();
		s.store();
		const unreachable = createChannelDirectory({ db: s.db, vault: s.vault, discordApi: "http://127.0.0.1:9/api" });
		const listing = await unreachable.listing();
		expect(listing.state).toBe("error");
		if (listing.state === "error") expect(listing.error).toStartWith("Discord is unreachable:");
	});
});

describe("save-time channel check (WEB-24)", () => {
	/** Saves through the Settings page; returns the response and the page shown afterwards. */
	async function save(s: Stack, fields: Record<string, string>): Promise<{ status: number; html: string }> {
		const res = await s.post("/admin/settings", {
			"discord.guildId": s.discord.guildId,
			"discord.allowedUserIds": "u1",
			"github.appId": String(s.github.appId),
			"secrets.discordToken": s.discord.token,
			"secrets.githubAppPrivateKey": s.github.privateKey,
			...fields,
		});
		if (res.status === 303) return { status: 303, html: await page(s, res.headers.get("location")!) };
		return { status: res.status, html: await res.text() };
	}

	test("gone, not text, not viewable, or a watch channel: the save fails naming the field and the channel", async () => {
		const s = await stack();
		const d = s.discord;
		const voice = d.addChannel({ name: "voice", type: ChannelType.GuildVoice });
		const secret = d.addChannel({ name: "secret", overwrites: [{ id: d.guildId, deny: P.ViewChannel }] });
		const watched = d.addChannel({ name: "acme-app" });
		const ok = d.addChannel({ name: "ok" });
		s.db.watchRepo({ repoId: 1, repo: "acme/app", channelId: watched.id, createdBy: "admin" });

		const cases: [Record<string, string>, string][] = [
			[{ "discord.workChannelId": "424242" }, "Work channel (discord.workChannelId): channel 424242 no longer exists."],
			[{ "discord.workChannelId": voice.id }, "Work channel (discord.workChannelId): #voice is not a text channel."],
			[{ "discord.workChannelId": secret.id }, "Work channel (discord.workChannelId): the bot can&#39;t see #secret; add it to the channel."],
			[{ "discord.workChannelId": watched.id }, "Work channel (discord.workChannelId): #acme-app is the watch channel of acme/app."],
			[{ "discord.workChannelId": ok.id, "discord.askChannelIds.add": watched.id }, "Ask-only channel (discord.askChannelIds): #acme-app is the watch channel of acme/app."],
			[{ "discord.workChannelId": ok.id, "discord.watchCategoryId": ok.id }, "Watch category (discord.watchCategoryId): category ok is not a category."],
		];
		for (const [fields, message] of cases) {
			const { status, html } = await save(s, fields);
			expect([status, html.includes(message)]).toEqual([400, true]);
		}
		expect(s.vault.readSettings()).toBeUndefined();
	});

	test("other missing permissions save, with warnings shown with the result", async () => {
		const s = await stack();
		const work = s.discord.addChannel({ name: "work", overwrites: [{ id: s.discord.guildId, deny: P.AttachFiles }] });
		const category = s.discord.addChannel({ name: "Watched", type: ChannelType.GuildCategory });
		const { status, html } = await save(s, { "discord.workChannelId": work.id, "discord.watchCategoryId": category.id });
		expect(status).toBe(303);
		expect(html).toContain("Settings saved.");
		expect(html).toContain("<li>Work channel (discord.workChannelId): the bot lacks Attach Files in #work.</li>");
		expect(html).toContain("<li>Watch category (discord.watchCategoryId): the bot lacks Manage Channels in category Watched.</li>");
		expect(s.vault.readSettings()?.config.discord.workChannelId).toBe(work.id);
	});

	test("the Add and Remove controls edit the ask-only channels", async () => {
		const s = await stack();
		const work = s.discord.addChannel({ name: "work" });
		const a = s.discord.addChannel({ name: "a" });
		const b = s.discord.addChannel({ name: "b" });
		expect((await save(s, { "discord.workChannelId": work.id, "discord.askChannelIds": a.id, "discord.askChannelIds.add": b.id })).status).toBe(303);
		expect(s.vault.readSettings()?.config.discord.askChannelIds).toEqual([a.id, b.id]);
		const removed = await save(s, { "discord.workChannelId": work.id, "discord.askChannelIds": b.id, "discord.askChannelIds.remove": b.id });
		expect(removed.status).toBe(303);
		expect(s.vault.readSettings()?.config.discord.askChannelIds).toEqual([]);
	});
});

describe("Repositories page (WEB-32)", () => {
	test("before the App credentials are stored", async () => {
		const s = await stack();
		expect(await page(s, "/admin/repos")).toContain(REPOS_UNCONFIGURED);
	});

	test("listing errors show with Retry: invalid key (GH-02 wording), wrong App id", async () => {
		const s = await stack();
		s.store({}, { privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----" });
		let html = await page(s, "/admin/repos");
		expect(html).toContain("GitHub App private key: the key could not be read");
		expect(html).toContain(">Retry</button>");

		s.store();
		s.github.failRoute(/^GET \/app$/, 401);
		html = await page(s, "/admin/repos");
		expect(html).toContain(`GitHub rejected App id ${s.github.appId} with this private key (HTTP 401`);
		s.github.failRoute(/^GET \/app$/, undefined);
		expect(await page(s, "/admin/repos?refresh=1")).toContain("The GitHub App is not installed on any repository yet.");
	});

	test("no installations: links the App's installation page", async () => {
		const s = await stack();
		s.store();
		expect(await page(s, "/admin/repos")).toContain(`<a href="https://github.com/apps/${s.github.slug}/installations/new">`);
	});

	test("lists every repository, watched first, archived without Watch; filter above 20", async () => {
		const s = await stack();
		s.github.addInstallation();
		const zeta = s.github.addRepo("acme/zeta");
		s.github.addRepo("acme/app", { private: true, defaultBranch: "trunk" });
		s.github.addRepo("acme/old", { archived: true });
		const channel = s.discord.addChannel({ name: "acme-zeta" });
		s.db.watchRepo({ repoId: zeta.id, repo: "acme/zeta", channelId: channel.id, createdBy: "admin" });
		s.store();

		const html = await page(s, "/admin/repos");
		const order = [...html.matchAll(/<tr data-name="([^"]+)">/g)].map(m => m[1]);
		expect(order).toEqual(["acme/zeta", "acme/app", "acme/old"]);
		expect(html).toContain(`<a href="https://discord.com/channels/${s.discord.guildId}/${channel.id}">watched</a>`);
		expect(html).toContain("<td>acme/app</td><td>private</td><td>trunk</td>");
		expect(html).toMatch(/<tr data-name="acme\/old">.*<button type="button" disabled title="Archived repositories cannot be watched">Watch<\/button>/);
		expect(html).not.toContain('id="repo-filter"');

		for (let i = 0; i < 20; i++) s.github.addRepo(`acme/r${i}`);
		expect(await page(s, "/admin/repos?refresh=1")).toContain('id="repo-filter"');
	});

	test("Watch and Unwatch with the engine stopped go over Discord's REST API", async () => {
		const s = await stack();
		s.github.addInstallation();
		const repo = s.github.addRepo("Acme/App");
		s.github.addRepo("acme/old", { archived: true });
		const category = s.discord.addChannel({ name: "Watched", type: ChannelType.GuildCategory });
		s.store({ watchCategoryId: category.id });
		expect(s.controller.status().phase).not.toBe("running");

		// Without Manage Channels: refused with the reason and the invite link (DSC-38).
		let html = await postAndFollow(s, "/admin/repos/watch", { repo: "Acme/App" });
		expect(html).toContain("the bot needs the Manage Channels permission");
		expect(html).toContain(botInviteLink(s.discord.botUserId).replaceAll("&", "&amp;"));
		expect(s.db.getWatch(repo.id)).toBeNull();

		s.discord.addRole(P.ManageChannels, { bot: true });
		html = await postAndFollow(s, "/admin/repos/watch", { repo: "Acme/App" });
		expect(html).toContain("Watching Acme/App in a new channel #acme-app.");
		const watch = s.db.getWatch(repo.id)!;
		expect(watch).toMatchObject({ repo: "Acme/App", created_by: "admin", state: "watching" });
		const created = s.discord.channels.get(watch.channel_id)!;
		expect(created).toMatchObject({ name: "acme-app", parent_id: category.id, topic: "Watching Acme/App: issues labelled `agentbot` start here." });
		expect(html).toContain(`<a href="https://discord.com/channels/${s.discord.guildId}/${watch.channel_id}">watched</a>`);
		expect(html).toContain(">Unwatch</button>");

		html = await postAndFollow(s, "/admin/repos/unwatch", { repo: "Acme/App" });
		expect(html).toContain("Stopped watching Acme/App. Its channel is kept.");
		expect(s.db.getWatch(repo.id)?.state).toBe("unwatched");
		expect(created.topic).toBe(UNWATCHED_TOPIC);
		expect(s.discord.messages.at(-1)).toMatchObject({ channelId: created.id, content: expect.stringContaining("No longer watching") });

		// Re-watching reuses the channel.
		html = await postAndFollow(s, "/admin/repos/watch", { repo: "acme/app" });
		expect(html).toContain("Watching Acme/App in its earlier channel.");
		expect(s.db.getWatch(repo.id)?.channel_id).toBe(created.id);

		html = await postAndFollow(s, "/admin/repos/watch", { repo: "acme/old" });
		expect(html).toContain("acme/old is archived (read-only)");
		html = await postAndFollow(s, "/admin/repos/watch", { repo: "acme/nope" });
		expect(html).toContain("acme/nope is not an available repository.");
	});
});
