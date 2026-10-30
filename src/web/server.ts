import { BlockList, isIP } from "node:net";
import type { ServerWebSocket } from "bun";
import type { SettingsSaveResponse, SettingsView, UsageWindow } from "../shared/adminApi";
import { MAX_SKILL_UPLOAD_BYTES } from "../shared/adminSkills";
import { errorMessage, log } from "../shared/log";
import { createLoginThrottle, THROTTLE_IN_FLIGHT_RETRY_MS, WEB_LOGIN_LIMITS } from "../shared/loginThrottle";
import { versionInfo } from "../shared/version";
import { type AdminClient, AdminApiError, type OrchestratorHealth, OrchestratorUnavailable } from "./adminClient";
import { loadChannelListing, REFRESH_CHANNELS } from "./channelFields";
import { html, json, matchPage, type PageRoutes, redirect, respond } from "./http";
import { credentialsError, field, formStateFromSubmission, formStateFromView, type SettingsFormState, saveRequestFromForm, settingsSavedText } from "./forms";
import { homePage } from "./homePage";
import { createSessionStore, type Session } from "./sessions";
import { DEFAULT_WINDOW, statusPage, USAGE_WINDOWS } from "./statusPage";
import { adminPage, errorPage, layout, loginPage, nav, notFoundPage, ORCHESTRATOR_UNAVAILABLE, setupPage, unavailablePage } from "./views";
import { createVsCode, isVsCodePath, VSCODE_PREFIX, type VsCodeConfig, type VsCodeSocketData, VsCodeStartError } from "./vscode";

export interface WebServerOptions {
	/** Every read and write goes through the orchestrator's admin API; web holds no database or vault (architecture §2.2). */
	admin: AdminClient;
	host: string;
	port: number;
	/** Clock for session expiry and the login throttle (tests). */
	now?: () => number;
	/** Feature pages (repositories, models, omp, skills, logs); every one needs a session. */
	pages?: PageRoutes;
	/** code-server proxied at `/admin/vscode/` (WEB-14); undefined when `AGENTBOT_WEB_VSCODE=off`. */
	vscode?: VsCodeConfig;
	/**
	 * `AGENTBOT_WEB_TRUSTED_PROXIES`: addresses and CIDRs of reverse proxies in front of web. A request from one of them is
	 * attributed to the right-most `X-Forwarded-For` entry that is not, for the login throttle (WEB-03); without them
	 * `X-Forwarded-For` is ignored.
	 */
	trustedProxies?: readonly string[];
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
/** Paths that need a session: `/`, `/status`, `/status.json`, `/logs/**`, `/admin/**`. Anything else is 404 before the session check. */
const PROTECTED_PATH = /^\/(?:|status|status\.json|logs(?:\/.*)?|admin(?:\/.*)?)$/;
/** Form posts are small; refuse anything bigger before parsing it. */
const MAX_BODY_BYTES = 1024 ** 2;
/** Skill uploads (a zip of up to 5 MiB unpacked, AGT-25) are the only bigger bodies; this leaves room for the multipart framing. */
const MAX_UPLOAD_BODY_BYTES = MAX_SKILL_UPLOAD_BYTES + 64 * 1024;
const UPLOAD_PATHS: Record<string, true> = { "/admin/skills/upload": true };
/** Long-lived event streams; Bun's idle timeout (10 s) would cut them between pings. */
const STREAM_PATHS: Record<string, true> = { "/logs/stream": true };
/** WebSocket close code when the login behind a VS Code connection ended (private range 4000–4999). */
const CLOSE_LOGGED_OUT = 4001;

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
function wantsJson(req: Request, url: URL, pages: PageRoutes): boolean {
	if (JSON_ROUTES[url.pathname] || url.pathname.endsWith(".json") || matchPage(pages, req.method, url.pathname)?.json) return true;
	const accept = req.headers.get("accept") ?? "";
	return accept.includes("application/json") && !accept.includes("text/html");
}

function throttledMessage(retryAfterMs: number): string {
	if (retryAfterMs <= THROTTLE_IN_FLIGHT_RETRY_MS) return "Another attempt from your address is still being checked. Try again in a moment.";
	const minutes = Math.ceil(retryAfterMs / 60_000);
	return `Too many failed attempts from your address. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function throttled(page: (opts: { error: string }) => string, retryAfterMs: number): Response {
	return html(page({ error: throttledMessage(retryAfterMs) }), 429, { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) });
}

/** The list of trusted proxies; entries were validated by `loadEnv` (an address, or an address and a prefix length). */
function proxyList(entries: readonly string[]): BlockList {
	const list = new BlockList();
	for (const entry of entries) {
		const [address = "", prefix] = entry.split("/");
		const type = isIP(address) === 6 ? "ipv6" : "ipv4";
		if (prefix === undefined) list.addAddress(address, type);
		else list.addSubnet(address, Number(prefix), type);
	}
	return list;
}

/**
 * The client a login attempt is counted against (WEB-03): the peer, or, when the peer is a trusted proxy, the right-most
 * `X-Forwarded-For` entry that is not one (entries further left are whatever the client sent).
 */
function clientAddress(req: Request, peer: string, proxies: BlockList | undefined): string {
	if (!proxies) return peer;
	const trusted = (address: string) => isIP(address) !== 0 && proxies.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
	if (!trusted(peer)) return peer;
	const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map(hop => hop.trim()).filter(hop => hop !== "");
	return hops.findLast(hop => !trusted(hop)) ?? hops[0] ?? peer;
}

function usageWindow(url: URL): UsageWindow {
	const requested = url.searchParams.get("window");
	return USAGE_WINDOWS.find(window => window === requested) ?? DEFAULT_WINDOW;
}

export function startWebServer(opts: WebServerOptions): WebServer {
	const { admin } = opts;
	const pages = opts.pages ?? {};
	const now = opts.now ?? Date.now;
	const sessions = createSessionStore(undefined, opts.now);
	const throttle = createLoginThrottle(WEB_LOGIN_LIMITS, opts.now);
	const proxies = opts.trustedProxies?.length ? proxyList(opts.trustedProxies) : undefined;
	const vscode = opts.vscode ? createVsCode(opts.vscode, SESSION_COOKIE) : undefined;
	const vscodeOn = vscode !== undefined;
	const sockets = new Set<ServerWebSocket<VsCodeSocketData>>();

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

		const retryAfter = throttle.begin(ip);
		if (retryAfter > 0) return throttled(setupPage, retryAfter);
		try {
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
		} finally {
			throttle.end(ip);
		}
	}

	async function handleLogin(req: Request, url: URL, ip: string): Promise<Response> {
		if (req.method === "GET") {
			const state = await tryState();
			if (state && !state.initialized) return redirect("/setup");
			return html(loginPage({ error: state ? undefined : ORCHESTRATOR_UNAVAILABLE }));
		}
		// WEB-03: one check at a time per IP, so parallel posts can't all be checked before their failures count.
		const retryAfter = throttle.begin(ip);
		if (retryAfter > 0) return throttled(loginPage, retryAfter);
		try {
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
				// The orchestrator's own budget of password checks (architecture §6) is spent: its message says when to retry.
				if (err instanceof AdminApiError && err.status === 429) return html(loginPage({ error: err.message, username }), 429);
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
		} finally {
			throttle.end(ip);
		}
	}

	async function renderAdmin(
		session: Session,
		page: { settings?: SettingsFormState; settingsError?: string; accountError?: string; refreshChannels?: boolean },
		status = 200,
	): Promise<Response> {
		const state = await admin.state();
		let { settings, settingsError } = page;
		let view: SettingsView | undefined;
		try {
			view = await admin.settings();
		} catch (err) {
			if (!(err instanceof AdminApiError && err.status === 409)) throw err;
			settingsError ??= SETTINGS_LOCKED;
		}
		settings ??= view && formStateFromView(view);
		// WEB-20 to WEB-23: channel dropdowns once the bot token and guild id are stored.
		const channels = view && (await loadChannelListing(admin, view, page.refreshChannels ?? false));
		const flash = session.flash;
		session.flash = undefined;
		return html(
			adminPage({ state, username: session.username, settings, channels, flash, settingsError, accountError: page.accountError, vscode: vscodeOn }),
			status,
		);
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
			text: settingsSavedText(result),
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
			if (!(err instanceof AdminApiError && (err.status === 400 || err.status === 429))) throw err;
			log("warn", "admin credential change rejected", { admin: session.username });
			return renderAdmin(session, { accountError: err.message }, err.status);
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
				return html(homePage({ state: await tryState(), version: await versionInfo(), vscode: vscodeOn }));
			case "GET /status": {
				const [report, guild] = await Promise.all([admin.status(usageWindow(url)), guildId()]);
				return html(statusPage({ report, context: { guildId: guild, now: (opts.now ?? Date.now)() }, vscode: vscodeOn }));
			}
			case "GET /status.json":
				return json(await admin.status(usageWindow(url)));
			case "GET /admin":
				return renderAdmin(session, { refreshChannels: url.searchParams.has(REFRESH_CHANNELS) });
			case "GET /admin/status": {
				const { phase, error, since } = await admin.state();
				return json({ phase, error, since });
			}
			case "POST /admin/settings":
				return saveSettings(req, session);
			case "POST /admin/account":
				return changeAccount(req, session);
			default: {
				if (isVsCodePath(url.pathname)) return vscodeRoute(req, url);
				const page = matchPage(pages, req.method, url.pathname);
				return page ? page.handle(req, url, { admin, session, now, vscode: vscodeOn }) : html(notFoundPage(), 404);
			}
		}
	}

	/** `/admin/vscode/**`: code-server behind the admin login, or a page saying it is off. */
	async function vscodeRoute(req: Request, url: URL): Promise<Response> {
		if (!vscode) {
			if (url.pathname !== VSCODE_PREFIX && url.pathname !== `${VSCODE_PREFIX}/`) return html(notFoundPage(), 404);
			return html(
				layout(
					"VS Code",
					`${nav("vscode", false)}
<h1>VS Code</h1>
<p>The VS Code configuration editor is <strong>off</strong>: this web pod runs with <code>AGENTBOT_WEB_VSCODE=off</code>.
Remove that setting (it defaults to <code>on</code>) and restart the web pod to edit settings, omp settings, skills and agents as files.</p>`,
				),
			);
		}
		try {
			return await vscode.proxy(req, url);
		} catch (err) {
			if (!(err instanceof VsCodeStartError)) throw err;
			return html(errorPage(`VS Code could not be started: ${err.message}`), 502);
		}
	}

	/** WebSockets under `/admin/vscode/`: browsers apply no CORS to them, so besides the login the origin must be this host. */
	function upgradeVsCode(req: Request, url: URL, srv: Bun.Server<VsCodeSocketData>, ip: string): Response | undefined {
		if (!vscode) return html(notFoundPage(), 404);
		const token = readCookie(req, SESSION_COOKIE);
		if (!token || !sessions.get(token)) return json({ error: "unauthorized" }, 401);
		if (!isSameOrigin(req, url)) {
			log("warn", "cross-origin VS Code connection rejected", { ip, origin: req.headers.get("origin") });
			return respond("Cross-origin request rejected", 403, { "Content-Type": "text/plain; charset=utf-8" });
		}
		const data = vscode.socketData(req, url, token);
		if (!data) return respond("VS Code is not running; reload the page.", 503, { "Content-Type": "text/plain; charset=utf-8" });
		if (srv.upgrade(req, { data })) return undefined;
		return respond("Expected a WebSocket upgrade", 426, { "Content-Type": "text/plain; charset=utf-8" });
	}

	async function handle(req: Request, ip: string): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "POST" && !isSameOrigin(req, url)) {
			log("warn", "cross-origin POST rejected", { ip, path: url.pathname });
			return respond("Cross-origin request rejected", 403, { "Content-Type": "text/plain; charset=utf-8" });
		}
		if (Number(req.headers.get("content-length") ?? 0) > (UPLOAD_PATHS[url.pathname] ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES)) {
			return respond("Request body too large", 413, { "Content-Type": "text/plain; charset=utf-8" });
		}
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /healthz") return health();
		if (url.pathname === "/setup" && (req.method === "GET" || req.method === "POST")) return handleSetup(req, url, ip);
		if (url.pathname === "/login" && (req.method === "GET" || req.method === "POST")) return handleLogin(req, url, ip);
		const token = readCookie(req, SESSION_COOKIE);
		if (route === "POST /logout") {
			if (token) {
				sessions.delete(token);
				for (const ws of sockets) if (ws.data.token === token) ws.close(CLOSE_LOGGED_OUT, "Logged out.");
			}
			return redirect("/login", sessionCookie(req, url, "", 0));
		}
		if (!PROTECTED_PATH.test(url.pathname)) return html(notFoundPage(), 404);

		const session = sessions.get(token);
		if (!session) {
			if (wantsJson(req, url, pages)) return json({ error: "unauthorized" }, 401);
			return redirect((await tryState())?.initialized === false ? "/setup" : "/login");
		}
		try {
			return await sessionRoute(req, url, session);
		} catch (err) {
			if (!(err instanceof OrchestratorUnavailable)) throw err;
			log("warn", "orchestrator unavailable", { path: url.pathname, reason: err.reason });
			if (wantsJson(req, url, pages)) return json({ error: ORCHESTRATOR_UNAVAILABLE }, 503);
			return html(
				unavailablePage(url.pathname === "/" ? "home" : url.pathname.startsWith("/admin") ? "settings" : "status", vscodeOn, "Unavailable", err.reason),
				503,
			);
		}
	}

	const server = Bun.serve<VsCodeSocketData>({
		hostname: opts.host,
		port: opts.port,
		maxRequestBodySize: MAX_UPLOAD_BODY_BYTES,
		async fetch(req, srv) {
			const ip = clientAddress(req, srv.requestIP(req)?.address ?? "unknown", proxies);
			const path = new URL(req.url).pathname;
			if (STREAM_PATHS[path]) srv.timeout(req, 0);
			try {
				if (isVsCodePath(path) && req.headers.get("upgrade")?.toLowerCase() === "websocket") return upgradeVsCode(req, new URL(req.url), srv, ip);
				return await handle(req, ip);
			} catch (err) {
				log("error", "web request failed", { method: req.method, path: new URL(req.url).pathname, error: errorMessage(err) });
				return html(errorPage("Internal error; see the web log."), 500);
			}
		},
		websocket: {
			open(ws) {
				sockets.add(ws);
				vscode?.websocket.open(ws);
			},
			message(ws, message) {
				// Traffic keeps the login alive, and stops working once it is gone (logout, expiry, credential change).
				if (!sessions.get(ws.data.token)) {
					ws.close(CLOSE_LOGGED_OUT, "Your login ended; log in again.");
					return;
				}
				vscode?.websocket.message(ws, message);
			},
			close(ws) {
				sockets.delete(ws);
				vscode?.websocket.close(ws);
			},
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
		async stop() {
			for (const ws of sockets) ws.close(1001, "AgentBot is stopping.");
			await vscode?.stop();
			await server.stop(true);
		},
	};
}
