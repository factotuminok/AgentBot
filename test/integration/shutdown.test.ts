import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbPath } from "../../src/orchestrator/store/db";
import { WORKER_WS_PATH } from "../../src/shared/wire";

/**
 * ENG-04, RUN-09: the real `agentbot orchestrator` process on SIGTERM. Worker sockets close with 1001 and nothing is
 * aborted, the database is closed (its WAL checkpointed away), the process exits 143 well within the 10 s bound.
 */

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const WORKER_TOKEN = "shutdown-worker-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	return Number(port);
}

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await cond())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
}

test("SIGTERM: worker sockets close with 1001, nothing is aborted, the DB is closed, exit 143 within 10 s (ENG-04, RUN-09)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "agentbot-shutdown-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const tokenFile = join(stateDir, "worker-token");
	await writeFile(tokenFile, WORKER_TOKEN);
	const port = freePort();
	const url = `http://127.0.0.1:${port}`;
	const proc = Bun.spawn(["bun", CLI, "orchestrator"], {
		env: {
			...process.env,
			AGENTBOT_STATE_DIR: stateDir,
			AGENTBOT_INTERNAL_HOST: "127.0.0.1",
			AGENTBOT_INTERNAL_PORT: String(port),
			AGENTBOT_WORKER_TOKEN_FILE: tokenFile,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	cleanups.push(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	});
	const stdout = new Response(proc.stdout).text();
	void new Response(proc.stderr).text();
	await until(async () => (await fetch(`${url}/livez`).catch(() => undefined))?.ok === true, "the orchestrator to listen");

	// A connected worker between runs.
	const options: Bun.WebSocketOptions = { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } };
	const ws = new WebSocket(`ws://127.0.0.1:${port}${WORKER_WS_PATH}`, options as unknown as string[]);
	const received: string[] = [];
	ws.addEventListener("message", e => received.push(String(e.data)));
	const opened = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<CloseEvent>();
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("close", e => closed.resolve(e), { once: true });
	await opened.promise;
	ws.send(JSON.stringify({ t: "hello", workerId: "w-1", identity: { version: "0.0.0-test", hash: "h" }, ompVersion: "0.0.0" }));

	const started = performance.now();
	proc.kill("SIGTERM");
	const close = await closed.promise;
	const code = await proc.exited;
	const elapsed = performance.now() - started;

	expect(close.code).toBe(1001);
	expect(close.reason).toBe("orchestrator shutting down");
	expect(received.filter(m => m.includes('"abort"') || m.includes('"lease-invalid"'))).toEqual([]);
	expect(code).toBe(143);
	expect(elapsed).toBeLessThan(10_000);

	const lines = (await stdout).split("\n").filter(Boolean);
	const index = (msg: string) => lines.findIndex(l => l.includes(`"msg":"${msg}"`));
	expect(index("shutting down")).toBeGreaterThan(-1);
	expect(index("shutdown complete")).toBeGreaterThan(index("shutting down"));
	expect(lines.some(l => l.includes('"msg":"shutdown failed"'))).toBe(false);
	// The database was closed: the last connection's close checkpoints the WAL (empty, or removed where WAL is not persistent).
	const wal = `${dbPath(stateDir)}-wal`;
	expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
}, 30_000);
