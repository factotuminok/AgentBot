import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, listedFiles, removeScratch, safeFileName, saveAttachments, scratchPaths, snapshotFiles } from "../../src/orchestrator/store/scratch";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentbot-scratch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("safeFileName (CHAT-09)", () => {
	test("keeps only the base name and replaces traversal", () => {
		expect(safeFileName("../../etc/passwd")).toBe("passwd");
		expect(safeFileName("a/b\\c.txt")).toBe("c.txt");
		expect(safeFileName("..")).toBe("_");
		expect(safeFileName("a..b.txt")).toBe("a_b.txt");
	});

	test("removes control characters and replaces unusual ones", () => {
		expect(safeFileName("na\u0000me\n.csv")).toBe("name.csv");
		expect(safeFileName("Bericht Übersicht?.csv")).toBe("Bericht _bersicht_.csv");
	});

	test("strips leading dots and spaces; empty input becomes `file`", () => {
		expect(safeFileName(".env")).toBe("env");
		expect(safeFileName("  .x.txt")).toBe("x.txt");
		expect(safeFileName("")).toBe("file");
		expect(safeFileName("/")).toBe("file");
	});

	test("caps long names at 100 characters and keeps an extension of up to 20", () => {
		const name = safeFileName(`${"x".repeat(300)}.json`);
		expect(name.length).toBe(100);
		expect(name.endsWith(".json")).toBe(true);
		const longExt = safeFileName(`a.${"e".repeat(30)}${"x".repeat(100)}`);
		expect(longExt.length).toBe(100);
	});
});

describe("saveAttachments (CHAT-08)", () => {
	test("saves files under inputs/, deduplicates names and never writes outside", async () => {
		const result = await saveAttachments(
			dir,
			[
				{ name: "../../escape.txt", url: "u1", size: 3 },
				{ name: "data.csv", url: "u2", size: 3 },
				{ name: "data.csv", url: "u3", size: 3 },
			],
			{ maxBytes: 10, maxFiles: 3, fetch: async url => new Response(`f-${url}`) },
		);
		expect(result.skipped).toEqual([]);
		expect(result.saved).toEqual(["inputs/escape.txt", "inputs/data.csv", "inputs/data-1.csv"]);
		expect(readFileSync(join(dir, "inputs", "data-1.csv"), "utf8")).toBe("f-u3");
		expect(readdirSync(dir)).toEqual(["inputs"]);
		expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
	});

	test("skips by reported size without fetching, over-limit streams, HTTP errors and failed downloads; the rest go through", async () => {
		const fetched: string[] = [];
		const result = await saveAttachments(
			dir,
			[
				{ name: "huge.bin", url: "huge", size: 11 },
				{ name: "liar.bin", url: "liar", size: 1 },
				{ name: "gone.txt", url: "gone", size: 1 },
				{ name: "net.txt", url: "net", size: 1 },
				{ name: "ok.txt", url: "ok", size: 2 },
			],
			{
				maxBytes: 10,
				maxFiles: 10,
				fetch: async url => {
					fetched.push(url);
					if (url === "liar") return new Response("x".repeat(50));
					if (url === "gone") return new Response("nope", { status: 404 });
					if (url === "net") throw new Error("socket closed");
					return new Response("ok");
				},
			},
		);
		expect(fetched).toEqual(["liar", "gone", "net", "ok"]);
		expect(result.saved).toEqual(["inputs/ok.txt"]);
		expect(result.skipped).toEqual([
			{ name: "huge.bin", reason: "larger than 10 bytes" },
			{ name: "liar.bin", reason: "larger than 10 bytes" },
			{ name: "gone.txt", reason: "download failed (HTTP 404)" },
			{ name: "net.txt", reason: "download failed" },
		]);
		expect(readdirSync(join(dir, "inputs"))).toEqual(["ok.txt"]);
	});

	test("a stream is cancelled as soon as it passes the limit", async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(6));
			},
		});
		const result = await saveAttachments(dir, [{ name: "endless.bin", url: "u", size: 1 }], {
			maxBytes: 10,
			maxFiles: 1,
			fetch: async () => new Response(stream),
		});
		expect(result.skipped).toEqual([{ name: "endless.bin", reason: "larger than 10 bytes" }]);
		expect(pulled).toBeLessThan(5);
	});

	test("files beyond the count limit are skipped", async () => {
		const items = ["a", "b", "c", "d"].map(name => ({ name: `${name}.txt`, url: name, size: 1 }));
		const result = await saveAttachments(dir, items, { maxBytes: 10, maxFiles: 3, fetch: async () => new Response("x") });
		expect(result.saved).toHaveLength(3);
		expect(result.skipped).toEqual([{ name: "d.txt", reason: "more than 3 files at once" }]);
	});
});

describe("produced files (CHAT-10)", () => {
	test("reports new and modified files, ignores unchanged files and symlinks", async () => {
		const outputs = join(dir, "outputs");
		mkdirSync(join(outputs, "sub"), { recursive: true });
		writeFileSync(join(outputs, "keep.txt"), "same");
		writeFileSync(join(outputs, "edit.txt"), "old");
		const old = new Date(Date.now() - 60_000);
		utimesSync(join(outputs, "edit.txt"), old, old);
		const before = await snapshotFiles(outputs);

		writeFileSync(join(outputs, "edit.txt"), "new content");
		writeFileSync(join(outputs, "sub", "new.csv"), "a,b");
		writeFileSync(join(dir, "secret.txt"), "secret");
		symlinkSync(join(dir, "secret.txt"), join(outputs, "link.txt"));

		const changed = await changedFiles(outputs, before);
		expect(changed.map(f => f.name)).toEqual(["edit.txt", "sub_new.csv"]);
		expect(changed.find(f => f.name === "sub_new.csv")).toMatchObject({ path: join(outputs, "sub", "new.csv"), size: 3 });
	});

	test("listed files keep regular files inside the directory only", async () => {
		const outputs = join(dir, "outputs");
		mkdirSync(join(outputs, "sub"), { recursive: true });
		writeFileSync(join(outputs, "a.txt"), "a");
		writeFileSync(join(outputs, "sub", "b.csv"), "bb");
		writeFileSync(join(dir, "secret.txt"), "secret");
		symlinkSync(join(dir, "secret.txt"), join(outputs, "link.txt"));
		const files = await listedFiles(outputs, ["sub/b.csv", "a.txt", "link.txt", "missing.txt", "../secret.txt", "a.txt"]);
		expect(files.map(f => [f.name, f.size])).toEqual([
			["a.txt", 1],
			["sub_b.csv", 2],
		]);
	});

	test("a missing directory has no files", async () => {
		expect(await snapshotFiles(join(dir, "none"))).toEqual(new Map());
	});
});

describe("removeScratch (CHAT-11)", () => {
	test("deletes a thread directory inside the root", async () => {
		const paths = scratchPaths(dir, "t1");
		mkdirSync(paths.inputs, { recursive: true });
		writeFileSync(join(paths.inputs, "a.txt"), "x");
		expect(await removeScratch(dir, paths.root)).toBe(true);
		expect(existsSync(paths.root)).toBe(false);
	});

	test("refuses the root itself and paths outside it", async () => {
		const outside = mkdtempSync(join(tmpdir(), "agentbot-outside-"));
		try {
			expect(await removeScratch(dir, outside)).toBe(false);
			expect(existsSync(outside)).toBe(true);
			expect(await removeScratch(dir, dir)).toBe(false);
			expect(await removeScratch(dir, join(dir, "..", "x"))).toBe(false);
			expect(existsSync(dir)).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
