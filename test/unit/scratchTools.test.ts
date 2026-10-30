import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import { createScratchTools, pageText, resolveInside, WRITE_MAX_BYTES } from "../../src/worker/host/scratchTools";

let base: string;
let root: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "agentbot-tools-"));
	root = join(base, "thread");
	mkdirSync(join(root, "inputs"), { recursive: true });
	mkdirSync(join(root, "outputs"), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Calls a tool's execute without a live session (the confined tools use none of the context). */
async function call(name: string, params: Record<string, unknown>): Promise<string> {
	const tool = createScratchTools(root).find(t => t.name === name) as CustomTool;
	const result = await (tool.execute as (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[] }>)("id", params, undefined, {}, undefined);
	return result.content.map(block => block.text ?? `[${block.type}]`).join("\n");
}

describe("resolveInside", () => {
	test("accepts paths inside the workspace, existing or not", async () => {
		expect(await resolveInside(root, "inputs/a.csv")).toBe(join(root, "inputs", "a.csv"));
		expect(await resolveInside(root, "outputs/new/deep.txt")).toBe(join(root, "outputs", "new", "deep.txt"));
		expect(await resolveInside(root, ".")).toBe(root);
	});

	test("rejects escapes, absolute paths and internal URLs", async () => {
		for (const bad of ["../x", "inputs/../../x", "/etc/passwd", "~/x", "local://notes.md", "skill://x", "a\0b"]) {
			await expect(resolveInside(root, bad)).rejects.toThrow();
		}
	});

	test("rejects a symlink to the outside, as target or as directory", async () => {
		writeFileSync(join(base, "secret.txt"), "secret");
		mkdirSync(join(base, "other"));
		symlinkSync(join(base, "secret.txt"), join(root, "inputs", "link.txt"));
		symlinkSync(join(base, "other"), join(root, "outputs", "dir"));
		await expect(resolveInside(root, "inputs/link.txt")).rejects.toThrow();
		await expect(resolveInside(root, "outputs/dir/new.txt")).rejects.toThrow();
		await expect(call("read_file", { path: "inputs/link.txt" })).rejects.toThrow();
	});
});

describe("confined tools", () => {
	test("write_file then read_file round-trips, and list_files shows it", async () => {
		await call("write_file", { path: "outputs/report/data.csv", content: "a,b\n1,2\n" });
		expect(readFileSync(join(root, "outputs", "report", "data.csv"), "utf8")).toBe("a,b\n1,2\n");
		expect(await call("read_file", { path: "outputs/report/data.csv" })).toBe("a,b\n1,2\n");
		const listing = await call("list_files", {});
		expect(listing).toContain("outputs/report/data.csv (8 bytes)");
	});

	test("an oversize write is rejected and writes nothing", async () => {
		await expect(call("write_file", { path: "outputs/big.txt", content: "x".repeat(WRITE_MAX_BYTES + 1) })).rejects.toThrow(/limit/);
		expect(await call("list_files", { path: "outputs" })).toBe("(empty)");
	});

	test("paths outside the workspace are refused by every tool", async () => {
		writeFileSync(join(base, "secret.txt"), "secret");
		await expect(call("read_file", { path: "../secret.txt" })).rejects.toThrow();
		await expect(call("read_file", { path: join(base, "secret.txt") })).rejects.toThrow();
		await expect(call("write_file", { path: "../evil.txt", content: "x" })).rejects.toThrow();
		await expect(call("list_files", { path: ".." })).rejects.toThrow();
	});

	test("binary files cannot be read as text", async () => {
		writeFileSync(join(root, "inputs", "blob.bin"), Buffer.from([1, 2, 0, 3]));
		await expect(call("read_file", { path: "inputs/blob.bin" })).rejects.toThrow(/binary/);
	});

	test("images come back as image content", async () => {
		writeFileSync(join(root, "inputs", "pixel.png"), Buffer.from([137, 80, 78, 71]));
		expect(await call("read_file", { path: "inputs/pixel.png" })).toContain("[image]");
	});
});

describe("pageText", () => {
	const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

	test("pages by lines with a continuation hint", () => {
		expect(pageText(text, 1, 3, 1000)).toBe("line 1\nline 2\nline 3\n\n[Showing lines 1-3 of 10. Use offset=4 to continue.]");
		expect(pageText(text, 9, 5, 1000)).toBe("line 9\nline 10");
	});

	test("caps the page by bytes", () => {
		const page = pageText(text, 1, 10, 20);
		expect(page.startsWith("line 1\nline 2\n")).toBe(true);
		expect(page).toContain("Use offset=");
		expect(page).not.toContain("line 10\n");
	});

	test("an offset past the end says so", () => {
		expect(pageText(text, 50, 5, 1000)).toContain("past the end");
	});
});
