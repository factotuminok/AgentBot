import { describe, expect, test } from "bun:test";
import type { SyncStatus } from "../../src/shared/workspaceSync";

/** The extension's pure module is plain CommonJS (no build step); this is the part of its surface the tests use. */
interface SyncModule {
	syncPaths(home: string): { workspace: string; status: string; commands: string };
	parseStatus(text: string | undefined): SyncStatus | undefined;
	statusView(status: SyncStatus | undefined): { text: string; tooltip: string; tone?: "error" | "warning" };
	problemsByFile(status: SyncStatus | undefined): Map<string, { line: number; message: string; severity: "error" | "warning" }[]>;
	unseenNotices(status: SyncStatus | undefined, seen: Set<string>): SyncStatus["notices"];
	workspacePath(workspace: string, file: string): string | undefined;
	commandFile(command: "reload" | "accept", file: string | undefined, now?: number, nonce?: string): { name: string; body: string };
}

const sync: SyncModule = require("../../vscode/extension/sync.js");

const STATUS: SyncStatus = {
	state: "rejected",
	message: "settings.json was rejected",
	updatedAt: "2026-10-30T10:00:00.000Z",
	problems: [
		{ path: "settings.json", message: "limits.maxConcurrentJobs: too big", line: 12 },
		{ path: "skills/x/SKILL.md", message: "frontmatter needs a name" },
	],
	conflicts: ["omp.json"],
	notices: [
		{ id: "n1", level: "info", text: "Settings applied; engine running." },
		{ id: "n2", level: "warning", text: "Deleted .vscode/tasks.json." },
	],
};

describe("extension sync helpers (WEB-28)", () => {
	test("paths follow the workspaceSync contract", () => {
		expect(sync.syncPaths("/home/agentbot")).toEqual({
			workspace: "/home/agentbot/config-workspace",
			status: "/home/agentbot/.agentbot/sync/status.json",
			commands: "/home/agentbot/.agentbot/sync/commands",
		});
	});

	test("status file parsing drops malformed parts and rejects unknown states", () => {
		expect(sync.parseStatus(JSON.stringify(STATUS))).toEqual(STATUS);
		expect(sync.parseStatus(undefined)).toBeUndefined();
		expect(sync.parseStatus("{")).toBeUndefined();
		expect(sync.parseStatus(JSON.stringify({ ...STATUS, state: "missing" }))).toBeUndefined();
		const partial = sync.parseStatus(JSON.stringify({ state: "synced", problems: [{ path: 1 }], notices: "x" }));
		expect(partial).toEqual({ state: "synced", message: undefined, updatedAt: "", problems: [], conflicts: [], notices: [] });
	});

	test("status bar text, tone and tooltip per state", () => {
		const view = sync.statusView(STATUS);
		expect(view.text).toBe("$(error) AgentBot: rejected");
		expect(view.tone).toBe("error");
		expect(view.tooltip.split("\n")).toEqual([
			"settings.json was rejected",
			"2 validation errors; see the Problems panel.",
			"Conflict: omp.json (the orchestrator's version is in omp.json.remote).",
			"Updated 2026-10-30T10:00:00.000Z",
		]);
		expect(sync.statusView({ ...STATUS, state: "synced", problems: [], conflicts: [] }).tone).toBeUndefined();
		expect(sync.statusView({ ...STATUS, state: "conflict" }).tone).toBe("warning");
		expect(sync.statusView({ ...STATUS, state: "unavailable" }).text).toBe("$(debug-disconnect) AgentBot: orchestrator unavailable");
		expect(sync.statusView(undefined).text).toBe("$(debug-disconnect) AgentBot: not syncing");
	});

	test("problems map to 0-based lines per file, plus a warning per conflict", () => {
		const files = sync.problemsByFile(STATUS);
		expect(files.get("settings.json")).toEqual([{ line: 11, message: "limits.maxConcurrentJobs: too big", severity: "error" }]);
		expect(files.get("skills/x/SKILL.md")).toEqual([{ line: 0, message: "frontmatter needs a name", severity: "error" }]);
		expect(files.get("omp.json")?.[0]?.severity).toBe("warning");
		expect(files.get("omp.json")?.[0]?.message).toContain("omp.json.remote");
		expect(sync.problemsByFile(undefined).size).toBe(0);
	});

	test("each notice is shown once", () => {
		expect(sync.unseenNotices(STATUS, new Set()).map(n => n.id)).toEqual(["n1", "n2"]);
		expect(sync.unseenNotices(STATUS, new Set(["n1"])).map(n => n.id)).toEqual(["n2"]);
	});

	test("the active file maps to a workspace path, `.remote` to its original", () => {
		const ws = "/home/agentbot/config-workspace";
		expect(sync.workspacePath(ws, `${ws}/settings.json`)).toBe("settings.json");
		expect(sync.workspacePath(ws, `${ws}/omp.json.remote`)).toBe("omp.json");
		expect(sync.workspacePath(ws, `${ws}/skills/x/SKILL.md`)).toBe("skills/x/SKILL.md");
		expect(sync.workspacePath(ws, "/etc/passwd")).toBeUndefined();
		expect(sync.workspacePath(ws, ws)).toBeUndefined();
	});

	test("command files carry the SyncCommand shape", () => {
		expect(sync.commandFile("accept", "omp.json", 1000, "abc")).toEqual({ name: "1000-abc.json", body: `{"command":"accept","path":"omp.json"}\n` });
		expect(JSON.parse(sync.commandFile("reload", undefined).body)).toEqual({ command: "reload" });
	});
});
