import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOmpAssetsDir, MAX_SKILL_BYTES, readSkillZip, saveSkillZip, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import { makeZip } from "../fixtures/zip";

const SKILL_MD = "---\nname: deploy\ndescription: Deploys the app\n---\nRun scripts/deploy.sh.\n";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agentbot-skillzip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readSkillZip", () => {
	test("SKILL.md at the archive root, deflated and stored entries, the executable bit kept", () => {
		const zip = makeZip([
			{ path: "SKILL.md", data: SKILL_MD, deflate: true },
			{ path: "scripts/", mode: 0o040755 },
			{ path: "scripts/deploy.sh", data: "#!/bin/sh\necho hi\n", mode: 0o100755 },
			{ path: "notes/readme.txt", data: "x".repeat(5000), deflate: true },
		]);
		const { name, files } = readSkillZip("deploy.zip", zip);
		expect(name).toBe("deploy");
		expect(files.map(f => f.path)).toEqual(["SKILL.md", "scripts/", "scripts/deploy.sh", "notes/readme.txt"]);
		expect(files.find(f => f.path === "scripts/deploy.sh")?.executable).toBe(true);
		expect(new TextDecoder().decode(files.find(f => f.path === "notes/readme.txt")!.data)).toBe("x".repeat(5000));
	});

	test("a zip of the skill folder itself is unpacked without that folder; Finder metadata is skipped", () => {
		const zip = makeZip([
			{ path: "whatever-folder/" },
			{ path: "whatever-folder/SKILL.md", data: SKILL_MD },
			{ path: "whatever-folder/ref.md", data: "ref" },
			{ path: "__MACOSX/whatever-folder/._SKILL.md", data: "junk" },
		]);
		const { name, files } = readSkillZip("x.zip", zip);
		expect(name).toBe("deploy");
		expect(files.map(f => f.path)).toEqual(["SKILL.md", "ref.md"]);
	});

	const REJECTIONS: [string, Uint8Array, RegExp][] = [
		["not a zip", new TextEncoder().encode("plain text"), /not a valid zip/],
		["no SKILL.md", makeZip([{ path: "README.md", data: "hi" }]), /no SKILL\.md at the top/],
		["SKILL.md only below the top", makeZip([{ path: "a/b/SKILL.md", data: SKILL_MD }]), /no SKILL\.md at the top/],
		["two top-level folders", makeZip([{ path: "a/SKILL.md", data: SKILL_MD }, { path: "b/x", data: "x" }]), /no SKILL\.md at the top/],
		["a parent-directory path", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "../evil.sh", data: "x" }]), /"\.\.\/evil\.sh" points outside the skill folder/],
		["a nested escape", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "a/../../evil", data: "x" }]), /points outside the skill folder/],
		["an absolute path", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "/etc/cron.d/x", data: "x" }]), /points outside the skill folder/],
		["a backslash path", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "..\\evil", data: "x" }]), /points outside the skill folder/],
		["a symlink", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "link", data: "/etc/passwd", mode: 0o120777 }]), /"link" is a symlink/],
		["a device file", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "dev", mode: 0o020644 }]), /not a regular file/],
		["more than 5 MiB unpacked", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "big.bin", data: new Uint8Array(MAX_SKILL_BYTES), deflate: true }]), /unpacks to more than 5 MiB/],
		["a size that lies", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "bomb", data: new Uint8Array(100_000), deflate: true, declaredSize: 10 }]), /"bomb" is damaged/],
		["a bad CRC", makeZip([{ path: "SKILL.md", data: SKILL_MD, crc: 1 }]), /"SKILL\.md" is damaged/],
		["a duplicate entry", makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "SKILL.md", data: SKILL_MD }]), /appears more than once/],
		["a bad name", makeZip([{ path: "SKILL.md", data: "---\nname: Bad_Name\ndescription: d\n---\n" }]), /Name "Bad_Name" must be/],
		["no description", makeZip([{ path: "SKILL.md", data: "---\nname: ok\ndescription: \"\"\n---\n" }]), /non-empty "description"/],
		["no frontmatter", makeZip([{ path: "SKILL.md", data: "# Just text\n" }]), /no YAML frontmatter/],
	];
	for (const [what, zip, message] of REJECTIONS) {
		test(`rejects ${what}`, () => {
			expect(() => readSkillZip("skill.zip", zip)).toThrow(message);
		});
	}

	test("exactly 5 MiB unpacked is accepted", () => {
		const skill = new TextEncoder().encode(SKILL_MD);
		const zip = makeZip([{ path: "SKILL.md", data: skill }, { path: "fill.bin", data: new Uint8Array(MAX_SKILL_BYTES - skill.length), deflate: true }]);
		expect(readSkillZip("skill.zip", zip).name).toBe("deploy");
	});
});

describe("saveSkillZip", () => {
	test("stores the folder under the frontmatter name and replaces a previous folder whole", async () => {
		await ensureOmpAssetsDir(dir);
		const first = makeZip([
			{ path: "SKILL.md", data: SKILL_MD },
			{ path: "old.txt", data: "old" },
			{ path: "run.sh", data: "#!/bin/sh\n", mode: 0o100755 },
		]);
		expect(await saveSkillZip(dir, "first.zip", first)).toEqual({ name: "deploy", replaced: false });
		expect(readFileSync(join(dir, "skills", "deploy", "old.txt"), "utf8")).toBe("old");
		expect(statSync(join(dir, "skills", "deploy", "run.sh")).mode & 0o777).toBe(0o755);
		const before = (await skillsBundle(dir)).hash;

		const second = makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "new.txt", data: "new" }]);
		expect(await saveSkillZip(dir, "second.zip", second)).toEqual({ name: "deploy", replaced: true });
		expect(readdirSync(join(dir, "skills", "deploy")).sort()).toEqual(["SKILL.md", "new.txt"]);
		// Nothing staged is left next to skills/ and agents/; the bundle reflects the new folder (AGT-26).
		expect(readdirSync(dir).sort()).toEqual(["agents", "skills"]);
		expect((await skillsBundle(dir)).hash).not.toBe(before);
	});

	test("a rejected zip changes nothing", async () => {
		await ensureOmpAssetsDir(dir);
		await saveSkillZip(dir, "ok.zip", makeZip([{ path: "SKILL.md", data: SKILL_MD }]));
		const bad = makeZip([{ path: "SKILL.md", data: SKILL_MD }, { path: "../x", data: "x" }]);
		await expect(saveSkillZip(dir, "bad.zip", bad)).rejects.toThrow(/points outside/);
		expect(readdirSync(join(dir, "skills", "deploy"))).toEqual(["SKILL.md"]);
		expect(existsSync(join(dir, "x"))).toBe(false);
		expect(readdirSync(dir).sort()).toEqual(["agents", "skills"]);
	});

	test("ensureOmpAssetsDir removes leftovers of an interrupted upload", async () => {
		const stale = join(dir, `.upload-${crypto.randomUUID()}`);
		mkdirSync(stale);
		writeFileSync(join(stale, "SKILL.md"), SKILL_MD);
		await ensureOmpAssetsDir(dir);
		expect(readdirSync(dir).sort()).toEqual(["agents", "skills"]);
	});
});
