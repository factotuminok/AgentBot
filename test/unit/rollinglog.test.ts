import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, setLogSink } from "../../src/shared/log";
import { logCapBytes, openRollingFiles, parseLogCapOverride, splitLogCap } from "../../src/shared/rollinglog";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-rolling-"));
	dirs.push(dir);
	return dir;
}

function totalBytes(dir: string): number {
	return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}

afterEach(() => {
	setLogSink(undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("rolling files", () => {
	test("delete nothing while the cap is unknown; setMaxBytes then prunes oldest first, right away", () => {
		const dir = tempDir();
		const files = openRollingFiles({ dir, prefix: "test", segmentBytes: 1000 });
		const line = "x".repeat(199); // 200 bytes with the newline
		for (let i = 0; i < 50; i++) files.append(`${i.toString().padStart(3, "0")}${line.slice(3)}`);
		expect(files.maxBytes).toBeUndefined();
		expect(totalBytes(dir)).toBe(50 * 200);
		const before = files.segments().map(s => s.name);

		files.setMaxBytes(4000);
		expect(files.maxBytes).toBe(4000);
		const after = files.segments().map(s => s.name);
		expect(totalBytes(dir)).toBeLessThanOrEqual(4000);
		expect(readdirSync(dir).length).toBe(after.length);
		// Newest first, and what's left is the newest tail of what existed.
		expect(after).toEqual(before.slice(0, after.length));
		expect(after.length).toBeLessThan(before.length);

		for (let i = 0; i < 100; i++) files.append(line);
		expect(totalBytes(dir)).toBeLessThanOrEqual(4000);
	});

	test("segment names are limited to the prefix; foreign files are not segments", () => {
		const dir = tempDir();
		const a = openRollingFiles({ dir, prefix: "alpha", maxBytes: 100_000, segmentBytes: 1000 });
		a.append("one");
		const b = openRollingFiles({ dir, prefix: "beta", maxBytes: 100_000, segmentBytes: 1000 });
		b.append("two");
		expect(a.segments().every(s => s.name.startsWith("alpha-"))).toBe(true);
		expect(b.segmentPath(a.segments()[0]!.name)).toBeUndefined();
	});

	test("as the log sink with a tiny cap, many log() calls neither recurse nor exceed the cap", () => {
		const dir = tempDir();
		const files = openRollingFiles({ dir, prefix: "orchestrator", maxBytes: 3000, segmentBytes: 500 });
		setLogSink(line => files.append(line));
		const stdout = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			for (let i = 0; i < 300; i++) log("info", "hello", { i, pad: "y".repeat(60) });
		} finally {
			process.stdout.write = stdout;
		}
		expect(totalBytes(dir)).toBeLessThanOrEqual(3000);
		expect(files.segments().length).toBeGreaterThan(1);
	});

	test("segments rotate at maxBytes / 20 by default, and lowering the cap deletes the oldest right away", () => {
		const dir = tempDir();
		const files = openRollingFiles({ dir, prefix: "agent", maxBytes: 20_000 });
		const line = "z".repeat(199);
		for (let i = 0; i < 90; i++) files.append(line);
		expect(files.segments().every(s => s.bytes <= 1000)).toBe(true);
		expect(totalBytes(dir)).toBe(90 * 200);
		files.setMaxBytes(6000);
		expect(totalBytes(dir)).toBeLessThanOrEqual(6000);
		files.append(line);
		files.append(line);
		expect(files.segments()[0]!.bytes).toBe(200); // new segments rotate at 6000 / 20 = 300 bytes
	});

	test("append never throws when the directory disappears", () => {
		const dir = tempDir();
		const files = openRollingFiles({ dir, prefix: "agent", maxBytes: 100_000 });
		rmSync(dir, { recursive: true, force: true });
		const stdout = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			expect(() => files.append("lost")).not.toThrow();
		} finally {
			process.stdout.write = stdout;
		}
	});
});

describe("logCapBytes", () => {
	test("uses maxGiB without the env override", () => {
		expect(logCapBytes(2, {})).toBe(2 * 1024 ** 3);
		expect(logCapBytes(0.1, {})).toBe(Math.floor(0.1 * 1024 ** 3));
	});

	test("the env override wins over maxGiB", () => {
		expect(logCapBytes(5, { AGENTBOT_AGENT_LOG_MAX_BYTES: "1073741824" })).toBe(1024 ** 3);
		expect(logCapBytes(5, { AGENTBOT_AGENT_LOG_MAX_BYTES: "1048576" })).toBe(1024 ** 2);
	});

	test("an invalid env override throws", () => {
		for (const bad of ["abc", "1.5", "1000", "1048575"]) {
			expect(() => logCapBytes(5, { AGENTBOT_AGENT_LOG_MAX_BYTES: bad })).toThrow(`AGENTBOT_AGENT_LOG_MAX_BYTES must be an integer ≥ 1048576, got "${bad}"`);
		}
		expect(parseLogCapOverride(undefined)).toBeUndefined();
		expect(parseLogCapOverride("")).toBeUndefined();
	});
});

describe("splitLogCap", () => {
	test("gives the process log 10% and the agent log the rest, adding up to the total", () => {
		expect(splitLogCap(1000)).toEqual({ agent: 900, process: 100 });
		const { agent, process: proc } = splitLogCap(1_000_003);
		expect(agent + proc).toBe(1_000_003);
		expect(proc).toBe(100_000);
	});
});
