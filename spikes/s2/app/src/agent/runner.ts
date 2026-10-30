import { type AuthStorage, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEvent } from "../agentlog";
import { errorMessage, log, writeLogSink } from "../log";
import type { OmpConfig } from "../ompconfig";
import { emptyUsage, type RunUsage } from "../usage";
import type { Loadout } from "./loadout";
import { readOomKills } from "./oom";
import { ompAssetsDir } from "./ompAssets";
import { type ChildMessage, NoStructuredOutput, type ParentMessage, type Reply, type UiMethod } from "./protocol";
import { AGENT_RUN_ENV, killMarkedProcesses } from "./reap";
import type { TodoItem } from "./todos";
import type { HeadlessUI } from "./ui";

/**
 * Main-process side of an agent run. Each run is a separate Bun process (`host.ts` → `session.ts`), so the omp
 * SDK's synchronous work cannot stall the web server's event loop, and a crashed or OOM-killed run fails only
 * itself. Callbacks, the Discord UI, the database and the agent log all stay in this process; the protocol is in
 * `protocol.ts`.
 */

export interface AgentRuntime {
	agentDir: string;
	/** The omp volume: the only extension root sessions load (D-039). */
	ompDir: string;
	/** Provider API keys from DevForge settings; each agent process installs them in memory only. */
	providerKeys: Record<string, string>;
}

/** Locations and keys every run needs; the agent process opens the SDK objects itself. */
export function agentRuntime(dataDir: string, providerKeys: Record<string, string> = {}): AgentRuntime {
	return { agentDir: join(dataDir, "omp-agent"), ompDir: ompAssetsDir(dataDir), providerKeys };
}

/**
 * Opens omp's credential store under `<dataDir>/omp-agent` (OAuth logins persist in its `agent.db`). The main
 * process uses it for the model-account page (D-029); each agent process opens its own handle on the same file.
 */
export async function openAuthStorage(dataDir: string): Promise<AuthStorage> {
	const agentDir = join(dataDir, "omp-agent");
	await mkdir(agentDir, { recursive: true });
	return discoverAuthStorage(agentDir);
}

export interface SessionHandle {
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
}

export type AgentProfile = "plan" | "implement" | "chat" | "draft" | "ask";

export interface RunAgentOptions {
	jobId: string;
	cwd: string;
	sessionDir: string;
	resumeFile?: string;
	profile: AgentProfile;
	modelPattern?: string;
	thinking: string;
	prompt: string;
	outputSchema?: object;
	/** The `create_issue` tool (chat sessions): `file` runs here in the main process and its result goes back to the session. */
	createIssue?: { repo: string; file(title: string, body: string): Promise<{ number: number; url: string }> };
	ui: HeadlessUI;
	limits: { minutes: number; costUsd: number };
	onProgress(p: { tool?: string; intent?: string; usage: RunUsage; elapsedMs: number }): void;
	/** Prompts, steering, assistant text, tool calls/results and the run's end, for the rolling agent log. */
	onTranscript?(event: TranscriptEvent): void;
	/** Called once right after the session is created, before the prompt, so a restart mid-run can resume it. */
	onSessionFile?(path: string): void;
	/** Called once when the run ends, also when it throws or the agent process dies, with what this run consumed. */
	onUsage?(usage: RunUsage): void;
	register(handle: SessionHandle): void;
	/** Admin-managed omp setting overrides and MCP servers (D-025); read fresh for every run. */
	omp?: OmpConfig;
	/** What the session loaded (tools, skills, task agents, MCP servers), reported once after creation (D-026). */
	onLoadout?(loadout: Loadout): void;
	/** The agent's todo list, after every `update_todos` call (complete list, in order). */
	onTodos?(todos: TodoItem[]): void;
}

export interface RunAgentResult {
	output?: unknown;
	sessionFile: string;
	usage: RunUsage;
	aborted?: "time" | "cost" | "user";
	/** Processes the kernel OOM-killed in the container during this run; 0 when detection is unavailable. */
	oomKills: number;
}

/** Entry script of the agent process; resolved from this file so it follows the active app copy (D-049). */
const HOST_ENTRY = join(import.meta.dir, "host.ts");
/** After an abort request, how long the agent process gets to finish before its process group is killed (under the 10 s shutdown deadline). */
export const ABORT_KILL_MS = 5_000;
/** After the agent process reports its result, how long it gets to exit on its own. */
const EXIT_GRACE_MS = 3_000;
/** Bound on waiting for the IPC channel to close after the process exited. */
const DISCONNECT_WAIT_MS = 1_000;

/** Rejection of requests still waiting when the agent process is gone. */
const PROCESS_GONE = new Error("agent process exited");

export interface HostTiming {
	abortKillMs: number;
}

export function runAgent(runtime: AgentRuntime, opts: RunAgentOptions): Promise<RunAgentResult> {
	return runAgentProcess(HOST_ENTRY, runtime, opts, { abortKillMs: ABORT_KILL_MS });
}

/** What the agent process reported, or that it died without reporting. */
type Outcome =
	| { kind: "done"; result: RunAgentResult }
	| { kind: "failed"; message: string; name: string }
	| { kind: "gone"; code: number | null; signal: string | null };

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/** Spawns `entry` as the agent process of one run and bridges its messages to `opts`. Exported so tests can run a fixture host. */
export async function runAgentProcess(entry: string, runtime: AgentRuntime, opts: RunAgentOptions, timing: HostTiming): Promise<RunAgentResult> {
	const oomAtSpawn = readOomKills();
	const oomKillsSince = () => {
		const now = readOomKills();
		return oomAtSpawn === undefined || now === undefined ? 0 : Math.max(0, now - oomAtSpawn);
	};

	let lastUsage = emptyUsage();
	let usageReported = false;
	let runEnded = false;
	let sessionFile: string | undefined;
	let forced = false;
	let exited = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let nextId = 0;
	const pending = new Map<number, { resolve(value: unknown): void; reject(err: unknown): void }>();
	const uiRequests = new Map<number, AbortController>();
	const outcome = Promise.withResolvers<Outcome>();
	const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
	const disconnected = Promise.withResolvers<void>();
	let receivedTerminal = false;

	const guard = (what: string, fn: () => void) => {
		try {
			fn();
		} catch (err) {
			log("warn", `${what} failed`, { job: opts.jobId, error: errorMessage(err) });
		}
	};
	const transcript = (event: TranscriptEvent) => guard("transcript sink", () => opts.onTranscript?.(event));

	const runMarker = crypto.randomUUID();
	const proc = Bun.spawn({
		cmd: [process.execPath, entry],
		// Not the run's cwd: Bun reads bunfig.toml from the working directory, and that is a checkout of the repository under work.
		env: { ...process.env, [AGENT_RUN_ENV]: runMarker },
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		// JSON, not "advanced": a malformed advanced frame becomes a process-global uncaughtException (oven-sh/bun#37287).
		serialization: "json",
		// Own process group: a forced kill takes the agent's tool subprocesses with it.
		detached: true,
		ipc: message => handle(message as ChildMessage),
		onDisconnect: () => disconnected.resolve(),
		onExit: (exitedProc, code) => {
			exited = true;
			const signal = exitedProc.signalCode;
			exit.resolve({ code, signal: signal === null ? null : String(signal) });
		},
	});

	const killGroup = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	};
	const send = (message: ParentMessage) => {
		try {
			proc.send(message);
		} catch (err) {
			log("warn", "agent process send failed", { job: opts.jobId, error: errorMessage(err) });
		}
	};
	const reply = (id: number, result: { ok: true; value?: unknown } | { ok: false; error: string; aborted?: boolean }) => send({ t: "reply", id, ...result });
	const replyFrom = (id: number, promise: Promise<unknown>) =>
		promise.then(
			value => reply(id, { ok: true, value }),
			err => reply(id, { ok: false, error: errorMessage(err), ...(isAbortError(err) ? { aborted: true } : {}) }),
		);

	function request(message: { t: "steer"; text: string } | { t: "abort" }): Promise<unknown> {
		if (exited) return Promise.reject(PROCESS_GONE);
		const id = ++nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		pending.set(id, { resolve, reject });
		send({ ...message, id });
		return promise;
	}

	function callUi(method: UiMethod, args: unknown[], dialog: object): Promise<unknown> {
		const ui = opts.ui;
		const a = args as never[];
		switch (method) {
			case "askDialog":
				return ui.askDialog ? ui.askDialog(a[0], dialog) : Promise.reject(new Error("askDialog unsupported"));
			case "select":
				return ui.select(a[0], a[1], dialog);
			case "input":
				return ui.input(a[0], a[1], dialog);
			case "editor":
				return ui.editor(a[0], a[1], dialog);
			case "confirm":
				return ui.confirm(a[0], a[1], dialog);
			case "notify":
				return Promise.resolve(ui.notify(a[0], a[1]));
		}
	}

	function handle(message: ChildMessage): void {
		switch (message.t) {
			case "progress":
				lastUsage = message.usage;
				guard("progress sink", () => opts.onProgress({ tool: message.tool, intent: message.intent, usage: message.usage, elapsedMs: message.elapsedMs }));
				break;
			case "transcript":
				if (message.event.type === "run_end") runEnded = true;
				transcript(message.event);
				break;
			case "todos":
				guard("todo sink", () => opts.onTodos?.(message.todos));
				break;
			case "loadout":
				guard("loadout sink", () => opts.onLoadout?.(message.loadout));
				break;
			case "usage":
				lastUsage = message.usage;
				usageReported = true;
				guard("usage sink", () => opts.onUsage?.(message.usage));
				break;
			case "session_file":
				sessionFile = message.path;
				try {
					opts.onSessionFile?.(message.path);
					reply(message.id, { ok: true });
				} catch (err) {
					reply(message.id, { ok: false, error: errorMessage(err) });
				}
				break;
			case "registered":
				opts.register({
					steer: async text => void (await request({ t: "steer", text })),
					abort: async () => {
						// Backstop for an agent process that ignores the abort: after this the whole process group is killed.
						killTimer ??= setTimeout(() => {
							forced = true;
							killGroup();
						}, timing.abortKillMs);
						try {
							await request({ t: "abort" });
						} catch (err) {
							if (err !== PROCESS_GONE) throw err;
						}
					},
				});
				break;
			case "ui": {
				if (message.method === "notify") {
					guard("notify", () => void callUi("notify", message.args, {}));
					break;
				}
				const controller = new AbortController();
				uiRequests.set(message.id, controller);
				void replyFrom(
					message.id,
					Promise.resolve()
						.then(() => {
							// ui_cancel can arrive before the call starts.
							controller.signal.throwIfAborted();
							return callUi(message.method, message.args, { ...message.dialog, signal: controller.signal });
						})
						.finally(() => uiRequests.delete(message.id)),
				);
				break;
			}
			case "ui_cancel":
				uiRequests.get(message.id)?.abort();
				break;
			case "tool_call":
				void replyFrom(
					message.id,
					opts.createIssue ? opts.createIssue.file(message.params.title, message.params.body) : Promise.reject(new Error(`Tool ${message.name} is not available`)),
				);
				break;
			case "reply": {
				const waiting = pending.get(message.id);
				pending.delete(message.id);
				if (message.ok) waiting?.resolve(message.value);
				else waiting?.reject(new Error(message.error));
				break;
			}
			case "log":
				writeLogSink(message.line);
				break;
			case "done":
				receivedTerminal = true;
				outcome.resolve({ kind: "done", result: message.result });
				break;
			case "failed":
				receivedTerminal = true;
				outcome.resolve({ kind: "failed", message: message.message, name: message.name });
				break;
		}
	}

	// A process that ended without a result: wait for the channel to drain so a result sent just before exit is not lost.
	void exit.promise.then(async ({ code, signal }) => {
		for (const waiting of pending.values()) waiting.reject(PROCESS_GONE);
		pending.clear();
		await Promise.race([disconnected.promise, Bun.sleep(DISCONNECT_WAIT_MS)]);
		if (!receivedTerminal) outcome.resolve({ kind: "gone", code, signal });
	});

	send({
		t: "start",
		runtime,
		opts: {
			jobId: opts.jobId,
			cwd: opts.cwd,
			sessionDir: opts.sessionDir,
			resumeFile: opts.resumeFile,
			profile: opts.profile,
			modelPattern: opts.modelPattern,
			thinking: opts.thinking,
			prompt: opts.prompt,
			outputSchema: opts.outputSchema,
			limits: opts.limits,
			omp: opts.omp,
			createIssueRepo: opts.createIssue?.repo,
			wantLoadout: !!opts.onLoadout,
		},
	});

	const result = await outcome.promise;
	clearTimeout(killTimer);
	// Nobody is left to answer a question the dead or finished session still has open.
	for (const controller of uiRequests.values()) controller.abort();
	if (result.kind !== "gone") {
		const grace = setTimeout(killGroup, EXIT_GRACE_MS);
		await exit.promise;
		clearTimeout(grace);
	}
	// Whatever the run left running dies with it: its process group, then anything that left the group (`setsid`)
	// but kept the run marker in its environment. Nothing manages those after the agent process is gone.
	killGroup();
	const left = killMarkedProcesses(runMarker);
	if (left.length > 0) log("info", "agent run left processes; killed", { job: opts.jobId, pids: left });

	switch (result.kind) {
		case "done":
			return result.result;
		case "failed":
			throw result.name === "NoStructuredOutput" ? new NoStructuredOutput(opts.jobId) : new Error(result.message);
		case "gone": {
			// The shared teardown above already killed whatever the process left running.
			const oomKills = oomKillsSince();
			const aborted = forced ? ("user" as const) : undefined;
			const reason = result.signal ? `signal ${result.signal}` : `code ${result.code}`;
			const error = aborted
				? undefined
				: result.signal === "SIGKILL" && oomKills > 0
					? `agent process was killed (${reason}); the kernel OOM killer killed ${oomKills} process(es) in this container meanwhile, so it most likely ran out of memory`
					: `agent process exited with ${reason}`;
			// The session could not report these itself.
			if (!usageReported) guard("usage sink", () => opts.onUsage?.(lastUsage));
			if (!runEnded) transcript({ type: "run_end", usage: lastUsage, ...(aborted ? { aborted } : {}), ...(error ? { error } : {}) });
			if (error) throw new Error(error);
			return { sessionFile: sessionFile ?? opts.resumeFile ?? "", usage: lastUsage, oomKills, aborted: "user" };
		}
	}
}
