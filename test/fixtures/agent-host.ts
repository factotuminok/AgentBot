// Agent host for tests: the real protocol server (`serveAgentHost`) running a scripted fake session instead of omp.
// The script is chosen by `start.opts.prompt` (exact name), or by a `fixture:<name>` marker inside a longer prompt (the
// `/ask` prompts the engine builds around the user's text). No omp code is loaded, so it starts fast.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, log } from "../../src/shared/log";
import type { HostResult, HostRuntime } from "../../src/shared/protocol";
import type { RunUsage } from "../../src/shared/transcript";
import { type CredentialRequester, NoStructuredOutput, serveAgentHost, type SessionOptions } from "../../src/worker/host/serve";
import type { SessionRuntime } from "../../src/worker/host/session";

/** What `openRuntime` hands the fixture: the start message's runtime plus the credential requester. */
type FixtureRuntime = HostRuntime & { requestCredential: CredentialRequester };

const usage = (costUsd: number): RunUsage => ({ costUsd, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

/** Writes `<sessionDir>/fixture.jsonl` (so a supervisor can upload it) and returns its path. */
function sessionFile(opts: SessionOptions): string {
	mkdirSync(opts.sessionDir, { recursive: true });
	const path = join(opts.sessionDir, "fixture.jsonl");
	writeFileSync(path, `${JSON.stringify({ type: "session", runId: opts.runId })}\n`);
	return path;
}

function result(opts: SessionOptions, extra: Partial<HostResult> = {}): HostResult {
	return { sessionFile: sessionFile(opts), usage: usage(0.5), oomKills: 0, ...extra };
}

/** Starts `sleep 300` once in the agent's process group and once in its own session; reports both pids as a `spawn` tool event. */
function reportLeftovers(opts: SessionOptions): void {
	const pids = [false, true].map(detached => {
		const child = spawn("sleep", ["300"], { stdio: "ignore", detached });
		child.unref();
		return child.pid;
	});
	opts.onTranscript({ type: "tool_start", tool: "spawn", intent: "", args: JSON.stringify(pids) });
}

const scripts: Record<string, (opts: SessionOptions, runtime: FixtureRuntime) => Promise<HostResult>> = {
	async happy(opts, runtime) {
		const file = sessionFile(opts);
		await opts.onSessionFile(file);
		opts.onTranscript({ type: "prompt", text: "the prompt" });
		opts.onLoadout?.({ capturedAt: new Date(0).toISOString(), profile: opts.profile, tools: ["read"], skills: [], agents: [], mcp: [] });
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onProgress({ tool: "read", intent: "reading", usage: usage(0.1), elapsedMs: 5 });
		opts.onTranscript({ type: "tool_start", tool: "read", intent: "reading", args: "{}" });
		opts.onTodos([{ content: "step", status: "in_progress" }]);
		opts.onProgress({ usage: usage(0.4), elapsedMs: 9 });
		if (opts.scratchRoot) {
			mkdirSync(join(opts.scratchRoot, "outputs"), { recursive: true });
			writeFileSync(join(opts.scratchRoot, "outputs", "answer.md"), "fixture answer\n");
		}
		opts.onUsage(usage(0.5));
		opts.onTranscript({ type: "run_end", usage: usage(0.5) });
		const { ui: _ui, onProgress: _p, onTranscript: _t, onTodos: _d, onUsage: _u, onLoadout: _l, onSessionFile: _s, register: _r, createIssue: _c, ...data } = opts;
		const { requestCredential: _rc, ...hostRuntime } = runtime;
		return { sessionFile: file, usage: usage(0.5), oomKills: 2, output: { runtime: hostRuntime, data, hasLoadoutCallback: !!opts.onLoadout } };
	},
	async bigTranscript(opts) {
		opts.onTranscript({ type: "tool_end", tool: "read", isError: false, text: "x".repeat(100_000) });
		return result(opts);
	},
	async ask(opts) {
		const answer = await opts.ui.askDialog!([{ id: "q", question: "Which?", options: [{ label: "a" }, { label: "b" }] }], { timeout: 1234, initialIndex: 1 });
		const confirmed = await opts.ui.confirm("Sure?", "really");
		opts.ui.notify("heads up", "warning");
		return result(opts, { output: { answer, confirmed, pausedMs: opts.ui.pausedMs() } });
	},
	async cancel(opts) {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		try {
			await opts.ui.input("Name?", undefined, { signal: controller.signal });
			return result(opts, { output: "not aborted" });
		} catch (err) {
			return result(opts, { output: { name: err instanceof Error ? err.name : String(err) } });
		}
	},
	async issue(opts) {
		const filed = await opts.createIssue!.file("Title", "Body");
		const failure = await opts.createIssue!.file("boom", "Body").then(
			() => "no error",
			err => errorMessage(err),
		);
		return result(opts, { output: { repo: opts.createIssue!.repo, filed, failure } });
	},
	async credential(opts, runtime) {
		const output = await runtime.requestCredential({ provider: "fixture", credentialId: "1", accessToken: "old" }).then(
			value => ({ value }),
			err => ({ error: errorMessage(err) }),
		);
		return result(opts, { output });
	},
	async steerable(opts) {
		await opts.onSessionFile(sessionFile(opts));
		const steered: string[] = [];
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"]>();
		opts.register({
			steer: async text => {
				steered.push(text);
			},
			abort: async reason => resolve(reason),
		});
		const aborted = await promise;
		return result(opts, { output: steered, aborted });
	},
	/** Registers only after 300 ms, so an abort can arrive first. */
	async lateRegister(opts) {
		await Bun.sleep(300);
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"]>();
		opts.register({ steer: async () => {}, abort: async reason => resolve(reason) });
		return result(opts, { aborted: await promise });
	},
	async exit(opts) {
		opts.onProgress({ usage: usage(0.3), elapsedMs: 1 });
		await Bun.sleep(50);
		process.exit(3);
	},
	async leavesChildren(opts) {
		reportLeftovers(opts);
		return result(opts);
	},
	async leavesChildrenThenExit(opts) {
		reportLeftovers(opts);
		await Bun.sleep(100);
		process.exit(3);
	},
	async askThenExit(opts) {
		void opts.ui.input("Still there?");
		await Bun.sleep(100);
		process.exit(3);
	},
	async selfKill(opts) {
		opts.onProgress({ usage: usage(0.3), elapsedMs: 1 });
		await Bun.sleep(50);
		process.kill(process.pid, "SIGKILL");
		return await new Promise<HostResult>(() => {});
	},
	async hung(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.onProgress({ usage: usage(0.2), elapsedMs: 1 });
		opts.register({ steer: async () => {}, abort: () => new Promise<void>(() => {}) });
		return await new Promise<HostResult>(() => {});
	},
	async noYield(opts) {
		log("info", "fixture log line", { run: opts.runId });
		throw new NoStructuredOutput();
	},
	async failure() {
		throw new Error("model exploded");
	},
	async sessionFileRejected(opts) {
		await opts.onSessionFile(sessionFile(opts));
		return result(opts, { output: "prompted anyway" });
	},
	/** An `/ask` turn: reads the first input, reports progress and to-dos, writes `outputs/summary.txt`, answers. */
	async chatFile(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const scratch = opts.scratchRoot!;
		const input = readdirSync(join(scratch, "inputs"))[0]!;
		opts.onProgress({ tool: "read_file", intent: `Reading ${input}`, usage: usage(0.1), elapsedMs: 5 });
		opts.onTodos([
			{ content: "Read the input", status: "in_progress" },
			{ content: "Write the summary", status: "pending" },
		]);
		const firstLine = readFileSync(join(scratch, "inputs", input), "utf8").split("\n")[0]!;
		await Bun.sleep(100);
		opts.onTodos([
			{ content: "Read the input", status: "completed" },
			{ content: "Write the summary", status: "in_progress" },
		]);
		mkdirSync(join(scratch, "outputs"), { recursive: true });
		writeFileSync(join(scratch, "outputs", "summary.txt"), `${input}: ${firstLine}\n`);
		opts.onProgress({ tool: "write_file", intent: "Writing the summary", usage: usage(0.3), elapsedMs: 9 });
		opts.onUsage(usage(0.5));
		return result(opts, { output: { answer: `Summarised \`${input}\` into \`outputs/summary.txt\`.` } });
	},
	/** An `/ask` turn that holds until it is steered with a message containing `finish`; then writes `outputs/held.txt` and answers. */
	async chatHeld(opts) {
		await opts.onSessionFile(sessionFile(opts));
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"] | "finish">();
		opts.register({
			steer: async text => {
				if (text.includes("finish")) resolve("finish");
			},
			abort: async reason => resolve(reason),
		});
		opts.onProgress({ tool: "read_file", intent: "Holding", usage: usage(0.1), elapsedMs: 5 });
		opts.onTodos([{ content: "Wait to be told to finish", status: "in_progress" }]);
		const outcome = await promise;
		if (outcome !== "finish") return result(opts, { aborted: outcome });
		opts.onTodos([{ content: "Wait to be told to finish", status: "completed" }]);
		mkdirSync(join(opts.scratchRoot!, "outputs"), { recursive: true });
		writeFileSync(join(opts.scratchRoot!, "outputs", "held.txt"), "held\n");
		opts.onUsage(usage(0.5));
		return result(opts, { output: { answer: "Held run finished." } });
	},
};

serveAgentHost({
	openRuntime: async (runtime, requestCredential) => ({ ...runtime, requestCredential }) as unknown as SessionRuntime,
	run: (runtime, opts) => {
		const script = scripts[opts.prompt] ?? scripts[/\bfixture:(\w+)/.exec(opts.prompt)?.[1] ?? ""];
		if (!script) throw new Error(`no script ${opts.prompt}`);
		return script(opts, runtime as unknown as FixtureRuntime);
	},
});
