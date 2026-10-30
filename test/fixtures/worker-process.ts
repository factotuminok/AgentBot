// A worker as its own OS process for integration tests: `runWorkerOnce` with the fixture agent host and short timings,
// configured by env. The run-local root is the real one (`<tmpdir>/agentbot-worker/<pid>`), so tests can check it is gone.
//   AGENTBOT_ORCHESTRATOR_URL  internal API base URL
//   TEST_WORKER_TOKEN          the worker token
//   TEST_WORKER_ID             worker id (default `test-worker-<pid>`)
//   TEST_CLAIM_TIMEOUT_MS      claim timeout (default 10000)
// Prints `{"outcome":…}` on stdout and exits 0, like `agentbot worker`.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runWorkerOnce } from "../../src/worker/main";
import { workerRoot } from "../../src/worker/status";

const env = process.env;
const orchestratorUrl = env.AGENTBOT_ORCHESTRATOR_URL;
const workerToken = env.TEST_WORKER_TOKEN;
if (!orchestratorUrl || !workerToken) throw new Error("AGENTBOT_ORCHESTRATOR_URL and TEST_WORKER_TOKEN are required");

const root = workerRoot();
// As `runWorker` does: omp state of this process stays inside the run-local root.
await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
process.env.HOME = join(root, "home");
process.env.PI_CODING_AGENT_DIR = join(root, "auth");
const sigterm = new AbortController();
process.once("SIGTERM", () => sigterm.abort());

const outcome = await runWorkerOnce({
	orchestratorUrl,
	workerToken,
	workerId: env.TEST_WORKER_ID || `test-worker-${process.pid}`,
	claimTimeoutMs: Number(env.TEST_CLAIM_TIMEOUT_MS ?? 10_000),
	root,
	identity: { version: "0.0.0-test", hash: "test" },
	ompVersion: "test",
	hostEntry: join(import.meta.dir, "agent-host.ts"),
	timing: { heartbeatMs: 100, abortKillMs: 400, exitGraceMs: 500, disconnectWaitMs: 200, endAckTimeoutMs: 5_000, retryMinMs: 20, retryMaxMs: 100 },
	reconnectMinMs: 30,
	reconnectMaxMs: 200,
	signal: sigterm.signal,
});
console.log(JSON.stringify({ outcome }));
process.exit(0);
