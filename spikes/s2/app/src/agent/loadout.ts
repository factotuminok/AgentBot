import { homedir } from "node:os";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { McpConnection } from "../ompconfig";
import type { AgentProfile } from "./runner";

/** What one agent session actually had loaded when it started (D-026), shown on the status page. */
export interface Loadout {
	capturedAt: string;
	profile: AgentProfile;
	/** Top-level tools the session exposed. */
	tools: string[];
	skills: { name: string; source: string; description: string }[];
	/** Agents the `task` tool could run; empty when the profile has no `task` tool. */
	agents: { name: string; source: string; description: string }[];
	mcp: { server: string; status: "connected" | "pending" | "failed"; error?: string; tools: string[] }[];
}

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
		// Sessions run with extension discovery off and the omp volume as the only explicit root; agent discovery mirrors that.
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
