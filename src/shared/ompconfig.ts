import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { type MCPLoadResult, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { z } from "zod";
import { errorMessage } from "./log";

/**
 * omp configuration managed from the admin UI (D-025): setting overrides applied to every agent session and
 * MCP servers connected for sessions that can use them. Stored encrypted in the vault next to the AgentBot
 * settings; read at the start of every agent run, so a save takes effect without restarting the engine.
 */

/** Settings AgentBot relies on to run headless; admins cannot override them. */
export const LOCKED_SETTINGS: Record<string, { value: unknown; reason: string }> = {
	"tools.approvalMode": { value: "yolo", reason: "There is no one at a terminal to approve tool calls; AgentBot controls risk with tool profiles and private worker checkouts." },
	"ask.timeout": { value: 0, reason: "AgentBot applies its own ask timeout (askTimeoutHours) through Discord." },
	"async.enabled": { value: false, reason: "Subagents and commands must finish inside the run so their results count (D-024)." },
};

/** AGT-22: MCP startup waits at most this long; servers still pending are skipped. */
export const MCP_STARTUP_TIMEOUT_MS = 15_000;
/** AGT-21: the "Test connection" timeout, counted from when a worker picks the test up. */
export const MCP_TEST_TIMEOUT_MS = 20_000;

const MCP_NAME = /^[A-Za-z0-9_-]{1,48}$/;
/** Names that collide with Object.prototype members; checked on the raw input because a parsed object drops them. */
const RESERVED_MCP_NAME = /^(__proto__|constructor|prototype)$/;
const stringMap = z.record(z.string().min(1), z.string());
const mcpBase = {
	enabled: z.boolean().optional(),
	timeout: z.number().int().nonnegative().optional(),
	instructions: z.boolean().optional(),
};
const mcpStdio = z.object({
	type: z.literal("stdio").optional(),
	command: z.string().trim().min(1, "command is required"),
	args: z.array(z.string()).optional(),
	env: stringMap.optional(),
	cwd: z.string().min(1).optional(),
	...mcpBase,
});
const mcpRemote = z.object({
	type: z.enum(["http", "sse"]),
	url: z.url({ protocol: /^https?$/, error: "url must be an http(s) URL" }),
	headers: stringMap.optional(),
	...mcpBase,
});
const mcpServer = z.union([mcpRemote, mcpStdio]);

const ompConfigSchema = z.object({
	settings: z.record(z.string(), z.unknown()).default({}),
	mcpServers: z
		.record(z.string(), mcpServer)
		.default({})
		.superRefine((servers, ctx) => {
			for (const name of Object.keys(servers)) {
				if (!MCP_NAME.test(name)) ctx.addIssue({ code: "custom", path: [name], message: "name may use letters, digits, - and _ (max 48)" });
			}
		}),
});

export type McpServer = z.infer<typeof mcpServer>;

/** JSON Schema (draft 2020-12) of one MCP server entry as an admin writes it. */
export function mcpServerJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(mcpServer, { io: "input" });
}

export interface OmpConfig {
	/** Setting id → value, as accepted by omp `Settings.isolated`. */
	settings: Record<string, unknown>;
	mcpServers: Record<string, McpServer>;
}

/** `path` locates the error in the `{ settings, mcpServers }` object when it is about one field. */
export class OmpConfigError extends Error {
	override name = "OmpConfigError";
	constructor(
		message: string,
		readonly path?: (string | number)[],
	) {
		super(message);
	}
}

export function emptyOmpConfig(): OmpConfig {
	return { settings: {}, mcpServers: {} };
}

/** One omp setting as shown in the admin UI. */
export interface SettingInfo {
	id: string;
	type: "boolean" | "number" | "string" | "enum" | "array" | "record";
	default: unknown;
	enumValues?: readonly string[];
	label?: string;
	description?: string;
	/** Never render the value back. */
	credential: boolean;
	/** Set when AgentBot pins this setting. */
	locked?: string;
}

/** Every omp setting with its type, default and description (550+ as of omp 18.12.1). */
export function listSettings(): SettingInfo[] {
	return orderedSettings().map(setting => {
		const { definition } = setting;
		const ui = definition.ui;
		return {
			id: setting.id,
			type: definition.type,
			default: definition.default,
			...(setting.enumValues ? { enumValues: setting.enumValues } : {}),
			...(ui?.label ? { label: ui.label } : {}),
			...(ui?.description ? { description: ui.description } : {}),
			credential: setting.isCredential,
			...(LOCKED_SETTINGS[setting.id] ? { locked: LOCKED_SETTINGS[setting.id]!.reason } : {}),
		};
	});
}

/**
 * Parses form text for one setting with omp's own parser (booleans as true/false/yes/no, numbers, enum
 * values, JSON for arrays and records). Throws `OmpConfigError` naming the setting.
 */
export function parseSettingValue(id: string, text: string): unknown {
	const setting = lookup(id);
	if (!setting) throw new OmpConfigError(`Unknown omp setting "${id}"`, ["settings", id]);
	if (LOCKED_SETTINGS[id]) throw new OmpConfigError(`${id} is managed by AgentBot: ${LOCKED_SETTINGS[id]!.reason}`, ["settings", id]);
	try {
		const value = setting.definition.type === "array" || setting.definition.type === "record" ? JSON.parse(text) : setting.parse(text);
		setting.assertWritable(value);
		return value;
	} catch (err) {
		throw new OmpConfigError(`${id}: ${errorMessage(err)}`, ["settings", id]);
	}
}

/** Validates a whole config (also as omp would load it) and returns it normalized. */
export function parseOmpConfig(raw: unknown): OmpConfig {
	const rawServers = raw && typeof raw === "object" && "mcpServers" in raw ? raw.mcpServers : undefined;
	if (rawServers && typeof rawServers === "object") {
		const reserved = Object.keys(rawServers).find(name => RESERVED_MCP_NAME.test(name));
		if (reserved) throw new OmpConfigError(`Invalid omp config: mcpServers.${reserved}: reserved name`, ["mcpServers", reserved]);
	}
	const result = ompConfigSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0]!;
		const path = issue.path.map(p => (typeof p === "number" ? p : String(p)));
		throw new OmpConfigError(`Invalid omp config: ${path.join(".") || "(root)"}: ${issue.message}`, path);
	}
	for (const id of Object.keys(result.data.settings)) {
		if (LOCKED_SETTINGS[id]) throw new OmpConfigError(`${id} is managed by AgentBot: ${LOCKED_SETTINGS[id]!.reason}`, ["settings", id]);
		if (!lookup(id)) throw new OmpConfigError(`Unknown omp setting "${id}"`, ["settings", id]);
	}
	try {
		Settings.isolated(sessionSettings(result.data));
	} catch (err) {
		throw new OmpConfigError(`Invalid omp settings: ${errorMessage(err)}`);
	}
	return result.data;
}

/** The record passed to `Settings.isolated`: admin overrides, then AgentBot's pinned values on top. */
export function sessionSettings(config: OmpConfig): Record<string, unknown> {
	const pinned = Object.fromEntries(Object.entries(LOCKED_SETTINGS).map(([id, { value }]) => [id, value]));
	return { "compaction.enabled": true, "retry.enabled": true, ...config.settings, ...pinned };
}

/**
 * Initializes omp's process-global settings with the admin overrides and returns them for the session.
 *
 * omp's `web_search` (and `executeBash`) read the global `settings` object, which only exists after
 * `Settings.init()`; a session created with `Settings.isolated` never sets it, so every `web_search` call threw
 * "Settings not initialized" (D-064). In-memory: omp writes nothing. `cwd` is a AgentBot-owned directory with no
 * project config, matching `isolated`, which loads no project layer.
 *
 * One run per agent process is the invariant: `Settings.init` returns the first call's settings to every later
 * caller, so a second run would silently keep the first run's overrides. Hence the throw.
 */
export async function initRunSettings(config: OmpConfig, agentDir: string): Promise<Settings> {
	if (Settings.current) throw new Error("omp settings are already initialized in this process; one agent run per process");
	return Settings.init({ inMemory: true, agentDir, cwd: agentDir, overrides: sessionSettings(config) });
}

/** Enabled servers only, in the shape omp's MCP layer expects. */
export function enabledMcpServers(config: OmpConfig): Record<string, MCPServerConfig> {
	const servers: Record<string, MCPServerConfig> = {};
	for (const [name, server] of Object.entries(config.mcpServers)) {
		if (server.enabled === false) continue;
		servers[name] = server;
	}
	return servers;
}

export interface McpConnection {
	manager: MCPManager;
	tools: MCPLoadResult["tools"];
	/** Server name → connection error, for servers that failed to start. */
	errors: Record<string, string>;
	close(): Promise<void>;
}

/**
 * Connects `servers` with a caller-owned MCP manager (no file discovery). `startupTimeoutMs` bounds the
 * initial handshake; slower servers keep connecting in the background.
 */
export async function connectMcp(cwd: string, servers: Record<string, MCPServerConfig>, startupTimeoutMs: number): Promise<McpConnection> {
	const sources: Record<string, SourceMeta> = {};
	for (const name of Object.keys(servers)) sources[name] = { provider: "agentbot", providerName: "AgentBot admin", path: "agentbot://omp", level: "native" };
	const manager = new MCPManager(cwd, null, async () => ({ configs: servers, exaApiKeys: [], sources }));
	const result = await manager.discoverAndConnect({ startupTimeoutMs, enableProjectConfig: false, filterExa: false });
	const errors = Object.fromEntries(result.errors);
	return {
		manager,
		tools: result.tools,
		errors,
		async close() {
			await manager.disconnectAll();
			if (MCPManager.instance() === manager) MCPManager.setInstance(undefined);
		},
	};
}

export interface McpTestResult {
	ok: boolean;
	tools: string[];
	error?: string;
}

/** Connects one server, lists its tools, and disconnects (admin "Test" button). */
export async function testMcpServer(name: string, server: McpServer, cwd: string, timeoutMs = MCP_TEST_TIMEOUT_MS): Promise<McpTestResult> {
	let connection: McpConnection | undefined;
	try {
		connection = await connectMcp(cwd, { [name]: { ...server, enabled: true } }, timeoutMs);
		await connection.manager.waitForStartup(timeoutMs);
		const tools = connection.manager.getTools().map(tool => tool.name);
		const error = connection.errors[name] ?? Object.values(connection.errors)[0];
		if (connection.manager.getConnectionStatus(name) !== "connected") {
			return { ok: false, tools, error: error ?? `Server did not connect within ${timeoutMs} ms` };
		}
		return { ok: true, tools };
	} catch (err) {
		return { ok: false, tools: [], error: errorMessage(err) };
	} finally {
		await connection?.close().catch(() => {});
	}
}
