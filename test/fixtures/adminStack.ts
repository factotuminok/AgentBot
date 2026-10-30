import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminApi } from "../../src/orchestrator/api/admin";
import type { AdminRoutes } from "../../src/orchestrator/api/http";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { createController } from "../../src/orchestrator/engine/controller";
import { type AgentLog, openAgentLog } from "../../src/orchestrator/store/agentlog";
import { dbPath, openDb } from "../../src/orchestrator/store/db";
import { openVault } from "../../src/orchestrator/store/vault";
import { openRollingFiles, type RollingFiles } from "../../src/shared/rollinglog";
import { createAdminClient } from "../../src/web/adminClient";
import type { PageRoutes } from "../../src/web/http";
import { startWebServer, type WebServer } from "../../src/web/server";
import type { VsCodeConfig } from "../../src/web/vscode";
import { createFakeDiscord } from "../fakes/discord";

/**
 * A real orchestrator admin API (db, vault, controller with a fake Discord, feature routes) and a real web server in
 * front of it, logged in as the admin: feature pages can be driven end to end without Discord, GitHub or providers.
 */

const WEB_TOKEN = "web-api-token-for-tests";
const SETUP_TOKEN = "setup-token-for-tests";
export const STACK_USERNAME = "admin";
const PASSWORD = "correct horse battery";

export interface StackDeps {
	stateDir: string;
	agentLog: AgentLog;
	processLog: RollingFiles;
}

export interface AdminStack extends StackDeps {
	api: InternalApi;
	web: WebServer;
	/** The logged-in browser's cookie. */
	cookie: string;
	/** Admin API call with the web token. */
	call(method: string, path: string, init?: { body?: BodyInit; headers?: Record<string, string> }): Promise<Response>;
	/** Web GET as the logged-in browser. */
	get(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response>;
	/** Same-origin web POST as the logged-in browser (form fields, or multipart form data). */
	post(path: string, body: Record<string, string> | FormData): Promise<Response>;
	close(): Promise<void>;
}

export async function startAdminStack(opts: { routes(deps: StackDeps): AdminRoutes; pages: PageRoutes; vscode?: VsCodeConfig }): Promise<AdminStack> {
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-stack-"));
	mkdirSync(join(stateDir, "logs", "orchestrator"), { recursive: true });
	const db = openDb(dbPath(stateDir));
	const vault = await openVault(db);
	const agentLog = await openAgentLog({ dir: join(stateDir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const processLog = openRollingFiles({ dir: join(stateDir, "logs", "orchestrator"), prefix: "orchestrator", maxBytes: 1024 ** 3 });
	const deps: StackDeps = { stateDir, agentLog, processLog };
	const dispatcher = createFakeDispatcher();
	const controller = createController({ stateDir, db, vault, agentLog, dispatcher, connectDiscord: () => createFakeDiscord() });
	const admin = createAdminApi({
		db,
		vault,
		controller,
		dispatcher,
		version: "0.0.0-test",
		workerCapacity: 4,
		webToken: WEB_TOKEN,
		setupToken: SETUP_TOKEN,
		routes: opts.routes(deps),
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
		pages: opts.pages,
		vscode: opts.vscode,
	});

	const setup = await fetch(`${web.url}/setup`, {
		method: "POST",
		redirect: "manual",
		headers: { origin: web.url, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token: SETUP_TOKEN, username: STACK_USERNAME, password: PASSWORD, confirm: PASSWORD }).toString(),
	});
	const cookie = setup.headers.get("set-cookie")?.split(";")[0];
	if (setup.status !== 303 || !cookie) throw new Error(`stack setup failed: HTTP ${setup.status}`);

	return {
		...deps,
		api,
		web,
		cookie,
		call: (method, path, init = {}) =>
			fetch(`${api.url}/internal/admin${path}`, { method, headers: { Authorization: `Bearer ${WEB_TOKEN}`, ...init.headers }, body: init.body }),
		get: (path, headers = {}, signal) => fetch(web.url + path, { redirect: "manual", headers: { cookie, ...headers }, signal }),
		post: (path, body) =>
			fetch(web.url + path, {
				method: "POST",
				redirect: "manual",
				headers: body instanceof FormData ? { cookie, origin: web.url } : { cookie, origin: web.url, "content-type": "application/x-www-form-urlencoded" },
				body: body instanceof FormData ? body : new URLSearchParams(body).toString(),
			}),
		async close() {
			await web.stop();
			await api.stop();
			await controller.stop();
			db.close();
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}
