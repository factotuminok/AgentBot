import { errorMessage, log, redactSecrets } from "../../shared/log";
import { type LogSegment, openRollingFiles } from "../../shared/rollinglog";
import { type TranscriptEvent, truncateEvent } from "../../shared/transcript";

/**
 * Rolling agent transcript log (OBS-03): every agent run's prompts, steering, assistant text, tool calls and
 * results, forwarded by workers, go to JSONL segment files under `<state>/logs/agent`, kept by the shared rolling
 * store (`rollinglog.ts`). The cap is the agent share of `logs.maxGiB` (OBS-04). The newest entries stay in memory
 * for the web tail, and subscribers receive every new entry.
 */

/** Which run an event belongs to; supplied by the orchestrator from the run record, not by the worker. */
export interface AgentLogRun {
	/** jobId, or `chat-<threadId>` for chats. */
	run: string;
	/** The run kind (`plan`, `implement`, `chat`, …). */
	kind: string;
	repo: string;
	issue?: number;
	thread?: string;
}

export type AgentLogEntry = AgentLogRun & TranscriptEvent & { seq: number; ts: string };

export interface AgentLog {
	/** Never throws (OBS-04). */
	append(run: AgentLogRun, event: TranscriptEvent): void;
	/** Up to `limit` newest entries (oldest first), optionally only those with `seq > afterSeq`. */
	recent(limit: number, afterSeq?: number): AgentLogEntry[];
	subscribe(listener: (entry: AgentLogEntry) => void): () => void;
	/** Segment files, newest first. */
	segments(): LogSegment[];
	/** Absolute path of a segment by name, or undefined for anything that isn't a current segment. */
	segmentPath(name: string): string | undefined;
	/** Retention cap, or undefined while it isn't known yet (nothing is deleted until it is). */
	readonly maxBytes: number | undefined;
	/** Sets the retention cap and prunes right away. */
	setMaxBytes(bytes: number): void;
}

export interface AgentLogOptions {
	dir: string;
	/** Retention cap for all segments together; undefined until known (nothing is deleted meanwhile). */
	maxBytes?: number;
	/** Rotation size; defaults to maxBytes / 20, at most 64 MiB. */
	segmentBytes?: number;
	/** Entries kept in memory for the tail page. */
	recentLimit?: number;
}

const DEFAULT_RECENT = 2000;
/** Bytes read from the end of the newest segments at startup to refill the in-memory tail. */
const STARTUP_TAIL_BYTES = 4 * 1024 ** 2;

export async function openAgentLog(opts: AgentLogOptions): Promise<AgentLog> {
	const recentLimit = opts.recentLimit ?? DEFAULT_RECENT;
	const files = openRollingFiles({ dir: opts.dir, prefix: "agent", maxBytes: opts.maxBytes, segmentBytes: opts.segmentBytes });
	const recent: AgentLogEntry[] = [];
	const listeners = new Set<(entry: AgentLogEntry) => void>();
	let seq = 0;

	// Refill the tail from the newest segments so the page shows history across restarts.
	for (const line of await files.tailLines(STARTUP_TAIL_BYTES, recentLimit)) {
		try {
			const entry = JSON.parse(line) as AgentLogEntry;
			recent.push(entry);
			seq = Math.max(seq, entry.seq);
		} catch {
			// A crash can leave a torn final line; skip it.
		}
	}

	return {
		get maxBytes() {
			return files.maxBytes;
		},
		setMaxBytes: bytes => files.setMaxBytes(bytes),
		append(run, event) {
			let entry: AgentLogEntry;
			try {
				entry = { seq: ++seq, ts: new Date().toISOString(), ...run, ...truncateEvent(event) } as AgentLogEntry;
				// F9: a token an agent printed (or a tool argument carrying one) is masked in the file, the tail and the stream.
				const raw = JSON.stringify(entry);
				const text = redactSecrets(raw);
				if (text !== raw) entry = JSON.parse(text) as AgentLogEntry;
				files.append(text);
			} catch (err) {
				log("error", "agent log append failed", { run: run.run, error: errorMessage(err) });
				return;
			}
			recent.push(entry);
			if (recent.length > recentLimit) recent.splice(0, recent.length - recentLimit);
			for (const listener of listeners) {
				try {
					listener(entry);
				} catch (err) {
					log("warn", "agent log listener failed", { error: errorMessage(err) });
				}
			}
		},
		recent(limit, afterSeq) {
			const pool = afterSeq === undefined ? recent : recent.filter(e => e.seq > afterSeq);
			return pool.slice(-limit);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		segments: () => files.segments(),
		segmentPath: name => files.segmentPath(name),
	};
}
