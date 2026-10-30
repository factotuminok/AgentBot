/**
 * Entry of the agent host: the worker supervisor spawns `bun src/worker/host/host.ts` once per run with an IPC channel
 * (`serialization: "json"`) and `HOME`, `PI_CODING_AGENT_DIR` (= `runtime.agentDir`), `TMPDIR` and `AGENTBOT_AGENT_RUN`
 * set (spike S2, AGT-06). The SDK is imported only after the IPC check, so a mistaken manual start fails fast.
 */
if (!process.send) {
	process.stderr.write(
		"agentbot agent host: no IPC channel. This process is started by the worker supervisor, one per run (Bun.spawn with ipc); it cannot run on its own.\n",
	);
	process.exit(2);
}

const [{ setLogComponent }, { openSessionRuntime, runSession }, { serveAgentHost }] = await Promise.all([
	import("../../shared/log"),
	import("./session"),
	import("./serve"),
]);
setLogComponent("agent-host");
serveAgentHost({ run: runSession, openRuntime: openSessionRuntime });

export {};
