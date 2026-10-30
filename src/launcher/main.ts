import { z } from "zod";
import { loadEnv } from "../shared/env";
import { errorMessage, log } from "../shared/log";
import { readTokenFile } from "../shared/tokens";
import { versionInfo } from "../shared/version";
import { ACTIVE_STATES, type ContainerSummary, type EngineInfo, FINISHED_STATES, PodmanClient, ROLE_LABEL, WORKER_ROLE, type WorkerContainerSpec } from "./podman";
import { launcherStatusPath, writeLauncherStatus } from "./status";

/**
 * The launcher (architecture §2.4, LCH-01 to LCH-04; spike S6): starts one worker container per pending run through
 * the rootless Podman API socket, and removes finished worker containers. It holds the scale token only; the worker
 * token reaches workers as a Podman secret named by `AGENTBOT_WORKER_SECRET`.
 */

export const TICK_MS = 2_000;
export const REAP_MS = 60_000;
/** uid and gid of the image's `agentbot` user (OPS-01). */
export const WORKER_UID = 10001;
/** Run-local tmpfs of a worker (`AGENTBOT_WORKER_RUN_DIR` in the image); counts against the memory limit (S6). */
export const WORKER_RUN_DIR = "/run/agentbot";
export const WORKER_RUN_DIR_SIZE = "256m";
/** Where the worker token secret appears in a worker (`/run/secrets/<target>`). */
export const WORKER_TOKEN_TARGET = "worker_token";
/** Most processes and threads in one worker (`--pids-limit`); Podman's own default is 2048. */
export const WORKER_PIDS_LIMIT = 4096;
/** CFS period of the CPU quota, as `podman run --cpus` uses it. */
export const CPU_PERIOD_US = 100_000;
const SECOND_NS = 1_000_000_000;
/** The container health check of a worker: `agentbot health` every 30 s, timeout 5 s, start period 30 s, 3 retries (OBS-01). */
export const WORKER_HEALTHCHECK = { Test: ["CMD", "agentbot", "health"], Interval: 30 * SECOND_NS, Timeout: 5 * SECOND_NS, StartPeriod: 30 * SECOND_NS, Retries: 3 };
/** Time from container start to the worker's first claim attempt, on top of the claim timeout. */
const STARTUP_GRACE_MS = 10_000;
const SCALE_TIMEOUT_MS = 5_000;

const scaleSchema = z.object({ pendingRuns: z.number().int().nonnegative() });

/** How each worker container is created. */
export interface WorkerSettings {
	image: string;
	/** Stack network the workers join; the orchestrator is reachable on it as `orchestratorUrl`. */
	network: string;
	/** Podman secret holding the worker token. */
	secret: string;
	memoryBytes: number;
	/** `AGENTBOT_WORKER_CPUS`: CPU quota in CPUs (fractions allowed). */
	cpus: number;
	diskBytes: number;
	claimTimeoutMs: number;
	orchestratorUrl: string;
}

export interface LauncherOptions {
	podman: PodmanClient;
	/** Orchestrator base URL for `/internal/scale`, without a trailing slash. */
	orchestratorUrl: string;
	scaleToken: string;
	/** `AGENTBOT_WORKER_CAPACITY`: never more worker containers than this at once. */
	capacity: number;
	/** `AGENTBOT_LAUNCHER_ALLOW_ROOTFUL`. */
	allowRootful: boolean;
	worker: WorkerSettings;
	version: string;
	statusPath: string;
	tickMs?: number;
	reapMs?: number;
}

/** The libpod create spec of one worker container (LCH-02, S6). */
export function workerSpec(worker: WorkerSettings, name: string): WorkerContainerSpec {
	return {
		name,
		// The worker's id in the orchestrator is its `HOSTNAME`, so it matches `podman ps`.
		hostname: name,
		image: worker.image,
		entrypoint: ["agentbot"],
		command: ["worker"],
		user: `${WORKER_UID}:${WORKER_UID}`,
		labels: { [ROLE_LABEL]: WORKER_ROLE },
		remove: true,
		// catatonit as PID 1 reaps the orphans of git and the agent host's children (the image has no init of its own).
		init: true,
		netns: { nsmode: "bridge" },
		Networks: { [worker.network]: {} },
		portmappings: [],
		publish_image_ports: false,
		env: {
			AGENTBOT_ORCHESTRATOR_URL: worker.orchestratorUrl,
			AGENTBOT_WORKER_TOKEN_FILE: `/run/secrets/${WORKER_TOKEN_TARGET}`,
			AGENTBOT_WORKER_DISK: String(worker.diskBytes),
			AGENTBOT_WORKER_CLAIM_TIMEOUT: `${worker.claimTimeoutMs}ms`,
		},
		// Swap equal to the limit: no swap (NFR-01). The CPU quota and the process limit keep one run from starving the host (F7).
		resource_limits: {
			memory: { limit: worker.memoryBytes, swap: worker.memoryBytes },
			cpu: { quota: Math.round(worker.cpus * CPU_PERIOD_US), period: CPU_PERIOD_US },
			pids: { limit: WORKER_PIDS_LIMIT },
		},
		// As hardened as the Helm worker: setuid binaries of the base image (su, mount, passwd) gain nothing (F7).
		no_new_privileges: true,
		cap_drop: ["all"],
		healthconfig: WORKER_HEALTHCHECK,
		mounts: [
			{
				destination: WORKER_RUN_DIR,
				type: "tmpfs",
				source: "tmpfs",
				// `U` chowns the tmpfs to the container user; `uid=`/`gid=` options are rejected (S6). Not `noexec`: omp runs tools it downloads there.
				options: ["rw", "nosuid", "nodev", `size=${WORKER_RUN_DIR_SIZE}`, "mode=0700", "U"],
			},
		],
		secrets: [{ source: worker.secret, target: WORKER_TOKEN_TARGET, uid: WORKER_UID, gid: WORKER_UID, mode: 0o400 }],
	};
}

/**
 * How many workers to start now. `pendingRuns` counts unclaimed runs only, so workers that may not have claimed yet
 * (created within `unclaimedMs`) are subtracted from it, and every active worker from the capacity. With only fresh
 * workers this is `min(pendingRuns, capacity) - active`.
 */
export function workersToStart(pendingRuns: number, active: readonly ContainerSummary[], capacity: number, unclaimedMs: number, now: number): number {
	const fresh = active.filter(c => now - Date.parse(c.Created) < unclaimedMs).length;
	return Math.max(0, Math.min(pendingRuns - fresh, capacity - active.length));
}

export class Launcher {
	readonly #opts: LauncherOptions;
	#rootless = false;
	#workers = 0;
	#scaleFailing = false;
	#stopped = false;
	readonly #stop = Promise.withResolvers<void>();
	#loop: Promise<void> | undefined;

	constructor(opts: LauncherOptions) {
		this.#opts = opts;
	}

	/** LCH-01: true only for rootless Podman, or a rootful Podman with the override (logged at every start). */
	async checkEngine(): Promise<boolean> {
		const { podman, allowRootful } = this.#opts;
		let info: EngineInfo;
		try {
			info = await podman.info();
		} catch (err) {
			log("error", "refusing to start: the Podman socket cannot be reached (LCH-01)", { socket: podman.socket, error: errorMessage(err) });
			return false;
		}
		if (info.rootless === true) {
			this.#rootless = true;
			log("info", "Podman engine is rootless", { socket: podman.socket, podmanVersion: info.version });
			return true;
		}
		if (info.rootless === false && allowRootful) {
			log("warn", "the Podman socket is rootful and AGENTBOT_LAUNCHER_ALLOW_ROOTFUL is set: the launcher has root on the host (LCH-01)", {
				socket: podman.socket,
				podmanVersion: info.version,
			});
			return true;
		}
		const reason = info.rootless === false ? "the Podman socket is rootful" : "the socket is not a Podman API socket";
		log("error", `refusing to start: ${reason} (LCH-01)`, { socket: podman.socket, status: info.status });
		return false;
	}

	/** Checks the engine, reaps, then ticks every `tickMs` and reaps every `reapMs`. False when the engine is refused. */
	async start(): Promise<boolean> {
		if (!(await this.checkEngine())) return false;
		this.#writeStatus();
		await this.reap();
		this.#loop = this.#run();
		return true;
	}

	/** Ends the loop after the current tick. Running workers are left alone: they finish their runs. */
	async stop(): Promise<void> {
		this.#stopped = true;
		this.#stop.resolve();
		await this.#loop;
	}

	async #run(): Promise<void> {
		const { tickMs = TICK_MS, reapMs = REAP_MS } = this.#opts;
		let lastReap = Date.now();
		while (!this.#stopped) {
			await this.tick();
			if (Date.now() - lastReap >= reapMs) {
				await this.reap();
				lastReap = Date.now();
			}
			await Promise.race([Bun.sleep(tickMs), this.#stop.promise]);
		}
	}

	/** LCH-02: one scaling step. Never throws; a failure is logged and the next tick retries. */
	async tick(): Promise<void> {
		const { podman, capacity, worker } = this.#opts;
		let active: ContainerSummary[];
		try {
			active = await podman.listWorkers(ACTIVE_STATES);
		} catch (err) {
			log("error", "cannot list worker containers on the Podman socket", { error: errorMessage(err) });
			return;
		}
		this.#workers = active.length;
		this.#writeStatus();
		const pendingRuns = await this.#pendingRuns();
		if (pendingRuns === undefined) return;
		const toStart = workersToStart(pendingRuns, active, capacity, worker.claimTimeoutMs + STARTUP_GRACE_MS, Date.now());
		if (toStart === 0) return;
		log("info", "starting workers", { pendingRuns, active: active.length, capacity, toStart });
		for (let i = 0; i < toStart && !this.#stopped; i++) {
			if (!(await this.#startWorker())) break;
			this.#workers++;
		}
		this.#writeStatus();
	}

	/** LCH-03: removes finished containers labelled `agentbot.role=worker`, and nothing else. Never throws. */
	async reap(): Promise<void> {
		const { podman } = this.#opts;
		let finished: ContainerSummary[];
		try {
			finished = await podman.listWorkers(FINISHED_STATES);
		} catch (err) {
			log("error", "cannot list finished worker containers on the Podman socket", { error: errorMessage(err) });
			return;
		}
		for (const container of finished) {
			if (container.Labels?.[ROLE_LABEL] !== WORKER_ROLE) continue;
			const fields = { container: container.Names?.[0], id: container.Id.slice(0, 12), state: container.State };
			try {
				log("info", "removed finished worker container", { ...fields, status: await podman.remove(container.Id) });
			} catch (err) {
				log("warn", "cannot remove finished worker container", { ...fields, error: errorMessage(err) });
			}
		}
	}

	/** `GET /internal/scale`; undefined (logged once per outage) while the orchestrator cannot answer. */
	async #pendingRuns(): Promise<number | undefined> {
		const { orchestratorUrl, scaleToken } = this.#opts;
		try {
			const res = await fetch(`${orchestratorUrl}/internal/scale`, {
				headers: { authorization: `Bearer ${scaleToken}` },
				signal: AbortSignal.timeout(SCALE_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`GET /internal/scale -> ${res.status}`);
			const { pendingRuns } = scaleSchema.parse(await res.json());
			if (this.#scaleFailing) log("info", "the orchestrator's scale endpoint answers again");
			this.#scaleFailing = false;
			return pendingRuns;
		} catch (err) {
			if (!this.#scaleFailing) log("warn", "cannot read pending runs from the orchestrator; retrying every tick", { error: errorMessage(err) });
			this.#scaleFailing = true;
			return undefined;
		}
	}

	/** Creates and starts one worker container; false when that failed (the tick stops starting more). */
	async #startWorker(): Promise<boolean> {
		const { podman, worker } = this.#opts;
		const name = `agentbot-worker-${crypto.randomUUID().slice(0, 8)}`;
		let id: string;
		try {
			const created = await podman.create(workerSpec(worker, name));
			id = created.id;
			if (created.warnings.length > 0) log("warn", "worker container created with warnings", { container: name, warnings: created.warnings });
		} catch (err) {
			log("error", "cannot create worker container", { container: name, image: worker.image, error: errorMessage(err) });
			return false;
		}
		try {
			const status = await podman.start(id);
			log("info", "worker container started", { container: name, id: id.slice(0, 12), status });
			return true;
		} catch (err) {
			log("error", "cannot start worker container", { container: name, id: id.slice(0, 12), error: errorMessage(err) });
		}
		// A container left in `created` would count against the capacity forever.
		try {
			await podman.remove(id);
		} catch (err) {
			log("warn", "cannot remove worker container that failed to start", { container: name, error: errorMessage(err) });
		}
		return false;
	}

	#writeStatus(): void {
		const { version, capacity, statusPath } = this.#opts;
		writeLauncherStatus(statusPath, { version, rootless: this.#rootless, workers: this.#workers, capacity, socketOkAt: new Date().toISOString() });
	}
}

/** `agentbot launcher` (Podman only): runs until SIGTERM; exits 2 when the socket is refused (LCH-01). */
export async function runLauncher(): Promise<never> {
	const env = loadEnv();
	if (!env.workerNetwork) throw new Error("AGENTBOT_WORKER_NETWORK must be set: the launcher puts workers on that network");
	const image = env.workerImage ?? env.image;
	if (!image) throw new Error("AGENTBOT_IMAGE must be set (or AGENTBOT_WORKER_IMAGE): the launcher starts workers from it");
	const launcher = new Launcher({
		podman: new PodmanClient(env.podmanSocket),
		orchestratorUrl: env.orchestratorUrl,
		scaleToken: await readTokenFile(env.scaleTokenFile, "AGENTBOT_SCALE_TOKEN_FILE"),
		capacity: env.workerCapacity,
		allowRootful: env.launcherAllowRootful,
		worker: {
			image,
			network: env.workerNetwork,
			secret: env.workerSecret,
			memoryBytes: env.workerMemoryBytes,
			cpus: env.workerCpus,
			diskBytes: env.workerDiskBytes,
			claimTimeoutMs: env.workerClaimTimeoutMs,
			orchestratorUrl: env.orchestratorUrl,
		},
		version: (await versionInfo()).agentbot,
		statusPath: launcherStatusPath(),
	});
	log("info", "launcher starting", { socket: env.podmanSocket, image, network: env.workerNetwork, capacity: env.workerCapacity });
	if (!(await launcher.start())) process.exit(2);
	const signal = Promise.withResolvers<void>();
	process.once("SIGTERM", signal.resolve);
	process.once("SIGINT", signal.resolve);
	await signal.promise;
	log("info", "launcher stopping; running workers finish their runs");
	await launcher.stop();
	process.exit(0);
}
