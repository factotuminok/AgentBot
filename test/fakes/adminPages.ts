import { afterEach } from "bun:test";
import { type AdminRoutes, HttpError, fail, matchRoute } from "../../src/orchestrator/api/http";
import { ADMIN_PREFIX } from "../../src/shared/adminApi";
import { createAdminClient } from "../../src/web/adminClient";
import type { PageRoutes } from "../../src/web/http";
import { startWebServer } from "../../src/web/server";

/**
 * A feature page end to end without the engine: the web server with `pages`, logged in, over a minimal orchestrator
 * admin API that checks the web token (SEC-14), answers `/login`, and mounts `routes` the way `createAdminApi` does
 * (405 for other methods, `HttpError` → its status, anything else → 500).
 */

const WEB_TOKEN = "web-api-token-for-page-tests";
const PASSWORD = "correct horse battery";

export interface PageStack {
	url: string;
	get(path: string): Promise<Response>;
	/** A same-origin form POST (WEB-07). Pairs keep repeated and ordered fields. */
	post(path: string, fields: Record<string, string> | [string, string][]): Promise<Response>;
	/** The admin API directly, with the web token. */
	api(method: string, path: string, body?: unknown): Promise<Response>;
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop();
});

export async function startPageStack(routes: AdminRoutes, pages: PageRoutes): Promise<PageStack> {
	const orchestrator = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (req.headers.get("authorization") !== `Bearer ${WEB_TOKEN}`) return fail(401, "unauthorized");
			const path = new URL(req.url).pathname.slice(ADMIN_PREFIX.length);
			if (path === "/login") {
				const body = (await req.json()) as { password?: string };
				return Response.json({ ok: body.password === PASSWORD });
			}
			const route = matchRoute(routes, path);
			if (!route) return fail(404, "not found");
			if (!route.methods.includes(req.method)) return fail(405, "method not allowed");
			try {
				return await route.handle(req, new URL(req.url), path);
			} catch (err) {
				if (err instanceof HttpError) return fail(err.status, err.message);
				return fail(500, "internal error");
			}
		},
	});
	const orchestratorUrl = `http://127.0.0.1:${orchestrator.port}`;
	const web = startWebServer({ admin: createAdminClient({ baseUrl: orchestratorUrl, token: WEB_TOKEN, timeoutMs: 5_000 }), host: "127.0.0.1", port: 0, pages });
	stops.push(async () => void orchestrator.stop(true), () => web.stop());

	let cookie = "";
	const post = (path: string, fields: Record<string, string> | [string, string][]) =>
		fetch(web.url + path, {
			method: "POST",
			redirect: "manual",
			headers: { cookie, origin: web.url, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		});
	const login = await post("/login", { username: "admin", password: PASSWORD });
	if (login.status !== 303) throw new Error(`login failed: ${login.status}`);
	cookie = login.headers.get("set-cookie")!.split(";")[0]!;

	return {
		url: web.url,
		get: path => fetch(web.url + path, { redirect: "manual", headers: { cookie } }),
		post,
		api: (method, path, body) =>
			fetch(`${orchestratorUrl}${ADMIN_PREFIX}${path}`, {
				method,
				headers: { Authorization: `Bearer ${WEB_TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
	};
}

/** Resolves once `check` passes, polling every few ms (a page's own polling, sped up). */
export async function eventually<T>(check: () => Promise<T | undefined>, what: string): Promise<T> {
	for (let i = 0; i < 500; i++) {
		const value = await check();
		if (value !== undefined) return value;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}
