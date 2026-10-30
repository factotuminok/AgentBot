// Agent host for tests: the real protocol server (`serveAgentHost`) running a scripted fake session instead of omp.
// The script is chosen by `start.opts.prompt` (exact name), or by a `fixture:<name>` marker inside a longer prompt (the
// `/ask` prompts the engine builds around the user's text). No omp code is loaded, so it starts fast.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, log } from "../../src/shared/log";
import type { HostResult, HostRuntime } from "../../src/shared/protocol";
import type { RunUsage } from "../../src/shared/transcript";
import { type CredentialRequester, NoStructuredOutput, serveAgentHost, type SessionOptions } from "../../src/worker/host/serve";
import type { SessionRuntime } from "../../src/worker/host/session";
import { readOomKills } from "../../src/worker/host/oom";

/** What `openRuntime` hands the fixture: the start message's runtime plus the credential requester. */
type FixtureRuntime = HostRuntime & { requestCredential: CredentialRequester };

const usage = (costUsd: number): RunUsage => ({ costUsd, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

/** Writes `<sessionDir>/fixture.jsonl` (so a supervisor can upload it) with an optional script record; returns its path. */
function sessionFile(opts: SessionOptions, record?: FixtureRecord): string {
	mkdirSync(opts.sessionDir, { recursive: true });
	const path = join(opts.sessionDir, "fixture.jsonl");
	writeFileSync(path, [{ type: "session", runId: opts.runId }, ...(record ? [record] : [])].map(r => `${JSON.stringify(r)}\n`).join(""));
	return path;
}

/** A session's record of the script that wrote it, so a resumed run (whose prompt has no marker) plays it again. */
interface FixtureRecord {
	type: "fixture";
	script: string;
	planSeconds: number;
	implementSeconds: number;
}

function recordedScript(resumeFile: string): Partial<FixtureRecord> | undefined {
	try {
		for (const line of readFileSync(resumeFile, "utf8").split("\n")) {
			const record: Partial<FixtureRecord> = line ? JSON.parse(line) : {};
			if (record.type === "fixture" && typeof record.script === "string") return record;
		}
	} catch {}
	return undefined;
}

function result(opts: SessionOptions, extra: Partial<HostResult> = {}, record?: FixtureRecord): HostResult {
	return { sessionFile: sessionFile(opts, record), usage: usage(0.5), oomKills: 0, ...extra };
}

/** `fixture-<name>-seconds:<n>` from the prompt, else `fallback`. */
function promptSeconds(prompt: string, name: string, fallback: number): number {
	const match = new RegExp(`\\bfixture-${name}-seconds:(\\d+)`).exec(prompt);
	return match ? Number(match[1]) : fallback;
}

/** Commits everything in the checkout, uncommitted and untracked files included, with `subject`. */
function commitAll(cwd: string, subject: string): void {
	gitIn(cwd, "add", "-A");
	gitIn(cwd, "commit", "-q", "-m", subject);
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

/** `git <args>` in the run's checkout, isolated from the developer's git config like the worker's own calls. */
function gitIn(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

/** What a code run sees in its checkout: commit subjects newest first, `git status --porcelain` lines, the branch. */
function checkoutState(cwd: string): { log: string[]; status: string[]; branch: string; shallow: string; setupRan: boolean } {
	return {
		log: gitIn(cwd, "log", "--format=%s").split("\n"),
		status: gitIn(cwd, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map(l => l.trim()),
		branch: gitIn(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
		shallow: gitIn(cwd, "rev-parse", "--is-shallow-repository"),
		setupRan: existsSync(join(cwd, ".setup", "ran")),
	};
}

/** Commits `file` with `subject` in the checkout. */
function commitFile(cwd: string, file: string, subject: string): void {
	writeFileSync(join(cwd, file), `${subject}\n`);
	gitIn(cwd, "add", file);
	gitIn(cwd, "commit", "-q", "-m", subject);
}

/**
 * `TEST_HOST_DUMP_DIR` (SEC-01, AGT-02): writes `<dir>/<runId>.json` with everything the run's agent can read from its
 * host: the environment, the start message (runtime and options) and every file in its agent dir (the auth store).
 */
function dumpRun(dir: string, opts: SessionOptions, runtime: FixtureRuntime): void {
	const files: Record<string, string> = {};
	for (const name of readdirSync(runtime.agentDir, { recursive: true, encoding: "utf8" })) {
		const path = join(runtime.agentDir, name);
		if (statSync(path).isFile()) files[name] = readFileSync(path, "latin1");
	}
	const { requestCredential: _rc, ...hostRuntime } = runtime;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${opts.runId}.json`), JSON.stringify({ env: process.env, runtime: hostRuntime, opts, files }));
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
	/**
	 * `fixture:oomSelfKill`: the kernel OOM-kills the agent host. Raises the `oom_kill` counter in the file the worker
	 * reads instead of the cgroup's (`$TEST_MEMORY_EVENTS`, see `fake-cgroup.ts`), then SIGKILLs itself (AGT-05).
	 */
	async oomSelfKill(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const events = process.env.TEST_MEMORY_EVENTS;
		if (!events) throw new Error("oomSelfKill needs TEST_MEMORY_EVENTS");
		writeFileSync(events, `oom 1\noom_kill ${(readOomKills(events) ?? 0) + 1}\n`);
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
	/** A code run: commits `feature.txt`, leaves `notes.txt` uncommitted, reports what it saw (setup marker included). */
	async codeCommit(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const seen = checkoutState(opts.cwd);
		commitFile(opts.cwd, "feature.txt", "Add feature");
		writeFileSync(join(opts.cwd, "notes.txt"), "uncommitted notes\n");
		return result(opts, { output: seen });
	},
	/**
	 * A code run that commits `a.txt`, leaves `wip.txt` uncommitted, reports a progress line, then holds until it is
	 * steered with `finish` or aborted.
	 */
	async codeHeld(opts) {
		await opts.onSessionFile(sessionFile(opts));
		const seen = checkoutState(opts.cwd);
		commitFile(opts.cwd, `a-${opts.runId}.txt`, "Add a");
		writeFileSync(join(opts.cwd, "wip.txt"), "work in progress\n");
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"] | "finish">();
		opts.register({
			steer: async text => {
				if (text.includes("finish")) resolve("finish");
			},
			abort: async reason => resolve(reason),
		});
		opts.onProgress({ tool: "edit", intent: "committed a", usage: usage(0.1), elapsedMs: 5 });
		const outcome = await promise;
		return result(opts, { output: seen, ...(outcome === "finish" ? {} : { aborted: outcome }) });
	},
	/** Reports what the checkout holds, then commits `c.txt` so the run has a result. */
	async inspect(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const seen = checkoutState(opts.cwd);
		commitFile(opts.cwd, "c.txt", "Continue");
		return result(opts, { output: seen });
	},
	/** Fills the checkout past a small disk limit, then waits to be stopped (STO-06). */
	async fillDisk(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		writeFileSync(join(opts.cwd, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 1));
		return await new Promise<HostResult>(() => {});
	},
	/**
	 * Plays whatever the run's output schema asks for, so one `fixture:auto` marker in an issue or request drives every
	 * run of a flow: plans (with a title for `/work plan`), implement (commits a file), revise and fix_ci (commit a file),
	 * chat answers and issue drafts. Resumed runs without a marker land here too.
	 */
	async auto(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const required = new Set(((opts.outputSchema as { required?: string[] } | undefined)?.required ?? []) as string[]);
		const tag = opts.runId.slice(0, 8);
		let output: unknown;
		if (required.has("prTitle")) {
			commitFile(opts.cwd, `feature-${tag}.txt`, "Implement the change");
			output = { prTitle: "Fixture change", prBody: "Made by the fixture agent.", testing: "Nothing to run." };
		} else if (required.has("planMarkdown")) {
			const plan = { summary: "Fixture plan summary.", planMarkdown: "## Plan\n1. Change one file.", complexity: "small" };
			output = required.has("title") ? { title: "Fixture planned change", ...plan } : plan;
		} else if (required.has("summary")) {
			commitFile(opts.cwd, `followup-${tag}.txt`, "Address the follow-up");
			output = { summary: "Addressed by the fixture agent." };
		} else if (required.has("answer")) {
			output = { answer: "Fixture answer." };
		} else if (required.has("title")) {
			output = { title: "Fixture drafted issue", body: "## Summary\nfixture:auto\n\n## Context\n`README.md`\n\n## Acceptance criteria\n- [ ] Done\n\n## Open questions\nNone." };
		}
		opts.onUsage(usage(0.2));
		return result(opts, { output });
	},
	/**
	 * `fixture:slow`: plays what the run's output schema asks for, like `auto`, but takes its time, so that many runs
	 * overlap and a worker can be stopped mid-run (the Kubernetes scenarios, test/e2e/k8s). A plan holds for
	 * `fixture-plan-seconds:<n>` (default 40); an implement run commits `slow-start.txt`, leaves `wip-slow.txt` uncommitted
	 * and holds for `fixture-implement-seconds:<n>` (default 40). The session records the script and its timings, so a
	 * resumed run (whose prompt has no marker) comes back here: finding `wip-slow.txt` restored from the checkpoint, it
	 * commits `resumed.txt` naming both runs, with the restored file, and finishes at once.
	 */
	async slow(opts, runtime) {
		const recorded = opts.resumeFile ? recordedScript(opts.resumeFile) : undefined;
		const record: FixtureRecord = {
			type: "fixture",
			script: "slow",
			planSeconds: recorded?.planSeconds ?? promptSeconds(opts.prompt, "plan", 40),
			implementSeconds: recorded?.implementSeconds ?? promptSeconds(opts.prompt, "implement", 40),
		};
		await opts.onSessionFile(sessionFile(opts, record));
		const stopped = Promise.withResolvers<HostResult["aborted"]>();
		opts.register({ steer: async () => {}, abort: async reason => stopped.resolve(reason) });
		/**
		 * Holds for `seconds` with a progress line, repeated every `fixture-progress-seconds:<n>` when the prompt has it
		 * (activity edits, as a real agent's tool calls make); the abort reason if the run was aborted meanwhile.
		 */
		const progressSeconds = promptSeconds(opts.prompt, "progress", 0);
		const hold = async (seconds: number, intent: string) => {
			let calls = 0;
			const report = () => opts.onProgress({ tool: "bash", intent: calls ? `${intent} (${calls})` : intent, usage: usage(0.1 * ++calls), elapsedMs: 1 });
			report();
			const ticker = progressSeconds > 0 ? setInterval(report, progressSeconds * 1000) : undefined;
			try {
				return await Promise.race([Bun.sleep(seconds * 1000).then(() => undefined), stopped.promise]);
			} finally {
				clearInterval(ticker);
			}
		};
		const required = new Set(((opts.outputSchema as { required?: string[] } | undefined)?.required ?? []) as string[]);
		if (required.has("prTitle")) {
			const wip = join(opts.cwd, "wip-slow.txt");
			const pr = { prTitle: "Fixture slow change", prBody: "Made by the fixture agent.", testing: "Nothing to run." };
			if (existsSync(wip)) {
				const restored = readFileSync(wip, "utf8").trim();
				log("info", "fixture resumed from the checkpoint", { run: opts.runId, restored });
				writeFileSync(join(opts.cwd, "resumed.txt"), `run ${opts.runId} resumed from the checkpoint: ${restored}\n`);
				commitAll(opts.cwd, "Resume from the checkpoint");
				return result(opts, { output: pr }, record);
			}
			commitFile(opts.cwd, "slow-start.txt", "Start the slow change");
			writeFileSync(wip, `written by run ${opts.runId}\n`);
			log("info", "fixture holding", { run: opts.runId, seconds: record.implementSeconds });
			const aborted = await hold(record.implementSeconds, "implementing slowly");
			if (aborted) return result(opts, { aborted }, record);
			commitAll(opts.cwd, "Finish the slow change");
			return result(opts, { output: pr }, record);
		}
		if (required.has("planMarkdown")) {
			const aborted = await hold(record.planSeconds, "planning slowly");
			if (aborted) return result(opts, { aborted }, record);
			const plan = { summary: "Fixture slow plan.", planMarkdown: "## Plan\n1. Change one file, slowly.", complexity: "small" };
			return result(opts, { output: required.has("title") ? { title: "Fixture slow change", ...plan } : plan }, record);
		}
		return scripts.auto!(opts, runtime);
	},
	/**
	 * `fixture:oomHost` (test/e2e/chaos): a plan run whose agent host itself allocates memory until the kernel OOM-kills
	 * it, so the worker reports the run as most likely out of memory (AGT-05, AGT-17). Other runs play `auto`.
	 */
	async oomHost(opts, runtime) {
		const required = new Set(((opts.outputSchema as { required?: string[] } | undefined)?.required ?? []) as string[]);
		if (!required.has("planMarkdown")) return scripts.auto!(opts, runtime);
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onProgress({ tool: "bash", intent: "allocating until OOM-killed", usage: usage(0.1), elapsedMs: 1 });
		const hog: Buffer[] = [];
		for (;;) {
			hog.push(Buffer.alloc(32 * 1024 * 1024, 1));
			await Bun.sleep(20);
		}
	},
	/**
	 * `fixture:oomChild` (test/e2e/chaos): an implement run whose tool subprocess allocates memory until the kernel
	 * OOM-kills it; the run carries on, commits and reports the cgroup's `oom_kill` count (AGT-17, AGT-19), so the PR,
	 * the Discord message and the job result carry the warning. Other runs play `auto`.
	 */
	async oomChild(opts, runtime) {
		const required = new Set(((opts.outputSchema as { required?: string[] } | undefined)?.required ?? []) as string[]);
		if (!required.has("prTitle")) return scripts.auto!(opts, runtime);
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const before = readOomKills();
		const child = Bun.spawn([process.execPath, "-e", "const a = []; for (;;) { a.push(Buffer.alloc(32 * 1024 * 1024, 1)); await Bun.sleep(20); }"], { stdio: ["ignore", "inherit", "inherit"] });
		await child.exited;
		const oomKills = Math.max(0, (readOomKills() ?? 0) - (before ?? 0));
		log("info", "fixture tool process ended", { run: opts.runId, signal: child.signalCode, oomKills });
		opts.onProgress({ tool: "bash", intent: "memory hog ended", usage: usage(0.1), elapsedMs: 1 });
		commitFile(opts.cwd, `feature-${opts.runId.slice(0, 8)}.txt`, "Implement the change");
		return result(opts, { oomKills, output: { prTitle: "Fixture change after an OOM kill", prBody: "Made by the fixture agent.", testing: "The memory hog was OOM-killed." } });
	},
	/** `scripts/dry-run.ts`: asks one question, then yields a plan with the answer and what the checkout holds. */
	async dryRun(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onProgress({ tool: "read", intent: "Reading the issue", usage: usage(0.1), elapsedMs: 5 });
		const answer = await opts.ui.askDialog!([{ id: "scope", question: "Which scope?", options: [{ label: "small" }, { label: "large" }] }]);
		const name = await opts.ui.input("Your name?");
		const choice = answer?.kind === "submit" ? answer.results[0] : undefined;
		opts.onUsage(usage(0.25));
		return result(opts, {
			usage: { costUsd: 0.25, input: 1200, output: 340, cacheRead: 50, cacheWrite: 7 },
			output: {
				summary: `Plan for ${choice?.selectedOptions[0] ?? choice?.customInput} scope by ${name}.`,
				planMarkdown: "## Plan\n1. Change one file.",
				complexity: "small",
				checkout: { ...checkoutState(opts.cwd), commits: Number(gitIn(opts.cwd, "rev-list", "--count", "HEAD")), profile: opts.profile, thinking: opts.thinking, model: opts.modelPattern ?? null },
			},
		});
	},
};

serveAgentHost({
	openRuntime: async (runtime, requestCredential) => ({ ...runtime, requestCredential }) as unknown as SessionRuntime,
	run: (runtime, opts) => {
		const script =
			scripts[opts.prompt] ??
			scripts[/\bfixture:(\w+)/.exec(opts.prompt)?.[1] ?? ""] ??
			(opts.resumeFile ? (scripts[recordedScript(opts.resumeFile)?.script ?? ""] ?? scripts.auto) : undefined);
		if (!script) throw new Error(`no script ${opts.prompt}`);
		const dumpDir = process.env.TEST_HOST_DUMP_DIR;
		if (dumpDir) dumpRun(dumpDir, opts, runtime as unknown as FixtureRuntime);
		return script(opts, runtime as unknown as FixtureRuntime);
	},
});
