// The real agent host (`src/worker/host/host.ts`, real omp) driven over its IPC protocol the way the worker supervisor
// drives it, against a fake OpenAI-compatible model server. No model is called: the server plays a script of replies
// (text or tool calls, with token usage) and records every request (tool definitions, authorization header).
// The model is declared in the run's `<agentDir>/models.yml` as provider `fake`, model `fake-model`.
import type { Subprocess } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyOmpConfig } from "../../src/shared/ompconfig";
import type { ChildMessage, HostResult, ParentMessage, StartOptions } from "../../src/shared/protocol";
import type { CredentialSnapshot } from "../../src/shared/wire";
import { seedAuthStore } from "../../src/worker/auth";
import { HOST_ENTRY } from "../../src/worker/runner";

export const FAKE_PROVIDER = "fake";
export const FAKE_MODEL = "fake-model";
/** Preload that points `readOomKills` at `$TEST_MEMORY_EVENTS` instead of the cgroup v2 file. */
const FAKE_CGROUP = join(import.meta.dir, "fake-cgroup.ts");
/** Preload that runs the session's 15 s wall-clock check every `$TEST_CLOCK_CHECK_MS` instead. */
const FAST_CLOCK = join(import.meta.dir, "fast-clock.ts");

/** One model reply: assistant text, or tool calls (name + arguments), with the usage the server reports. */
export interface ModelTurn {
	text?: string;
	toolCalls?: { name: string; args: unknown }[];
	usage?: { input: number; output: number };
	/** Delay before answering. */
	delayMs?: number;
}

export interface ModelRequest {
	authorization: string | null;
	/** Names of the tools the request offered the model. */
	tools: string[];
	messages: { role: string; content?: unknown; tool_calls?: unknown }[];
}

export interface FakeModel {
	baseUrl: string;
	requests: ModelRequest[];
	/** Every request that was not a chat completion. */
	other: string[];
	stop(): void;
}

/** Serves `/v1/chat/completions`; `play(n, req)` gives the n-th (0-based) reply. `accept` can refuse a bearer with 401. */
export function startFakeModel(play: (n: number, req: ModelRequest) => ModelTurn, accept: (authorization: string | null) => boolean = () => true): FakeModel {
	const requests: ModelRequest[] = [];
	const other: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async req => {
			const url = new URL(req.url);
			if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				other.push(`${req.method} ${url.pathname}`);
				return new Response("not found", { status: 404 });
			}
			const body = (await req.json()) as { tools?: { function: { name: string } }[]; messages: ModelRequest["messages"] };
			const authorization = req.headers.get("authorization");
			const record: ModelRequest = { authorization, tools: (body.tools ?? []).map(t => t.function.name).sort(), messages: body.messages };
			if (!accept(authorization)) return Response.json({ error: { message: "invalid bearer", type: "authentication_error" } }, { status: 401 });
			const turn = play(requests.length, record);
			requests.push(record);
			if (turn.delayMs) await Bun.sleep(turn.delayMs);
			const base = { id: `fake-${requests.length}`, object: "chat.completion.chunk", created: 0, model: FAKE_MODEL };
			const chunks: unknown[] = [];
			if (turn.text) chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }] });
			for (const [index, call] of (turn.toolCalls ?? []).entries()) {
				chunks.push({
					...base,
					choices: [
						{
							index: 0,
							delta: { role: "assistant", tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] },
							finish_reason: null,
						},
					],
				});
			}
			const usage = turn.usage ?? { input: 1, output: 1 };
			chunks.push({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
			});
			const text = `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
			return new Response(text, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, other, stop: () => server.stop(true) };
}

/** A run's directories, as `makeRunDirs` lays them out. */
export interface HostDirs {
	root: string;
	home: string;
	auth: string;
	tmp: string;
	sessions: string;
	omp: string;
	work: string;
	scratch: string;
}

export async function makeHostDirs(): Promise<HostDirs> {
	const root = await mkdtemp(join(tmpdir(), "agentbot-realhost-"));
	const dirs: HostDirs = {
		root,
		home: join(root, "home"),
		auth: join(root, "auth"),
		tmp: join(root, "tmp"),
		sessions: join(root, "sessions"),
		omp: join(root, "omp"),
		work: join(root, "work"),
		scratch: join(root, "scratch"),
	};
	for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
	await mkdir(join(dirs.scratch, "inputs"), { recursive: true });
	await mkdir(join(dirs.scratch, "outputs"), { recursive: true });
	return dirs;
}

export const removeHostDirs = (dirs: HostDirs) => rm(dirs.root, { recursive: true, force: true });

/**
 * Declares the fake model in `<agentDir>/models.yml`. `costPerMTok` is the price of input and output tokens per
 * million. With `apiKey`, the provider authenticates with it; without, with whatever the auth store holds (OAuth).
 */
export async function writeFakeModels(dirs: HostDirs, model: FakeModel, opts: { costPerMTok?: number; apiKey?: string } = {}): Promise<void> {
	const cost = opts.costPerMTok ?? 0;
	const yaml = [
		"providers:",
		`  ${FAKE_PROVIDER}:`,
		`    baseUrl: ${model.baseUrl}`,
		"    api: openai-completions",
		// Without a key the provider signs in with OAuth: the auth store's sign-in is its credential (CRED-03).
		...(opts.apiKey ? [`    apiKey: ${opts.apiKey}`] : ["    auth: oauth"]),
		"    models:",
		`      - id: ${FAKE_MODEL}`,
		"        name: Fake model",
		"        reasoning: false",
		"        input: [text]",
		"        supportsTools: true",
		`        cost: { input: ${cost}, output: ${cost}, cacheRead: 0, cacheWrite: 0 }`,
		"        contextWindow: 200000",
		"        maxTokens: 4000",
		"",
	].join("\n");
	await writeFile(join(dirs.auth, "models.yml"), yaml);
}

/** Seeds the run-private auth store from a run-spec snapshot, as the supervisor does (CRED-02). */
export const seedCredentials = (dirs: HostDirs, snapshot: CredentialSnapshot[]) => seedAuthStore(dirs.auth, snapshot);

export interface HostRun {
	/** Every message the host sent, in order (logs included). */
	messages: ChildMessage[];
	/** `done` result, or the `failed` message. */
	end: Promise<{ t: "done"; result: HostResult } | { t: "failed"; message: string; name: string } | undefined>;
	send(message: ParentMessage): void;
	proc: Subprocess;
}

export interface HostRunOptions {
	dirs: HostDirs;
	opts: Partial<StartOptions> & Pick<StartOptions, "profile" | "prompt">;
	providerKeys?: Record<string, string>;
	/** Answers `credential_request` (CRED-03); default: refused. */
	credential?(req: Extract<ChildMessage, { t: "credential_request" }>): { accessToken: string; expiresAt: number } | { error: string };
	/** Called for every message the host sends. */
	onMessage?(message: ChildMessage, run: HostRun): void;
	/** `memory.events` file the host reads instead of the cgroup's (AGT-17). */
	memoryEvents?: string;
	/** Interval of the session's wall-clock check instead of 15 s (AGT-14). */
	clockCheckMs?: number;
}

/** Spawns the real agent host for one run and sends `start`; answers `session_file` like the supervisor. */
export function runRealHost(o: HostRunOptions): HostRun {
	const { dirs } = o;
	const messages: ChildMessage[] = [];
	const ended = Promise.withResolvers<Awaited<HostRun["end"]>>();
	const run: HostRun = {
		messages,
		end: ended.promise,
		send: message => run.proc.send(message),
		proc: undefined as never,
	};
	run.proc = Bun.spawn({
		cmd: [
			process.execPath,
			...(o.memoryEvents ? ["--preload", FAKE_CGROUP] : []),
			...(o.clockCheckMs ? ["--preload", FAST_CLOCK] : []),
			HOST_ENTRY,
		],
		cwd: dirs.root,
		env: {
			...process.env,
			HOME: dirs.home,
			PI_CODING_AGENT_DIR: dirs.auth,
			TMPDIR: dirs.tmp,
			// Bun keeps its transpiler cache under HOME, which is fresh per run: share one so omp loads warm.
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? join(tmpdir(), "agentbot-realhost-bun-cache"),
			...(o.memoryEvents ? { TEST_MEMORY_EVENTS: o.memoryEvents } : {}),
			...(o.clockCheckMs ? { TEST_CLOCK_CHECK_MS: String(o.clockCheckMs) } : {}),
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
		serialization: "json",
		ipc: raw => {
			const msg = raw as ChildMessage;
			messages.push(msg);
			if (msg.t === "session_file") run.send({ t: "reply", id: msg.id, ok: true });
			if (msg.t === "credential_request") {
				const answer = o.credential?.(msg) ?? { error: "no credential" };
				run.send("error" in answer ? { t: "reply", id: msg.id, ok: false, error: answer.error } : { t: "reply", id: msg.id, ok: true, value: answer });
			}
			o.onMessage?.(msg, run);
			if (msg.t === "done" || msg.t === "failed") ended.resolve(msg);
		},
		onExit: () => ended.resolve(undefined),
	});
	const cwd = o.opts.profile === "ask" ? dirs.scratch : dirs.work;
	run.send({
		t: "start",
		runtime: { agentDir: dirs.auth, ompDir: dirs.omp, providerKeys: o.providerKeys ?? {} },
		opts: {
			runId: "real-host-run",
			cwd,
			sessionDir: dirs.sessions,
			modelPattern: `${FAKE_PROVIDER}/${FAKE_MODEL}`,
			thinking: "off",
			limits: { minutes: 10, costUsd: 100 },
			omp: emptyOmpConfig(),
			wantLoadout: false,
			...(o.opts.profile === "ask" ? { scratchRoot: dirs.scratch } : {}),
			...o.opts,
		},
	});
	return run;
}
