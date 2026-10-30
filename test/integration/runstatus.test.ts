import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInternalApi } from "../../src/orchestrator/api/server";
import type { RunHooks, RunRequest, RunUi } from "../../src/orchestrator/dispatch/dispatcher";
import { createWorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { createRepos } from "../../src/orchestrator/git/repos";
import { dbPath, openDb } from "../../src/orchestrator/store/db";
import type { Loadout } from "../../src/shared/agent";
import type { ChildMessage } from "../../src/shared/protocol";
import type { RunUsage } from "../../src/shared/transcript";
import { type DownMessage, WORKER_WS_PATH } from "../../src/shared/wire";

/**
 * The status page's view of runs on the real worker dispatcher (§9.3, NFR-06): a scripted WebSocket worker claims an
 * `/ask` run, the claim and the host's `registered` stamp the setup time, and progress and loadout show up live.
 */

const WORKER_TOKEN = "worker-token";
const USAGE: RunUsage = { costUsd: 0.25, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
const LOADOUT: Loadout = { capturedAt: "2026-10-30T00:00:00.000Z", profile: "ask", tools: ["read", "web_search"], skills: [], agents: [], mcp: [] };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A scripted worker: resolves `next(pred)` with the first matching message, waiting for it if needed. */
async function connectWorker(url: string, workerId: string) {
	const options: Bun.WebSocketOptions = { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } };
	const ws = new WebSocket(`${url.replace(/^http/, "ws")}${WORKER_WS_PATH}`, options as unknown as string[]);
	const opened = Promise.withResolvers<void>();
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("error", () => opened.reject(new Error("worker connection failed")), { once: true });
	await opened.promise;
	cleanups.push(() => ws.close());
	const inbox: DownMessage[] = [];
	const waiters: { pred(msg: DownMessage): boolean; resolve(msg: DownMessage): void }[] = [];
	ws.addEventListener("message", event => {
		const msg = JSON.parse(String(event.data)) as DownMessage;
		inbox.push(msg);
		for (const waiter of waiters.splice(0)) {
			if (waiter.pred(msg)) waiter.resolve(msg);
			else waiters.push(waiter);
		}
	});
	const send = (msg: unknown) => ws.send(JSON.stringify(msg));
	const next = (pred: (msg: DownMessage) => boolean): Promise<DownMessage> => {
		const found = inbox.find(pred);
		if (found) return Promise.resolve(found);
		const { promise, resolve } = Promise.withResolvers<DownMessage>();
		waiters.push({ pred, resolve });
		return promise;
	};
	send({ t: "hello", workerId, identity: { version: "0.0.0-test", hash: "h" }, ompVersion: "18.12.1" });
	let seq = 0;
	return {
		next,
		async claim() {
			send({ t: "claim" });
			return (await next(m => m.t === "assign")) as Extract<DownMessage, { t: "assign" }>;
		},
		/** Relays a host message and waits until the orchestrator handled it (its ack). */
		async relay(runId: string, msg: ChildMessage) {
			const mine = ++seq;
			send({ t: "relay", runId, seq: mine, msg });
			await next(m => m.t === "ack" && m.runId === runId && m.seq >= mine);
		},
	};
}

test("a run's claim and agent start give its setup time; the status view shows worker, last tool, usage and loadout", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "agentbot-runstatus-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const db = openDb(dbPath(stateDir));
	const dispatcher = createWorkerDispatcher({
		db,
		stateDir,
		// Every worker here connects from 127.0.0.1 (architecture §6 address binding is tested in dispatch.test.ts).
		bindWorkerAddresses: false,
		limits: () => ({ maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 4 }),
		reattachGraceMs: 2000,
		spec: {
			stateDir,
			ompConfig: () => ({ settings: {}, mcpServers: {} }),
			providerKeys: () => ({}),
			credentials: async () => [],
			skillsHash: async () => "skills-hash",
		},
		skills: async () => ({ hash: "skills-hash", tar: new Uint8Array() }),
		credentialRequest: async () => ({ ok: false, error: "none" }),
		repos: createRepos({ stateDir }),
	});
	const api = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir,
		db,
		version: "0.0.0-test",
		workerCapacity: 4,
		phase: () => "running",
		config: () => undefined,
		dispatcher,
		admin: { handle: async () => new Response("admin") },
		workers: dispatcher,
		workerToken: WORKER_TOKEN,
		scaleToken: "scale-token",
	});
	cleanups.push(async () => {
		dispatcher.close();
		await api.stop();
		db.close();
	});

	db.insertChat("t1", "ask");
	const req: RunRequest = {
		owner: { kind: "chat", threadId: "t1" },
		kind: "ask",
		profile: "ask",
		prompt: "Hello?",
		thinking: "high",
		limits: { minutes: 10, costUsd: 1 },
		session: "chat-t1",
		resume: false,
		threadId: "t1",
	};
	const hooks: RunHooks = { ui: {} as RunUi, register: () => {} };
	const result = dispatcher.runAgent(req, hooks);

	// Pending: its age comes from created_at; nothing claimed yet.
	const [pending] = dispatcher.activeRuns();
	expect(pending).toMatchObject({ kind: "ask", state: "pending", owner: "chat:t1", threadId: "t1", usage: { costUsd: 0 } });
	expect(pending!.claimedAt).toBeUndefined();
	expect(pending!.repo).toBeUndefined();

	const worker = await connectWorker(api.url, "worker-1");
	const assign = await worker.claim();
	if (assign.kind !== "run") throw new Error("expected a run");
	const { runId } = assign;

	// Claimed, setting up: claimed_at is recorded, the setup time isn't known yet.
	const claimedRow = db.getRun(runId)!;
	expect(claimedRow.claimed_at).not.toBeNull();
	expect(claimedRow.started_at).toBeNull();
	const [settingUp] = dispatcher.activeRuns();
	expect(settingUp).toMatchObject({ id: runId, state: "assigned", workerId: "worker-1", claimedAt: claimedRow.claimed_at! });
	expect(settingUp!.setupMs).toBeUndefined();

	// The agent starts: started_at is stamped; the setup time is claim → start.
	await worker.relay(runId, { t: "registered" });
	await worker.relay(runId, { t: "progress", tool: "read", intent: "reading", usage: USAGE, elapsedMs: 1200 });
	await worker.relay(runId, { t: "loadout", loadout: LOADOUT });
	const startedRow = db.getRun(runId)!;
	expect(startedRow.state).toBe("running");
	expect(startedRow.claimed_at).toBe(claimedRow.claimed_at);
	const setupMs = Date.parse(startedRow.started_at!) - Date.parse(startedRow.claimed_at!);
	expect(setupMs).toBeGreaterThanOrEqual(0);
	expect(dispatcher.activeRuns()).toEqual([
		{
			id: runId,
			kind: "ask",
			state: "running",
			owner: "chat:t1",
			threadId: "t1",
			workerId: "worker-1",
			createdAt: startedRow.created_at,
			claimedAt: startedRow.claimed_at!,
			startedAt: startedRow.started_at!,
			setupMs,
			lastTool: "read",
			usage: USAGE,
			loadout: LOADOUT,
		},
	]);

	await worker.relay(runId, { t: "done", result: { output: { answer: "Hi." }, sessionFile: "/run/session.jsonl", usage: USAGE, oomKills: 0 } });
	await result;
	expect(dispatcher.activeRuns()).toEqual([]);
});
