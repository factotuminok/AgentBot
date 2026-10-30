import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { captureLoadout } from "../../src/worker/host/loadout";
import type { McpConnection } from "../../src/shared/ompconfig";

/** Just the members captureLoadout reads from a real AgentSession. */
function fakeSession(tools: string[]): AgentSession {
	const session = {
		getActiveToolNames: () => tools,
		skills: [{ name: "agentbot-workflow", source: "claude-plugins:project", description: "rules", filePath: "/x", baseDir: "/x" }],
	};
	return session as unknown as AgentSession;
}

function fakeMcp(): McpConnection {
	const manager = {
		getTools: () => [
			{ name: "mcp__docs_search", mcpServerName: "docs" },
			{ name: "mcp__docs_fetch", mcpServerName: "docs" },
		],
		getAllServerNames: () => ["docs", "broken"],
		getConnectionStatus: (name: string) => (name === "docs" ? "connected" : "disconnected"),
	};
	return { manager, tools: [], errors: { broken: "ENOENT" }, close: async () => {} } as unknown as McpConnection;
}

test("restricted sessions report skills but no agents or MCP", async () => {
	const loadout = await captureLoadout(fakeSession(["yield", "read", "bash"]), { cwd: tmpdir(), ompDir: tmpdir(), profile: "plan" });
	expect(loadout.tools).toEqual(["bash", "read", "yield"]);
	expect(loadout.skills).toEqual([{ name: "agentbot-workflow", source: "claude-plugins:project", description: "rules" }]);
	expect(loadout.agents).toEqual([]);
	expect(loadout.mcp).toEqual([]);
});

test("sessions with a task tool list discoverable agents (downloaded skills dir included) minus disabled ones, and MCP tools by server", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "agentbot-loadout-"));
	try {
		const ompDir = join(cwd, "omp");
		mkdirSync(join(ompDir, "agents"), { recursive: true });
		writeFileSync(join(ompDir, "agents", "my-agent.md"), "---\nname: my-agent\ndescription: Mine\n---\nDo things.\n");
		const loadout = await captureLoadout(fakeSession(["task", "read"]), {
			cwd,
			ompDir,
			profile: "implement",
			mcp: fakeMcp(),
			disabledAgents: ["sonic"],
		});
		const names = loadout.agents.map(a => a.name);
		expect(names).toContain("task");
		expect(names).toContain("my-agent");
		expect(names).not.toContain("sonic");
		expect(loadout.mcp).toEqual([
			{ server: "broken", status: "failed", error: "ENOENT", tools: [] },
			{ server: "docs", status: "connected", tools: ["mcp__docs_fetch", "mcp__docs_search"] },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
