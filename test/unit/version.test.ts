import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAppIdentity, readAppIdentity, writeAppIdentity } from "../../src/shared/version";

const dirs: string[] = [];

function tempApp(order: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "agentbot-identity-"));
	dirs.push(root);
	const files: Record<string, string> = {
		"package.json": JSON.stringify({ version: "1.2.0" }),
		"bun.lock": "lock",
		"src/cli.ts": "cli",
		"src/shared/log.ts": "log",
		"src/worker/main.ts": "worker",
	};
	for (const rel of order) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), files[rel]!);
	}
	return root;
}

const ALL = ["package.json", "bun.lock", "src/cli.ts", "src/shared/log.ts", "src/worker/main.ts"];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app identity", () => {
	test("is stable across calls and file creation order", async () => {
		const a = await computeAppIdentity(tempApp(ALL));
		const b = await computeAppIdentity(tempApp([...ALL].reverse()));
		expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(b).toEqual(a);
		expect(await computeAppIdentity(dirs[0]!)).toEqual(a);
	});

	test("changes when a source file, the lockfile or a file name changes", async () => {
		const root = tempApp(ALL);
		const before = (await computeAppIdentity(root)).hash;
		writeFileSync(join(root, "src/shared/log.ts"), "log2");
		const edited = (await computeAppIdentity(root)).hash;
		expect(edited).not.toBe(before);
		writeFileSync(join(root, "bun.lock"), "lock2");
		const relocked = (await computeAppIdentity(root)).hash;
		expect(relocked).not.toBe(edited);
		rmSync(join(root, "src/cli.ts"));
		writeFileSync(join(root, "src/main.ts"), "cli");
		expect((await computeAppIdentity(root)).hash).not.toBe(relocked);
	});

	test("an identity file wins over the sources", async () => {
		const root = tempApp(ALL);
		const path = join(root, "IDENTITY");
		const written = await writeAppIdentity(path, root);
		writeFileSync(join(root, "src/cli.ts"), "changed after the build");
		expect(await readAppIdentity(path, root)).toEqual(written);
		expect((await readAppIdentity(join(root, "missing"), root)).hash).not.toBe(written.hash);
	});
});
