import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	ADMIN_PREFIX,
	type AdminState,
	type CredentialsRequest,
	type LoginRequest,
	type LoginResponse,
	type SettingsSaveRequest,
	type SettingsSaveResponse,
	type SettingsView,
	type SetupRequest,
	type StatusReport,
} from "../../shared/adminApi";
import { ConfigError, parseSettings, type Settings } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { Controller } from "../engine/controller";
import { githubKeyProblem } from "../github/app";
import type { Db } from "../store/db";
import { issueOverview, parseUsageWindow, usageReport } from "../store/stats";
import type { Vault } from "../store/vault";
import { healthLimits } from "./health";

/** The orchestrator side of the web ↔ orchestrator admin API (`src/shared/adminApi.ts`, architecture §4.5). */

export const MAX_USERNAME_CHARS = 64;
export const MIN_PASSWORD_CHARS = 12;

export interface AdminApiOptions {
	db: Db;
	vault: Vault;
	controller: Controller;
	dispatcher: Pick<Dispatcher, "counts" | "workers">;
	version: string;
	workerCapacity: number;
	/** Content of `AGENTBOT_WEB_API_TOKEN_FILE`; undefined refuses every request with 401 (SEC-14). */
	webToken: string | undefined;
	/** One-time setup token (WEB-02); undefined once an admin exists. */
	setupToken: string | undefined;
}

export interface AdminApi {
	/** Answers a request under `/internal/admin/`. */
	handle(req: Request): Promise<Response>;
}

/** WEB-02: 18 random bytes, base64url. */
export function generateSetupToken(): string {
	return randomBytes(18).toString("base64url");
}

/**
 * Reads the mounted web token (SEC-14). Undefined (and one log line) when the variable is unset or the file is missing
 * or empty: the admin API then refuses everything.
 */
export async function loadWebApiToken(path: string | undefined): Promise<string | undefined> {
	if (!path) {
		log("error", "AGENTBOT_WEB_API_TOKEN_FILE is not set: the admin API refuses every request");
		return undefined;
	}
	try {
		const token = (await Bun.file(path).text()).trim();
		if (token) return token;
		log("error", "the web API token file is empty: the admin API refuses every request", { path });
	} catch (err) {
		log("error", "the web API token file cannot be read: the admin API refuses every request", { path, error: errorMessage(err) });
	}
	return undefined;
}

/** Constant-time comparison; hashing first equalises lengths. */
export function tokensEqual(given: string, expected: string): boolean {
	const digest = (text: string) => createHash("sha256").update(text).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

/** Username and password rules of WEB-02 and WEB-04; the "entered twice" check is the web form's. */
export function credentialsError(username: string, password: string): string | undefined {
	if (username.length < 1 || username.length > MAX_USERNAME_CHARS) return `Username must be 1-${MAX_USERNAME_CHARS} characters.`;
	if (password.length < MIN_PASSWORD_CHARS) return `Password must be at least ${MIN_PASSWORD_CHARS} characters.`;
	return undefined;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const fail = (status: number, error: string) => Response.json({ error }, { status });

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function jsonBody<T>(req: Request): Promise<Partial<T>> {
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
function actingAdmin(req: Request): string | undefined {
	const raw = req.headers.get("x-agentbot-admin");
	if (!raw) return undefined;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export function createAdminApi(opts: AdminApiOptions): AdminApi {
	const { db, vault, controller } = opts;
	let setupToken = opts.setupToken;

	function state(): AdminState {
		const { phase, error, since } = controller.status();
		return {
			phase,
			error,
			since,
			initialized: vault.isInitialized(),
			unlocked: vault.isUnlocked(),
			username: vault.username(),
			version: opts.version,
		};
	}

	/** Settings as stored; undefined when none are saved or they no longer validate (the engine reports that error). */
	function storedSettings(): Settings | undefined {
		try {
			return vault.readSettings();
		} catch (err) {
			log("warn", "could not read stored settings", { error: errorMessage(err) });
			return undefined;
		}
	}

	function requireUnlocked(): void {
		if (!vault.isInitialized() || !vault.isUnlocked()) throw new HttpError(409, "Settings are locked; log in to unlock them.");
	}

	async function setup(req: Request): Promise<Response> {
		if (vault.isInitialized()) return fail(409, "The admin account already exists.");
		const body = await jsonBody<SetupRequest>(req);
		if (!setupToken || !tokensEqual(str(body.token), setupToken)) {
			log("warn", "admin setup rejected: invalid setup token");
			return fail(400, "Invalid setup token.");
		}
		const username = str(body.username).trim();
		const password = str(body.password);
		const invalid = credentialsError(username, password);
		if (invalid) return fail(400, invalid);
		try {
			await vault.initialize(username, password);
		} catch (err) {
			// A concurrent setup won the race.
			log("warn", "admin setup failed", { error: errorMessage(err) });
			return fail(409, "The admin account already exists.");
		}
		setupToken = undefined;
		log("info", "admin account created", { admin: username });
		await controller.apply();
		return Response.json({ ok: true });
	}

	async function login(req: Request): Promise<Response> {
		if (!vault.isInitialized()) return fail(409, "No admin account exists yet.");
		const body = await jsonBody<LoginRequest>(req);
		const username = str(body.username);
		const wasLocked = !vault.isUnlocked();
		// The vault always pays the scrypt cost and fails the same way for an unknown user and a wrong password (WEB-03).
		if (!(await vault.login(username, str(body.password)))) {
			log("warn", "admin login failed");
			return Response.json({ ok: false } satisfies LoginResponse);
		}
		log("info", "admin logged in", { admin: username, unlocked: wasLocked });
		// An unlock starts the engine; the web UI follows the phase through /state.
		if (wasLocked) void controller.apply().catch(err => log("error", "engine apply failed", { reason: "login", error: errorMessage(err) }));
		return Response.json({ ok: true } satisfies LoginResponse);
	}

	async function credentials(req: Request): Promise<Response> {
		if (!vault.isInitialized()) return fail(409, "No admin account exists yet.");
		const body = await jsonBody<CredentialsRequest>(req);
		const username = str(body.username).trim();
		const password = str(body.password);
		const invalid = credentialsError(username, password);
		if (invalid) return fail(400, invalid);
		if (!(await vault.changeCredentials(str(body.currentPassword), username, password))) {
			log("warn", "admin credential change rejected: wrong current password", { admin: actingAdmin(req) });
			return fail(400, "Current password is incorrect.");
		}
		log("info", "admin credentials changed", { admin: actingAdmin(req), username });
		return Response.json({ ok: true });
	}

	function settingsView(): SettingsView {
		requireUnlocked();
		const stored = storedSettings();
		return {
			config: stored?.config,
			secrets: {
				discordToken: !!stored?.secrets.discordToken,
				githubAppPrivateKey: !!stored?.secrets.githubAppPrivateKey,
				providerKeys: Object.keys(stored?.secrets.providerKeys ?? {}).sort(),
			},
		};
	}

	async function saveSettings(req: Request): Promise<Response> {
		requireUnlocked();
		const body = await jsonBody<SettingsSaveRequest>(req);
		const given = body.secrets && typeof body.secrets === "object" ? body.secrets : {};
		const previous = storedSettings()?.secrets;
		// A blank or absent secret keeps the stored value; an empty provider key deletes it.
		const providerKeys: Record<string, string> = { ...previous?.providerKeys };
		if (given.providerKeys && typeof given.providerKeys === "object") {
			for (const [id, value] of Object.entries(given.providerKeys)) {
				const key = str(value).trim();
				if (key) providerKeys[id] = key;
				else delete providerKeys[id];
			}
		}
		const secrets = {
			discordToken: str(given.discordToken).trim() || previous?.discordToken,
			githubAppPrivateKey: str(given.githubAppPrivateKey).trim() || previous?.githubAppPrivateKey,
			providerKeys,
		};
		let settings: Settings;
		try {
			settings = parseSettings({ config: body.config, secrets });
		} catch (err) {
			if (err instanceof ConfigError) return fail(400, err.message);
			throw err;
		}
		const keyProblem = githubKeyProblem(settings.secrets.githubAppPrivateKey);
		if (keyProblem) return fail(400, `GitHub App private key: ${keyProblem}.`);
		vault.writeSettings(settings);
		log("info", "settings saved", { admin: actingAdmin(req) });
		await controller.apply();
		const { phase, error } = controller.status();
		const response: SettingsSaveResponse = { phase, error, warnings: healthLimits(settings.config, opts.workerCapacity).warnings };
		return Response.json(response);
	}

	function status(url: URL): StatusReport {
		const { limits, warnings } = healthLimits(vault.isUnlocked() ? storedSettings()?.config : undefined, opts.workerCapacity);
		const window = parseUsageWindow(url.searchParams.get("window"));
		return {
			state: state(),
			engine: controller.snapshot(),
			runs: opts.dispatcher.counts(),
			workers: opts.dispatcher.workers(),
			limits,
			warnings,
			issues: issueOverview(db),
			usage: usageReport(db, window),
		};
	}

	async function route(req: Request, url: URL): Promise<Response> {
		const path = url.pathname.slice(ADMIN_PREFIX.length);
		const allow = (methods: string[]): Response | undefined =>
			methods.includes(req.method) ? undefined : new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: { Allow: methods.join(", "), "Content-Type": "application/json" } });
		switch (path) {
			case "/state":
				return allow(["GET"]) ?? Response.json(state());
			case "/setup":
				return allow(["POST"]) ?? setup(req);
			case "/login":
				return allow(["POST"]) ?? login(req);
			case "/credentials":
				return allow(["POST"]) ?? credentials(req);
			case "/settings":
				return allow(["GET", "PUT"]) ?? (req.method === "GET" ? Response.json(settingsView()) : saveSettings(req));
			case "/status":
				return allow(["GET"]) ?? Response.json(status(url));
			default:
				return fail(404, "not found");
		}
	}

	return {
		async handle(req) {
			// SEC-14: the web token, and only it, opens /internal/admin/*.
			const auth = req.headers.get("authorization") ?? "";
			const given = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
			if (!opts.webToken || !tokensEqual(given, opts.webToken)) return fail(401, "unauthorized");
			try {
				return await route(req, new URL(req.url));
			} catch (err) {
				if (err instanceof HttpError) return fail(err.status, err.message);
				log("error", "admin API request failed", { path: new URL(req.url).pathname, error: errorMessage(err) });
				return fail(500, "internal error");
			}
		},
	};
}
