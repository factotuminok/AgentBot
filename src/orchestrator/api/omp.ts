import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpRow, McpServerInput, McpTestRequest, McpTestState, OmpSaveRequest, OmpView, SecretKeyInput, SettingRow } from "../../shared/adminOmp";
import { errorMessage, log } from "../../shared/log";
import {
	emptyOmpConfig,
	LOCKED_SETTINGS,
	listSettings,
	type McpServer,
	type OmpConfig,
	OmpConfigError,
	parseOmpConfig,
	parseSettingValue,
	type SettingInfo,
} from "../../shared/ompconfig";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { OmpUpdater } from "../omp/updates";
import type { Vault } from "../store/vault";
import { type AdminRoutes, actingAdmin, fail, HttpError, jsonBody, str } from "./http";

/**
 * `/internal/admin/omp*`: omp setting overrides and MCP servers (AGT-20 to AGT-23); the contract is in
 * `src/shared/adminOmp.ts`. The configuration is stored in the vault and read by the dispatcher when a run is claimed,
 * so a save applies to runs that start afterwards (AGT-23).
 */

/** Finished connection tests stay readable this long. */
const TEST_RETENTION_MS = 10 * 60_000;

export interface OmpRoutesDeps {
	vault: Vault;
	dispatcher: Pick<Dispatcher, "mcpTest">;
	/** In-place worker updates: their status and the manual check (UPD-02, UPD-10). */
	updates: Pick<OmpUpdater, "status" | "check">;
}

let settingsCache: { list: SettingInfo[]; byId: Map<string, SettingInfo> } | undefined;

/** Every registered omp setting, read once (550+). Keyed by user-supplied ids, so a Map (no prototype keys). */
export function ompSettings(): { list: SettingInfo[]; byId: Map<string, SettingInfo> } {
	if (!settingsCache) {
		const list = listSettings();
		settingsCache = { list, byId: new Map(list.map(info => [info.id, info])) };
	}
	return settingsCache;
}

/** Form text for a stored setting value: JSON for arrays and records, plain text otherwise; what `parseSettingValue` reads. */
export function settingText(info: SettingInfo | undefined, value: unknown): string {
	if (typeof value === "string") return value;
	if (info?.type === "array" || info?.type === "record") return JSON.stringify(value, null, 2);
	return value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function stored<T>(map: Record<string, T> | undefined, key: string): T | undefined {
	return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

export function serverMaps(server: McpServer | undefined): { env?: Record<string, string>; headers?: Record<string, string> } {
	if (!server) return {};
	return "url" in server ? { headers: server.headers } : { env: server.env };
}

/** Key/value rows with blank values replaced by the stored value for that key ("" when there is none). */
function keepStored(rows: SecretKeyInput[], previous: Record<string, string> | undefined): Record<string, string> | undefined {
	const kept = rows.filter(row => row.key.trim());
	if (!kept.length) return undefined;
	return Object.fromEntries(kept.map(({ key, value }) => [key.trim(), value.trim() ? value : (stored(previous, key.trim()) ?? "")]));
}

const secretRows = z.array(z.object({ key: z.string(), value: z.string() })).default([]);
const saveSchema = z.object({
	settings: z.array(z.object({ id: z.string(), value: z.string() })).default([]),
	servers: z
		.array(
			z.object({
				name: z.string(),
				type: z.enum(["stdio", "http", "sse"]),
				enabled: z.boolean().default(true),
				instructions: z.boolean().default(true),
				timeout: z.string().default(""),
				command: z.string().default(""),
				args: z.array(z.string()).default([]),
				cwd: z.string().default(""),
				url: z.string().default(""),
				env: secretRows,
				headers: secretRows,
			}),
		)
		.default([]),
});

/** One submitted server as a raw config entry, validated afterwards by `parseOmpConfig`. */
function serverEntry(input: McpServerInput, previous: McpServer | undefined): Record<string, unknown> {
	const prev = serverMaps(previous);
	const server: Record<string, unknown> = { type: input.type };
	if (input.type === "stdio") {
		server.command = input.command.trim();
		const args = input.args.map(arg => arg.trim()).filter(Boolean);
		if (args.length) server.args = args;
		if (input.cwd.trim()) server.cwd = input.cwd.trim();
		const env = keepStored(input.env, prev.env);
		if (env) server.env = env;
	} else {
		server.url = input.url.trim();
		const headers = keepStored(input.headers, prev.headers);
		if (headers) server.headers = headers;
	}
	if (!input.enabled) server.enabled = false;
	if (!input.instructions) server.instructions = false;
	const timeoutText = input.timeout.trim();
	if (timeoutText) {
		const timeout = Number(timeoutText);
		if (!Number.isInteger(timeout) || timeout < 0) throw new OmpConfigError(`Invalid omp config: mcpServers.${input.name}.timeout: must be a whole number of milliseconds`);
		server.timeout = timeout;
	}
	return server;
}

/**
 * The submitted configuration, validated as omp would load it. Setting values go through omp's own parser (pinned ones
 * are refused); blank credential settings and blank env/header values keep what `previous` stores. Throws `OmpConfigError`.
 */
export function ompConfigFromRequest(req: OmpSaveRequest, previous: OmpConfig): OmpConfig {
	const { byId } = ompSettings();
	const settings: Record<string, unknown> = {};
	for (const { id: rawId, value } of req.settings) {
		const id = rawId.trim();
		if (!id) continue;
		const keep = byId.get(id)?.credential && !value.trim() && Object.hasOwn(previous.settings, id);
		settings[id] = keep ? previous.settings[id] : parseSettingValue(id, value);
	}
	const mcpServers: Record<string, unknown> = {};
	for (const server of req.servers) {
		const name = server.name.trim();
		if (!name) throw new OmpConfigError("Every MCP server needs a name");
		if (Object.hasOwn(mcpServers, name)) throw new OmpConfigError(`Duplicate MCP server name "${name}"`);
		Object.defineProperty(mcpServers, name, { value: serverEntry({ ...server, name }, stored(previous.mcpServers, name)), enumerable: true, writable: true, configurable: true });
	}
	return parseOmpConfig({ settings, mcpServers });
}

/** Whatever of a stored configuration that no longer validates still parses on its own, so the admin can fix the rest. */
function lenientConfig(raw: unknown): OmpConfig {
	const config: OmpConfig = { settings: {}, mcpServers: {} };
	if (!raw || typeof raw !== "object") return config;
	if ("settings" in raw && raw.settings && typeof raw.settings === "object") config.settings = { ...raw.settings };
	if ("mcpServers" in raw && raw.mcpServers && typeof raw.mcpServers === "object") {
		for (const [name, server] of Object.entries(raw.mcpServers)) {
			try {
				Object.assign(config.mcpServers, parseOmpConfig({ mcpServers: { [name]: server } }).mcpServers);
			} catch {
				// Dropped from the form; saving replaces it.
			}
		}
	}
	return config;
}

/** The stored configuration (an unlocked vault); `error` when it no longer validates (then what still parses). */
export function storedOmpConfig(vault: Pick<Vault, "readOmpConfig">): { config: OmpConfig; error?: string } {
	const raw = vault.readOmpConfig();
	if (raw === undefined) return { config: emptyOmpConfig() };
	try {
		return { config: parseOmpConfig(raw) };
	} catch (err) {
		return { config: lenientConfig(raw), error: errorMessage(err) };
	}
}

function settingRows(config: OmpConfig): SettingRow[] {
	const { byId } = ompSettings();
	return Object.entries(config.settings).map(([id, value]) => {
		const info = byId.get(id);
		return info?.credential ? { id, value: "", credentialSet: true } : { id, value: settingText(info, value), credentialSet: false };
	});
}

function serverRows(config: OmpConfig): McpRow[] {
	return Object.entries(config.mcpServers).map(([name, server]): McpRow => {
		const maps = serverMaps(server);
		const common = {
			name,
			existing: true,
			enabled: server.enabled !== false,
			instructions: server.instructions !== false,
			timeout: server.timeout === undefined ? "" : String(server.timeout),
			env: Object.keys(maps.env ?? {}).map(key => ({ key, set: true })),
			headers: Object.keys(maps.headers ?? {}).map(key => ({ key, set: true })),
		};
		return "url" in server
			? { ...common, type: server.type, command: "", args: "", cwd: "", url: server.url }
			: { ...common, type: "stdio", command: server.command, args: (server.args ?? []).join("\n"), cwd: server.cwd ?? "", url: "" };
	});
}

export function createOmpRoutes(deps: OmpRoutesDeps): AdminRoutes {
	const { vault } = deps;
	const tests = new Map<string, McpTestState>();

	function requireUnlocked(): void {
		if (!vault.isInitialized() || !vault.isUnlocked()) throw new HttpError(409, "Settings are locked; log in to unlock them.");
	}

	function storedConfig(): { config: OmpConfig; error?: string } {
		requireUnlocked();
		return storedOmpConfig(vault);
	}

	async function view(): Promise<OmpView> {
		const { config, error } = storedConfig();
		return {
			update: deps.updates.status(),
			reference: ompSettings().list,
			pinned: Object.entries(LOCKED_SETTINGS).map(([id, { value, reason }]) => ({ id, value, reason })),
			settings: settingRows(config),
			servers: serverRows(config),
			...(error ? { storedError: error } : {}),
		};
	}

	async function save(req: Request): Promise<Response> {
		const previous = storedConfig().config;
		const parsed = saveSchema.safeParse(await jsonBody<OmpSaveRequest>(req));
		if (!parsed.success) {
			const issue = parsed.error.issues[0]!;
			return fail(400, `Invalid request: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
		}
		let config: OmpConfig;
		try {
			config = ompConfigFromRequest(parsed.data, previous);
		} catch (err) {
			if (err instanceof OmpConfigError) return fail(400, err.message);
			throw err;
		}
		vault.writeOmpConfig(config);
		log("info", "omp configuration saved", { admin: actingAdmin(req), settings: Object.keys(config.settings).length, mcpServers: Object.keys(config.mcpServers).length });
		return Response.json({ ok: true });
	}

	async function startTest(req: Request): Promise<Response> {
		const name = str((await jsonBody<McpTestRequest>(req)).name);
		const server = stored(storedConfig().config.mcpServers, name);
		if (!server) return fail(404, `No saved MCP server named "${name}".`);
		const state: McpTestState = { id: randomBytes(12).toString("base64url"), name, status: "starting", startedAt: new Date().toISOString() };
		tests.set(state.id, state);
		log("info", "MCP connection test requested", { admin: actingAdmin(req), server: name });
		const settle = (result: NonNullable<McpTestState["result"]>) => {
			Object.assign(state, { status: "done", result });
			log(result.ok ? "info" : "warn", "MCP connection test finished", { server: name, ok: result.ok, tools: result.tools.length, error: result.error });
			const timer = setTimeout(() => tests.delete(state.id), TEST_RETENTION_MS);
			timer.unref?.();
		};
		deps.dispatcher
			.mcpTest(
				{ name, server },
				{
					onWaitingForWorker: () => {
						if (state.status === "starting") state.status = "waiting";
					},
					onStarted: () => {
						if (state.status !== "done") state.status = "running";
					},
				},
			)
			.then(settle, err => settle({ ok: false, tools: [], error: errorMessage(err) }));
		return Response.json(state);
	}

	return {
		"/omp": {
			methods: ["GET", "PUT"],
			handle: async req => (req.method === "GET" ? Response.json(await view()) : save(req)),
		},
		"/omp/mcp-tests": { methods: ["POST"], handle: startTest },
		"/omp/update-check": {
			methods: ["POST"],
			async handle(req) {
				log("info", "omp update check requested", { admin: actingAdmin(req) });
				return Response.json(await deps.updates.check());
			},
		},
		"/omp/mcp-tests/": {
			methods: ["GET"],
			handle(_req, _url, path) {
				const state = tests.get(path.slice("/omp/mcp-tests/".length));
				return state ? Response.json(state) : fail(404, "This connection test does not exist or has expired.");
			},
		},
	};
}
