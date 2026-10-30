import { describe, expect, test } from "bun:test";
import { claimNextRun, holdsLease, sameToken } from "../../src/orchestrator/dispatch/leases";
import { openDb } from "../../src/orchestrator/store/db";

const LEASE_MS = 45_000;
const later = (ms: number) => new Date(Date.now() + ms);

describe("leases (RUN-02, RUN-07, architecture §6)", () => {
	test("a worker claims the oldest pending run with a live lease", () => {
		const db = openDb(":memory:");
		const first = db.insertRun({ kind: "draft", draftId: "d1" });
		db.insertRun({ kind: "draft", draftId: "d2" });
		const row = claimNextRun(db, "w1", LEASE_MS)!;
		expect(row.id).toBe(first.id);
		expect(row.state).toBe("assigned");
		expect(holdsLease(db.getRun(row.id), "w1", row.leaseToken)).toBe(true);
		expect(holdsLease(db.getRun(row.id), "w2", row.leaseToken)).toBe(false);
		expect(holdsLease(db.getRun(row.id), "w1", "wrong")).toBe(false);
		expect(holdsLease(db.getRun(row.id), undefined, row.leaseToken)).toBe(true);
	});

	test("one claim per worker id, ever, even after its run ended", () => {
		const db = openDb(":memory:");
		const run = db.insertRun({ kind: "draft", draftId: "d1" });
		db.insertRun({ kind: "draft", draftId: "d2" });
		expect(claimNextRun(db, "w1", LEASE_MS)?.id).toBe(run.id);
		expect(claimNextRun(db, "w1", LEASE_MS)).toBeNull();
		db.transitionRun(run.id, ["assigned"], "finished", { outcome: "succeeded" });
		expect(claimNextRun(db, "w1", LEASE_MS)).toBeNull();
		expect(db.workerClaim("w1")).toBe(run.id);
		// The refused claim left the other run pending for another worker.
		expect(claimNextRun(db, "w2", LEASE_MS)?.draft_id).toBe("d2");
	});

	test("a claim with nothing pending records nothing", () => {
		const db = openDb(":memory:");
		expect(claimNextRun(db, "w1", LEASE_MS)).toBeNull();
		db.insertRun({ kind: "draft", draftId: "d1" });
		expect(claimNextRun(db, "w1", LEASE_MS)?.draft_id).toBe("d1");
	});

	test("expired leases: an unstarted run goes back to pending, a running one is lost; heartbeats keep them", () => {
		const db = openDb(":memory:");
		const a = db.insertRun({ kind: "draft", draftId: "a" });
		const b = db.insertRun({ kind: "draft", draftId: "b" });
		const c = db.insertRun({ kind: "draft", draftId: "c" });
		const leaseA = claimNextRun(db, "wa", 1000)!;
		const leaseB = claimNextRun(db, "wb", 1000)!;
		const leaseC = claimNextRun(db, "wc", 1000)!;
		db.transitionRun(b.id, ["assigned"], "running");
		db.transitionRun(c.id, ["assigned"], "running");
		expect(db.renewLease(c.id, leaseC.leaseToken, 60_000)).not.toBeNull();
		expect(db.renewLease(c.id, "wrong", 60_000)).toBeNull();

		const expired = db.expireLeases(later(5_000));
		expect(expired.requeued.map(r => r.id)).toEqual([a.id]);
		expect(expired.lost.map(r => r.id)).toEqual([b.id]);
		expect(db.getRun(a.id)).toMatchObject({ state: "pending", lease_token: null, worker_id: null });
		expect(db.getRun(b.id)).toMatchObject({ state: "lost", loss_count: 1, lease_token: null });
		expect(db.getRun(c.id)?.state).toBe("running");
		// Revoked tokens hold nothing.
		expect(holdsLease(db.getRun(a.id), "wa", leaseA.leaseToken)).toBe(false);
		expect(holdsLease(db.getRun(b.id), "wb", leaseB.leaseToken)).toBe(false);
	});

	test("after a restart, the grace period keeps leases alive until it ends (RUN-07)", () => {
		const db = openDb(":memory:");
		db.insertRun({ kind: "draft", draftId: "a" });
		const run = claimNextRun(db, "w1", 1)!;
		db.transitionRun(run.id, ["assigned"], "running");
		db.graceLeases(90_000);
		expect(db.expireLeases(later(60_000)).lost).toEqual([]);
		expect(db.expireLeases(later(91_000)).lost.map(r => r.id)).toEqual([run.id]);
	});

	test("tokens compare in constant time regardless of length", () => {
		expect(sameToken("abc", "abc")).toBe(true);
		expect(sameToken("abc", "abcd")).toBe(false);
		expect(sameToken("", "abc")).toBe(false);
	});
});
