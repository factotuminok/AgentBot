import type { AdminClient } from "./adminClient";
import type { Session } from "./sessions";

/**
 * Responses with the security headers every web response carries (WEB-06), and the contract of the feature pages the
 * web server mounts (repositories, models, omp, skills, logs).
 */

export const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
	"Cache-Control": "no-store",
};

export function respond(body: BodyInit | null, status: number, headers: Record<string, string>): Response {
	return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return respond(body, status, { "Content-Type": "text/html; charset=utf-8", ...headers });
}

export function json(body: unknown, status = 200): Response {
	return respond(JSON.stringify(body), status, { "Content-Type": "application/json;charset=utf-8" });
}

export function redirect(location: string, headers: Record<string, string> = {}): Response {
	return respond(null, 303, { Location: location, ...headers });
}

/**
 * What a feature page handler gets: the admin API, the logged-in session (its `flash` survives one redirect), the clock,
 * and whether VS Code is on (the ☰ menu lists it, WEB-10).
 */
export interface PageContext {
	admin: AdminClient;
	session: Session;
	now(): number;
	vscode: boolean;
}

/** One logged-in route. `json` routes answer 401 JSON instead of redirecting to the login page (WEB-09). */
export interface PageRoute {
	json?: boolean;
	handle(req: Request, url: URL, ctx: PageContext): Promise<Response>;
}

/**
 * Feature routes by `"<METHOD> <path>"`, e.g. `"GET /admin/repos"`. A key whose path ends in `/` (`"GET /logs/files/"`)
 * matches every path under it. Paths must be under `/admin/` or `/logs`, which need a session.
 */
export type PageRoutes = Record<string, PageRoute>;

/** The route for `method path`, exact keys first, then the longest matching prefix key. */
export function matchPage(routes: PageRoutes, method: string, path: string): PageRoute | undefined {
	const exact = `${method} ${path}`;
	if (Object.hasOwn(routes, exact)) return routes[exact];
	let best: string | undefined;
	for (const key of Object.keys(routes)) {
		if (key.endsWith("/") && exact.startsWith(key) && (!best || key.length > best.length)) best = key;
	}
	return best === undefined ? undefined : routes[best];
}
