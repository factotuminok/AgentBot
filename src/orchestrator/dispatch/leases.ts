import { createHash, timingSafeEqual } from "node:crypto";
import type { Db, RunRow, RunState } from "../store/db";

/**
 * Claims and leases (RUN-02, RUN-07, architecture §6). A worker claims once in its life: the claim is recorded per worker
 * id, so a worker whose run is going, or done, cannot claim a second one on any connection.
 */

/** States in which a lease is live. */
export const LEASED_STATES: readonly RunState[] = ["assigned", "running", "finishing"];

/** Constant-time token comparison (SEC-14); hashing first equalises the lengths. */
export function sameToken(given: string, expected: string): boolean {
	const digest = (text: string) => createHash("sha256").update(text).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

/** A fresh random lease token (also used for `mcp-test` tasks, which are not in the runs table). */
export function newLeaseToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * Atomically claims the oldest pending run for `workerId` with a lease of `leaseMs`, recording the worker's one claim.
 * Null when nothing is pending or the worker has claimed before.
 */
export function claimNextRun(db: Db, workerId: string, leaseMs: number): RunRow | null {
	return db.raw.transaction(() => {
		if (db.workerClaim(workerId) !== null) return null;
		const row = db.claimRun(workerId, leaseMs);
		if (row) db.recordWorkerClaim(workerId, row.id);
		return row;
	})();
}

/** True when `token` is the live lease of `row` held by `workerId`. */
export function holdsLease(row: RunRow | null, workerId: string | undefined, token: string): row is RunRow {
	return (
		row !== null &&
		row.lease_token !== null &&
		LEASED_STATES.includes(row.state) &&
		(workerId === undefined || row.worker_id === workerId) &&
		sameToken(token, row.lease_token)
	);
}
