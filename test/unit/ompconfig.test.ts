import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { resetSettingsForTest, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgProvidersWebSearchTimeoutSeconds } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import {
	connectMcp,
	emptyOmpConfig,
	enabledMcpServers,
	initRunSettings,
	listSettings,
	MCP_STARTUP_TIMEOUT_MS,
	OmpConfigError,
	parseOmpConfig,
	parseSettingValue,
	sessionSettings,
	testMcpServer,
} from "../../src/shared/ompconfig";

const ECHO_SERVER = { command: process.execPath, args: [join(import.meta.dir, "..", "fixtures", "echo-mcp.ts")], env: { ECHO_PREFIX: "echo: " } };

describe("omp settings", () => {
	test("values are parsed with omp's types and validated", () => {
		expect(parseSettingValue("compaction.enabled", "off")).toBe(false);
		expect(parseSettingValue("mcp.startupTimeoutMs", "5000")).toBe(5000);
		expect(parseSettingValue("find.enabled", "on")).toBe("on");
		expect(() => parseSettingValue("find.enabled", "sometimes")).toThrow(OmpConfigError);
		expect(() => parseSettingValue("mcp.startupTimeoutMs", "soon")).toThrow("mcp.startupTimeoutMs");
		expect(() => parseSettingValue("no.such.setting", "1")).toThrow('Unknown omp setting "no.such.setting"');
	});

	test("pinned settings cannot be overridden and are applied last (AGT-20)", () => {
		expect(() => parseSettingValue("tools.approvalMode", "always-ask")).toThrow("managed by AgentBot");
		expect(() => parseOmpConfig({ settings: { "async.enabled": true } })).toThrow("managed by AgentBot");
		const merged = sessionSettings({ settings: { "compaction.enabled": false, "find.enabled": "on", "ask.timeout": 30 }, mcpServers: {} });
		expect(merged).toMatchObject({ "compaction.enabled": false, "find.enabled": "on", "tools.approvalMode": "yolo", "async.enabled": false, "ask.timeout": 0 });
		const pinned = listSettings()
			.filter(s => s.locked)
			.map(s => s.id)
			.sort();
		expect(pinned).toEqual(["ask.timeout", "async.enabled", "tools.approvalMode"]);
	});

	test("whole-config validation catches bad settings and MCP definitions (AGT-21)", () => {
		expect(() => parseOmpConfig({ settings: { "find.enabled": "sometimes" } })).toThrow(OmpConfigError);
		expect(() => parseOmpConfig({ mcpServers: { "bad name": { command: "x" } } })).toThrow("name may use");
		expect(() => parseOmpConfig({ mcpServers: { ["x".repeat(49)]: { command: "x" } } })).toThrow("name may use");
		expect(() => parseOmpConfig({ mcpServers: { web: { type: "http", url: "ftp://example.com" } } })).toThrow("http(s)");
		expect(() => parseOmpConfig({ mcpServers: { local: { command: "  " } } })).toThrow("command is required");
		expect(() => parseOmpConfig(JSON.parse('{"mcpServers": {"__proto__": {"command": "x"}}}'))).toThrow("reserved name");
		expect(() => parseOmpConfig({ mcpServers: { constructor: { command: "x" } } })).toThrow("reserved name");
		expect(() => parseOmpConfig({ mcpServers: { prototype: { command: "x" } } })).toThrow("reserved name");
		const ok = parseOmpConfig({ mcpServers: { "docs_v-2": { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } } } });
		expect(ok.mcpServers["docs_v-2"]).toEqual({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
	});

	test("disabled servers are left out", () => {
		const config = parseOmpConfig({ mcpServers: { on: { command: "a" }, off: { command: "b", enabled: false } } });
		expect(Object.keys(enabledMcpServers(config))).toEqual(["on"]);
	});
});

describe("MCP", () => {
	test("startup waits at most 15 s (AGT-22)", () => {
		expect(MCP_STARTUP_TIMEOUT_MS).toBe(15_000);
	});

	test("connectMcp connects only the given servers, with no file discovery", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "agentbot-mcp-"));
		await Bun.write(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { discovered: { command: "/nonexistent/server" } } }));
		const connection = await connectMcp(cwd, { echo: ECHO_SERVER }, 10_000);
		try {
			expect(connection.manager.getConnectionStatus("echo")).toBe("connected");
			expect(connection.manager.getConnectionStatus("discovered")).not.toBe("connected");
			expect(connection.errors).toEqual({});
		} finally {
			await connection.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("testMcpServer connects a real stdio server and lists its tools", async () => {
		const result = await testMcpServer("echo", ECHO_SERVER, tmpdir(), 10_000);
		expect(result).toEqual({ ok: true, tools: [expect.stringContaining("echo")] });
	});

	test("testMcpServer reports a server that cannot start", async () => {
		const result = await testMcpServer("missing", { command: "/nonexistent/mcp-server-binary" }, tmpdir(), 5_000);
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe("initRunSettings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agentbot-omp-"));
	});
	afterEach(async () => {
		resetSettingsForTest();
		await rm(dir, { recursive: true, force: true });
	});

	test("web_search can read omp's process-global settings", async () => {
		await initRunSettings(emptyOmpConfig(), dir);
		const authStorage = await discoverAuthStorage(dir, { cwd: dir });
		try {
			const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.yml"));
			const result = await runSearchQuery({ query: "x", model: "none/none" }, { authStorage, modelRegistry });
			expect(result.content[0]?.text).toBe('Error: No web search model matches selector "none/none".');
		} finally {
			authStorage.close();
		}
	});

	test("admin overrides are what the global settings return", async () => {
		const returned = await initRunSettings({ settings: { "providers.webSearchTimeoutSeconds": 7 }, mcpServers: {} }, dir);
		expect(cfgProvidersWebSearchTimeoutSeconds.get(returned)).toBe(7);
		expect(cfgProvidersWebSearchTimeoutSeconds.get(settings)).toBe(7);
	});

	test("a second call in the same process throws instead of keeping the first run's settings", async () => {
		await initRunSettings(emptyOmpConfig(), dir);
		await expect(initRunSettings(emptyOmpConfig(), dir)).rejects.toThrow("already initialized");
	});
});
