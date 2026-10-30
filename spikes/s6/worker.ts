// Spike S6: stub worker. Reads the worker token secret, calls the stub orchestrator, reports its limits, exits 0.
import { $ } from "bun";

const token = (await Bun.file("/run/secrets/worker_token").text()).trim();
const orch = process.env.AGENTBOT_ORCHESTRATOR_URL ?? "http://agentbot-spike-s6-stub:8081";
const res = await fetch(`${orch}/hello`, { headers: { authorization: `Bearer ${token}` } });
const out = (cmd: string) => $`sh -c ${cmd}`.nothrow().quiet().text().then((s) => s.trim());

console.log(
	JSON.stringify({
		component: "worker",
		uid: process.getuid?.(),
		tokenLength: token.length,
		hello: { status: res.status, body: await res.text() },
		memoryMax: await out("cat /sys/fs/cgroup/memory.max"),
		swapMax: await out("cat /sys/fs/cgroup/memory.swap.max"),
		mounts: await out("grep -E ' /run/agentbot | /work | /run/secrets' /proc/mounts"),
		df: await out("df -h / /run/agentbot /work 2>&1"),
		perms: await out("ls -lnd /run/secrets /run/secrets/worker_token /run/agentbot /work"),
	}),
);

// Give the driver time to attach `podman logs -f` and inspect the running container.
await Bun.sleep(Number(process.env.SPIKE_WORKER_SLEEP_MS ?? "6000"));

// Fill the scratch area past its limit to see whether the limit holds (STO-06).
if (process.env.SPIKE_SCRATCH && process.env.SPIKE_SCRATCH !== "none") {
	const target = "/work/fill"; // a mount for tmpfs/volume, the container's own rootfs for storage-opt
	const dd = await $`sh -c ${`mkdir -p $(dirname ${target}) && dd if=/dev/zero of=${target} bs=1M count=768 2>&1; ls -la ${target}; rm -f ${target}`}`
		.nothrow()
		.quiet();
	console.log(JSON.stringify({ component: "worker", fill: target, exitCode: dd.exitCode, output: dd.text().trim() }));
}

console.log(JSON.stringify({ component: "worker", msg: "exiting 0" }));
