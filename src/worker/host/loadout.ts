import { homedir } from "node:os";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentProfile, Loadout } from "../../shared/agent";
import type { McpConnection } from "../../shared/ompconfig";

/** What one agent session actually had loaded when it started (AGT-27). */
export async function captureLoadout(
	session: AgentSession,
	opts: { cwd: string; ompDir: string; profile: AgentProfile; mcp?: McpConnection; disabledAgents?: readonly string[] },
): Promise<Loadout> {
	const tools = session.getActiveToolNames().sort();
	const skills = session.skills
		.map(skill => ({ name: skill.name, source: skill.source, description: skill.description }))
		.sort((a, b) => a.name.localeCompare(b.name));

	let agents: Loadout["agents"] = [];
	if (tools.includes("task")) {
		const disabled = opts.disabledAgents ?? [];
		// Sessions run with extension discovery off and the downloaded skills dir as the only explicit root (AGT-24);
		// agent discovery mirrors that. `homedir()` is the run-local HOME the supervisor set.
		const { agents: found } = await discoverAgents(opts.cwd, homedir(), {
			explicit: [opts.ompDir],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		});
		agents = found
			.filter(agent => !disabled.includes(agent.name))
			.map(agent => ({ name: agent.name, source: agent.source, description: agent.description }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	const mcp: Loadout["mcp"] = [];
	if (opts.mcp) {
		const { manager, errors } = opts.mcp;
		const toolsByServer: Record<string, string[]> = {};
		for (const tool of manager.getTools()) {
			// MCP bridge tools carry their server name (`MCPTool`/`DeferredMCPTool.mcpServerName`).
			const server = "mcpServerName" in tool && typeof tool.mcpServerName === "string" ? tool.mcpServerName : "?";
			(toolsByServer[server] ??= []).push(tool.name);
		}
		for (const server of manager.getAllServerNames().sort()) {
			const status = manager.getConnectionStatus(server);
			mcp.push({
				server,
				status: status === "connected" ? "connected" : status === "connecting" ? "pending" : "failed",
				...(errors[server] ? { error: errors[server] } : {}),
				tools: (toolsByServer[server] ?? []).sort(),
			});
		}
	}

	return { capturedAt: new Date().toISOString(), profile: opts.profile, tools, skills, agents, mcp };
}
