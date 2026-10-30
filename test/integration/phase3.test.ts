import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type InternalApi, SCALE_PATH, startInternalApi } from "../../src/orchestrator/api/server";
import type { MsgRef } from "../../src/orchestrator/discord/surface";
import type { RunOwner } from "../../src/orchestrator/dispatch/dispatcher";
import { createWorkerDispatcher, type WorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import { openSignins, type Signins } from "../../src/orchestrator/store/signins";
import { openVault } from "../../src/orchestrator/store/vault";
import { parseSettings } from "../../src/shared/config";
import { setLogSink } from "../../src/shared/log";
import { workerRoot } from "../../src/worker/status";
import { createFakeDiscord, type FakeDiscord, type FakeMessage } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

/**
 * Phase 3 exit (implementation.md §4): `/ask` end to end through the real controller, the real worker dispatcher and
 * internal API, and worker processes (`test/fixtures/worker-process.ts`: `runWorkerOnce` with the fixture agent host)
 * as separate OS processes. Discord and GitHub are the fakes. Covers the happy path with an attached file, an
 * orchestrator restart mid-run, a killed worker, and `/internal/scale`.
 */

const WORKER_TOKEN = "phase3-worker-token";
const SCALE_TOKEN = "phase3-scale-token";
const WORK = "work-channel";
const ASK = "ask-channel";
const ALICE = "u-alice";
const LEASE_MS = 1_500;
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const LOST = "the worker running this was lost (pod evicted or crashed)";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Agent host pids recorded before a test kills their worker (they are no longer its children then). */
const hostPidsOf = new WeakMap<Worker, number[]>();

async function until(cond: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

/** One orchestrator "process": its own db handle, vault, sign-ins, dispatcher, internal API and controller. */
interface Orchestrator {
	db: Db;
	dispatcher: WorkerDispatcher;
	api: InternalApi;
	controller: Controller;
	/** Owners whose run the engine attached to (the dispatcher's `register` hook ran), in order. */
	attached: RunOwner[];
	/** A crash-like stop: sockets closed abruptly, nothing aborted on the worker (RUN-09). */
	stop(): Promise<void>;
}

interface Worker {
	proc: Subprocess<"ignore", "pipe", "pipe">;
	/** `<tmpdir>/agentbot-worker/<pid>`: the worker's run-local root. */
	root: string;
	stdout: Promise<string>;
	exited: Promise<number>;
}

interface Harness {
	stateDir: string;
	discord: FakeDiscord;
	gh: FakeGitHub;
	orch: Orchestrator;
	/** Every orchestrator log line of this test (the in-process components). */
	logs: string[];
	/** Each edit of a bot message as applied: message id → contents after each edit. */
	edits: Map<string, string[]>;
	/** Serves `files` as Discord attachment URLs. */
	attachmentUrl(name: string): string;
	files: Map<string, string>;
	/** Stops the current orchestrator and starts another on the same state, Discord and port. */
	restart(): Promise<void>;
	spawnWorker(): Worker;
}

async function boot(): Promise<Harness> {
	const stateDir = await mkdtemp(join(tmpdir(), "agentbot-phase3-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const logs: string[] = [];
	setLogSink(line => logs.push(line));
	cleanups.push(() => setLogSink(undefined));
	const masterKey = Buffer.from(crypto.randomUUID() + crypto.randomUUID(), "utf8");
	const ompDir = join(stateDir, "omp");
	await ensureOmpAssetsDir(ompDir);

	const gh = startFakeGitHub();
	cleanups.push(() => gh.stop());
	const discord = createFakeDiscord({ guildId: "g1", channels: [{ id: WORK, name: "work" }, { id: ASK, name: "ask" }] });
	// Observation only: what each message said after each edit.
	const edits = new Map<string, string[]>();
	const edit = discord.edit.bind(discord);
	discord.edit = async (ref: MsgRef, msg, priority) => {
		await edit(ref, msg, priority);
		const content = discord.message(ref.messageId)?.content;
		if (content !== undefined) edits.set(ref.messageId, [...(edits.get(ref.messageId) ?? []), content]);
	};

	const files = new Map<string, string>();
	const attachments = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: req => {
			const body = files.get(new URL(req.url).pathname.slice(1));
			return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
		},
	});
	cleanups.push(() => attachments.stop(true));

	const workers: Worker[] = [];
	cleanups.push(async () => {
		for (const w of workers) {
			// The agent host runs in its own process group under the worker; kill both, then the run-local root.
			const children = Bun.spawnSync(["pgrep", "-P", String(w.proc.pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
			w.proc.kill("SIGKILL");
			for (const pid of [...children, ...(hostPidsOf.get(w) ?? [])]) {
				for (const target of [-pid, pid]) {
					try {
						process.kill(target, "SIGKILL");
					} catch {}
				}
			}
			await w.exited;
			await rm(w.root, { recursive: true, force: true });
		}
	});

	let port = 0;
	async function start(writeSettings: boolean): Promise<Orchestrator> {
		const db = openDb(dbPath(stateDir));
		const vault = await openVault(db, masterKey);
		if (writeSettings) {
			await vault.initialize("admin", "correct horse battery");
			vault.writeSettings(
				parseSettings({
					config: {
						discord: { guildId: "g1", allowedUserIds: [ALICE], workChannelId: WORK, askChannelIds: [ASK] },
						github: { appId: gh.appId, pollIntervalSeconds: 60 },
					},
					secrets: { discordToken: "discord-token", githubAppPrivateKey: gh.privateKey },
				}),
			);
		}
		expect(vault.isUnlocked()).toBe(true);
		const settings = () => vault.readSettings();
		const signins: Signins = await openSignins(stateDir);
		const dispatcher = createWorkerDispatcher({
			db,
			stateDir,
			limits: () => {
				const config = settings()?.config;
				if (!config) return undefined;
				const { maxConcurrentJobs, maxChatSessions } = config.limits;
				return { maxConcurrentJobs, maxChatSessions, maxConcurrentRuns: config.workers.maxConcurrentRuns ?? 4 };
			},
			reattachGraceMs: 10_000,
			spec: {
				stateDir,
				ompConfig: () => vault.readOmpConfig(),
				providerKeys: () => settings()?.secrets.providerKeys ?? {},
				credentials: () => signins.snapshotForRun(),
				skillsHash: async () => (await skillsBundle(ompDir)).hash,
			},
			skills: () => skillsBundle(ompDir),
			credentialRequest: req => signins.handleCredentialRequest(req),
			leaseMs: LEASE_MS,
			sweepMs: 50,
		});
		const attached: RunOwner[] = [];
		const runAgent = dispatcher.runAgent.bind(dispatcher);
		dispatcher.runAgent = (req, hooks, signal) =>
			runAgent(req, { ...hooks, register: handle => (attached.push(req.owner), hooks.register?.(handle)) }, signal);
		const api = startInternalApi({
			host: "127.0.0.1",
			port,
			stateDir,
			db,
			version: "0.0.0-test",
			workerCapacity: 4,
			phase: () => controller.status().phase,
			config: () => settings()?.config,
			dispatcher,
			admin: { handle: async () => new Response("admin") },
			workers: dispatcher,
			workerToken: WORKER_TOKEN,
			scaleToken: SCALE_TOKEN,
		});
		port = Number(new URL(api.url).port);
		const controller = createController({
			stateDir,
			db,
			vault,
			agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
			dispatcher,
			connectDiscord: () => discord,
			connectGitHub: ({ appId, privateKey, labels }) => createGitHub({ appId, privateKey, labels, baseUrl: gh.url, throttle: false }),
		});
		await controller.apply();
		expect(controller.status()).toMatchObject({ phase: "running", error: undefined });
		let stopped = false;
		const stop = async () => {
			if (stopped) return;
			stopped = true;
			// main.ts's shutdown order (RUN-09): stop serving workers (connections cut), dispatcher timers, engine; runs keep going.
			await api.stop();
			dispatcher.close();
			await controller.stop();
			signins.close();
			db.close();
		};
		cleanups.push(stop);
		return { db, dispatcher, api, controller, attached, stop };
	}

	const h: Harness = {
		stateDir,
		discord,
		gh,
		orch: await start(true),
		logs,
		edits,
		files,
		attachmentUrl: name => `${attachments.url}${name}`,
		async restart() {
			await h.orch.stop();
			h.orch = await start(false);
		},
		spawnWorker() {
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: { ...process.env, AGENTBOT_ORCHESTRATOR_URL: h.orch.api.url, TEST_WORKER_TOKEN: WORKER_TOKEN },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			// Drained so a chatty worker never blocks on a full pipe.
			const stdout = new Response(proc.stdout).text();
			void new Response(proc.stderr).text();
			const w: Worker = { proc, root: workerRoot(join(tmpdir(), "agentbot-worker"), proc.pid), stdout, exited: proc.exited };
			workers.push(w);
			return w;
		},
	};
	return h;
}

async function ask(h: Harness, prompt: string, files: { name: string; content: string }[] = []): Promise<string> {
	for (const f of files) h.files.set(f.name, f.content);
	const e = await h.discord.emitCommand({
		command: "ask",
		options: { prompt },
		attachments: files.map(f => ({ name: f.name, url: h.attachmentUrl(f.name), size: f.content.length })),
		actor: h.discord.actor(ALICE, { username: "alice" }),
		channelId: ASK,
	});
	const started = e.responses.find(r => r.type === "editReply")?.msg?.content ?? "";
	const threadId = /<#(\d+)>/.exec(started)?.[1];
	if (!threadId) throw new Error(`no thread started: ${JSON.stringify(e.responses)}`);
	return threadId;
}

const statusMessages = (h: Harness, threadId: string) => h.discord.messages(threadId).filter(m => m.content.includes("**Answering**"));
const todoMessage = (h: Harness, threadId: string, item: string) => h.discord.messages(threadId).find(m => m.content.includes(item));
const withFile = (h: Harness, threadId: string, name: string) => h.discord.messages(threadId).filter(m => m.files.some(f => f.name === name));
const said = (h: Harness, threadId: string, text: string) => h.discord.messages(threadId).filter(m => m.content.includes(text));

function fileText(m: FakeMessage, name: string): string {
	const data = m.files.find(f => f.name === name)!.data;
	return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function runOf(h: Harness, threadId: string) {
	return h.orch.db.currentRun("chat_thread_id", threadId);
}

describe("phase 3 exit", () => {
	test("/ask with a file: progress, to-dos, answer.md and the output file; the worker exits 0 and leaves nothing", async () => {
		const h = await boot();
		const threadId = await ask(h, "fixture:chatFile summarise the attached notes", [
			{ name: "notes.txt", content: "Quarterly numbers are up 12%.\nSecond line.\n" },
		]);
		const worker = h.spawnWorker();
		await until(() => said(h, threadId, "✅ **Done.**").length === 1, "the chat to finish");
		expect(await worker.exited).toBe(0);
		expect(await worker.stdout).toContain('{"outcome":"run"}');
		expect(existsSync(worker.root)).toBe(false);
		await h.discord.settled();

		const [status] = statusMessages(h, threadId);
		expect(statusMessages(h, threadId)).toHaveLength(1);
		const history = h.edits.get(status!.id) ?? [];
		expect(history.some(c => c.includes("Starting the agent…") || c.includes("Waiting for a worker…"))).toBe(true);
		expect(history.some(c => c.includes("Posting the answer…"))).toBe(true);
		expect(status!.content).toContain("$0.50");
		expect(status!.content).not.toContain("↳");

		const todos = todoMessage(h, threadId, "Read the input")!;
		expect(todos.edits).toBeGreaterThanOrEqual(1);
		expect(todos.content).toContain("Write the summary");
		expect(h.edits.get(todos.id)!.some(c => /Read the input/.test(c))).toBe(true);

		const answers = withFile(h, threadId, "answer.md");
		expect(answers).toHaveLength(1);
		expect(fileText(answers[0]!, "answer.md")).toContain("Summarised `notes.txt` into `outputs/summary.txt`.");
		const outputs = withFile(h, threadId, "summary.txt");
		expect(outputs).toHaveLength(1);
		expect(fileText(outputs[0]!, "summary.txt")).toBe("notes.txt: Quarterly numbers are up 12%.\n");
		expect(h.discord.message(threadId)?.content).toStartWith("✅");

		const usage = h.orch.db.raw.query<{ cost_usd: number }, [string]>("SELECT cost_usd FROM agent_runs WHERE thread_id = ?").all(threadId);
		expect(usage.map(u => u.cost_usd)).toEqual([0.5]);
		expect(runOf(h, threadId)).toBeNull();
	}, 20_000);

	test("an orchestrator restart mid-run: the worker re-attaches, the same status message keeps editing, one answer (RUN-07 to RUN-09, RUN-14)", async () => {
		const h = await boot();
		const threadId = await ask(h, "fixture:chatHeld hold until told");
		const worker = h.spawnWorker();
		await until(() => !!todoMessage(h, threadId, "Wait to be told to finish"), "the held run's to-do list");
		await h.discord.settled();
		const [status] = statusMessages(h, threadId);
		const editsBefore = status!.edits;
		const runId = runOf(h, threadId)!.id;
		const logsBefore = h.logs.length;

		await h.restart();
		const owner: RunOwner = { kind: "chat", threadId };
		await until(() => h.orch.attached.some(o => o.kind === "chat" && o.threadId === threadId), "the chat to re-attach");
		await until(() => h.logs.slice(logsBefore).some(l => l.includes('"msg":"worker re-attached"') && l.includes(runId)), "the worker to re-announce its lease");
		expect(h.orch.dispatcher.hasUnfinishedRun(owner)).toBe(true);

		const steer = await h.discord.emitMessage({ channelId: threadId, content: "please finish now", actor: h.discord.actor(ALICE, { username: "alice" }) });
		await until(() => said(h, threadId, "✅ **Done.**").length === 1, "the chat to finish after the restart");
		expect(await worker.exited).toBe(0);
		expect(existsSync(worker.root)).toBe(false);
		await h.discord.settled();

		expect(statusMessages(h, threadId).map(m => m.id)).toEqual([status!.id]);
		expect(status!.edits).toBeGreaterThan(editsBefore);
		expect(h.discord.messages(threadId).filter(m => m.content.includes("Wait to be told to finish"))).toHaveLength(1);
		expect(withFile(h, threadId, "answer.md")).toHaveLength(1);
		expect(fileText(withFile(h, threadId, "answer.md")[0]!, "answer.md")).toContain("Held run finished.");
		expect(withFile(h, threadId, "held.txt")).toHaveLength(1);
		expect(said(h, threadId, "✅ **Done.**")).toHaveLength(1);
		expect(h.discord.message(steer.ref!.messageId)?.reactions).toContain("👀");
		expect(h.orch.db.getRun(runId)?.state).toBe("finished");
	}, 25_000);

	test("killing the worker: after the lease expires the chat fails with the worker-lost message (RUN-04, CHAT-05)", async () => {
		const h = await boot();
		const threadId = await ask(h, "fixture:chatHeld hold until killed");
		const worker = h.spawnWorker();
		await until(() => !!todoMessage(h, threadId, "Wait to be told to finish"), "the held run's to-do list");
		const host = Bun.spawnSync(["pgrep", "-P", String(worker.proc.pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
		hostPidsOf.set(worker, host);
		expect(host.length).toBeGreaterThan(0);
		worker.proc.kill("SIGKILL");
		expect(await worker.exited).not.toBe(0);

		await until(() => said(h, threadId, LOST).length === 1, "the worker-lost message", LEASE_MS + 5_000);
		await h.discord.settled();
		const [failed] = said(h, threadId, LOST);
		expect(failed!.content).toBe(`❌ **Failed:** ${LOST}\nSend another message to try again.`);
		expect(statusMessages(h, threadId)).toHaveLength(1);
		expect(h.discord.message(threadId)?.content).toStartWith("❌");
		expect(withFile(h, threadId, "answer.md")).toHaveLength(0);
		expect(h.orch.dispatcher.hasUnfinishedRun({ kind: "chat", threadId })).toBe(false);
		// The orphaned agent host winds down on its own once its worker is gone.
		await until(() => host.every(pid => !alive(pid)), "the orphaned agent host to exit", 7_000);
	}, 25_000);

	test("/internal/scale counts the pending run until a worker claims it (architecture §4.4)", async () => {
		const h = await boot();
		const scale = async (token?: string) => {
			const res = await fetch(`${h.orch.api.url}${SCALE_PATH}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
			return { status: res.status, body: (await res.json()) as unknown };
		};
		expect(await scale()).toEqual({ status: 401, body: { error: "unauthorized" } });
		expect(await scale(SCALE_TOKEN)).toEqual({ status: 200, body: { pendingRuns: 0 } });

		const threadId = await ask(h, "fixture:chatFile one file", [{ name: "a.txt", content: "alpha\n" }]);
		await until(() => runOf(h, threadId)?.state === "pending", "the run to be pending");
		expect(await scale(WORKER_TOKEN)).toMatchObject({ status: 401 });
		expect(await scale(SCALE_TOKEN)).toEqual({ status: 200, body: { pendingRuns: 1 } });

		const worker = h.spawnWorker();
		await until(() => runOf(h, threadId)?.state !== "pending", "a worker to claim the run");
		expect(await scale(SCALE_TOKEN)).toEqual({ status: 200, body: { pendingRuns: 0 } });
		await until(() => said(h, threadId, "✅ **Done.**").length === 1, "the chat to finish");
		expect(await worker.exited).toBe(0);
		expect(await scale(SCALE_TOKEN)).toEqual({ status: 200, body: { pendingRuns: 0 } });
	}, 20_000);
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
