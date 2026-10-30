import { readdirSync, readFileSync } from "node:fs";

/**
 * Environment variable that tags an agent run and, through environment inheritance, everything it starts (AGT-06).
 * The worker supervisor sets it on the agent host and calls `killMarkedProcesses` when the run ends. This module
 * imports nothing from omp, so the supervisor can load it without the SDK.
 */
export const AGENT_RUN_ENV = "AGENTBOT_AGENT_RUN";

/**
 * SIGKILLs every process whose environment carries `AGENTBOT_AGENT_RUN=<marker>` (Linux `/proc`) and returns
 * their pids. Reaches what a process-group kill cannot: children that called `setsid` (omp's bash commands, its
 * launch broker and services, MCP servers). Unreadable entries (exited meanwhile, other user) are skipped; without
 * `/proc` nothing is killed. Sync on purpose: runs once at the end of a run, over small procfs files.
 */
export function killMarkedProcesses(marker: string, procDir = "/proc"): number[] {
	let entries: string[];
	try {
		entries = readdirSync(procDir);
	} catch {
		return [];
	}
	const needle = `${AGENT_RUN_ENV}=${marker}`;
	const killed: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		let environ: string;
		try {
			environ = readFileSync(`${procDir}/${entry}/environ`, "latin1");
		} catch {
			continue;
		}
		if (!environ.split("\0").includes(needle)) continue;
		try {
			process.kill(pid, "SIGKILL");
			killed.push(pid);
		} catch {
			// Exited between the read and the kill.
		}
	}
	return killed;
}
