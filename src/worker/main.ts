import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../shared/env";
import { errorMessage, log } from "../shared/log";
import { APP_ROOT, type AppIdentity, appIdentity } from "../shared/version";
import type { OrchestratorControl, WorkerPhase } from "../shared/wire";
import { WorkerConnection } from "./connection";
import { type ActiveRun, McpTestRun, type RunTiming, RunSupervisor } from "./runner";
import { StatusFile, workerRoot } from "./status";

/**
 * The worker role (architecture §2.3): connect, claim one run, serve it, clean up, exit 0. Nothing to claim within
 * `AGENTBOT_WORKER_CLAIM_TIMEOUT`, or `nothing` from the orchestrator, also exits 0: another worker won the race.
 */

export interface WorkerOptions {
	orchestratorUrl: string;
	workerToken: string;
	/** Pod or container name (`HOSTNAME`), else random. */
	workerId: string;
	claimTimeoutMs: number;
	/** Run-local root; holds the status file and everything of the run, and is deleted at the end (RUN-20). */
	root: string;
	identity: AppIdentity;
	ompVersion: string;
	/** The agent host entry; tests use a fixture host. */
	hostEntry?: string;
	timing?: Partial<RunTiming>;
	reconnectMinMs?: number;
	reconnectMaxMs?: number;
	/** Aborted on SIGTERM: checkpoint, stop the host, clean up (RUN-18). */
	signal?: AbortSignal;
}

export type WorkerOutcome = "nothing" | "run" | "mcp-test";

type Assign = Extract<OrchestratorControl, { t: "assign" }>;

/** Serves at most one assignment and deletes the run-local root before returning. */
export async function runWorkerOnce(opts: WorkerOptions): Promise<WorkerOutcome> {
	await mkdir(opts.root, { recursive: true, mode: 0o700 });
	const status = new StatusFile(opts.root, opts.identity.version);
	const claimed = Promise.withResolvers<Assign | undefined>();
	const ready = Promise.withResolvers<ActiveRun | undefined>();
	let active: ActiveRun | undefined;
	const conn = new WorkerConnection({
		orchestratorUrl: opts.orchestratorUrl,
		workerToken: opts.workerToken,
		workerId: opts.workerId,
		identity: { version: opts.identity.version, hash: opts.identity.hash },
		ompVersion: opts.ompVersion,
		reconnectMinMs: opts.reconnectMinMs,
		reconnectMaxMs: opts.reconnectMaxMs,
		onControl: msg => {
			if (msg.t === "assign") claimed.resolve(msg);
			else if (msg.t === "nothing") claimed.resolve(undefined);
			else active?.onControl(msg);
		},
		onRelay: async msg => (await ready.promise)?.onRelay(msg),
		onScratchInput: async name => (await ready.promise)?.onScratchInput(name),
		onConnectedChange: connected => status.update({ connected }),
	});
	const claimTimer = setTimeout(() => claimed.resolve(undefined), opts.claimTimeoutMs);
	// SIGTERM before a claim: nothing to save, stop claiming.
	const stopClaiming = () => claimed.resolve(undefined);
	opts.signal?.addEventListener("abort", stopClaiming, { once: true });
	try {
		conn.start();
		conn.claim();
		const assign = await claimed.promise;
		clearTimeout(claimTimer);
		opts.signal?.removeEventListener("abort", stopClaiming);
		if (!assign) {
			log("info", "nothing to claim; exiting", { worker: opts.workerId });
			return "nothing";
		}
		const lease = { runId: assign.runId, token: assign.token };
		log("info", "run claimed", { run: assign.runId, worker: opts.workerId, kind: assign.kind });
		status.update({ runId: assign.runId });
		const supervisorOptions = {
			conn,
			lease,
			orchestratorUrl: opts.orchestratorUrl,
			root: opts.root,
			ompVersion: opts.ompVersion,
			hostEntry: opts.hostEntry,
			timing: opts.timing,
			onPhase: (phase: WorkerPhase) => status.update({ phase }),
		};
		const run = assign.kind === "run" ? new RunSupervisor(supervisorOptions, assign.spec) : new McpTestRun(supervisorOptions, assign.mcp);
		active = run;
		ready.resolve(run);
		const onSigterm = () => void run.terminate();
		opts.signal?.addEventListener("abort", onSigterm, { once: true });
		const running = run.run();
		if (opts.signal?.aborted) onSigterm();
		await running;
		opts.signal?.removeEventListener("abort", onSigterm);
		log("info", "run finished on the worker", { run: assign.runId });
		return assign.kind;
	} finally {
		clearTimeout(claimTimer);
		ready.resolve(undefined);
		await conn.stop();
		await rm(opts.root, { recursive: true, force: true }).catch(err => log("warn", "run-local cleanup failed", { error: errorMessage(err) }));
	}
}

/** The omp version installed with this app copy, for `hello` and `run-info`. */
export async function installedOmpVersion(): Promise<string> {
	try {
		const pkg = (await Bun.file(join(APP_ROOT, "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json")).json()) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

/** `agentbot worker`: one run, then exit 0. */
export async function runWorker(): Promise<never> {
	const env = loadEnv();
	if (!env.workerTokenFile) throw new Error("AGENTBOT_WORKER_TOKEN_FILE is not set");
	const workerToken = (await Bun.file(env.workerTokenFile).text()).trim();
	if (!workerToken) throw new Error(`worker token file ${env.workerTokenFile} is empty`);
	const root = workerRoot();
	// omp captures these when it loads (spike S2); the supervisor loads it only for the auth store and `mcp-test`.
	await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
	await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "auth");
	const sigterm = new AbortController();
	process.once("SIGTERM", () => sigterm.abort());
	const workerId = process.env.HOSTNAME?.trim() || `${hostname()}-${crypto.randomUUID().slice(0, 8)}`;
	await runWorkerOnce({
		orchestratorUrl: env.orchestratorUrl,
		workerToken,
		workerId,
		claimTimeoutMs: env.workerClaimTimeoutMs,
		root,
		identity: await appIdentity(),
		ompVersion: await installedOmpVersion(),
		signal: sigterm.signal,
	});
	process.exit(0);
}
