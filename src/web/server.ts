import type { SettingsSaveResponse, UsageWindow } from "../shared/adminApi";
import { errorMessage, log } from "../shared/log";
import { versionInfo } from "../shared/version";
import { type AdminClient, AdminApiError, type OrchestratorHealth, OrchestratorUnavailable } from "./adminClient";
import { credentialsError, field, formStateFromSubmission, formStateFromView, type SettingsFormState, saveRequestFromForm } from "./forms";
import { homePage } from "./homePage";
import { createLoginThrottle, createSessionStore, type Session } from "./sessions";
import { DEFAULT_WINDOW, statusPage, USAGE_WINDOWS } from "./statusPage";
import { adminPage, errorPage, loginPage, notFoundPage, ORCHESTRATOR_UNAVAILABLE, setupPage, unavailablePage } from "./views";

export interface WebServerOptions {
	/** Every read and write goes through the orchestrator's admin API; web holds no database or vault (architecture §2.2). */
	admin: AdminClient;
	host: string;
	port: number;
	/** Clock for session expiry and the login throttle (tests). */
	now?: () => number;
}

export interface WebServer {
	url: string;
	stop(): Promise<void>;
}

/** Body of web `GET /healthz` (§9.3): never error text, names or ids (RUN-13). */
export interface WebHealth {
	status: "ok";
	version: string;
	orchestrator: OrchestratorHealth;
}

export const SESSION_COOKIE = "agentbot_session";
const LOGIN_FAILED = "Invalid username or password.";
const SETTINGS_LOCKED = "The settings are locked. Log out and log in again to unlock them.";
/** Session-protected endpoints that answer 401 JSON instead of redirecting to the login page (plus every `*.json`). */
const JSON_ROUTES: Record<string, true> = { "/admin/status": true, "/status.json": true };
/** Paths that need a session: `/`, `/status`, `/status.json`, `/admin/**`. Anything else is 404 before the session check. */
const PROTECTED_PATH = /^\/(?:|status|status\.json|admin(?:\/.*)?)$/;
/** Form posts are small; refuse anything bigger before parsing it. */
const MAX_BODY_BYTES = 1024 ** 2;

const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
	"Cache-Control": "no-store",
};

function respond(body: BodyInit | null, status: number, headers: Record<string, string>): Response {
	return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return respond(body, status, { "Content-Type": "text/html; charset=utf-8", ...headers });
}

function json(body: unknown, status = 200): Response {
	return respond(JSON.stringify(body), status, { "Content-Type": "application/json;charset=utf-8" });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
	return respond(null, 303, { Location: location, ...headers });
}

function readCookie(req: Request, name: string): string | undefined {
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

function isHttps(req: Request, url: URL): boolean {
	return url.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

/** WEB-05: HttpOnly, SameSite=Strict, Path=/, and Secure over HTTPS (directly or through the first `X-Forwarded-Proto`). */
function sessionCookie(req: Request, url: URL, value: string, maxAge?: number): Record<string, string> {
	const attrs = [`${SESSION_COOKIE}=${value}`, "HttpOnly", "SameSite=Strict", "Path=/"];
	if (maxAge !== undefined) attrs.push(`Max-Age=${maxAge}`);
	if (isHttps(req, url)) attrs.push("Secure");
	return { "Set-Cookie": attrs.join("; ") };
}

/** WEB-07: `Origin` (or, when absent, `Referer`) must name the host the request was sent to. */
function isSameOrigin(req: Request, url: URL): boolean {
	const source = req.headers.get("origin") ?? req.headers.get("referer");
	if (!source) return false;
	try {
		return new URL(source).host === url.host;
	} catch {
		return false;
	}
}

/** WEB-09: `*.json`, the JSON endpoints, and requests that ask for JSON rather than HTML. */
function wantsJson(req: Request, url: URL): boolean {
	if (JSON_ROUTES[url.pathname] || url.pathname.endsWith(".json")) return true;
	const accept = req.headers.get("accept") ?? "";
	return accept.includes("application/json") && !accept.includes("text/html");
}

function throttledMessage(retryAfterMs: number): string {
	const minutes = Math.ceil(retryAfterMs / 60_000);
	return `Too many failed attempts from your address. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function throttled(page: (opts: { error: string }) => string, retryAfterMs: number): Response {
	return html(page({ error: throttledMessage(retryAfterMs) }), 429, { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
}

function usageWindow(url: URL): UsageWindow {
	const requested = url.searchParams.get("window");
	return USAGE_WINDOWS.find(window => window === requested) ?? DEFAULT_WINDOW;
}

export function startWebServer(opts: WebServerOptions): WebServer {
	const { admin } = opts;
	const sessions = createSessionStore(undefined, opts.now);
	const throttle = createLoginThrottle(opts.now);

	/** The admin state, or undefined when the orchestrator is unavailable (logged; pages say so). */
	async function tryState() {
		try {
			return await admin.state();
		} catch (err) {
			if (!(err instanceof OrchestratorUnavailable)) throw err;
			log("warn", "orchestrator unavailable", { reason: err.reason });
			return undefined;
		}
	}

	async function handleSetup(req: Request, url: URL, ip: string): Promise<Response> {
		const state = await tryState();
		if (state?.initialized) return req.method === "GET" ? redirect("/") : html(notFoundPage(), 404);
		if (req.method === "GET") return html(setupPage({ error: state ? undefined : ORCHESTRATOR_UNAVAILABLE }));

		const retryAfter = throttle.retryAfterMs(ip);
		if (retryAfter > 0) return throttled(setupPage, retryAfter);
		const form = await req.formData();
		const username = field(form, "username").trim();
		const password = field(form, "password");
		const invalid = credentialsError(username, password, field(form, "confirm"));
		if (invalid) return html(setupPage({ error: invalid, username }), 400);
		if (!state) return html(setupPage({ error: ORCHESTRATOR_UNAVAILABLE, username }), 503);
		try {
			await admin.setup({ token: field(form, "token"), username, password });
		} catch (err) {
			if (err instanceof OrchestratorUnavailable) return html(setupPage({ error: ORCHESTRATOR_UNAVAILABLE, username }), 503);
			if (!(err instanceof AdminApiError)) throw err;
			if (err.status === 409) return redirect("/"); // a concurrent setup won the race
			if (err.status !== 400) throw err;
			// Almost always a wrong setup token: username and password were checked above.
			throttle.fail(ip);
			log("warn", "admin setup rejected", { ip, error: err.message });
			return html(setupPage({ error: err.message, username }), 400);
		}
		throttle.succeed(ip);
		log("info", "admin account created", { username, ip });
		return redirect("/", sessionCookie(req, url, sessions.create(username).token));
	}

	async function handleLogin(req: Request, url: URL, ip: string): Promise<Response> {
		if (req.method === "GET") {
			const state = await tryState();
			if (state && !state.initialized) return redirect("/setup");
			return html(loginPage({ error: state ? undefined : ORCHESTRATOR_UNAVAILABLE }));
		}
		const retryAfter = throttle.retryAfterMs(ip);
		if (retryAfter > 0) return throttled(loginPage, retryAfter);
		const form = await req.formData();
		const username = field(form, "username");
		let ok: boolean;
		try {
			ok = (await admin.login({ username, password: field(form, "password") })).ok === true;
		} catch (err) {
			if (err instanceof OrchestratorUnavailable) {
				log("warn", "admin login failed: orchestrator unavailable", { ip, reason: err.reason });
				return html(loginPage({ error: ORCHESTRATOR_UNAVAILABLE, username }), 503);
			}
			if (err instanceof AdminApiError && err.status === 409) return redirect("/setup");
			throw err;
		}
		if (!ok) {
			throttle.fail(ip);
			log("warn", "admin login failed", { ip });
			return html(loginPage({ error: LOGIN_FAILED, username }), 401);
		}
		throttle.succeed(ip);
		log("info", "admin logged in", { username, ip });
		return redirect("/", sessionCookie(req, url, sessions.create(username).token));
	}

	async function renderAdmin(
		session: Session,
		page: { settings?: SettingsFormState; settingsError?: string; accountError?: string },
		status = 200,
	): Promise<Response> {
		const state = await admin.state();
		let { settings, settingsError } = page;
		if (!settings) {
			try {
				settings = formStateFromView(await admin.settings());
			} catch (err) {
				if (!(err instanceof AdminApiError && err.status === 409)) throw err;
				settingsError ??= SETTINGS_LOCKED;
			}
		}
		const flash = session.flash;
		session.flash = undefined;
		return html(adminPage({ state, username: session.username, settings, flash, settingsError, accountError: page.accountError }), status);
	}

	async function saveSettings(req: Request, session: Session): Promise<Response> {
		const form = await req.formData();
		let result: SettingsSaveResponse;
		try {
			result = await admin.saveSettings(saveRequestFromForm(form), session.username);
		} catch (err) {
			if (!(err instanceof AdminApiError)) throw err;
			if (err.status === 409) return renderAdmin(session, { settingsError: SETTINGS_LOCKED }, 409);
			if (err.status !== 400) throw err;
			const stored = await admin.settings();
			return renderAdmin(session, { settings: formStateFromSubmission(form, stored.secrets), settingsError: err.message }, 400);
		}
		log("info", "settings saved", { admin: session.username, phase: result.phase });
		session.flash = {
			text: `Settings saved. Engine is ${result.phase}${result.error ? `: ${result.error}` : ""}.`,
			error: result.phase === "error",
			details: result.warnings,
		};
		return redirect("/admin");
	}

	async function changeAccount(req: Request, session: Session): Promise<Response> {
		const form = await req.formData();
		const username = field(form, "username").trim();
		const password = field(form, "password");
		const invalid = credentialsError(username, password, field(form, "confirm"));
		if (invalid) return renderAdmin(session, { accountError: invalid }, 400);
		try {
			await admin.credentials({ currentPassword: field(form, "currentPassword"), username, password }, session.username);
		} catch (err) {
			if (!(err instanceof AdminApiError && err.status === 400)) throw err;
			log("warn", "admin credential change rejected", { admin: session.username });
			return renderAdmin(session, { accountError: err.message }, 400);
		}
		// WEB-04: every other login ends.
		sessions.deleteOthers(session.token);
		log("info", "admin credentials changed", { from: session.username, username });
		session.username = username;
		session.flash = { text: "Account updated. Other logins were ended." };
		return redirect("/admin");
	}

	/** Discord guild for links on the status page; best effort (locked settings read as none). */
	async function guildId(): Promise<string | undefined> {
		try {
			return (await admin.settings()).config?.discord.guildId;
		} catch {
			return undefined;
		}
	}

	async function health(): Promise<Response> {
		const body: WebHealth = { status: "ok", version: (await versionInfo()).agentbot, orchestrator: await admin.health() };
		return json(body);
	}

	async function sessionRoute(req: Request, url: URL, session: Session): Promise<Response> {
		switch (`${req.method} ${url.pathname}`) {
			case "GET /":
				return html(homePage({ state: await tryState(), version: await versionInfo() }));
			case "GET /status": {
				const [report, guild] = await Promise.all([admin.status(usageWindow(url)), guildId()]);
				return html(statusPage({ report, context: { guildId: guild, now: (opts.now ?? Date.now)() } }));
			}
			case "GET /status.json":
				return json(await admin.status(usageWindow(url)));
			case "GET /admin":
				return renderAdmin(session, {});
			case "GET /admin/status": {
				const { phase, error, since } = await admin.state();
				return json({ phase, error, since });
			}
			case "POST /admin/settings":
				return saveSettings(req, session);
			case "POST /admin/account":
				return changeAccount(req, session);
			default:
				return html(notFoundPage(), 404);
		}
	}

	async function handle(req: Request, ip: string): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "POST" && !isSameOrigin(req, url)) {
			log("warn", "cross-origin POST rejected", { ip, path: url.pathname });
			return respond("Cross-origin request rejected", 403, { "Content-Type": "text/plain; charset=utf-8" });
		}
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /healthz") return health();
		if (url.pathname === "/setup" && (req.method === "GET" || req.method === "POST")) return handleSetup(req, url, ip);
		if (url.pathname === "/login" && (req.method === "GET" || req.method === "POST")) return handleLogin(req, url, ip);
		const token = readCookie(req, SESSION_COOKIE);
		if (route === "POST /logout") {
			if (token) sessions.delete(token);
			return redirect("/login", sessionCookie(req, url, "", 0));
		}
		if (!PROTECTED_PATH.test(url.pathname)) return html(notFoundPage(), 404);

		const session = sessions.get(token);
		if (!session) {
			if (wantsJson(req, url)) return json({ error: "unauthorized" }, 401);
			return redirect((await tryState())?.initialized === false ? "/setup" : "/login");
		}
		try {
			return await sessionRoute(req, url, session);
		} catch (err) {
			if (!(err instanceof OrchestratorUnavailable)) throw err;
			log("warn", "orchestrator unavailable", { path: url.pathname, reason: err.reason });
			if (wantsJson(req, url)) return json({ error: ORCHESTRATOR_UNAVAILABLE }, 503);
			return html(unavailablePage(url.pathname === "/" ? "home" : url.pathname.startsWith("/admin") ? "settings" : "status", "Unavailable", err.reason), 503);
		}
	}

	const server = Bun.serve({
		hostname: opts.host,
		port: opts.port,
		maxRequestBodySize: MAX_BODY_BYTES,
		async fetch(req, srv) {
			const ip = srv.requestIP(req)?.address ?? "unknown";
			try {
				return await handle(req, ip);
			} catch (err) {
				log("error", "web request failed", { method: req.method, path: new URL(req.url).pathname, error: errorMessage(err) });
				return html(errorPage("Internal error; see the web log."), 500);
			}
		},
		error(err) {
			log("error", "web request failed", { error: errorMessage(err) });
			return html(errorPage("Internal error; see the web log."), 500);
		},
	});
	const origin = server.url.origin;
	log("info", "web server listening", { url: origin });

	return {
		url: origin,
		stop: () => server.stop(true),
	};
}
