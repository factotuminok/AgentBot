/**
 * Spike S1 entry point: `bun spikes/s1/run.ts`. Runs parent.ts (and its workers) with HOME and the omp agent dir
 * pointed at a fresh temp sandbox, so nothing reads or writes the real ~/.omp. Removes the sandbox afterwards.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "agentbot-spike-s1-"));
const env: Record<string, string> = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	HOME: join(sandbox, "home"),
	TMPDIR: join(sandbox, "tmp"),
	PI_CODING_AGENT_DIR: join(sandbox, "orchestrator", "omp-agent"),
	S1_SANDBOX: sandbox,
};
await Bun.$`mkdir -p ${env.HOME} ${env.TMPDIR}`;
const proc = Bun.spawn({ cmd: [process.execPath, join(import.meta.dir, "parent.ts")], env, stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;
await rm(sandbox, { recursive: true, force: true });
process.exit(code);
