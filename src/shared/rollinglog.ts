import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, log } from "./log";

/**
 * Rolling JSONL segment files in one directory (OBS-02, OBS-04): the agent transcript log and the orchestrator's
 * own process log both use it. Segments rotate at `segmentBytes`; the oldest are deleted so the directory never
 * holds more than `maxBytes`. While the cap is unknown (`maxBytes` undefined) nothing is ever deleted.
 */

export interface LogSegment {
	name: string;
	bytes: number;
	modifiedAt: string;
}

export interface RollingFiles {
	/** Appends one line (without the trailing newline); rotates first if it would overflow the current segment. Never throws. */
	append(line: string): void;
	/** Segment files, newest first. */
	segments(): LogSegment[];
	/** Absolute path of a segment by name, or undefined for anything that isn't a current segment. */
	segmentPath(name: string): string | undefined;
	/** Retention cap, or undefined while it isn't known yet. */
	readonly maxBytes: number | undefined;
	/** Sets the retention cap, recomputes the rotation size (unless pinned) and prunes right away. */
	setMaxBytes(bytes: number): void;
	/** Up to `limit` newest lines (oldest first) read from the end of the newest segments, at most `budgetBytes` in total. */
	tailLines(budgetBytes: number, limit: number): Promise<string[]>;
}

export interface RollingFilesOptions {
	dir: string;
	/** File name prefix; files are `<prefix>-<timestamp>.jsonl`. */
	prefix: string;
	/** Retention cap for all segments together; undefined until known. */
	maxBytes?: number;
	/** Rotation size; defaults to maxBytes / 20, at most 64 MiB (64 MiB while maxBytes is undefined). */
	segmentBytes?: number;
}

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 ** 3;
const MAX_SEGMENT_BYTES = 64 * 1024 ** 2;
const MIN_ENV_CAP_BYTES = 1024 * 1024;

/** Sortable, filesystem-safe segment name from the current time. */
function newSegmentName(dir: string, prefix: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	let name = `${prefix}-${stamp}.jsonl`;
	for (let i = 1; existsSync(join(dir, name)); i++) name = `${prefix}-${stamp}-${i}.jsonl`;
	return name;
}

function segmentSize(maxBytes: number | undefined): number {
	return maxBytes === undefined ? MAX_SEGMENT_BYTES : Math.min(MAX_SEGMENT_BYTES, Math.floor(maxBytes / 20));
}

function checkSizes(prefix: string, segmentBytes: number, maxBytes: number | undefined): void {
	if (segmentBytes <= 0 || (maxBytes !== undefined && segmentBytes > maxBytes)) {
		throw new Error(`Invalid ${prefix} log sizes: segment ${segmentBytes}, max ${maxBytes}`);
	}
}

export function openRollingFiles(opts: RollingFilesOptions): RollingFiles {
	const { dir, prefix } = opts;
	let maxBytes = opts.maxBytes;
	let segmentBytes = opts.segmentBytes ?? segmentSize(maxBytes);
	checkSizes(prefix, segmentBytes, maxBytes);
	mkdirSync(dir, { recursive: true });
	const segmentRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z(?:-\\d+)?\\.jsonl$`);

	/** Oldest first; the last element is the segment being written. */
	const segments: { name: string; bytes: number }[] = readdirSync(dir)
		.filter(name => segmentRe.test(name))
		.sort()
		.map(name => ({ name, bytes: statSync(join(dir, name)).size }));

	/** Deletes oldest closed segments until closed segments plus one full current segment fit in maxBytes. */
	function prune(): void {
		if (maxBytes === undefined) return;
		let closed = segments.slice(0, -1).reduce((sum, s) => sum + s.bytes, 0);
		const deleted: { name: string; bytes: number; error?: string }[] = [];
		while (segments.length > 1 && closed + segmentBytes > maxBytes) {
			const oldest = segments.shift()!;
			closed -= oldest.bytes;
			try {
				rmSync(join(dir, oldest.name), { force: true });
				deleted.push(oldest);
			} catch (err) {
				deleted.push({ ...oldest, error: errorMessage(err) });
			}
		}
		// Logged after the loop: the process log's sink appends to a store that may be this one, so state must be consistent.
		for (const { name, bytes, error } of deleted) {
			if (error === undefined) log("info", `${prefix} log segment deleted`, { segment: name, bytes });
			else log("warn", `${prefix} log segment delete failed`, { segment: name, error });
		}
	}

	function rotate(): void {
		segments.push({ name: newSegmentName(dir, prefix), bytes: 0 });
		prune();
	}

	if (segments.length === 0 || segments.at(-1)!.bytes >= segmentBytes) rotate();
	else prune();

	return {
		get maxBytes() {
			return maxBytes;
		},
		setMaxBytes(bytes) {
			const next = opts.segmentBytes ?? segmentSize(bytes);
			checkSizes(prefix, next, bytes);
			maxBytes = bytes;
			segmentBytes = next;
			prune();
		},
		append(line) {
			const text = `${line}\n`;
			const size = Buffer.byteLength(text);
			if (segments.at(-1)!.bytes + size > segmentBytes && segments.at(-1)!.bytes > 0) rotate();
			const current = segments.at(-1)!;
			try {
				appendFileSync(join(dir, current.name), text);
				current.bytes += size;
			} catch (err) {
				log("error", `${prefix} log write failed`, { segment: current.name, error: errorMessage(err) });
			}
		},
		segments: () =>
			segments
				.map(s => ({ name: s.name, bytes: s.bytes, modifiedAt: statSync(join(dir, s.name), { throwIfNoEntry: false })?.mtime.toISOString() ?? "" }))
				.filter(s => s.modifiedAt)
				.reverse(),
		segmentPath: name => (segments.some(s => s.name === name) ? join(dir, name) : undefined),
		async tailLines(budgetBytes, limit) {
			let budget = budgetBytes;
			const tail: string[] = [];
			for (let i = segments.length - 1; i >= 0 && budget > 0 && tail.length < limit; i--) {
				const seg = segments[i]!;
				if (seg.bytes === 0) continue; // the fresh current segment: its file doesn't exist until the first append
				const start = Math.max(0, seg.bytes - budget);
				const text = await Bun.file(join(dir, seg.name)).slice(start, seg.bytes).text();
				budget -= seg.bytes - start;
				const lines = text.split("\n").filter(Boolean);
				if (start > 0) lines.shift(); // first line is partial
				tail.unshift(...lines);
			}
			return tail.slice(-limit);
		},
	};
}

/** Parses `AGENTBOT_AGENT_LOG_MAX_BYTES`: undefined when unset or empty, else an integer ≥ 1 MiB; anything else throws. */
export function parseLogCapOverride(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < MIN_ENV_CAP_BYTES) throw new Error(`AGENTBOT_AGENT_LOG_MAX_BYTES must be an integer ≥ ${MIN_ENV_CAP_BYTES}, got "${raw}"`);
	return value;
}

/**
 * Total byte budget for `<state>/logs`: `AGENTBOT_AGENT_LOG_MAX_BYTES` if set (it overrides the setting),
 * otherwise `logs.maxGiB` (OBS-04).
 */
export function logCapBytes(maxGiB: number, env: Record<string, string | undefined> = process.env): number {
	return parseLogCapOverride(env.AGENTBOT_AGENT_LOG_MAX_BYTES) ?? Math.floor(maxGiB * 1024 ** 3);
}

/** Splits the total budget: 10% for the orchestrator's process log, the rest for the agent transcript log. */
export function splitLogCap(total: number): { agent: number; process: number } {
	const processShare = Math.floor(total / 10);
	return { agent: total - processShare, process: processShare };
}
