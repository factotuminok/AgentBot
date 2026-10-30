/**
 * OPS-06, ported from DevForge: one planning run against a local repository, without GitHub or Discord.
 *
 *   bun run dry-run --repo <git repo> --issue <issue.md> [--ref HEAD] [--model <pattern>] [--thinking <level>] [--agent-dir <dir>]
 *
 * Does what a worker does for a plan run (architecture §2.3): makes the run directories, seeds a run-private auth store,
 * makes a shallow checkout of the start commit (RUN-17, so the AGT-13 no-history rule holds), and spawns the agent host
 * with the `plan` profile, prompt and output schema of the engine's plan job. The issue file's first line is the title
 * (a leading `#` is dropped), the rest its body. Sign-ins come from the developer's own omp agent dir (`--agent-dir`,
 * else `PI_CODING_AGENT_DIR`, else `~/.omp/agent`), which also refreshes them for the run like the orchestrator does
 * (CRED-03); provider API keys in the environment reach omp unchanged. Questions are asked on the console, progress goes
 * to stderr, and the plan (JSON) and usage to stdout. The temporary directory is always removed, also on Ctrl-C.
 */
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResultItem,
	ExtensionAskDialogSubmitResult,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { postmortem } from "@oh-my-pi/pi-utils";
import { PLAN_SCHEMA, planPrompt, runPrompt } from "../src/orchestrator/engine/prompts";
import type { GhIssue } from "../src/orchestrator/github/types";
import { openSigninStore, type Signins } from "../src/orchestrator/store/signins";
import { type Config, parseConfig } from "../src/shared/config";
import { gitRun } from "../src/shared/git";
import { errorMessage } from "../src/shared/log";
import { emptyOmpConfig } from "../src/shared/ompconfig";
import type { ChildMessage, HostResult, ParentMessage, Reply, StartOptions } from "../src/shared/protocol";
import { abortError, callUi, type HeadlessUI, headlessUIBase, selectViaAskDialog } from "../src/shared/ui";
import { runBranch } from "../src/shared/wire";
import { seedAuthStore } from "../src/worker/auth";
import { makeCheckout } from "../src/worker/checkout";
import { killMarkedProcesses } from "../src/worker/host/reap";
import { DEFAULT_TIMING, HOST_ENTRY, hostEnv, makeRunDirs } from "../src/worker/runner";

export interface DryRunOptions {
	repo: string;
	/** Markdown or text: the first line is the title, the rest the body. */
	issueFile: string;
	/** The start commit, as any git revision (default `HEAD`). */
	ref?: string;
	model?: string;
	thinking?: string;
	/** The omp agent dir whose sign-ins the run uses. */
	agentDir: string;
	/** Parent of the temporary run directory (default the OS temp dir). */
	tmpDir?: string;
	/** The agent host entry; tests use the fixture host. */
	hostEntry?: string;
	/** Answers to the agent's questions, one per line. */
	input: NodeJS.ReadableStream;
	/** The plan and usage. */
	out: NodeJS.WritableStream;
	/** Questions, progress and warnings. */
	err: NodeJS.WritableStream;
	/** Ctrl-C: the run is aborted (as by a user), then cleaned up. */
	signal?: AbortSignal;
}

/** A problem with the options or the environment, reported without a stack. */
export class DryRunError extends Error {
	override name = "DryRunError";
}

const USAGE =
	"usage: bun run dry-run --repo <git repo> --issue <issue.md> [--ref HEAD] [--model <pattern>] [--thinking <level>] [--agent-dir <omp agent dir>]";

/** The developer's omp agent dir: `PI_CODING_AGENT_DIR`, else `~/.omp/agent`. */
export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

/** The issue file as an issue: first line (without a leading `#`) the title, the rest the body. */
export function issueFromFile(path: string, text: string): GhIssue {
	const lines = text.replace(/^\s+/, "").split("\n");
	const title = (lines[0] ?? "").replace(/^#+\s*/, "").trim();
	if (!title) throw new DryRunError(`--issue ${path}: the file is empty; its first line must be the issue title`);
	return {
		number: 1,
		title,
		body: lines.slice(1).join("\n").trim(),
		state: "open",
		labels: [],
		html_url: `file://${path}`,
		updated_at: new Date().toISOString(),
		author: "dry-run",
		isPullRequest: false,
	};
}

/** Answers read from the console, one per line. */
interface LineReader {
	next(signal?: AbortSignal): Promise<string>;
	close(): void;
}

/** Lines of `input`, queued so an answer typed (or piped) before its question is not lost. */
function lineReader(input: NodeJS.ReadableStream): LineReader {
	let rl: Interface | undefined;
	let closed = false;
	const lines: string[] = [];
	const waiters: { resolve(line: string): void; reject(err: unknown): void }[] = [];
	function open(): void {
		// Not a terminal interface: the TTY stays in cooked mode, so Ctrl-C remains a real SIGINT.
		rl = createInterface({ input, terminal: false });
		rl.on("line", line => {
			const waiter = waiters.shift();
			if (waiter) waiter.resolve(line);
			else lines.push(line);
		});
		rl.on("close", () => {
			closed = true;
			for (const waiter of waiters.splice(0)) waiter.reject(new Error("stdin closed before the question was answered"));
		});
	}
	return {
		next(signal) {
			if (signal?.aborted) return Promise.reject(abortError());
			const queued = lines.shift();
			if (queued !== undefined) return Promise.resolve(queued);
			if (closed) return Promise.reject(new Error("stdin closed before the question was answered"));
			if (!rl) open();
			const { promise, resolve, reject } = Promise.withResolvers<string>();
			const waiter = { resolve, reject };
			waiters.push(waiter);
			signal?.addEventListener(
				"abort",
				() => {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					reject(abortError());
				},
				{ once: true },
			);
			return promise;
		},
		close() {
			rl?.close();
		},
	};
}

/** Questions on the console (DevForge `console-ui.ts`): numbered options, a number or a custom answer per line. */
function consoleUI(reader: LineReader, err: NodeJS.WritableStream): HeadlessUI {
	async function readLine(prompt: string, signal: AbortSignal | undefined): Promise<string> {
		err.write(prompt);
		return (await reader.next(signal)).trim();
	}

	async function askQuestion(q: ExtensionAskDialogQuestion, signal: AbortSignal | undefined): Promise<ExtensionAskDialogResultItem> {
		const labels = q.options.map(o => o.label);
		const lines = ["", ...(q.header ? [`== ${q.header} ==`] : []), q.question];
		q.options.forEach((option, index) => {
			const marker = q.recommended === index ? " (recommended)" : "";
			lines.push(`  ${index + 1}. ${option.label}${marker}${option.description ? ` - ${option.description}` : ""}`);
		});
		lines.push(q.multi ? "Enter numbers separated by commas, or type a custom answer:" : "Enter a number, or type a custom answer:");
		const answer = await readLine(`${lines.join("\n")}\n> `, signal);
		const base = { id: q.id, question: q.question, options: labels, multi: !!q.multi };
		const indices = answer.split(",").map(part => Number(part.trim()));
		if (answer !== "" && indices.every(n => Number.isInteger(n) && n >= 1 && n <= labels.length)) {
			const selected = indices.map(n => labels[n - 1] as string);
			return { ...base, selectedOptions: q.multi ? selected : selected.slice(0, 1) };
		}
		if (answer === "") {
			const fallback = labels[q.recommended ?? 0];
			return { ...base, selectedOptions: fallback === undefined ? [] : [fallback] };
		}
		return { ...base, selectedOptions: [], customInput: answer };
	}

	async function askDialog(questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionAskDialogSubmitResult> {
		const results: ExtensionAskDialogResultItem[] = [];
		for (const q of questions) results.push(await askQuestion(q, dialogOptions?.signal));
		return { kind: "submit", results };
	}

	return {
		...headlessUIBase(),
		askDialog,
		select: (title, options, dialogOptions) => selectViaAskDialog(askDialog, title, options, dialogOptions),
		input: async (title, _placeholder, dialogOptions) => (await readLine(`\n${title}\n> `, dialogOptions?.signal)) || undefined,
		editor: async (title, prefill, dialogOptions) => (await readLine(`\n${title}\n> `, dialogOptions?.signal)) || prefill,
		confirm: async (title, message, dialogOptions) => /^y(es)?$/i.test(await readLine(`\n${title}\n${message}\n[y/N] > `, dialogOptions?.signal)),
		notify: (message, type) => err.write(`${type === "error" ? "error" : type === "warning" ? "warning" : "note"}: ${message}\n`),
	};
}

/** The repository's top level and the start commit `ref` names in it. */
async function resolveStart(repoArg: string, ref: string): Promise<{ repo: string; commit: string }> {
	const path = resolve(repoArg);
	if (!(await stat(path).catch(() => undefined))?.isDirectory()) throw new DryRunError(`--repo ${path}: no such directory`);
	const top = await gitRun(["rev-parse", "--show-toplevel"], { cwd: path });
	if (top.exitCode !== 0) throw new DryRunError(`--repo ${path}: not a git repository`);
	const commit = await gitRun(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: path });
	if (commit.exitCode !== 0) throw new DryRunError(`--ref ${ref}: no such commit in ${top.stdout.trim()}`);
	return { repo: top.stdout.trim(), commit: commit.stdout.trim() };
}

/** Opens the developer's sign-in store and checks that some model can be used with it or with the environment's keys. */
async function openCredentials(agentDir: string, model: string | undefined): Promise<Signins> {
	const signins = await openSigninStore(agentDir);
	try {
		const registry = new ModelRegistry(signins.authStorage, join(agentDir, "models.yml"));
		await registry.refresh("offline");
		const available = registry.getAvailable();
		if (available.length === 0) {
			throw new DryRunError(
				`no model credentials: ${join(agentDir, "agent.db")} has no usable sign-in and no provider API key is set in the environment. Sign in with \`omp\` (or pass --agent-dir), or set a key such as ANTHROPIC_API_KEY.`,
			);
		}
		if (model && !parseModelPattern(model, available).model) {
			const names = available.map(m => `${m.provider}/${m.id}`);
			throw new DryRunError(`--model ${model}: no available model matches; available: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ", …" : ""}`);
		}
		return signins;
	} catch (err) {
		signins.close();
		throw err;
	}
}

function usageLine(result: HostResult): string {
	const { usage } = result;
	const parts = [
		`cost: $${usage.costUsd.toFixed(4)}`,
		`tokens in ${usage.input} / out ${usage.output} / cache read ${usage.cacheRead} / cache write ${usage.cacheWrite}`,
		...(result.oomKills > 0 ? [`OOM kills ${result.oomKills}`] : []),
		...(result.aborted ? [`aborted: ${result.aborted}`] : []),
	];
	return parts.join(" · ");
}

/** Runs the plan; prints the plan and usage to `out`, and returns the host's result. Throws `DryRunError` for bad options. */
export async function dryRun(opts: DryRunOptions): Promise<HostResult> {
	const ref = opts.ref ?? "HEAD";
	const issuePath = resolve(opts.issueFile);
	if (!existsSync(issuePath)) throw new DryRunError(`--issue ${issuePath}: no such file`);
	const issue = issueFromFile(issuePath, await Bun.file(issuePath).text());
	let config: Config;
	try {
		// The engine's defaults for agent name, thinking and limits; --model and --thinking validated like the config.
		config = parseConfig({
			discord: { guildId: "dry-run", allowedUserIds: ["dry-run"] },
			github: { appId: 1 },
			models: { ...(opts.model ? { plan: opts.model } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}) },
		});
	} catch (err) {
		throw new DryRunError(errorMessage(err).replace("Invalid config: models.thinking", "--thinking").replace("Invalid config: models.plan", "--model"));
	}
	const start = await resolveStart(opts.repo, ref);
	const signins = await openCredentials(opts.agentDir, config.models.plan);
	const reader = lineReader(opts.input);
	const ui = consoleUI(reader, opts.err);
	const runId = crypto.randomUUID();
	const marker = crypto.randomUUID();
	const root = await mkdtemp(join(opts.tmpDir ?? tmpdir(), "agentbot-dry-run-"));
	let proc: Subprocess | undefined;
	let exited = false;
	let killTimer: Timer | undefined;
	const killGroup = () => {
		if (!proc || exited) return;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	};
	const onAbort = () => {
		opts.err.write("\ninterrupted: aborting the run…\n");
		send({ t: "abort", id: -1, reason: "user" });
		killTimer ??= setTimeout(killGroup, DEFAULT_TIMING.abortKillMs);
	};
	const send = (msg: ParentMessage) => {
		if (!proc || exited) return;
		try {
			proc.send(msg);
		} catch (err) {
			opts.err.write(`warning: agent host send failed: ${errorMessage(err)}\n`);
		}
	};
	const reply = (id: number, result: { ok: true; value?: unknown } | { ok: false; error: string }) => send({ t: "reply", id, ...result } as Reply);
	try {
		const dirs = await makeRunDirs(root, root, false);
		const credentialIds = await seedAuthStore(dirs.auth, await signins.snapshotForRun());
		// The developer's custom models and providers, which the credentials check above counted.
		const models = join(opts.agentDir, "models.yml");
		if (existsSync(models)) await copyFile(models, join(dirs.auth, "models.yml"));
		const checkout = join(root, "checkout");
		await makeCheckout(
			checkout,
			{
				repo: basename(start.repo),
				startRef: ref,
				startCommit: start.commit,
				branch: runBranch(runId),
				writesCode: false,
				restore: false,
				identity: { name: `${config.agent.name} dry run`, email: "dry-run@agentbot.invalid" },
			},
			{ url: start.repo, env: {} },
		);
		opts.err.write(`dry run: planning "${issue.title}" on ${start.commit.slice(0, 12)} (${ref}) of ${start.repo}\n`);

		const startOpts: StartOptions = {
			runId,
			cwd: checkout,
			sessionDir: dirs.sessions,
			profile: "plan",
			...(config.models.plan ? { modelPattern: config.models.plan } : {}),
			thinking: config.models.thinking,
			prompt: runPrompt(config.agent.name, planPrompt(issue, [])),
			outputSchema: PLAN_SCHEMA,
			limits: { minutes: config.limits.planMinutes, costUsd: config.limits.maxCostUsdPerJob },
			omp: emptyOmpConfig(),
			wantLoadout: false,
		};
		const outcome = Promise.withResolvers<HostResult>();
		const questions = new Map<number, AbortController>();
		const startedAt = Date.now();
		let lastLine = "";
		const fromHost = (msg: ChildMessage) => {
			switch (msg.t) {
				case "progress": {
					// Also sent at each turn end with the last tool, to report cost: print each tool once.
					const line = msg.tool ? `${msg.tool}${msg.intent ? ` — ${msg.intent}` : ""}` : "";
					if (!line || line === lastLine) return;
					lastLine = line;
					opts.err.write(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${line}\n`);
					return;
				}
				case "todos":
					opts.err.write(`${msg.todos.map(todo => `  [${todo.status}] ${todo.content}`).join("\n")}\n`);
					return;
				case "session_file":
					reply(msg.id, { ok: true });
					return;
				case "ui": {
					if (msg.method === "notify") {
						const a = msg.args as never[];
						ui.notify(a[0], a[1]);
						return;
					}
					const controller = new AbortController();
					questions.set(msg.id, controller);
					callUi(ui, msg.method, msg.args, { ...msg.dialog, signal: controller.signal }).then(
						value => {
							if (questions.delete(msg.id)) reply(msg.id, { ok: true, value });
						},
						err => {
							if (questions.delete(msg.id)) reply(msg.id, { ok: false, error: errorMessage(err) });
						},
					);
					return;
				}
				case "ui_cancel":
					questions.get(msg.id)?.abort();
					questions.delete(msg.id);
					return;
				case "tool_call":
					reply(msg.id, { ok: false, error: `${msg.name} is not available in a dry run` });
					return;
				case "credential_request": {
					const credentialId = credentialIds.get(msg.credentialId);
					if (credentialId === undefined) {
						reply(msg.id, { ok: false, error: `revoked: credential ${msg.credentialId} is not part of this run's sign-ins` });
						return;
					}
					void signins
						.handleCredentialRequest({ provider: msg.provider, credentialId, ...(msg.accessToken ? { accessToken: msg.accessToken } : {}) })
						.then(answer =>
							reply(msg.id, answer.ok ? { ok: true, value: { accessToken: answer.accessToken, expiresAt: answer.expiresAt } } : { ok: false, error: answer.error }),
						);
					return;
				}
				case "log": {
					// The host's own log lines, at warning level and up.
					let entry: { level?: string; msg?: string } = {};
					try {
						entry = JSON.parse(msg.line);
					} catch {}
					if (entry.level === "warn" || entry.level === "error") opts.err.write(`${entry.level}: ${msg.line}\n`);
					return;
				}
				case "done":
					outcome.resolve(msg.result);
					return;
				case "failed":
					outcome.reject(new Error(`the agent run failed (${msg.name}): ${msg.message}`));
					return;
			}
		};
		proc = Bun.spawn({
			cmd: [process.execPath, opts.hostEntry ?? HOST_ENTRY],
			cwd: dirs.root,
			env: hostEnv(dirs, marker),
			stdin: "ignore",
			// Its log lines arrive as `log` messages too; stdout stays the plan's.
			stdout: "ignore",
			stderr: "inherit",
			serialization: "json",
			// Own process group: Ctrl-C reaches only this process, which aborts the run; a kill takes the tools with it.
			detached: true,
			ipc: message => fromHost(message as ChildMessage),
			onExit: (_proc, code, signal) => {
				exited = true;
				// A result sent just before the exit is already delivered or follows within the drain wait.
				setTimeout(() => outcome.reject(new Error(`the agent host exited without a result (${signal ? `signal ${signal}` : `code ${code}`})`)), DEFAULT_TIMING.disconnectWaitMs);
			},
		});
		send({ t: "start", runtime: { agentDir: dirs.auth, ompDir: dirs.omp, providerKeys: {} }, opts: startOpts });
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });

		const result = await outcome.promise;
		const changed = await gitRun(["status", "--porcelain"], { cwd: checkout });
		if (changed.stdout.trim()) opts.err.write(`warning: the planning run changed the checkout:\n${changed.stdout}`);
		opts.out.write(`${result.output === undefined ? "(no plan)" : JSON.stringify(result.output, null, 2)}\n${usageLine(result)}\n`);
		return result;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		clearTimeout(killTimer);
		killGroup();
		killMarkedProcesses(marker);
		reader.close();
		signins.close();
		await rm(root, { recursive: true, force: true });
	}
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			options: {
				repo: { type: "string" },
				issue: { type: "string" },
				ref: { type: "string", default: "HEAD" },
				model: { type: "string" },
				thinking: { type: "string" },
				"agent-dir": { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (err) {
		console.error(`dry-run: ${errorMessage(err)}\n${USAGE}`);
		return 2;
	}
	const { values } = parsed;
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (!values.repo || !values.issue) {
		console.error(`dry-run: --repo and --issue are required\n${USAGE}`);
		return 2;
	}
	const interrupt = new AbortController();
	const run = dryRun({
		repo: values.repo,
		issueFile: values.issue,
		ref: values.ref,
		model: values.model,
		thinking: values.thinking,
		agentDir: resolve(values["agent-dir"] ?? defaultAgentDir()),
		input: process.stdin,
		out: process.stdout,
		err: process.stderr,
		signal: interrupt.signal,
	});
	// omp's SDK owns SIGINT and SIGTERM (it runs registered cleanups, then exits): abort the run and clean up first.
	postmortem.register(
		"agentbot-dry-run",
		async () => {
			interrupt.abort();
			await run.catch(() => {});
		},
		{ exitOnly: true },
	);
	try {
		const result = await run;
		return result.aborted ? 130 : 0;
	} catch (err) {
		console.error(`dry-run: ${errorMessage(err)}`);
		return err instanceof DryRunError ? 2 : 1;
	}
}

if (import.meta.main) process.exit(await main());
