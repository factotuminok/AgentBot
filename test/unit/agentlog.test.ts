import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentLogRun, openAgentLog } from "../../src/orchestrator/store/agentlog";
import { TRANSCRIPT_LIMITS, truncate, truncateEvent } from "../../src/shared/transcript";

const RUN: AgentLogRun = { run: "job-1", kind: "plan", repo: "acme/widgets", issue: 7, thread: "t1" };
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-agentlog-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function totalBytes(dir: string): number {
	return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}

describe("agent log", () => {
	test("rotates segments and deletes the oldest so the directory never exceeds maxBytes", async () => {
		const dir = tempDir();
		const log = await openAgentLog({ dir, maxBytes: 4000, segmentBytes: 1000 });
		const text = "x".repeat(200);
		let maxSeen = 0;
		for (let i = 0; i < 100; i++) {
			log.append(RUN, { type: "assistant", text: `${i} ${text}` });
			maxSeen = Math.max(maxSeen, totalBytes(dir));
		}
		expect(maxSeen).toBeLessThanOrEqual(4000);
		const segments = log.segments();
		expect(segments.length).toBeGreaterThan(1);
		expect(segments.every(s => s.bytes <= 1000)).toBe(true);
		// Newest first, and the newest segment holds the last entry.
		const newest = await Bun.file(join(dir, segments[0]!.name)).text();
		expect(newest.trim().split("\n").at(-1)).toContain('"text":"99 ');
		// The oldest entries were deleted with their segments.
		const all = readdirSync(dir).map(name => Bun.file(join(dir, name)));
		const contents = (await Promise.all(all.map(f => f.text()))).join("");
		expect(contents).not.toContain('"text":"0 ');
	});

	test("reopening continues sequence numbers, refills the tail, and skips a torn last line", async () => {
		const dir = tempDir();
		const first = await openAgentLog({ dir, maxBytes: 1_000_000, segmentBytes: 100_000 });
		first.append(RUN, { type: "prompt", text: "plan it" });
		first.append(RUN, { type: "tool_start", tool: "read", intent: "Reading README", args: '{"path":"README.md"}' });
		const [segment] = first.segments();
		writeFileSync(join(dir, segment!.name), '{"seq":3,"ts":"2026', { flag: "a" });

		const second = await openAgentLog({ dir, maxBytes: 1_000_000, segmentBytes: 100_000 });
		expect(second.recent(10).map(e => [e.seq, e.type])).toEqual([
			[1, "prompt"],
			[2, "tool_start"],
		]);
		second.append(RUN, { type: "assistant", text: "done" });
		expect(second.recent(1)[0]).toMatchObject({ seq: 3, type: "assistant", run: "job-1", repo: "acme/widgets", issue: 7 });
		expect(second.recent(10, 1).map(e => e.seq)).toEqual([2, 3]);
	});

	test("subscribers get every entry; oversized fields are truncated with a marker", async () => {
		const log = await openAgentLog({ dir: tempDir(), maxBytes: 10_000_000, segmentBytes: 1_000_000 });
		const seen: number[] = [];
		const unsubscribe = log.subscribe(e => seen.push(e.seq));
		log.append(RUN, { type: "tool_end", tool: "bash", isError: false, text: "y".repeat(20_000) });
		unsubscribe();
		log.append(RUN, { type: "steer", text: "ignored by the unsubscribed listener" });
		expect(seen).toEqual([1]);
		const big = log.recent(2)[0]!;
		expect(big.type === "tool_end" && big.text.length < 9000 && big.text.endsWith("more chars truncated]")).toBe(true);
	});

	test("segmentPath only resolves current segment names", async () => {
		const dir = tempDir();
		const log = await openAgentLog({ dir, maxBytes: 1_000_000, segmentBytes: 100_000 });
		log.append(RUN, { type: "assistant", text: "hi" });
		const [segment] = log.segments();
		expect(log.segmentPath(segment!.name)).toBe(join(dir, segment!.name));
		expect(log.segmentPath("../agentbot.db")).toBeUndefined();
		expect(log.segmentPath("agent-2020-01-01T00-00-00-000Z.jsonl")).toBeUndefined();
	});
});

describe("transcript truncation", () => {
	test("cuts at the limit and the marker gives the number of characters dropped", () => {
		expect(truncate("abcdef", 6)).toBe("abcdef");
		expect(truncate("abcdefgh", 5)).toBe("abcde… [3 more chars truncated]");
	});

	test("each event type truncates its own field at the OBS-03 limit", () => {
		const long = "q".repeat(70 * 1024);
		const prompt = truncateEvent({ type: "prompt", text: long });
		expect(prompt.type === "prompt" && prompt.text.startsWith("q".repeat(TRANSCRIPT_LIMITS.prompt) + "…")).toBe(true);
		expect(prompt.type === "prompt" && prompt.text.endsWith(`[${long.length - 64 * 1024} more chars truncated]`)).toBe(true);
		const start = truncateEvent({ type: "tool_start", tool: "bash", args: long });
		expect(start.type === "tool_start" && start.args.length < 5 * 1024).toBe(true);
		const usage = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const end = truncateEvent({ type: "run_end", usage, error: long });
		expect(end.type === "run_end" && end.error!.length < 5 * 1024).toBe(true);
		expect(truncateEvent({ type: "run_end", usage })).toEqual({ type: "run_end", usage });
	});
});
