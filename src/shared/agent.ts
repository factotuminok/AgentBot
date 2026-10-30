/** Agent types shared by the orchestrator (rendering, status) and the worker (agent host). No omp or Discord imports. */

/** Tool profiles (AGT-08). */
export type AgentProfile = "plan" | "implement" | "chat" | "draft" | "ask";

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

/** What a session loaded (AGT-27). */
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
