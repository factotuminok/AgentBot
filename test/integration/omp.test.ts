/**
 * `/admin/omp` end to end (AGT-20 to AGT-23, UPD-10): the web page over the orchestrator's `/omp*` admin API, a real
 * vault, the fake dispatcher answering "Test connection" (AGT-21), and the omp updater against a fake npm registry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpRoutes } from "../../src/orchestrator/api/omp";
import type { Dispatcher } from "../../src/orchestrator/dispatch/dispatcher";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { createOmpUpdater } from "../../src/orchestrator/omp/updates";
import { dbPath, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import type { McpTestState } from "../../src/shared/adminOmp";
import { listSettings } from "../../src/shared/ompconfig";
import { OMP_PACKAGE } from "../../src/shared/ompPins";
import { MCP_WAITING, OMP_SAVED, ompPages } from "../../src/web/ompPage";
import { eventually, type PageStack, startPageStack } from "../fakes/adminPages";
import { outsideImageUpdater, TEST_IDENTITY } from "../fakes/ompUpdates";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Harness {
	stack: PageStack;
	vault: Vault;
	fake: FakeDispatcher;
	/** Settles the next "Test connection". */
	answer: PromiseWithResolvers<{ ok: boolean; tools: string[]; error?: string }>;
	/** A worker picks the test up (it stays "waiting" until then). */
	pickedUp: PromiseWithResolvers<void>;
}

async function start(opts: { locked?: boolean } = {}): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-omp-"));
	const db = openDb(dbPath(dir));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
	const setup = await openVault(db);
	await setup.initialize("admin", "correct horse battery");
	// A restarted orchestrator's vault stays locked until the admin logs in.
	const vault = opts.locked ? await openVault(db) : setup;
	const h = { vault, answer: Promise.withResolvers(), pickedUp: Promise.withResolvers<void>() } as Harness;
	h.fake = createFakeDispatcher({ mcpTest: () => h.answer.promise });
	// Like the worker dispatcher: the test waits for a worker, and its timeout starts when one picks it up.
	const dispatcher: Pick<Dispatcher, "mcpTest"> = {
		async mcpTest(spec, testOpts) {
			testOpts?.onWaitingForWorker?.();
			const result = h.fake.mcpTest(spec);
			await h.pickedUp.promise;
			testOpts?.onStarted?.();
			return result;
		},
	};
	h.stack = await startPageStack(createOmpRoutes({ vault, dispatcher, updates: outsideImageUpdater(db) }), ompPages);
	return h;
}

async function save(h: Harness, fields: Record<string, string> | [string, string][]): Promise<Response> {
	return h.stack.post("/admin/omp", fields);
}

async function saved(h: Harness, fields: Record<string, string> | [string, string][]): Promise<void> {
	const res = await save(h, fields);
	if (res.status !== 303) throw new Error(`save refused (${res.status}): ${(await res.text()).match(/role="alert">([^<]*)/)?.[1]}`);
	expect(res.headers.get("location")).toBe("/admin/omp");
}

/** The error shown on a refused save. */
async function refusal(res: Response): Promise<string> {
	expect(res.status).toBe(400);
	const page = await res.text();
	const message = page.match(/class="error"[^>]*>([^<]*)</)?.[1];
	if (!message) throw new Error("no error shown");
	return message.replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

const STDIO_SERVER = {
	"mcp.0.name": "search",
	"mcp.0.type": "stdio",
	"mcp.0.enabled": "on",
	"mcp.0.instructions": "on",
	"mcp.0.timeout": "5000",
	"mcp.0.command": "npx",
	"mcp.0.args": "-y\n@example/search-mcp\n",
	"mcp.0.env.0.key": "SEARCH_API_KEY",
	"mcp.0.env.0.value": "env-secret-value",
};

describe("omp settings (AGT-20)", () => {
	test("the page shows the version, the pinned settings and the searchable reference", async () => {
		const h = await start();
		const res = await h.stack.get("/admin/omp");
		expect(res.status).toBe(200);
		const page = await res.text();
		expect(page).toContain("Image omp <code>18.12.1</code>, used by the orchestrator and by workers.");
		expect(page).toContain(`All omp settings (${listSettings().length})`);
		expect(page).toContain('id="omp-ref-filter"');
		for (const [id, value] of [
			["tools.approvalMode", '"yolo"'],
			["ask.timeout", "0"],
			["async.enabled", "false"],
		]) {
			expect(page).toContain(`<td><code>${id}</code> <span class="badge">PINNED</span></td><td><code>${value.replaceAll('"', "&quot;")}</code></td>`);
			// Not offered for overriding.
			expect(page).not.toContain(`<option value="${id}">`);
		}
		expect(page).toContain('<option value="git.enabled">');
	});

	test("overrides are saved through omp's parser; invalid values, unknown and pinned settings are refused", async () => {
		const h = await start();
		await saved(h, { "setting.new.id": "git.enabled", "setting.new.value": "false" });
		expect(await (await h.stack.get("/admin/omp")).text()).toContain(OMP_SAVED);
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false }, mcpServers: {} });

		const keep = { "setting.0.id": "git.enabled", "setting.0.value": "false" };
		const invalid = await save(h, { ...keep, "setting.new.id": "loop.conditionTimeoutMs", "setting.new.value": "soon" });
		expect(await refusal(invalid)).toStartWith("loop.conditionTimeoutMs: ");
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "symbolPreset", "setting.new.value": "emoji" }))).toStartWith("symbolPreset: ");
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "no.such.setting", "setting.new.value": "1" }))).toBe('Unknown omp setting "no.such.setting"');
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "tools.approvalMode", "setting.new.value": "ask" }))).toStartWith("tools.approvalMode is managed by AgentBot");
		expect(await refusal(await save(h, { ...keep, "setting.new.id": "ask.timeout", "setting.new.value": "30" }))).toStartWith("ask.timeout is managed by AgentBot");
		// The rejected submission is echoed for correction; nothing was stored.
		const echoed = await (await save(h, { ...keep, "setting.new.id": "loop.conditionTimeoutMs", "setting.new.value": "soon" })).text();
		expect(echoed).toContain('name="setting.new.id" list="omp-setting-ids" placeholder="add setting id" value="loop.conditionTimeoutMs"');
		expect(echoed).toContain(">soon</textarea>");
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false }, mcpServers: {} });
		// The API refuses pinned settings too.
		expect((await h.stack.api("PUT", "/omp", { settings: [{ id: "async.enabled", value: "true" }], servers: [] })).status).toBe(400);

		await saved(h, { ...keep, "setting.new.id": "loop.conditionTimeoutMs", "setting.new.value": "45000" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false, "loop.conditionTimeoutMs": 45000 }, mcpServers: {} });
		// Removing a row drops the override.
		await saved(h, { ...keep, "setting.0.remove": "on", "setting.1.id": "loop.conditionTimeoutMs", "setting.1.value": "45000" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "loop.conditionTimeoutMs": 45000 }, mcpServers: {} });
	});

	test("credential settings are write-only: never shown, kept when left blank", async () => {
		const h = await start();
		await saved(h, { "setting.new.id": "searxng.token", "setting.new.value": "searx-secret-token" });
		const page = await (await h.stack.get("/admin/omp")).text();
		expect(page).not.toContain("searx-secret-token");
		expect(page).toContain('<input type="password" name="setting.0.value" autocomplete="off" placeholder="blank keeps current"> <span class="hint">set</span>');

		await saved(h, { "setting.0.id": "searxng.token", "setting.0.value": "", "setting.new.id": "git.enabled", "setting.new.value": "true" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "searxng.token": "searx-secret-token", "git.enabled": true }, mcpServers: {} });
		// A rejected save doesn't echo a typed credential.
		const refused = await save(h, { "setting.0.id": "searxng.token", "setting.0.value": "typed-new-secret", "setting.new.id": "symbolPreset", "setting.new.value": "emoji" });
		expect(refused.status).toBe(400);
		expect(await refused.text()).not.toContain("typed-new-secret");
		await saved(h, { "setting.0.id": "searxng.token", "setting.0.value": "rotated-token" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "searxng.token": "rotated-token" }, mcpServers: {} });
	});

	test("a stored configuration that no longer validates shows what still parses, and a save replaces it", async () => {
		const h = await start();
		h.vault.writeOmpConfig({ settings: { "git.enabled": false, "gone.in.this.omp": 1 }, mcpServers: { good: { command: "npx" }, broken: { type: "http", url: "nope" } } });
		const page = await (await h.stack.get("/admin/omp")).text();
		expect(page).toContain("The stored omp configuration no longer validates");
		expect(page).toContain('value="gone.in.this.omp" readonly');
		expect(page).toContain('name="mcp.0.name" value="good" readonly');
		expect(page).not.toContain('value="broken"');
		await saved(h, { "setting.0.id": "git.enabled", "setting.0.value": "false", "mcp.0.name": "good", "mcp.0.type": "stdio", "mcp.0.enabled": "on", "mcp.0.command": "npx" });
		expect(h.vault.readOmpConfig()).toEqual({ settings: { "git.enabled": false }, mcpServers: { good: { type: "stdio", command: "npx", instructions: false } } });
	});

	test("a locked vault is reported, not served", async () => {
		const h = await start({ locked: true });
		const res = await h.stack.get("/admin/omp");
		expect(res.status).toBe(409);
		expect(await res.text()).toContain("Settings are locked");
		expect((await save(h, { "setting.new.id": "git.enabled", "setting.new.value": "true" })).status).toBe(409);
	});
});

describe("MCP servers (AGT-21)", () => {
	test("add, edit and remove servers; env and header values are write-only", async () => {
		const h = await start();
		await saved(h, STDIO_SERVER);
		expect(h.vault.readOmpConfig()).toEqual({
			settings: {},
			mcpServers: { search: { type: "stdio", command: "npx", args: ["-y", "@example/search-mcp"], env: { SEARCH_API_KEY: "env-secret-value" }, timeout: 5000 } },
		});
		const page = await (await h.stack.get("/admin/omp")).text();
		expect(page).not.toContain("env-secret-value");
		expect(page).toContain('name="mcp.0.name" value="search" readonly');
		expect(page).toContain('value="SEARCH_API_KEY" readonly');
		expect(page).toContain("Test connection");

		// Edit: blank env value keeps the stored one; disable (an unchecked box isn't sent); add a remote server with a header.
		const { "mcp.0.enabled": _enabled, ...disabled } = STDIO_SERVER;
		await saved(h, {
			...disabled,
			"mcp.0.env.0.value": "",
			"mcp.0.env.1.key": "REGION",
			"mcp.0.env.1.value": "eu",
			"mcp.1.name": "docs",
			"mcp.1.type": "http",
			"mcp.1.enabled": "on",
			"mcp.1.url": "https://mcp.example.com/docs",
			"mcp.1.header.0.key": "Authorization",
			"mcp.1.header.0.value": "Bearer header-secret",
		});
		const search = { type: "stdio", command: "npx", args: ["-y", "@example/search-mcp"], env: { SEARCH_API_KEY: "env-secret-value", REGION: "eu" }, timeout: 5000, enabled: false };
		expect(h.vault.readOmpConfig()).toEqual({
			settings: {},
			mcpServers: { search, docs: { type: "http", url: "https://mcp.example.com/docs", headers: { Authorization: "Bearer header-secret" }, instructions: false } },
		});
		const edited = await (await h.stack.get("/admin/omp")).text();
		expect(edited).not.toContain("header-secret");
		expect(edited).not.toContain("env-secret-value");

		// Remove one server.
		await saved(h, {
			...disabled,
			"mcp.0.env.0.value": "",
			"mcp.0.env.1.key": "REGION",
			"mcp.1.name": "docs",
			"mcp.1.type": "http",
			"mcp.1.url": "https://mcp.example.com/docs",
			"mcp.1.delete": "on",
		});
		expect(h.vault.readOmpConfig()).toEqual({ settings: {}, mcpServers: { search } });
	});

	test("invalid servers are refused with the reason", async () => {
		const h = await start();
		const server = (fields: Record<string, string>) => save(h, { "mcp.0.type": "stdio", "mcp.0.enabled": "on", "mcp.0.command": "npx", ...fields });
		expect(await refusal(await server({ "mcp.0.name": "bad name" }))).toBe("Invalid omp config: mcpServers.bad name: name may use letters, digits, - and _ (max 48)");
		expect(await refusal(await server({ "mcp.0.name": "x".repeat(49) }))).toContain("max 48");
		expect(await refusal(await server({ "mcp.0.name": "__proto__" }))).toBe("Invalid omp config: mcpServers.__proto__: reserved name");
		expect(await refusal(await server({ "mcp.0.name": "constructor" }))).toBe("Invalid omp config: mcpServers.constructor: reserved name");
		expect(await refusal(await server({ "mcp.0.name": "", "mcp.0.command": "npx" }))).toBe("Every MCP server needs a name");
		expect(await refusal(await server({ "mcp.0.name": "s", "mcp.0.command": "" }))).toContain("command is required");
		expect(await refusal(await server({ "mcp.0.name": "s", "mcp.0.timeout": "-1" }))).toContain("must be a whole number of milliseconds");
		expect(await refusal(await server({ "mcp.0.name": "s", "mcp.0.type": "sse", "mcp.0.url": "ftp://example.com" }))).toContain("url must be an http(s) URL");
		expect(await refusal(await server({ "mcp.0.name": "s", "mcp.1.name": "s", "mcp.1.type": "stdio", "mcp.1.command": "x" }))).toBe('Duplicate MCP server name "s"');
		expect(h.vault.readOmpConfig()).toBeUndefined();
	});

	test("Test connection waits for a worker, then shows the result", async () => {
		const h = await start();
		await saved(h, STDIO_SERVER);
		const started = await h.stack.post("/admin/omp/mcp/test", { ...STDIO_SERVER, server: "search" });
		expect(started.status).toBe(303);
		const location = started.headers.get("location")!;
		expect(location).toStartWith("/admin/omp/mcp/test/");

		const waiting = await (await h.stack.get(location)).text();
		expect(waiting).toContain(MCP_WAITING);
		expect(waiting).toContain(`${location}.json`); // polls
		// The worker gets the saved server, write-only values included.
		expect(h.fake.mcpTests).toEqual([{ name: "search", server: { type: "stdio", command: "npx", args: ["-y", "@example/search-mcp"], env: { SEARCH_API_KEY: "env-secret-value" }, timeout: 5000 } }]);

		h.pickedUp.resolve();
		await eventually(async () => ((await (await h.stack.get(`${location}.json`)).json()) as McpTestState).status === "running" || undefined, "the pickup");
		expect(await (await h.stack.get(location)).text()).toContain("Connecting…");
		h.answer.resolve({ ok: true, tools: ["web_search", "fetch_page"] });
		const done = await eventually(async () => {
			const state = (await (await h.stack.get(`${location}.json`)).json()) as McpTestState;
			return state.status === "done" ? state : undefined;
		}, "test result");
		expect(done.result).toEqual({ ok: true, tools: ["web_search", "fetch_page"] });
		const page = await (await h.stack.get(location)).text();
		expect(page).toContain("Connected to search: 2 tools.");
		expect(page).toContain("<code>fetch_page</code>");
		expect(page).not.toContain(MCP_WAITING);

		// A failure shows its error.
		h.answer = Promise.withResolvers();
		const second = (await h.stack.post("/admin/omp/mcp/test", { server: "search" })).headers.get("location")!;
		h.answer.resolve({ ok: false, tools: [], error: "spawn npx ENOENT" });
		await eventually(async () => ((await (await h.stack.get(`${second}.json`)).json()) as McpTestState).status === "done" || undefined, "failed test");
		expect(await (await h.stack.get(second)).text()).toContain("Connection failed: spawn npx ENOENT");

		// Only saved servers can be tested.
		const unknown = await h.stack.post("/admin/omp/mcp/test", { server: "nope" });
		expect(unknown.headers.get("location")).toBe("/admin/omp");
		expect(await (await h.stack.get("/admin/omp")).text()).toContain("No saved MCP server named &quot;nope&quot;.");
		expect((await h.stack.get("/admin/omp/mcp/test/missing")).status).toBe(404);
	});
});

describe("omp version and updates (UPD-10)", () => {
	test("the page shows the image's and the workers' omp when they differ, the update status, and Check now", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agentbot-omp-upd-"));
		const db = openDb(dbPath(dir));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
		const vault = await openVault(db);
		await vault.initialize("admin", "correct horse battery");
		const registry = { answer: () => Response.json({ version: "99.2.0" }) };
		const npm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => registry.answer() });
		cleanups.push(() => void npm.stop(true));
		const updater = createOmpUpdater({
			db,
			runtimeDir: join(dir, "omp-runtime"),
			identity: TEST_IDENTITY,
			imageOmpVersion: "18.12.1",
			imageAppDir: dir,
			registryUrl: npm.url.href,
			installer: async ({ dir: app, version }) => {
				for (const sub of ["src", join("node_modules", OMP_PACKAGE)]) mkdirSync(join(app, sub), { recursive: true });
				writeFileSync(join(app, "package.json"), "{}");
				writeFileSync(join(app, "bun.lock"), "");
				writeFileSync(join(app, "node_modules", OMP_PACKAGE, "package.json"), JSON.stringify({ version }));
				return { output: "" };
			},
		});
		cleanups.push(() => updater.stop());
		const stack = await startPageStack(createOmpRoutes({ vault, dispatcher: createFakeDispatcher(), updates: updater }), ompPages);

		// Before any check: the image's omp only.
		let page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Image omp <code>18.12.1</code>, used by the orchestrator and by workers.");
		expect(page).toContain("not checked yet");
		expect(page).toContain('<form method="post" action="/admin/omp/update-check"><button type="submit">Check now</button></form>');

		// Check now: a newer omp is offered; an approved one makes workers use it while the orchestrator keeps the image's.
		let res = await stack.post("/admin/omp/update-check", {});
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/omp");
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Checked npm: the latest omp is 99.2.0. omp 99.2.0 is available for workers; approve it in the Discord work channel.");
		expect(page).toContain("omp 99.2.0 is available: approve it in the Discord work channel");
		expect(await updater.install("99.2.0", "@alice")).toMatchObject({ ok: true });
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("Workers use omp <code>99.2.0</code>");
		expect(page).toContain("The orchestrator keeps the image's omp <code>18.12.1</code>");
		expect(page).toContain("omp 99.2.0 (from 18.12.1), installed; approved by @alice");
		expect(page).toContain("<tr><th>Update</th><td>up to date</td></tr>");

		// A failed check is stored and shown, and the last good answer stays.
		registry.answer = () => new Response("down", { status: 502 });
		res = await stack.post("/admin/omp/update-check", {});
		page = await (await stack.get("/admin/omp")).text();
		expect(page).toContain("The npm check failed: the npm registry answered 502");
		expect(page).toContain('<tr><th>Check error</th><td><span class="error">the npm registry answered 502</span></td></tr>');
		expect(page).toContain("<tr><th>Latest on npm</th><td><code>99.2.0</code></td></tr>");
		const view = (await (await stack.api("GET", "/omp")).json()) as { update: { active?: { version: string }; image: string } };
		expect(view.update).toMatchObject({ image: "18.12.1", active: { version: "99.2.0" } });
	});
});
