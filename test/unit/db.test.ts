import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dbPath, hashLeaseToken, openDb } from "../../src/orchestrator/store/db";

const LEASE_MS = 45_000;
const later = (ms: number) => new Date(Date.now() + ms);

describe("runs", () => {
	test("workers claim the oldest pending run, each run once, with a lease token", () => {
		const db = openDb(":memory:");
		const first = db.insertRun({ kind: "draft", draftId: "d1" });
		const second = db.insertRun({ kind: "draft", draftId: "d2" });

		const a = db.claimRun("worker-a", LEASE_MS)!;
		expect(a.id).toBe(first.id);
		expect(a.state).toBe("assigned");
		expect(a.worker_id).toBe("worker-a");
		expect(a.lease_token).toBeTruthy();
		expect(db.runForLease(a.leaseToken)?.id).toBe(first.id);

		const b = db.claimRun("worker-b", LEASE_MS)!;
		expect(b.id).toBe(second.id);
		expect(b.leaseToken).not.toBe(a.leaseToken);
		// SEC-14: only the sha256 of the token is stored.
		expect(a.lease_token).toBe(hashLeaseToken(a.leaseToken));
		expect(db.getRun(a.id)!.lease_token).not.toBe(a.leaseToken);
		expect(db.claimRun("worker-c", LEASE_MS)).toBeNull();
	});

	test("a lease token stored raw by an older version is hashed at open and still authorises (SEC-14)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agentbot-db-"));
		try {
			const first = openDb(dbPath(dir));
			const run = first.insertRun({ kind: "draft", draftId: "d1" });
			first.claimRun("w1", LEASE_MS);
			first.close();
			// What an older version left behind: the plain token in the column.
			const raw = new Database(dbPath(dir));
			raw.run("UPDATE runs SET lease_token = ? WHERE id = ?", ["plain-old-token", run.id]);
			raw.close();
			const db = openDb(dbPath(dir));
			expect(db.getRun(run.id)!.lease_token).toBe(hashLeaseToken("plain-old-token"));
			expect(db.runForLease("plain-old-token")?.id).toBe(run.id);
			expect(db.runForLease(hashLeaseToken("plain-old-token"))).toBeNull();
			expect(db.renewLease(run.id, "plain-old-token", LEASE_MS)).not.toBeNull();
			db.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the store is WAL with synchronous=NORMAL: only checkpoints fsync, not every commit (phase 11 load test)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agentbot-db-"));
		try {
			const db = openDb(dbPath(dir));
			expect(db.raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
			// 1 = NORMAL (2 = FULL, SQLite's default, fsynced the WAL at every commit).
			expect(db.raw.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(1);
			db.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("two connections to the same file never claim the same run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agentbot-db-"));
		try {
			const one = openDb(dbPath(dir));
			const two = openDb(dbPath(dir));
			for (let i = 0; i < 6; i++) one.insertRun({ kind: "draft", draftId: `d${i}` });
			const claimed: string[] = [];
			for (let i = 0; i < 6; i++) claimed.push((i % 2 ? one : two).claimRun(`w${i}`, LEASE_MS)!.id);
			expect(new Set(claimed).size).toBe(6);
			expect(one.claimRun("w", LEASE_MS)).toBeNull();
			expect(two.claimRun("w", LEASE_MS)).toBeNull();
			one.close();
			two.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an expired lease requeues an assigned run and loses a running one, revoking the token", () => {
		const db = openDb(":memory:");
		const assigned = db.insertRun({ kind: "draft", draftId: "d1" });
		const running = db.insertRun({ kind: "draft", draftId: "d2" });
		const fresh = db.insertRun({ kind: "draft", draftId: "d3" });
		const lease1 = db.claimRun("w1", LEASE_MS)!.leaseToken;
		const lease2 = db.claimRun("w2", LEASE_MS)!.leaseToken;
		expect(db.transitionRun(running.id, ["assigned"], "running")?.started_at).toBeTruthy();
		const lease3 = db.claimRun("w3", 5 * LEASE_MS)!.leaseToken;

		expect(db.expireLeases()).toEqual({ requeued: [], lost: [] });
		const expired = db.expireLeases(later(LEASE_MS + 1000));
		expect(expired.requeued.map(r => r.id)).toEqual([assigned.id]);
		expect(expired.lost.map(r => r.id)).toEqual([running.id]);

		const requeued = db.getRun(assigned.id)!;
		expect(requeued).toMatchObject({ state: "pending", worker_id: null, lease_token: null, loss_count: 0 });
		expect(db.getRun(running.id)).toMatchObject({ state: "lost", lease_token: null, loss_count: 1 });
		expect(db.renewLease(assigned.id, lease1, LEASE_MS)).toBeNull();
		expect(db.runForLease(lease2)).toBeNull();
		expect(db.getRun(fresh.id)!.state).toBe("assigned");
		expect(db.renewLease(fresh.id, lease3, LEASE_MS)?.state).toBe("assigned");

		// The requeued run is the oldest pending one again.
		expect(db.claimRun("w4", LEASE_MS)?.id).toBe(assigned.id);
	});

	test("a heartbeat keeps the lease alive; a wrong token does not", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		const { leaseToken } = db.claimRun("w", 1000)!;
		expect(db.renewLease(run.id, "not-the-token", LEASE_MS)).toBeNull();
		expect(db.renewLease(run.id, leaseToken, LEASE_MS)).not.toBeNull();
		expect(db.expireLeases(later(5000))).toEqual({ requeued: [], lost: [] });
	});

	test("after a restart, live leases get the reattach grace period", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		db.claimRun("w", 1000);
		db.graceLeases(90_000);
		expect(db.expireLeases(later(60_000)).requeued).toEqual([]);
		expect(db.expireLeases(later(91_000)).requeued.map(r => r.id)).toEqual([run.id]);
	});

	test("transitions only apply from the expected state", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		expect(db.transitionRun(run.id, ["running"], "finishing")).toBeNull();
		const cancelled = db.transitionRun(run.id, ["pending"], "finished", { outcome: "cancelled" })!;
		expect(cancelled).toMatchObject({ state: "finished", outcome: "cancelled" });
		expect(cancelled.finished_at).toBeTruthy();
		expect(db.claimRun("w", LEASE_MS)).toBeNull();
	});

	test("an owner has at most one unfinished run, and exactly one owner is required", () => {
		const db = openDb(":memory:");
		const issue = db.insertIssue("o/r", 1, "t");
		const job = db.insertJob(issue.id, "plan");
		const run = db.insertRun({ kind: "plan", jobId: job.id });
		expect(() => db.insertRun({ kind: "plan", jobId: job.id })).toThrow();
		db.transitionRun(run.id, ["pending"], "finished", { outcome: "cancelled" });
		expect(db.insertRun({ kind: "plan", jobId: job.id }).state).toBe("pending");
		expect(() => db.insertRun({ kind: "draft" })).toThrow();
		expect(() => db.insertRun({ kind: "plan", jobId: job.id, draftId: "d" })).toThrow();
	});
});

describe("relay", () => {
	test("outgoing messages are numbered per run and dropped once acknowledged", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		const other = db.insertRun({ kind: "draft", draftId: "d2" });
		expect([1, 2, 3].map(n => db.appendOutbox(run.id, { type: "steer", n }))).toEqual([1, 2, 3]);
		expect(db.appendOutbox(other.id, { type: "abort" })).toBe(1);

		expect(db.ackOutbox(run.id, 2)).toBe(2);
		expect(db.outbox(run.id).map(m => [m.seq, JSON.parse(m.payload)])).toEqual([[3, { type: "steer", n: 3 }]]);
		expect(db.outbox(other.id)).toHaveLength(1);

		// Numbering continues after everything was acknowledged, so the worker never sees a reused number.
		db.ackOutbox(run.id, 3);
		expect(db.appendOutbox(run.id, { type: "steer" })).toBe(4);
		expect(() => db.appendOutbox("missing", {})).toThrow();
	});

	test("incoming duplicates are recognised by sequence number", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		expect(db.acceptInbound(run.id, 1)).toBe(true);
		expect(db.acceptInbound(run.id, 2)).toBe(true);
		expect(db.acceptInbound(run.id, 2)).toBe(false);
		expect(db.acceptInbound(run.id, 1)).toBe(false);
		expect(db.acceptInbound(run.id, 3)).toBe(true);
	});
});

describe("watches", () => {
	test("re-watching an unwatched repository resets its cursor; resuming a suspended one keeps it", () => {
		const db = openDb(":memory:");
		const watch = { repoId: 42, repo: "Owner/Repo", channelId: "c1", createdBy: "u1" };
		expect(db.watchRepo(watch)).toMatchObject({ state: "watching", cursor: null });
		db.updateWatch(42, { cursor: "2026-01-01T00:00:00Z", state: "suspended", last_error: "no access" });
		expect(db.watchRepo(watch)).toMatchObject({ state: "watching", cursor: "2026-01-01T00:00:00Z", last_error: null });

		db.updateWatch(42, { state: "unwatched" });
		expect(db.watchRepo({ ...watch, createdBy: "admin" })).toMatchObject({ state: "watching", cursor: null, created_by: "admin" });
		expect(db.watchByName("owner/repo")?.repo_id).toBe(42);
		expect(db.watchByChannel("c1")?.repo_id).toBe(42);
	});
});
