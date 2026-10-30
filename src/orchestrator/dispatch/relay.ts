import type { RelayDown } from "../../shared/wire";
import type { Db } from "../store/db";

/**
 * The orchestrator's side of one run's relay (RUN-06). Outgoing messages are stored in `relay_outbox` before they are
 * sent and kept until the worker acknowledges them, so a steer or an answer survives a dropped connection and an
 * orchestrator restart. Incoming messages are deduplicated by sequence number.
 */
export interface RunRelay {
	/**
	 * Stores the message under the run's next sequence number and returns the envelope to send. `build` receives that
	 * number; it doubles as the request id of `steer` and `abort`, so ids never repeat within a run, across restarts too.
	 */
	enqueue(build: (seq: number) => RelayDown["msg"]): RelayDown;
	/** Every stored message the worker has not acknowledged, in order: resent after a reconnect. */
	unacked(): RelayDown[];
	/** The worker stored everything up to `seq`. */
	ack(seq: number): void;
	/**
	 * Records an incoming sequence number. True when it is new (handle the message), false for a duplicate. Gaps are
	 * accepted: a worker whose buffer overflowed drops progress, transcript and log messages.
	 */
	accept(seq: number): boolean;
	/** Highest incoming sequence number received and stored: the value to `ack`. */
	received(): number;
	/** Drops every unacknowledged message (the run finished; nobody will read them). */
	clear(): void;
}

export function runRelay(db: Db, runId: string): RunRelay {
	return {
		enqueue(build) {
			const row = db.getRun(runId);
			if (!row) throw new Error(`run ${runId} not found`);
			const msg = build(row.relay_out_seq + 1);
			const seq = db.appendOutbox(runId, msg);
			return { t: "relay", runId, seq, msg };
		},
		unacked: () => db.outbox(runId).map(row => ({ t: "relay", runId, seq: row.seq, msg: JSON.parse(row.payload) as RelayDown["msg"] })),
		ack(seq) {
			db.ackOutbox(runId, seq);
		},
		accept: seq => db.acceptInbound(runId, seq),
		received: () => db.getRun(runId)?.relay_in_seq ?? 0,
		clear() {
			db.ackOutbox(runId, Number.MAX_SAFE_INTEGER);
		},
	};
}
