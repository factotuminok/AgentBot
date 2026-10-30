import { readWorkerStatus, workerBaseDir } from "./status";

/**
 * `agentbot health` for a worker (architecture §4.5): prints `{status, version, phase, runId, connected}` from the
 * status file of the worker process on this host and exits 0 while that process is alive. With `--claimed` it exits
 * 0 only once the worker has claimed a run: the Kubernetes readiness probe (spike S5). Returns the exit code.
 */
export function runWorkerHealth(args: readonly string[], base: string = workerBaseDir(), out: (line: string) => void = line => process.stdout.write(line)): number {
	const status = readWorkerStatus(base);
	if (!status) {
		out(`${JSON.stringify({ status: "down" })}\n`);
		return 1;
	}
	const { version, phase, runId, connected } = status;
	out(`${JSON.stringify({ status: status.status, version, phase, runId, connected })}\n`);
	return args.includes("--claimed") && runId === null ? 1 : 0;
}
