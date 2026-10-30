/**
 * Helpers shared by the admin API's endpoint modules (`/internal/admin/*`, architecture §4.5). Each feature module
 * exports its endpoints as `AdminRoutes`; `createAdminApi` mounts them after the token check (SEC-14).
 */

/** Thrown by a handler to answer `{error}` with `status` (400 = shown to the admin, 409 = wrong vault state). */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export const fail = (status: number, error: string): Response => Response.json({ error }, { status });

/** `value` when it is a string, else "". */
export function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The request's JSON object body; 400 for anything else. */
export async function jsonBody<T>(req: Request): Promise<Partial<T>> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new HttpError(400, "Request body must be JSON.");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object.");
	return body as Partial<T>;
}

/** The acting admin from `X-Agentbot-Admin` (URI-encoded by web), for the log (WEB-29). */
export function actingAdmin(req: Request): string | undefined {
	const raw = req.headers.get("x-agentbot-admin");
	if (!raw) return undefined;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** One admin endpoint: the methods it answers (others get 405) and its handler. `path` is relative to `/internal/admin`. */
export interface AdminRoute {
	methods: readonly string[];
	handle(req: Request, url: URL, path: string): Promise<Response> | Response;
}

/**
 * A feature's endpoints by path relative to `/internal/admin`: `"/repos"` matches exactly; a key ending in `/`
 * (`"/skills/"`) matches every path under it. The longest matching key wins.
 */
export type AdminRoutes = Record<string, AdminRoute>;

/** The route for `path` among `routes`, exact keys first, then the longest matching prefix key. */
export function matchRoute(routes: AdminRoutes, path: string): AdminRoute | undefined {
	if (Object.hasOwn(routes, path)) return routes[path];
	let best: string | undefined;
	for (const key of Object.keys(routes)) {
		if (key.endsWith("/") && path.startsWith(key) && (!best || key.length > best.length)) best = key;
	}
	return best === undefined ? undefined : routes[best];
}
