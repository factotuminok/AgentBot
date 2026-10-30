import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildMessage } from "../../src/shared/protocol";
import { emptyOmpConfig } from "../../src/shared/ompconfig";
import { LOG_LINE_LIMIT } from "../../src/shared/transcript";
import { type DownMessage, type RelayUp, type RunSpec, type UpMessage, WORKER_WS_PATH, type WorkerControl } from "../../src/shared/wire";
import { limitChildMessage, type OutboxEntry, RelayOutbox } from "../../src/worker/connection";
import { runWorkerHealth } from "../../src/worker/health";
import { runWorkerOnce, type WorkerOptions, type WorkerOutcome } from "../../src/worker/main";
import { listOutputFiles } from "../../src/worker/runner";
import { StatusFile, workerRoot } from "../../src/worker/status";

const WORKER_TOKEN = "worker-token-for-tests";
const LEASE = "lease-token-for-tests";
const RUN_ID = "run-1";
const FIXTURE_HOST = join(import.meta.dir, "..", "fixtures", "agent-host.ts");
const ECHO_MCP = join(import.meta.dir, "..", "fixtures", "echo-mcp.ts");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await Bun.sleep(10);
	}
}

/** Stub orchestrator: the worker WebSocket and the run artifact routes, with programmable answers. */
class StubOrchestrator {
	readonly server: ReturnType<typeof Bun.serve>;
	socket: ServerWebSocket<unknown> | undefined;
	/** Every message received, in order. */
	readonly received: UpMessage[] = [];
	/** Relay messages by first receipt; resends counted in `duplicates`. */
	readonly relays: RelayUp[] = [];
	readonly duplicates: number[] = [];
	/** Ordered log of artifact uploads and relayed message types, to check upload-before-relay ordering. */
	readonly events: string[] = [];
	readonly uploads = new Map<string, string>();
	readonly files = new Map<string, Blob | string>();
	connections = 0;
	autoAck = true;
	/** What `claim` gets. */
	assignment: DownMessage | undefined;
	/** The orchestrator's next relay seq down. */
	downSeq = 0;
	onMessage: ((msg: UpMessage) => void) | undefined;

	constructor() {
		const stub = this;
		this.server = Bun.serve({
			port: 0,
			async fetch(req, server) {
				const url = new URL(req.url);
				if (url.pathname === WORKER_WS_PATH) {
					if (req.headers.get("authorization") !== `Bearer ${WORKER_TOKEN}`) return new Response("unauthorized", { status: 401 });
					return server.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
				}
				const match = /^\/internal\/runs\/([^/]+)\/(.+)$/.exec(url.pathname);
				if (!match) return new Response("not found", { status: 404 });
				if (req.headers.get("authorization") !== `Bearer ${LEASE}`) return new Response("bad lease", { status: 401 });
				const artifact = decodeURIComponent(match[2]!);
				if (req.method === "PUT") {
					stub.uploads.set(artifact, await req.text());
					stub.events.push(`put ${artifact}`);
					return new Response(null, { status: 204 });
				}
				const file = stub.files.get(artifact);
				return file === undefined ? new Response("not found", { status: 404 }) : new Response(file);
			},
			websocket: {
				open(ws) {
					stub.socket = ws;
					stub.connections++;
				},
				message(ws, data) {
					if (stub.socket !== ws) return;
					stub.#handle(JSON.parse(String(data)) as UpMessage);
				},
				close(ws) {
					if (stub.socket === ws) stub.socket = undefined;
				},
			},
		});
		cleanups.push(() => this.server.stop(true));
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	send(msg: DownMessage): void {
		this.socket?.send(JSON.stringify(msg));
	}

	/** Relays a message down with the next seq. */
	relayDown(msg: Extract<DownMessage, { t: "relay" }>["msg"]): number {
		const seq = ++this.downSeq;
		this.send({ t: "relay", runId: RUN_ID, seq, msg });
		return seq;
	}

	dropConnection(): void {
		this.socket?.close(1011, "test drop");
		this.socket = undefined;
	}

	acks(): Extract<UpMessage, { t: "ack" }>[] {
		return this.received.filter((m): m is Extract<UpMessage, { t: "ack" }> => m.t === "ack");
	}

	controls<T extends WorkerControl["t"]>(t: T): Extract<WorkerControl, { t: T }>[] {
		return this.received.filter((m): m is Extract<WorkerControl, { t: T }> => m.t === t);
	}

	relayed<T extends ChildMessage["t"]>(t: T): Extract<ChildMessage, { t: T }>[] {
		return this.relays.map(r => r.msg).filter((m): m is Extract<ChildMessage, { t: T }> => m.t === t);
	}

	#handle(msg: UpMessage): void {
		this.received.push(msg);
		switch (msg.t) {
			case "claim":
				if (this.assignment) this.send(this.assignment);
				break;
			case "relay": {
				if (this.relays.some(r => r.seq === msg.seq)) this.duplicates.push(msg.seq);
				else {
					this.relays.push(msg);
					this.events.push(`relay ${msg.msg.t}`);
					if (msg.msg.t === "session_file") this.relayDown({ t: "reply", id: msg.msg.id, ok: true });
				}
				if (this.autoAck) this.send({ t: "ack", runId: msg.runId, seq: Math.max(...this.relays.map(r => r.seq)) });
				break;
			}
			case "gone":
			case "mcp-test-result":
				this.send({ t: "lease-invalid", runId: msg.runId });
				break;
		}
		this.onMessage?.(msg);
	}
}

function askSpec(prompt: string, extra: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: RUN_ID,
		kind: "ask",
		profile: "ask",
		prompt,
		thinking: "low",
		limits: { minutes: 5, costUsd: 1 },
		resumeSession: false,
		omp: emptyOmpConfig(),
		skillsHash: "hash",
		providerKeys: { fixture: "key" },
		credentials: [],
		scratch: { inputs: [] },
		...extra,
	};
}

interface Started {
	root: string;
	base: string;
	result: Promise<WorkerOutcome>;
}

function startWorker(stub: StubOrchestrator, overrides: Partial<WorkerOptions> = {}): Started {
	const base = tempDir("agentbot-worker-test-");
	const root = workerRoot(base);
	const result = runWorkerOnce({
		orchestratorUrl: stub.url,
		workerToken: WORKER_TOKEN,
		workerId: "worker-test",
		claimTimeoutMs: 5_000,
		root,
		identity: { version: "0.0.0-test", hash: "abc" },
		ompVersion: "18.12.1",
		hostEntry: FIXTURE_HOST,
		timing: { heartbeatMs: 100, abortKillMs: 400, exitGraceMs: 500, disconnectWaitMs: 200, endAckTimeoutMs: 5_000, retryMinMs: 20, retryMaxMs: 100 },
		reconnectMinMs: 30,
		reconnectMaxMs: 200,
		...overrides,
	});
	return { root, base, result };
}

function assign(spec: RunSpec): DownMessage {
	return { t: "assign", runId: spec.runId, token: LEASE, kind: "run", spec };
}

describe("worker run", () => {
	test("claims, relays, uploads the session and outputs before done, then cleans up", async () => {
		const stub = new StubOrchestrator();
		stub.files.set("skills", await new Bun.Archive({ "skills/probe/SKILL.md": "---\nname: probe\ndescription: d\n---\n" }).blob());
		stub.files.set("scratch/inputs/in.txt", "input");
		stub.files.set("session", '{"type":"session"}\n');
		stub.assignment = assign(askSpec("happy", { resumeSession: true, scratch: { inputs: ["in.txt"] } }));
		const { root, result } = startWorker(stub);

		expect(await result).toBe("run");
		expect(existsSync(root)).toBe(false);

		const hello = stub.controls("hello")[0]!;
		expect(hello).toMatchObject({ workerId: "worker-test", identity: { version: "0.0.0-test", hash: "abc" }, ompVersion: "18.12.1" });
		expect(hello.lease).toBeUndefined();
		expect(stub.controls("claim")).toHaveLength(1);
		expect(stub.controls("run-info")).toEqual([{ t: "run-info", runId: RUN_ID, ompVersion: "18.12.1" }]);
		expect(stub.controls("heartbeat")[0]).toMatchObject({ runId: RUN_ID, token: LEASE });

		const types = stub.relays.map(r => r.msg.t);
		expect(types).toContain("registered");
		expect(types).toContain("progress");
		expect(types).toContain("todos");
		expect(types).toContain("loadout");
		expect(types.at(-1)).toBe("done");
		expect(stub.relays.map(r => r.seq)).toEqual(stub.relays.map((_, i) => i + 1));
		// The session is uploaded before `session_file` is relayed; the final session and outputs before `done` (RUN-19).
		expect(stub.events.indexOf("put session")).toBeLessThan(stub.events.indexOf("relay session_file"));
		expect(stub.events.lastIndexOf("put session")).toBeLessThan(stub.events.indexOf("relay done"));
		expect(stub.events.indexOf("put scratch/outputs/answer.md")).toBeLessThan(stub.events.indexOf("relay done"));
		expect(stub.uploads.get("scratch/outputs/answer.md")).toBe("fixture answer\n");
		expect(stub.uploads.get("session")).toContain(RUN_ID);

		const done = stub.relayed("done")[0]!;
		const output = done.result.output as { runtime: { agentDir: string; ompDir: string; providerKeys: Record<string, string> }; data: Record<string, unknown> };
		expect(output.runtime).toEqual({ agentDir: join(root, "auth"), ompDir: join(root, "omp"), providerKeys: { fixture: "key" } });
		expect(output.data).toMatchObject({ runId: RUN_ID, cwd: join(root, "scratch"), scratchRoot: join(root, "scratch"), resumeFile: join(root, "sessions", "resume.jsonl"), profile: "ask", prompt: "happy" });
		expect(done.result.oomKills).toBe(2);
	});

	test("prepares run-local files, steers via relay after scratch-input, and stops on abort", async () => {
		const stub = new StubOrchestrator();
		stub.files.set("skills", await new Bun.Archive({ "skills/probe/SKILL.md": "skill", "agents/helper.md": "agent" }).blob());
		stub.files.set("scratch/inputs/late.txt", "late input");
		stub.assignment = assign(askSpec("steerable"));
		const { root, base, result } = startWorker(stub);
		await waitFor(() => stub.relayed("registered").length > 0);

		expect(readFileSync(join(root, "omp", "skills", "probe", "SKILL.md"), "utf8")).toBe("skill");
		expect(readFileSync(join(root, "omp", "agents", "helper.md"), "utf8")).toBe("agent");
		expect(statSync(join(root, "auth")).mode & 0o777).toBe(0o700);
		expect(existsSync(join(root, "auth", "agent.db"))).toBe(true);

		// Health while running (architecture §4.5).
		const lines: string[] = [];
		expect(runWorkerHealth(["--claimed"], base, line => lines.push(line))).toBe(0);
		expect(JSON.parse(lines[0]!)).toEqual({ status: "ok", version: "0.0.0-test", phase: "running", runId: RUN_ID, connected: true });

		stub.send({ t: "scratch-input", runId: RUN_ID, name: "late.txt" });
		stub.relayDown({ t: "steer", id: 1, text: "read late.txt" });
		await waitFor(() => stub.relayed("reply").some(r => r.id === 1));
		expect(readFileSync(join(root, "scratch", "inputs", "late.txt"), "utf8")).toBe("late input");
		const abortSeq = stub.relayDown({ t: "abort", id: 2, reason: "user" });

		expect(await result).toBe("run");
		const done = stub.relayed("done")[0]!;
		expect(done.result.output).toEqual(["read late.txt"]);
		expect(done.result.aborted).toBe("user");
		expect(stub.acks().at(-1)).toEqual({ t: "ack", runId: RUN_ID, seq: abortSeq });
		expect(existsSync(root)).toBe(false);
	});

	test("reconnects mid-run: re-announces the lease, resends unacknowledged relays and drops duplicates", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(askSpec("steerable"));
		const { result } = startWorker(stub);
		await waitFor(() => stub.relayed("registered").length > 0);
		stub.relayDown({ t: "steer", id: 1, text: "first" });
		await waitFor(() => stub.relayed("reply").some(r => r.id === 1));
		const ackedBefore = stub.acks().length;

		// Stop acknowledging, take one more message, then drop the connection.
		stub.autoAck = false;
		stub.relayDown({ t: "steer", id: 2, text: "second" });
		await waitFor(() => stub.relayed("reply").some(r => r.id === 2));
		const unacked = stub.relays.at(-1)!.seq;
		stub.dropConnection();
		await waitFor(() => stub.connections === 2 && stub.controls("hello").length === 2);
		stub.autoAck = true;

		const hello = stub.controls("hello")[1]!;
		expect(hello.lease).toEqual({ runId: RUN_ID, token: LEASE });
		expect(stub.controls("claim")).toHaveLength(1);
		await waitFor(() => stub.duplicates.includes(unacked));
		// The worker re-acknowledges what it delivered; a resent steer is dropped, not delivered twice.
		expect(stub.acks().length).toBeGreaterThan(ackedBefore);
		stub.send({ t: "relay", runId: RUN_ID, seq: 2, msg: { t: "steer", id: 2, text: "second" } });
		stub.relayDown({ t: "steer", id: 3, text: "third" });
		await waitFor(() => stub.relayed("reply").some(r => r.id === 3));
		stub.relayDown({ t: "abort", id: 4, reason: "user" });

		expect(await result).toBe("run");
		expect(stub.relayed("done")[0]!.result.output).toEqual(["first", "second", "third"]);
	});

	test("an ignored abort kills the host after the abort timeout; the run ends as aborted by the user", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(askSpec("hung"));
		const { result } = startWorker(stub);
		await waitFor(() => stub.relayed("registered").length > 0);
		const abortedAt = Date.now();
		stub.relayDown({ t: "abort", id: 1, reason: "user" });

		expect(await result).toBe("run");
		const done = stub.relayed("done")[0]!;
		expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(400);
		expect(done.result.aborted).toBe("user");
		expect(stub.relayed("transcript").at(-1)!.event).toMatchObject({ type: "run_end", aborted: "user" });
		expect(stub.controls("gone")).toHaveLength(0);
	});

	test("a host that dies without a result is reported as gone", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(askSpec("exit"));
		const { root, result } = startWorker(stub);

		expect(await result).toBe("run");
		expect(stub.controls("gone")).toEqual([{ t: "gone", runId: RUN_ID, exitCode: 3, signal: null, oomKills: 0 }]);
		expect(stub.relayed("done")).toHaveLength(0);
		expect(stub.relayed("transcript").at(-1)!.event).toMatchObject({ type: "run_end", error: "agent process exited with code 3" });
		expect(stub.relayed("usage")).toHaveLength(1);
		expect(existsSync(root)).toBe(false);
	});

	test("kills the process group the run left behind (AGT-06)", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(askSpec("leavesChildren"));
		const { result } = startWorker(stub);
		expect(await result).toBe("run");
		const spawned = stub.relayed("transcript").map(t => t.event).find(e => e.type === "tool_start" && e.tool === "spawn");
		if (spawned?.type !== "tool_start") throw new Error("no spawn event");
		const [grouped, detached] = JSON.parse(spawned.args) as number[];
		cleanups.push(() => {
			try {
				process.kill(detached!, "SIGKILL");
			} catch {}
		});
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		await waitFor(() => !alive(grouped!), 2_000);
		// The `setsid` child is reached only through the run marker in /proc (Linux).
		if (existsSync("/proc/self/environ")) await waitFor(() => !alive(detached!), 2_000);
	});

	test("routes credential requests to the orchestrator with its credential id", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(
			askSpec("credential", {
				credentials: [{ id: 42, provider: "fixture", credential: { type: "oauth", access: "old", refresh: "__remote__", expires: Date.now() + 3_600_000 }, identityKey: null }],
			}),
		);
		stub.onMessage = msg => {
			if (msg.t === "credential-request") stub.send({ t: "credential-response", runId: msg.runId, requestId: msg.requestId, ok: true, accessToken: "new", expiresAt: 123 });
		};
		const { result } = startWorker(stub);
		expect(await result).toBe("run");
		expect(stub.controls("credential-request")).toEqual([{ t: "credential-request", runId: RUN_ID, requestId: 1, provider: "fixture", credentialId: "42", accessToken: "old" }]);
		expect(stub.relayed("done")[0]!.result.output).toEqual({ value: { accessToken: "new", expiresAt: 123 } });
	});

	test("uploads session checkpoints while running and at SIGTERM, then stops without reporting (RUN-18)", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(askSpec("steerable"));
		const sigterm = new AbortController();
		const { root, result } = startWorker(stub, { signal: sigterm.signal, timing: { heartbeatMs: 100, checkpointMs: 100, disconnectWaitMs: 200, retryMinMs: 20, retryMaxMs: 100 } });
		await waitFor(() => stub.controls("checkpoint").length > 0);
		const checkpoints = stub.controls("checkpoint").length;
		const sessionPuts = stub.events.filter(e => e === "put session").length;
		sigterm.abort();
		expect(await result).toBe("run");
		expect(stub.events.filter(e => e === "put session").length).toBeGreaterThan(sessionPuts);
		expect(stub.controls("checkpoint").length).toBeGreaterThan(checkpoints);
		expect(stub.relayed("done")).toHaveLength(0);
		expect(existsSync(root)).toBe(false);
	});

	test("lease-invalid stops the host and cleans up", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign(askSpec("hung"));
		const { root, result } = startWorker(stub);
		await waitFor(() => stub.relayed("registered").length > 0);
		stub.send({ t: "lease-invalid", runId: RUN_ID });
		expect(await result).toBe("run");
		expect(stub.relayed("done")).toHaveLength(0);
		expect(existsSync(root)).toBe(false);
	});

	test("a run that needs a checkout fails clearly", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = assign({ ...askSpec("happy"), kind: "implement", profile: "implement" });
		const { result } = startWorker(stub);
		expect(await result).toBe("run");
		expect(stub.relayed("failed")[0]!.message).toContain("needs a repository checkout");
	});

	test("runs an mcp-test and reports its tools", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = {
			t: "assign",
			runId: RUN_ID,
			token: LEASE,
			kind: "mcp-test",
			mcp: { name: "echo", server: { type: "stdio", command: process.execPath, args: [ECHO_MCP] } as never, timeoutMs: 10_000 },
		};
		const { result } = startWorker(stub);
		expect(await result).toBe("mcp-test");
		expect(stub.controls("mcp-test-result")).toEqual([{ t: "mcp-test-result", runId: RUN_ID, ok: true, tools: [expect.stringContaining("echo")] as never }]);
	});
});

describe("worker claim", () => {
	test("exits when the orchestrator has nothing to claim", async () => {
		const stub = new StubOrchestrator();
		stub.assignment = { t: "nothing" };
		const { root, result } = startWorker(stub);
		expect(await result).toBe("nothing");
		expect(existsSync(root)).toBe(false);
	});

	test("exits after the claim timeout when no orchestrator answers", async () => {
		const stub = new StubOrchestrator();
		const started = Date.now();
		const { result } = startWorker(stub, { claimTimeoutMs: 300 });
		expect(await result).toBe("nothing");
		expect(Date.now() - started).toBeLessThan(3_000);
	});
});

describe("relay buffer (RUN-06)", () => {
	const entry = (seq: number, type: ChildMessage["t"], bytes = 10): OutboxEntry => ({ seq, type, text: "", bytes });

	test("drops the oldest progress, transcript and log first, then all but the newest todos, never anything else", () => {
		const outbox = new RelayOutbox(4, 1_000_000);
		outbox.push(entry(1, "ui"));
		outbox.push(entry(2, "progress"));
		outbox.push(entry(3, "todos"));
		outbox.push(entry(4, "transcript"));
		expect(outbox.push(entry(5, "todos"))).toEqual([2]);
		expect(outbox.push(entry(6, "log"))).toEqual([4]);
		expect(outbox.push(entry(7, "session_file"))).toEqual([6]);
		expect(outbox.push(entry(8, "reply"))).toEqual([3]);
		expect(outbox.entries().map(e => e.seq)).toEqual([1, 5, 7, 8]);
		expect(outbox.push(entry(9, "done"))).toEqual([]);
		expect(outbox.length).toBe(5);
	});

	test("bounds bytes as well as messages, and acks remove everything up to the seq", () => {
		const outbox = new RelayOutbox(100, 100);
		outbox.push(entry(1, "transcript", 60));
		expect(outbox.push(entry(2, "registered", 60))).toEqual([1]);
		expect(outbox.bytes).toBe(60);
		outbox.push(entry(3, "progress", 10));
		outbox.ack(2);
		expect(outbox.entries().map(e => e.seq)).toEqual([3]);
		expect(outbox.bytes).toBe(10);
	});

	test("cuts log lines at 8 KiB and leaves other messages alone", () => {
		const cut = limitChildMessage({ t: "log", line: "x".repeat(LOG_LINE_LIMIT + 100) }) as { line: string };
		expect(cut.line.startsWith("x".repeat(LOG_LINE_LIMIT))).toBe(true);
		expect(cut.line).toContain("100 more chars truncated");
		const progress: ChildMessage = { t: "registered" };
		expect(limitChildMessage(progress)).toBe(progress);
	});
});

describe("worker health", () => {
	test("--claimed fails until a run is claimed; a dead worker is not reported", () => {
		const base = tempDir("agentbot-health-");
		const lines: string[] = [];
		const out = (line: string) => lines.push(line);
		expect(runWorkerHealth([], base, out)).toBe(1);
		const status = new StatusFile(workerRoot(base), "1.2.3");
		expect(runWorkerHealth([], base, out)).toBe(0);
		expect(runWorkerHealth(["--claimed"], base, out)).toBe(1);
		status.update({ runId: "r", phase: "running", connected: true });
		expect(runWorkerHealth(["--claimed"], base, out)).toBe(0);
		expect(JSON.parse(lines.at(-1)!)).toEqual({ status: "ok", version: "1.2.3", phase: "running", runId: "r", connected: true });
	});
});

describe("output files", () => {
	test("lists regular files recursively, skipping symlinks", async () => {
		const dir = tempDir("agentbot-outputs-");
		await Bun.write(join(dir, "a.md"), "a");
		await Bun.write(join(dir, "sub", "b.txt"), "b");
		symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
		expect((await listOutputFiles(dir)).map(f => f.name)).toEqual(["a.md", "sub_b.txt"]);
	});
});
