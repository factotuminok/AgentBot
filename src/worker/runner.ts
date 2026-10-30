import type { Subprocess } from "bun";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { errorMessage, log } from "../shared/log";
import type { ChildMessage, HostResult, ParentMessage, Reply, StartOptions } from "../shared/protocol";
import type { RunUsage } from "../shared/transcript";
import { ARTIFACTS, type McpTestSpec, type OrchestratorControl, type RelayDown, type RunSpec, type WorkerPhase } from "../shared/wire";
import { ArtifactClient } from "./artifacts";
import type { Lease, WorkerConnection } from "./connection";
import { readOomKills } from "./host/oom";
import { AGENT_RUN_ENV, killMarkedProcesses } from "./host/reap";

/**
 * Process side of one run on a worker (architecture §2.3, ported from DevForge `runAgentProcess`): prepares the
 * run-local directories and downloads, spawns the agent host as a child process, relays its IPC to the orchestrator
 * and back, enforces the abort and exit timings (AGT-04), uploads the session and ask outputs before relaying the
 * result (RUN-19), and kills whatever the run left running (AGT-06). The caller deletes the run-local root (RUN-20).
 */

/** Entry script of the agent host; resolved from this file so it follows the app copy that runs. */
export const HOST_ENTRY = join(import.meta.dir, "host", "host.ts");

export interface RunTiming {
	heartbeatMs: number;
	/** After an abort is delivered, how long the host gets to report a result before its process group is killed (AGT-04). */
	abortKillMs: number;
	/** After the host reports its result, how long it gets to exit on its own (AGT-04). */
	exitGraceMs: number;
	/** Bound on waiting for the IPC channel to drain after the host exited. */
	disconnectWaitMs: number;
	/** Session checkpoint interval while the host runs (RUN-18, session only for runs that write no code). */
	checkpointMs: number;
	/** How long the worker waits for the orchestrator to acknowledge the end of the run before it cleans up anyway. */
	endAckTimeoutMs: number;
	retryMinMs: number;
	retryMaxMs: number;
}

export const DEFAULT_TIMING: Readonly<RunTiming> = Object.freeze({
	heartbeatMs: 10_000,
	abortKillMs: 5_000,
	exitGraceMs: 3_000,
	disconnectWaitMs: 1_000,
	checkpointMs: 5 * 60_000,
	endAckTimeoutMs: 10 * 60_000,
	retryMinMs: 1_000,
	retryMaxMs: 15_000,
});

/** Run-local directories, all under the worker's root and deleted with it (RUN-20). */
export interface RunDirs {
	root: string;
	/** The host's `HOME`: omp's install id and logs (spike S2). */
	home: string;
	/** The host's `PI_CODING_AGENT_DIR`: the run-private auth store and model cache, mode 0700 (CRED-02). */
	auth: string;
	sessions: string;
	/** The downloaded skills and agents (AGT-24). */
	omp: string;
	tmp: string;
	/** Working directory of runs without a checkout or scratch copy, and of `mcp-test`. */
	work: string;
	/** Ask runs: the scratch copy with `inputs/` and `outputs/` (CHAT-07). */
	scratch?: string;
}

export async function makeRunDirs(root: string, scratch: boolean): Promise<RunDirs> {
	const dirs: RunDirs = {
		root,
		home: join(root, "home"),
		auth: join(root, "auth"),
		sessions: join(root, "sessions"),
		omp: join(root, "omp"),
		tmp: join(root, "tmp"),
		work: join(root, "work"),
		...(scratch ? { scratch: join(root, "scratch") } : {}),
	};
	for (const dir of [dirs.home, dirs.auth, dirs.sessions, dirs.omp, dirs.tmp, dirs.work]) await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dirs.auth, 0o700);
	if (dirs.scratch) {
		await mkdir(join(dirs.scratch, "inputs"), { recursive: true, mode: 0o700 });
		await mkdir(join(dirs.scratch, "outputs"), { recursive: true, mode: 0o700 });
	}
	return dirs;
}

export interface OutputFile {
	/** Upload name: the path relative to `outputs/`, with `/` replaced by `_`. */
	name: string;
	path: string;
}

/** Regular files under `dir`, recursively; symlinks and other entries are skipped (CHAT-10). */
export async function listOutputFiles(dir: string): Promise<OutputFile[]> {
	let entries: { name: string; parentPath: string; isFile(): boolean }[];
	try {
		entries = await readdir(dir, { withFileTypes: true, recursive: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return entries
		.filter(entry => entry.isFile())
		.map(entry => {
			const path = join(entry.parentPath, entry.name);
			return { name: relative(dir, path).split(sep).join("_"), path };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** A cancellable sleep: resolves after `ms`, or at once when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted) {
		resolve();
		return promise;
	}
	const timer = setTimeout(resolve, ms);
	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve();
		},
		{ once: true },
	);
	return promise;
}

const ZERO_USAGE: RunUsage = Object.freeze({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** What the worker's message routing hands to the assignment it is serving. */
export interface ActiveRun {
	onControl(msg: OrchestratorControl): void;
	onRelay(msg: RelayDown["msg"]): Promise<void>;
	onScratchInput(name: string): Promise<void>;
	/** Runs the assignment to its end; never throws. */
	run(): Promise<void>;
	/** SIGTERM (eviction, shutdown): checkpoint, then stop the host and return from `run()` without reporting (RUN-18). */
	terminate(): Promise<void>;
}

export interface SupervisorOptions {
	conn: WorkerConnection;
	lease: Lease;
	orchestratorUrl: string;
	/** Run-local root; the caller deletes it after `run()`. */
	root: string;
	ompVersion: string;
	hostEntry?: string;
	timing?: Partial<RunTiming>;
	onPhase(phase: WorkerPhase): void;
}

/** Shared by runs and `mcp-test`: heartbeats with the phase, and the stop on `lease-invalid` or SIGTERM. */
abstract class Assignment {
	protected readonly opts: SupervisorOptions;
	protected readonly timing: RunTiming;
	protected readonly runId: string;
	/** Aborted when the run stops early (lease invalid, SIGTERM) and when it ends: pending downloads and waits end. */
	protected readonly stop = new AbortController();
	/** Resolves when the run must stop early. */
	protected readonly stopped = Promise.withResolvers<void>();
	protected phase: WorkerPhase = "checkout";

	constructor(opts: SupervisorOptions) {
		this.opts = opts;
		this.timing = { ...DEFAULT_TIMING, ...opts.timing };
		this.runId = opts.lease.runId;
	}

	protected setPhase(phase: WorkerPhase): void {
		// A lifecycle still unwinding after an early stop must not move the phase back from `cleanup`.
		if (this.phase === "cleanup") return;
		this.phase = phase;
		this.opts.onPhase(phase);
	}

	protected heartbeat(): void {
		this.opts.conn.sendIfConnected({ t: "heartbeat", runId: this.runId, token: this.opts.lease.token, phase: this.phase });
	}

	protected stopNow(reason: string): void {
		if (this.stop.signal.aborted) return;
		log("info", "run stopped on the worker", { run: this.runId, reason });
		this.stop.abort(new Error(reason));
		this.stopped.resolve();
	}

	onControl(msg: OrchestratorControl): void {
		if (msg.t === "lease-invalid" && msg.runId === this.runId) this.stopNow("lease invalid");
	}

	async onRelay(_msg: RelayDown["msg"]): Promise<void> {}

	async onScratchInput(_name: string): Promise<void> {}

	async terminate(): Promise<void> {
		this.stopNow("SIGTERM");
	}

	protected abstract lifecycle(): Promise<void>;

	protected cleanup(): void {}

	async run(): Promise<void> {
		this.opts.onPhase(this.phase);
		this.heartbeat();
		const heartbeat = setInterval(() => this.heartbeat(), this.timing.heartbeatMs);
		try {
			await Promise.race([this.lifecycle(), this.stopped.promise]);
		} catch (err) {
			if (!this.stop.signal.aborted) log("error", "run failed on the worker", { run: this.runId, error: errorMessage(err) });
		} finally {
			clearInterval(heartbeat);
			this.setPhase("cleanup");
			if (!this.stop.signal.aborted) this.stop.abort(new Error("run ended"));
			this.cleanup();
		}
	}
}

type HostOutcome = { kind: "result"; msg: Extract<ChildMessage, { t: "done" | "failed" }> } | { kind: "gone"; code: number | null; signal: string | null };

/** One agent run (`assign` kind `run`). */
export class RunSupervisor extends Assignment {
	readonly #spec: RunSpec;
	readonly #artifacts: ArtifactClient;
	readonly #marker = crypto.randomUUID();
	#dirs: RunDirs | undefined;
	/** Resolves with true once the run-local directories and downloads are ready, false when they never will be. */
	readonly #prepared = Promise.withResolvers<boolean>();
	/** Resolves with the host process once spawned, or undefined when it never will be. */
	readonly #host = Promise.withResolvers<Subprocess | undefined>();
	#proc: Subprocess | undefined;
	#hostExited = false;
	#outcome: PromiseWithResolvers<HostOutcome> | undefined;
	#terminal: HostOutcome | undefined;
	#killTimer: ReturnType<typeof setTimeout> | undefined;
	#forced = false;
	#lastUsage: RunUsage = ZERO_USAGE;
	#usageReported = false;
	#runEnded = false;
	#sessionFile: string | undefined;
	#upChain: Promise<void> = Promise.resolve();
	#sessionChain: Promise<unknown> = Promise.resolve();
	/** Local auth-store row id → orchestrator credential id (CRED-03). */
	#credentialIds = new Map<string, string>();
	#credentialSeq = 0;
	/** `credential-request` id → the host's request id. */
	#credentialRequests = new Map<number, number>();

	constructor(opts: SupervisorOptions, spec: RunSpec) {
		super(opts);
		this.#spec = spec;
		this.#artifacts = new ArtifactClient({
			orchestratorUrl: opts.orchestratorUrl,
			runId: opts.lease.runId,
			leaseToken: opts.lease.token,
			signal: this.stop.signal,
			retryMinMs: this.timing.retryMinMs,
			retryMaxMs: this.timing.retryMaxMs,
		});
	}

	override onControl(msg: OrchestratorControl): void {
		if (msg.t === "credential-response" && msg.runId === this.runId) {
			const hostId = this.#credentialRequests.get(msg.requestId);
			if (hostId === undefined) return;
			this.#credentialRequests.delete(msg.requestId);
			this.#reply(hostId, msg.ok ? { ok: true, value: { accessToken: msg.accessToken, expiresAt: msg.expiresAt } } : { ok: false, error: msg.error });
			return;
		}
		super.onControl(msg);
		if (this.stop.signal.aborted) this.#killGroup();
	}

	override async onRelay(msg: RelayDown["msg"]): Promise<void> {
		const proc = await this.#host.promise;
		if (!proc || this.#hostExited) return;
		if (msg.t === "abort" && !this.#terminal) {
			// Backstop for a host that ignores the abort: after this its whole process group is killed (AGT-04).
			this.#killTimer ??= setTimeout(() => {
				this.#forced = true;
				log("warn", "agent host did not stop after abort; killing it", { run: this.runId });
				this.#killGroup();
			}, this.timing.abortKillMs);
		}
		this.#send(msg);
	}

	override async onScratchInput(name: string): Promise<void> {
		if (!(await this.#prepared.promise)) return;
		await this.#downloadInput(name);
	}

	override async terminate(): Promise<void> {
		await this.#checkpoint();
		this.stopNow("SIGTERM");
		this.#killGroup();
	}

	protected override async lifecycle(): Promise<void> {
		const spec = this.#spec;
		if (spec.kind !== "ask" && !spec.checkout) {
			this.#notPrepared();
			await this.#finish({ t: "failed", name: "Error", message: `A ${spec.kind} run needs a repository checkout, and this worker cannot make one yet.` });
			return;
		}
		let start: StartOptions;
		try {
			start = await this.#prepare();
		} catch (err) {
			this.#notPrepared();
			if (this.stop.signal.aborted) throw err;
			log("error", "run preparation failed", { run: this.runId, error: errorMessage(err) });
			await this.#finish({ t: "failed", name: "Error", message: `The worker could not prepare the run: ${errorMessage(err)}` });
			return;
		}
		this.opts.conn.send({ t: "run-info", runId: this.runId, ompVersion: this.opts.ompVersion });
		this.setPhase("running");
		const outcome = await this.#runHost(start);
		if (this.stop.signal.aborted) return;
		this.setPhase("uploading");
		await this.#upChain;
		await this.#uploadSession();
		await this.#uploadOutputs();
		if (outcome.kind === "result") {
			await this.#finish(outcome.msg);
			return;
		}
		const oomKills = this.#oomKillsSince();
		if (this.#forced) {
			// Killed after an ignored abort: the run ends as aborted by the user (AGT-04).
			this.#reportEnd("user");
			await this.#finish({ t: "done", result: { sessionFile: this.#sessionFile ?? start.resumeFile ?? "", usage: this.#lastUsage, aborted: "user", oomKills } });
			return;
		}
		const reason = outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`;
		const error =
			outcome.signal === "SIGKILL" && oomKills > 0
				? `agent process was killed (${reason}); the kernel OOM killer killed ${oomKills} process(es) in this container meanwhile, so it most likely ran out of memory`
				: `agent process exited with ${reason}`;
		log("warn", "agent host exited without a result", { run: this.runId, code: outcome.code, signal: outcome.signal, oomKills });
		this.#reportEnd(undefined, error);
		this.opts.conn.send({ t: "gone", runId: this.runId, exitCode: outcome.code, signal: outcome.signal, oomKills });
		// The orchestrator answers `gone` with `lease-invalid`.
		await delay(this.timing.endAckTimeoutMs, this.stop.signal);
	}

	protected override cleanup(): void {
		this.#notPrepared();
		clearTimeout(this.#killTimer);
		for (const hostId of this.#credentialRequests.values()) this.#reply(hostId, { ok: false, error: "the run ended" });
		this.#credentialRequests.clear();
		// Whatever the run left running dies with it: its process group, then anything that left the group (`setsid`)
		// but kept the run marker in its environment (AGT-06).
		if (this.#proc) this.#killGroup();
		const left = killMarkedProcesses(this.#marker);
		if (left.length > 0) log("info", "agent run left processes; killed", { run: this.runId, pids: left });
	}

	#notPrepared(): void {
		this.#prepared.resolve(false);
		this.#host.resolve(undefined);
	}

	async #prepare(): Promise<StartOptions> {
		const spec = this.#spec;
		const dirs = await makeRunDirs(this.opts.root, spec.kind === "ask");
		this.#dirs = dirs;
		// Dynamic: omp captures `PI_CODING_AGENT_DIR` and `HOME` when it loads, and `runWorker` sets them to run-local paths first.
		const { seedAuthStore } = await import("./auth");
		this.#credentialIds = await seedAuthStore(dirs.auth, spec.credentials);
		const skills = await this.#artifacts.bytes(ARTIFACTS.skills);
		if (skills && skills.byteLength > 0) await new Bun.Archive(skills).extract(dirs.omp);
		let resumeFile: string | undefined;
		if (spec.resumeSession) {
			const path = join(dirs.sessions, "resume.jsonl");
			if (await this.#artifacts.download(ARTIFACTS.session, path)) resumeFile = path;
			else log("warn", "session to resume not found; starting a new one", { run: this.runId });
		}
		for (const name of spec.scratch?.inputs ?? []) await this.#downloadInput(name);
		this.#prepared.resolve(true);
		const cwd = dirs.scratch ?? dirs.work;
		return {
			runId: this.runId,
			cwd,
			sessionDir: dirs.sessions,
			...(resumeFile ? { resumeFile } : {}),
			profile: spec.profile,
			...(spec.model ? { modelPattern: spec.model } : {}),
			thinking: spec.thinking,
			prompt: spec.prompt,
			...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
			limits: spec.limits,
			omp: spec.omp,
			...(spec.createIssueRepo ? { createIssueRepo: spec.createIssueRepo } : {}),
			wantLoadout: true,
			...(dirs.scratch ? { scratchRoot: dirs.scratch } : {}),
		};
	}

	async #downloadInput(name: string): Promise<void> {
		const scratch = this.#dirs?.scratch;
		if (!scratch) return;
		if (basename(name) !== name || name === "." || name === ".." || name === "") {
			log("warn", "scratch input with an unsafe name skipped", { run: this.runId, name });
			return;
		}
		if (!(await this.#artifacts.download(ARTIFACTS.scratchInput(name), join(scratch, "inputs", name)))) {
			log("warn", "scratch input not found", { run: this.runId, name });
		}
	}

	#oomAtSpawn: number | undefined;

	#oomKillsSince(): number {
		const now = readOomKills();
		return this.#oomAtSpawn === undefined || now === undefined ? 0 : Math.max(0, now - this.#oomAtSpawn);
	}

	async #runHost(start: StartOptions): Promise<HostOutcome> {
		const dirs = this.#dirs!;
		const outcome = Promise.withResolvers<HostOutcome>();
		this.#outcome = outcome;
		const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
		const disconnected = Promise.withResolvers<void>();
		this.#oomAtSpawn = readOomKills();
		const proc = Bun.spawn({
			cmd: [process.execPath, this.opts.hostEntry ?? HOST_ENTRY],
			cwd: dirs.root,
			// omp writes under HOME and PI_CODING_AGENT_DIR; both must be run-local before omp loads (spike S2).
			env: { ...process.env, HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.auth, TMPDIR: dirs.tmp, [AGENT_RUN_ENV]: this.#marker },
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			// JSON, not "advanced": a malformed advanced frame becomes a process-global uncaughtException (oven-sh/bun#37287).
			serialization: "json",
			// Own process group: a forced kill takes the agent's tool subprocesses with it.
			detached: true,
			ipc: message => this.#fromHost(message as ChildMessage),
			onDisconnect: () => disconnected.resolve(),
			onExit: (exited, code) => exit.resolve({ code, signal: exited.signalCode === null ? null : String(exited.signalCode) }),
		});
		this.#proc = proc;
		log("info", "agent host started", { run: this.runId, pid: proc.pid });
		this.#send({ t: "start", runtime: { agentDir: dirs.auth, ompDir: dirs.omp, providerKeys: this.#spec.providerKeys }, opts: start });
		this.#host.resolve(proc);
		const checkpoints = setInterval(() => void this.#checkpoint(), this.timing.checkpointMs);
		// A host that ended without a result: wait for the channel to drain so a result sent just before exit is not lost.
		void exit.promise.then(async ({ code, signal }) => {
			this.#hostExited = true;
			await Promise.race([disconnected.promise, Bun.sleep(this.timing.disconnectWaitMs)]);
			outcome.resolve({ kind: "gone", code, signal });
		});
		try {
			const result = await outcome.promise;
			clearTimeout(this.#killTimer);
			if (result.kind === "result") {
				const grace = setTimeout(() => this.#killGroup(), this.timing.exitGraceMs);
				await Promise.race([exit.promise, this.stopped.promise]);
				clearTimeout(grace);
			}
			return result;
		} finally {
			clearInterval(checkpoints);
		}
	}

	#fromHost(msg: ChildMessage): void {
		switch (msg.t) {
			case "credential_request":
				this.#credentialRequest(msg);
				return;
			case "done":
			case "failed":
				this.#terminal ??= { kind: "result", msg };
				this.#outcome?.resolve(this.#terminal);
				return;
			case "progress":
				this.#lastUsage = msg.usage;
				break;
			case "usage":
				this.#lastUsage = msg.usage;
				this.#usageReported = true;
				break;
			case "transcript":
				if (msg.event.type === "run_end") this.#runEnded = true;
				break;
			case "session_file":
				this.#sessionFile = msg.path;
				// The file is uploaded before the host's report is relayed, so the session the orchestrator records exists (RUN-18).
				this.#up(async () => {
					await this.#uploadSession();
					this.#relay(msg);
				});
				return;
		}
		this.#up(async () => this.#relay(msg));
	}

	#up(task: () => Promise<void>): void {
		this.#upChain = this.#upChain.then(task).catch(err => {
			if (!this.stop.signal.aborted) log("warn", "relaying a host message failed", { run: this.runId, error: errorMessage(err) });
		});
	}

	#relay(msg: ChildMessage): void {
		const seq = this.opts.conn.relay(msg);
		if (seq === undefined && (msg.t === "ui" || msg.t === "tool_call")) this.#reply(msg.id, { ok: false, error: "The request is larger than 4 MiB and cannot be relayed." });
	}

	/** The host's `run_end` transcript and final usage, when it died before reporting them itself. */
	#reportEnd(aborted: "user" | undefined, error?: string): void {
		if (!this.#usageReported) this.#relay({ t: "usage", usage: this.#lastUsage });
		if (!this.#runEnded) this.#relay({ t: "transcript", event: { type: "run_end", usage: this.#lastUsage, ...(aborted ? { aborted } : {}), ...(error ? { error } : {}) } });
	}

	#credentialRequest(msg: Extract<ChildMessage, { t: "credential_request" }>): void {
		const credentialId = this.#credentialIds.get(msg.credentialId);
		if (credentialId === undefined) {
			// "revoked" makes omp disable the row instead of retrying it (spike S1).
			this.#reply(msg.id, { ok: false, error: `revoked: credential ${msg.credentialId} is not part of this run's sign-ins` });
			return;
		}
		const requestId = ++this.#credentialSeq;
		this.#credentialRequests.set(requestId, msg.id);
		this.opts.conn.send({
			t: "credential-request",
			runId: this.runId,
			requestId,
			provider: msg.provider,
			credentialId,
			...(msg.accessToken ? { accessToken: msg.accessToken } : {}),
		});
	}

	#send(msg: ParentMessage): void {
		const proc = this.#proc;
		if (!proc || this.#hostExited) return;
		try {
			proc.send(msg);
		} catch (err) {
			log("warn", "agent host send failed", { run: this.runId, error: errorMessage(err) });
		}
	}

	#reply(id: number, result: { ok: true; value?: unknown } | { ok: false; error: string }): void {
		this.#send({ t: "reply", id, ...result } as Reply);
	}

	#killGroup(): void {
		const proc = this.#proc;
		if (!proc) return;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}

	/** Uploads the current session file, one upload at a time. Returns whether it went up. */
	#uploadSession(): Promise<boolean> {
		const next = this.#sessionChain.then(async () => {
			const path = this.#sessionFile;
			if (!path || !(await Bun.file(path).exists())) return false;
			try {
				await this.#artifacts.upload(ARTIFACTS.session, path);
				return true;
			} catch (err) {
				if (!this.stop.signal.aborted) log("warn", "session upload failed", { run: this.runId, error: errorMessage(err) });
				return false;
			}
		});
		this.#sessionChain = next;
		return next;
	}

	/** RUN-18 for runs that write no code: the session file every few minutes and at SIGTERM. */
	async #checkpoint(): Promise<void> {
		if (this.stop.signal.aborted || !this.#sessionFile) return;
		if (await this.#uploadSession()) this.opts.conn.send({ t: "checkpoint", runId: this.runId });
	}

	/** Ask runs: every regular file in `outputs/` (the copy starts empty, so all are new or changed, RUN-19). */
	async #uploadOutputs(): Promise<void> {
		const scratch = this.#dirs?.scratch;
		if (!scratch) return;
		for (const file of await listOutputFiles(join(scratch, "outputs"))) {
			try {
				await this.#artifacts.upload(ARTIFACTS.scratchOutput(file.name), file.path);
			} catch (err) {
				if (this.stop.signal.aborted) throw err;
				log("warn", "scratch output upload failed", { run: this.runId, name: file.name, error: errorMessage(err) });
			}
		}
	}

	/** Relays the result after everything before it, then waits for the orchestrator's ack (RUN-19, RUN-20). */
	async #finish(msg: Extract<ChildMessage, { t: "done" | "failed" }>): Promise<void> {
		await this.#upChain;
		const conn = this.opts.conn;
		const seq = conn.relay(msg) ?? conn.relay({ t: "failed", name: "Error", message: "The run's result is larger than 4 MiB and could not be reported." });
		if (seq === undefined) return;
		await Promise.race([conn.waitAck(seq), delay(this.timing.endAckTimeoutMs, this.stop.signal)]);
	}
}

/** `assign` kind `mcp-test` (AGT-21): connect one MCP server with this worker's omp, list its tools, report. */
export class McpTestRun extends Assignment {
	readonly #spec: McpTestSpec;

	constructor(opts: SupervisorOptions, spec: McpTestSpec) {
		super(opts);
		this.#spec = spec;
	}

	protected override async lifecycle(): Promise<void> {
		const dirs = await makeRunDirs(this.opts.root, false);
		this.setPhase("running");
		const { name, server, timeoutMs } = this.#spec;
		// Dynamic for the same reason as `seedAuthStore`: omp loads only after the run-local environment is set.
		const { testMcpServer } = await import("../shared/ompconfig");
		const timedOut = delay(timeoutMs + 1_000, this.stop.signal).then(() => ({ ok: false, tools: [] as string[], error: `No answer within ${timeoutMs} ms` }));
		const result = await Promise.race([testMcpServer(name, server, dirs.work, timeoutMs), timedOut]);
		this.setPhase("uploading");
		this.opts.conn.send({ t: "mcp-test-result", runId: this.runId, ok: result.ok, tools: result.tools, ...(result.error ? { error: result.error } : {}) });
		// The orchestrator answers the result with `lease-invalid`.
		await delay(this.timing.endAckTimeoutMs, this.stop.signal);
	}
}
