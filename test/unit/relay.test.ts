import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRelay } from "../../src/orchestrator/dispatch/relay";
import { dbPath, openDb } from "../../src/orchestrator/store/db";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function stateDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agentbot-relay-"));
	dirs.push(dir);
	return dir;
}

describe("run relay (RUN-06)", () => {
	test("outgoing messages get increasing sequence numbers, double as request ids, and stay until acknowledged", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		const relay = runRelay(db, run.id);
		const first = relay.enqueue(id => ({ t: "steer", id, text: "one" }));
		const second = relay.enqueue(id => ({ t: "abort", id, reason: "user" }));
		const third = relay.enqueue(() => ({ t: "reply", id: 7, ok: true }));
		expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
		expect(first).toEqual({ t: "relay", runId: run.id, seq: 1, msg: { t: "steer", id: 1, text: "one" } });
		expect(second.msg).toEqual({ t: "abort", id: 2, reason: "user" });

		relay.ack(2);
		expect(relay.unacked()).toEqual([third]);
		// A stale ack changes nothing.
		relay.ack(1);
		expect(relay.unacked().map(m => m.seq)).toEqual([3]);
		relay.clear();
		expect(relay.unacked()).toEqual([]);
		expect(relay.enqueue(id => ({ t: "steer", id, text: "after" })).seq).toBe(4);
	});

	test("incoming duplicates are dropped and gaps are accepted", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		const relay = runRelay(db, run.id);
		expect(relay.received()).toBe(0);
		expect(relay.accept(1)).toBe(true);
		expect(relay.accept(1)).toBe(false);
		// The worker dropped 2 to 4 from a full buffer.
		expect(relay.accept(5)).toBe(true);
		expect(relay.accept(3)).toBe(false);
		expect(relay.received()).toBe(5);
	});

	test("the outbox and the received sequence survive an orchestrator restart", async () => {
		const dir = await stateDir();
		const before = openDb(dbPath(dir));
		const run = before.insertRun({ kind: "draft", draftId: "d1" });
		const relay = runRelay(before, run.id);
		relay.enqueue(id => ({ t: "steer", id, text: "keep me" }));
		relay.enqueue(() => ({ t: "reply", id: 3, ok: true, value: "yes" }));
		relay.ack(1);
		relay.accept(4);
		before.close();

		const after = openDb(dbPath(dir));
		const resumed = runRelay(after, run.id);
		expect(resumed.unacked()).toEqual([{ t: "relay", runId: run.id, seq: 2, msg: { t: "reply", id: 3, ok: true, value: "yes" } }]);
		expect(resumed.received()).toBe(4);
		expect(resumed.accept(4)).toBe(false);
		expect(resumed.enqueue(id => ({ t: "steer", id, text: "next" })).seq).toBe(3);
		after.close();
	});
});
