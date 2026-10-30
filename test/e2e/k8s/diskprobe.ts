// Disk latency probe for the load test's orchestrator (test/e2e/k8s/orchestrator.ts runs it as a child process, so its
// own stalls never block the orchestrator's event loop): every 500 ms, in the directory given as the first argument (the
// state volume), it appends a log-sized line without fsync (like the rolling process log) and writes + fsyncs a page
// (like an SQLite WAL commit with synchronous=FULL), and prints `{"at","appendMs","fsyncMs"}` per probe. It exits once
// the process given as the second argument (its parent) is gone.
import { appendFileSync, closeSync, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? ".";
const parent = Number(process.argv[3] ?? process.ppid);
const appendFile = join(dir, "diskprobe-append.log");
const syncFile = join(dir, "diskprobe-sync.bin");
const page = new Uint8Array(4096).fill(1);
const line = `${"x".repeat(199)}\n`;
let appended = 0;

for (;;) {
	try {
		process.kill(parent, 0);
	} catch {
		process.exit(0);
	}
	const t0 = performance.now();
	appendFileSync(appendFile, line);
	const t1 = performance.now();
	const fd = openSync(syncFile, "w");
	writeSync(fd, page);
	fsyncSync(fd);
	closeSync(fd);
	const t2 = performance.now();
	console.log(JSON.stringify({ at: new Date().toISOString(), appendMs: Math.round(t1 - t0), fsyncMs: Math.round(t2 - t1) }));
	if (++appended % 10_000 === 0) rmSync(appendFile, { force: true });
	await Bun.sleep(500);
}
