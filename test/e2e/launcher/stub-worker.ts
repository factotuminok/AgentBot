#!/usr/bin/env bun
// Stub worker for the launcher smoke test, installed as `agentbot` in the stub worker image so the launcher's
// `agentbot worker` runs it: reads the worker token secret, says hello to the stub orchestrator, reports what the
// launcher's create spec gave it, holds the container for a few seconds so it shows in `podman ps`, and exits 0.
import { readFileSync, statSync } from "node:fs";

const read = (path: string) => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch (err) {
		return `unreadable: ${err instanceof Error ? err.message : String(err)}`;
	}
};
const status = read("/proc/self/status");
const statusField = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(status)?.[1];
const token = read(process.env.AGENTBOT_WORKER_TOKEN_FILE ?? "/run/secrets/worker_token");
const res = await fetch(`${process.env.AGENTBOT_ORCHESTRATOR_URL}/hello`, { headers: { authorization: `Bearer ${token}` } });
const runDir = statSync("/run/agentbot");
console.log(
	JSON.stringify({
		component: "stub-worker",
		args: process.argv.slice(2),
		pid1: read("/proc/1/comm"),
		uid: process.getuid?.(),
		hostname: process.env.HOSTNAME,
		hello: res.status,
		tokenLength: token.length,
		runDir: { uid: runDir.uid, gid: runDir.gid, mode: (runDir.mode & 0o777).toString(8) },
		memoryMax: read("/sys/fs/cgroup/memory.max"),
		swapMax: read("/sys/fs/cgroup/memory.swap.max"),
		// F7: CPU quota, process limit, no_new_privileges and no capabilities.
		cpuMax: read("/sys/fs/cgroup/cpu.max"),
		pidsMax: read("/sys/fs/cgroup/pids.max"),
		noNewPrivs: statusField("NoNewPrivs"),
		capEff: statusField("CapEff"),
		capBnd: statusField("CapBnd"),
		disk: process.env.AGENTBOT_WORKER_DISK,
		claimTimeout: process.env.AGENTBOT_WORKER_CLAIM_TIMEOUT,
	}),
);
await Bun.sleep(Number(process.env.STUB_WORKER_HOLD_MS ?? "6000"));
process.exit(res.ok ? 0 : 1);
