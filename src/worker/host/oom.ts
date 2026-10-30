import { readFileSync } from "node:fs";

/** cgroup v2 events file of the container the worker runs in. */
const CGROUP_MEMORY_EVENTS = "/sys/fs/cgroup/memory.events";

/**
 * Number of processes in this cgroup killed by any OOM killer since it was created (cgroup v2 `memory.events`, AGT-17).
 * `undefined` when the file or line is absent (cgroup v1, macOS dev, non-container run): detection is then off.
 * Sync on purpose: a tiny sysfs file, read from sync event handlers. Imports nothing from omp (the supervisor uses it too).
 */
export function readOomKills(path: string = CGROUP_MEMORY_EVENTS): number | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const match = /^oom_kill (\d+)$/m.exec(text);
	return match ? Number(match[1]) : undefined;
}
