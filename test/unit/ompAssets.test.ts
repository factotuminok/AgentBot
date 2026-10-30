import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOmpAssets, MAX_ASSET_BYTES, type OmpAssetKind, parseOmpAsset, removeOmpAsset, saveOmpAsset, skillsBundle } from "../../src/orchestrator/store/ompAssets";

const REVIEWER = "---\nname: reviewer\ndescription: Reviews a diff\n---\nLook closely.\n";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentbot-ompassets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("omp assets", () => {
	test("saving an agent creates it, saving again replaces it", async () => {
		expect(await saveOmpAsset(dir, "agent", "reviewer.md", REVIEWER)).toEqual({ name: "reviewer", replaced: false });
		expect(readFileSync(join(dir, "agents", "reviewer.md"), "utf8")).toBe(REVIEWER);
		expect(await saveOmpAsset(dir, "agent", "whatever.md", REVIEWER)).toEqual({ name: "reviewer", replaced: true });
		expect(readdirSync(join(dir, "agents"))).toEqual(["reviewer.md"]);
	});

	test("the frontmatter name places a skill; removing deletes its whole folder", async () => {
		const skill = "---\nname: my-skill\ndescription: Does a thing\n---\nSteps.\n";
		expect(await saveOmpAsset(dir, "skill", "SKILL.md", skill)).toEqual({ name: "my-skill", replaced: false });
		expect(existsSync(join(dir, "skills", "my-skill", "SKILL.md"))).toBe(true);
		writeFileSync(join(dir, "skills", "my-skill", "notes.txt"), "kept on replace");
		await saveOmpAsset(dir, "skill", "SKILL.md", skill);
		expect(existsSync(join(dir, "skills", "my-skill", "notes.txt"))).toBe(true);

		expect(await removeOmpAsset(dir, "skill", "my-skill")).toBe(true);
		expect(existsSync(join(dir, "skills", "my-skill"))).toBe(false);
		expect(await removeOmpAsset(dir, "skill", "my-skill")).toBe(false);
		expect(await removeOmpAsset(dir, "agent", "../x")).toBe(false);
	});

	const REJECTIONS: [string, OmpAssetKind, string, string, string][] = [
		["no frontmatter", "skill", "a.md", "# Title\n", "no YAML frontmatter"],
		["missing description", "agent", "a.md", "---\nname: a\n---\n", "description"],
		["traversal name", "skill", "a.md", "---\nname: ../evil\ndescription: x\n---\n", '"../evil"'],
		["uppercase name", "agent", "a.md", "---\nname: Big\ndescription: x\n---\n", '"Big"'],
		["reserved agent name main", "agent", "main.md", "---\nname: main\ndescription: x\n---\n", "reserved"],
		["reserved agent name sub", "agent", "x.md", "---\nname: sub\ndescription: x\n---\n", "reserved"],
		["non-markdown file", "skill", "a.txt", "---\nname: a\ndescription: x\n---\n", "a.txt"],
		["oversized file", "skill", "a.md", "---\nname: a\ndescription: x\n---\n".padEnd(MAX_ASSET_BYTES + 1, "x"), "256 KiB"],
	];
	for (const [what, kind, fileName, content, message] of REJECTIONS) {
		test(`rejects ${what}`, async () => {
			await expect(saveOmpAsset(dir, kind, fileName, content)).rejects.toThrow(message);
			expect(readdirSync(dir)).toEqual([]);
		});
	}

	test("a file of exactly 256 KiB is accepted; main and sub are fine as skill names", () => {
		const content = "---\nname: a\ndescription: x\n---\n".padEnd(MAX_ASSET_BYTES, "x");
		expect(parseOmpAsset("skill", "a.md", content).name).toBe("a");
		expect(parseOmpAsset("skill", "SKILL.md", "---\nname: main\ndescription: x\n---\n").name).toBe("main");
	});

	test("listing reports entries omp would skip", async () => {
		await saveOmpAsset(dir, "skill", "SKILL.md", "---\nname: good\ndescription: Fine\n---\n");
		mkdirSync(join(dir, "skills", "empty"));
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(join(dir, "agents", "broken.md"), "no frontmatter here\n");
		writeFileSync(join(dir, "agents", "readme.txt"), "ignored");
		expect(await listOmpAssets(dir)).toEqual({
			skills: [{ name: "empty", problem: "No SKILL.md in this folder." }, { name: "good", description: "Fine" }],
			agents: [{ name: "broken", problem: 'Missing "name" or "description" in frontmatter.' }],
		});
	});

	test("listing a missing directory is empty", async () => {
		expect(await listOmpAssets(join(dir, "nope"))).toEqual({ skills: [], agents: [] });
	});
});

describe("skillsBundle", () => {
	async function populate(root: string): Promise<void> {
		await saveOmpAsset(root, "skill", "SKILL.md", "---\nname: build\ndescription: Builds\n---\nRun it.\n");
		await saveOmpAsset(root, "agent", "reviewer.md", REVIEWER);
		const deep = join(root, "skills", "build", "scripts", "a-rather-long-folder-name-to-push-the-path", "past-one-hundred-bytes");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(deep, "helper-script-with-a-long-name.sh"), "#!/bin/sh\necho hi\n");
		chmodSync(join(deep, "helper-script-with-a-long-name.sh"), 0o755);
	}

	async function extract(tar: Uint8Array): Promise<Record<string, string>> {
		const files = await new Bun.Archive(tar).files();
		const out: Record<string, string> = {};
		for (const [path, file] of files) out[path] = await file.text();
		return out;
	}

	test("equal trees give byte-identical bundles regardless of when or where they were written", async () => {
		const a = join(dir, "a");
		const b = join(dir, "b");
		await populate(a);
		await populate(b);
		utimesSync(join(b, "agents", "reviewer.md"), new Date(2001, 1, 1), new Date(2001, 1, 1));
		const [ba, bb] = [await skillsBundle(a), await skillsBundle(b)];
		expect(ba.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(bb.hash).toBe(ba.hash);
		expect(Buffer.from(bb.tar).equals(Buffer.from(ba.tar))).toBe(true);
	});

	test("the tar extracts to the skills and agents tree, long paths included", async () => {
		await populate(dir);
		writeFileSync(join(dir, "agents", "notes.txt"), "not an agent");
		writeFileSync(join(dir, "agents", `x.md.tmp-${crypto.randomUUID()}`), "half-written");
		symlinkSync("/etc/passwd", join(dir, "skills", "build", "leak"));
		writeFileSync(join(dir, "stray.txt"), "outside the tree");
		const files = await extract((await skillsBundle(dir)).tar);
		const longPath = "skills/build/scripts/a-rather-long-folder-name-to-push-the-path/past-one-hundred-bytes/helper-script-with-a-long-name.sh";
		expect(Object.keys(files).sort()).toEqual(["agents/reviewer.md", "skills/build/SKILL.md", longPath]);
		expect(files["agents/reviewer.md"]).toBe(REVIEWER);
		expect(files[longPath]).toBe("#!/bin/sh\necho hi\n");
	});

	test("the bundle is cached until the tree changes", async () => {
		await populate(dir);
		const first = await skillsBundle(dir);
		expect(await skillsBundle(dir)).toBe(first);
		await saveOmpAsset(dir, "agent", "other.md", "---\nname: other\ndescription: Another\n---\n");
		const second = await skillsBundle(dir);
		expect(second.hash).not.toBe(first.hash);
		expect(Object.keys(await extract(second.tar))).toContain("agents/other.md");
		await removeOmpAsset(dir, "agent", "other");
		expect((await skillsBundle(dir)).hash).toBe(first.hash);
	});

	test("a missing directory gives an empty bundle", async () => {
		const bundle = await skillsBundle(join(dir, "nope"));
		expect(bundle.tar.length).toBe(1024);
		expect(await extract(bundle.tar)).toEqual({});
	});
});
