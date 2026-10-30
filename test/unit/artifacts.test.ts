import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactHandler, MAX_BUNDLE_BYTES, MAX_SESSION_BYTES, STATE_FREE_FLOOR_BYTES } from "../../src/orchestrator/dispatch/artifacts";
import { createRunRefs } from "../../src/orchestrator/dispatch/checkouts";
import { claimNextRun } from "../../src/orchestrator/dispatch/leases";
import { sessionDir } from "../../src/orchestrator/dispatch/spec";
import { createRepos } from "../../src/orchestrator/git/repos";
import { type Db, openDb, type RunRow } from "../../src/orchestrator/store/db";
import { sessionPath } from "../../src/orchestrator/store/sessions";
import { ARTIFACTS, runArtifactPath } from "../../src/shared/wire";

/**
 * The run artifact uploads against a lease (security review F2, F8): one upload at a time per run and artifact, the
 * session and bundle caps, the state volume's free-space floor, and the lease checked again before anything is kept.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function setup(over: { bundleLimitBytes?: number; freeFloorBytes?: number } = {}) {
	const stateDir = await mkdtemp(join(tmpdir(), "agentbot-artifacts-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const db = openDb(":memory:");
	const repos = createRepos({ stateDir });
	const handler = createArtifactHandler({
		db,
		stateDir,
		skills: async () => ({ hash: "h", tar: new Uint8Array() }),
		repos,
		refs: createRunRefs(db, repos),
		bundleLimitBytes: over.bundleLimitBytes ?? MAX_BUNDLE_BYTES,
		freeFloorBytes: over.freeFloorBytes ?? STATE_FREE_FLOOR_BYTES,
	});
	return { stateDir, db, handler };
}

/** A claimed run with a session and a scratch directory, and its lease token. */
function claimed(db: Db, stateDir: string, kind: "draft" | "implement" = "draft"): { row: RunRow; token: string } {
	db.insertRun({ kind, draftId: crypto.randomUUID(), sessionKey: "s1", scratchDir: join(stateDir, "scratch", "t1"), repo: "o/r", startCommit: "c0ffee" });
	const row = claimNextRun(db, "w1", 60_000)!;
	return { row, token: row.leaseToken };
}

function put(runId: string, artifact: string, token: string, body: BodyInit): Request {
	return new Request(`http://orchestrator${runArtifactPath(runId, artifact)}`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } });
}

/** A request body that stays open until `end` is called. */
function heldBody(first: string) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start: c => {
			controller = c;
			c.enqueue(new TextEncoder().encode(first));
		},
	});
	return {
		stream,
		end: () => controller.close(),
	};
}

describe("run artifact uploads (F2, F8)", () => {
	test("one upload at a time per run and artifact; other artifacts are not blocked", async () => {
		const { stateDir, db, handler } = await setup();
		const { row, token } = claimed(db, stateDir);
		const held = heldBody('{"type":"session"}\n');
		const first = handler.handle(put(row.id, ARTIFACTS.session, token, held.stream));
		const second = await handler.handle(put(row.id, ARTIFACTS.session, token, "other"));
		expect(second.status).toBe(503);
		expect(second.headers.get("retry-after")).toBe("1");
		expect((await handler.handle(put(row.id, ARTIFACTS.scratchOutput("a.txt"), token, "a"))).status).toBe(204);
		held.end();
		expect((await first).status).toBe(204);
		// The slot is free again.
		expect((await handler.handle(put(row.id, ARTIFACTS.session, token, "again\n"))).status).toBe(204);
		expect(await readFile(sessionPath(sessionDir(stateDir), "s1"), "utf8")).toBe("again\n");
	});

	test(`a session over ${MAX_SESSION_BYTES / 1024 ** 2} MiB is refused and nothing is kept`, async () => {
		const { stateDir, db, handler } = await setup();
		const { row, token } = claimed(db, stateDir);
		const mib = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull: c => {
				if (sent++ > MAX_SESSION_BYTES / mib.byteLength) c.close();
				else c.enqueue(mib);
			},
		});
		expect((await handler.handle(put(row.id, ARTIFACTS.session, token, body))).status).toBe(413);
		expect(existsSync(sessionPath(sessionDir(stateDir), "s1"))).toBe(false);
	});

	test("bundles are capped at the worker's disk limit", async () => {
		const { stateDir, db, handler } = await setup({ bundleLimitBytes: 1024 });
		const { row, token } = claimed(db, stateDir, "implement");
		expect((await handler.handle(put(row.id, ARTIFACTS.result, token, new Uint8Array(2048)))).status).toBe(413);
		expect((await handler.handle(put(row.id, ARTIFACTS.checkpoint, token, new Uint8Array(2048)))).status).toBe(413);
	});

	test("uploads are refused while the state volume is below its free-space floor", async () => {
		const { stateDir, db, handler } = await setup({ freeFloorBytes: Number.MAX_SAFE_INTEGER });
		const { row, token } = claimed(db, stateDir, "implement");
		for (const artifact of [ARTIFACTS.session, ARTIFACTS.result, ARTIFACTS.scratchOutput("a.txt")]) {
			expect((await handler.handle(put(row.id, artifact, token, "x"))).status).toBe(507);
		}
		expect(existsSync(sessionPath(sessionDir(stateDir), "s1"))).toBe(false);
	});

	test("a session or output upload that outlives the lease keeps nothing (F8)", async () => {
		const { stateDir, db, handler } = await setup();
		const { row, token } = claimed(db, stateDir);
		const session = heldBody('{"type":"poisoned"}\n');
		const output = heldBody("late");
		const sessionPut = handler.handle(put(row.id, ARTIFACTS.session, token, session.stream));
		const outputPut = handler.handle(put(row.id, ARTIFACTS.scratchOutput("late.txt"), token, output.stream));
		db.transitionRun(row.id, ["assigned"], "finished", { outcome: "succeeded" });
		session.end();
		output.end();
		expect((await sessionPut).status).toBe(401);
		expect((await outputPut).status).toBe(401);
		expect(existsSync(sessionPath(sessionDir(stateDir), "s1"))).toBe(false);
		expect(existsSync(join(stateDir, "scratch", "t1", "outputs", "late.txt"))).toBe(false);
	});
});
