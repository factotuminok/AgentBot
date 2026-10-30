import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { loadEnv } from "../shared/env";
import { errorMessage, log } from "../shared/log";
import { installedOmpVersion } from "../shared/ompPins";
import { readTokenFile } from "../shared/tokens";
import { APP_ROOT, type AppIdentity, appIdentity } from "../shared/version";
import type { OrchestratorControl, WorkerPhase } from "../shared/wire";
import { WorkerConnection } from "./connection";
import { type ActiveRun, McpTestRun, type RunTiming, RunSupervisor } from "./runner";
import { StatusFile, workerRoot, workerRunBaseDir } from "./status";

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
	/** Checkout root on container storage: checkout, sessions, skills and scratch copies (architecture §5, "worker checkout"). */
	root: string;
	/**
	 * Run-local root (architecture §5, "run-local"; a tmpfs in the image): the status file, the run-private auth store,
	 * omp's `HOME` and agent dir, and the host's `TMPDIR`. May equal `root`. Both are deleted at the end (RUN-20).
	 */
	runLocal: string;
	identity: AppIdentity;
	ompVersion: string;
	/** The agent host entry; tests use a fixture host. */
	hostEntry?: string;
	timing?: Partial<RunTiming>;
	/** The checkout's size limit (STO-06, `AGENTBOT_WORKER_DISK`). */
	diskLimitBytes?: number;
	reconnectMinMs?: number;
	reconnectMaxMs?: number;
	/** Ping interval of the orchestrator connection (`KEEPALIVE_MS`). */
	keepaliveMs?: number;
	/** Aborted on SIGTERM: checkpoint, stop the host, clean up (RUN-18). */
	signal?: AbortSignal;
}

export type WorkerOutcome = "nothing" | "run" | "mcp-test";

type Assign = Extract<OrchestratorControl, { t: "assign" }>;

/** Serves at most one assignment and deletes the checkout and run-local roots before returning. */
export async function runWorkerOnce(opts: WorkerOptions): Promise<WorkerOutcome> {
	await mkdir(opts.root, { recursive: true, mode: 0o700 });
	await mkdir(opts.runLocal, { recursive: true, mode: 0o700 });
	const status = new StatusFile(opts.runLocal, opts.identity.version);
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
		keepaliveMs: opts.keepaliveMs,
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
			runLocal: opts.runLocal,
			ompVersion: opts.ompVersion,
			identity: opts.identity,
			hostEntry: opts.hostEntry,
			timing: opts.timing,
			diskLimitBytes: opts.diskLimitBytes,
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
		for (const dir of new Set([opts.root, opts.runLocal]))
			await rm(dir, { recursive: true, force: true }).catch(err => log("warn", "run directory cleanup failed", { dir, error: errorMessage(err) }));
	}
}

/**
 * `runWorkerOnce` as this process's one job: the checkout root at `workerRoot()` and the run-local root under
 * `AGENTBOT_WORKER_RUN_DIR`, with `HOME` and `PI_CODING_AGENT_DIR` pointed into the run-local root before omp loads
 * (spike S2), and SIGTERM wired to the checkpoint-and-stop path (RUN-18). omp's SDK,
 * loaded for the auth store, handles SIGTERM process-wide by running registered cleanups and then exiting, so the worker
 * registers with it: the SIGTERM checkpoint and the cleanup finish before the process exits (within postmortem's 10 s).
 */
export async function runWorkerProcess(opts: Omit<WorkerOptions, "root" | "runLocal" | "signal">): Promise<WorkerOutcome> {
	const root = workerRoot();
	const runLocal = workerRoot(workerRunBaseDir());
	await mkdir(join(runLocal, "home"), { recursive: true, mode: 0o700 });
	await mkdir(join(runLocal, "auth"), { recursive: true, mode: 0o700 });
	process.env.HOME = join(runLocal, "home");
	process.env.PI_CODING_AGENT_DIR = join(runLocal, "auth");
	const sigterm = new AbortController();
	process.once("SIGTERM", () => sigterm.abort());
	const done = runWorkerOnce({ ...opts, root, runLocal, signal: sigterm.signal });
	postmortem.register(
		"agentbot-worker-sigterm",
		async () => {
			sigterm.abort();
			await done.catch(() => {});
		},
		{ exitOnly: true },
	);
	return done;
}

/** `agentbot worker`: one run, then exit 0. */
export async function runWorker(): Promise<never> {
	const env = loadEnv();
	const workerToken = await readTokenFile(env.workerTokenFile, "AGENTBOT_WORKER_TOKEN_FILE");
	await runWorkerProcess({
		orchestratorUrl: env.orchestratorUrl,
		workerToken,
		workerId: process.env.HOSTNAME?.trim() || `${hostname()}-${crypto.randomUUID().slice(0, 8)}`,
		claimTimeoutMs: env.workerClaimTimeoutMs,
		identity: await appIdentity(),
		ompVersion: installedOmpVersion(APP_ROOT),
		diskLimitBytes: env.workerDiskBytes,
	});
	process.exit(0);
}
