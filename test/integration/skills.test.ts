import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSkillsRoutes } from "../../src/orchestrator/api/skills";
import { ensureOmpAssetsDir, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import type { SkillsListing } from "../../src/shared/adminSkills";
import { skillsPages } from "../../src/web/skillsPage";
import { esc } from "../../src/web/views";
import { type AdminStack, startAdminStack } from "../fixtures/adminStack";
import { makeZip } from "../fixtures/zip";

const REVIEWER = "---\nname: reviewer\ndescription: Reviews a diff\n---\nLook closely.\n";
const DEPLOY = "---\nname: deploy\ndescription: Deploys the app\n---\nRun run.sh.\n";

let stack: AdminStack | undefined;
afterEach(async () => {
	await stack?.close();
	stack = undefined;
});

async function start(): Promise<{ stack: AdminStack; ompDir: string }> {
	let ompDir = "";
	stack = await startAdminStack({
		routes: ({ stateDir }) => {
			ompDir = join(stateDir, "omp");
			return createSkillsRoutes({ ompDir });
		},
		pages: skillsPages,
	});
	await ensureOmpAssetsDir(ompDir);
	return { stack, ompDir };
}

function upload(s: AdminStack, kind: string, name: string, data: string | Uint8Array<ArrayBuffer>): Promise<Response> {
	const form = new FormData();
	form.set("kind", kind);
	form.set("file", new File([data], name));
	return s.post("/admin/skills/upload", form);
}

/** Follows the redirect after a post and returns the page with its flash. */
async function page(s: AdminStack): Promise<string> {
	const res = await s.get("/admin/skills");
	expect(res.status).toBe(200);
	return res.text();
}

describe("/admin/skills", () => {
	test("agent and SKILL.md uploads are stored by frontmatter name and listed; uploading again replaces", async () => {
		const { stack: s, ompDir } = await start();
		let res = await upload(s, "agent", "whatever.md", REVIEWER);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/skills");
		expect(await page(s)).toContain(esc('Added agent "reviewer".'));
		expect(readFileSync(join(ompDir, "agents", "reviewer.md"), "utf8")).toBe(REVIEWER);

		res = await upload(s, "skill", "SKILL.md", DEPLOY);
		expect(res.status).toBe(303);
		const html = await page(s);
		expect(html).toContain(esc('Added skill "deploy".'));
		expect(html).toContain("<code>reviewer</code>");
		expect(html).toContain("Deploys the app");
		expect(existsSync(join(ompDir, "skills", "deploy", "SKILL.md"))).toBe(true);

		const updated = REVIEWER.replace("Reviews a diff", "Reviews carefully");
		res = await upload(s, "agent", "reviewer.md", updated);
		expect(await page(s)).toContain(esc('Replaced agent "reviewer".'));
		expect(readFileSync(join(ompDir, "agents", "reviewer.md"), "utf8")).toBe(updated);

		// The admin API's listing agrees with the page.
		const listing = (await (await s.call("GET", "/skills")).json()) as SkillsListing;
		expect(listing.agents).toEqual([{ name: "reviewer", description: "Reviews carefully" }]);
		expect(listing.skills).toEqual([{ name: "deploy", description: "Deploys the app" }]);
	});

	test("a skill zip is unpacked into its folder and replaces the old folder; sessions started afterwards get it", async () => {
		const { stack: s, ompDir } = await start();
		const before = (await skillsBundle(ompDir)).hash;
		const first = makeZip([
			{ path: "deploy/" },
			{ path: "deploy/SKILL.md", data: DEPLOY, deflate: true },
			{ path: "deploy/run.sh", data: "#!/bin/sh\n", mode: 0o100755 },
			{ path: "deploy/old.txt", data: "old" },
		]);
		expect((await upload(s, "skill", "deploy.zip", first)).status).toBe(303);
		expect(await page(s)).toContain(esc('Added skill "deploy".'));
		expect(readdirSync(join(ompDir, "skills", "deploy")).sort()).toEqual(["SKILL.md", "old.txt", "run.sh"]);
		const afterFirst = (await skillsBundle(ompDir)).hash;
		expect(afterFirst).not.toBe(before);

		const second = makeZip([{ path: "SKILL.md", data: DEPLOY }, { path: "new.txt", data: "new" }]);
		expect((await upload(s, "skill", "v2.zip", second)).status).toBe(303);
		expect(await page(s)).toContain(esc('Replaced skill "deploy".'));
		expect(readdirSync(join(ompDir, "skills", "deploy")).sort()).toEqual(["SKILL.md", "new.txt"]);
		expect((await skillsBundle(ompDir)).hash).not.toBe(afterFirst);
	});

	const REJECTED: [string, string, string, () => Uint8Array<ArrayBuffer> | string, string][] = [
		["oversize zip", "skill", "big.zip", () => makeZip([{ path: "SKILL.md", data: DEPLOY }, { path: "big", data: new Uint8Array(5 * 1024 ** 2), deflate: true }]), "unpacks to more than 5 MiB"],
		["symlink in zip", "skill", "s.zip", () => makeZip([{ path: "SKILL.md", data: DEPLOY }, { path: "link", data: "/etc/passwd", mode: 0o120777 }]), "symlinks are not allowed"],
		["traversal in zip", "skill", "t.zip", () => makeZip([{ path: "SKILL.md", data: DEPLOY }, { path: "../../agents/x.md", data: "x" }]), "points outside the skill folder"],
		["zip without SKILL.md", "skill", "m.zip", () => makeZip([{ path: "README.md", data: "hi" }]), "no SKILL.md at the top"],
		["bad name in zip", "skill", "n.zip", () => makeZip([{ path: "SKILL.md", data: "---\nname: -bad\ndescription: d\n---\n" }]), "must be 1–64 lowercase letters"],
		["reserved agent name", "agent", "main.md", () => "---\nname: main\ndescription: d\n---\n", "reserved agent names"],
		["agent as zip", "agent", "a.zip", () => makeZip([{ path: "SKILL.md", data: DEPLOY }]), "only skills can be uploaded as a .zip"],
		["agent over 256 KiB", "agent", "big.md", () => `---\nname: big\ndescription: d\n---\n${"x".repeat(256 * 1024)}`, "larger than 256 KiB"],
		["not markdown", "agent", "notes.txt", () => REVIEWER, "Only .md files can be uploaded"],
	];
	for (const [what, kind, name, data, message] of REJECTED) {
		test(`rejects ${what} with the reason and changes nothing`, async () => {
			const { stack: s, ompDir } = await start();
			const res = await upload(s, kind, name, data());
			expect(res.status).toBe(400);
			const html = await res.text();
			expect(html).toContain(esc(message));
			expect(readdirSync(join(ompDir, "skills"))).toEqual([]);
			expect(readdirSync(join(ompDir, "agents"))).toEqual([]);
			expect(readdirSync(ompDir).sort()).toEqual(["agents", "skills"]);
		});
	}

	test("remove deletes a skill's whole folder or an agent's file; a missing entry is reported", async () => {
		const { stack: s, ompDir } = await start();
		await upload(s, "skill", "d.zip", makeZip([{ path: "SKILL.md", data: DEPLOY }, { path: "extra.txt", data: "x" }]));
		await upload(s, "agent", "r.md", REVIEWER);
		await page(s);

		let res = await s.post("/admin/skills/remove", { kind: "skill", name: "deploy" });
		expect(res.status).toBe(303);
		expect(await page(s)).toContain(esc('Removed skill "deploy".'));
		expect(existsSync(join(ompDir, "skills", "deploy"))).toBe(false);

		res = await s.post("/admin/skills/remove", { kind: "agent", name: "reviewer" });
		expect(await page(s)).toContain(esc('Removed agent "reviewer".'));
		expect(existsSync(join(ompDir, "agents", "reviewer.md"))).toBe(false);

		res = await s.post("/admin/skills/remove", { kind: "agent", name: "reviewer" });
		expect(res.status).toBe(303);
		expect(await page(s)).toContain(esc('No agent named "reviewer".'));
	});

	test("broken entries are listed with the reason", async () => {
		const { stack: s, ompDir } = await start();
		mkdirSync(join(ompDir, "skills", "empty"), { recursive: true });
		mkdirSync(join(ompDir, "skills", "nodesc"), { recursive: true });
		writeFileSync(join(ompDir, "skills", "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n");
		writeFileSync(join(ompDir, "agents", "noname.md"), "---\ndescription: d\n---\n");
		const html = await page(s);
		expect(html).toContain("<code>empty</code>");
		expect(html).toContain("No SKILL.md in this folder.");
		expect(html).toContain("<code>nodesc</code>");
		expect(html).toContain("<code>noname</code>");
		expect(html).toContain(esc('Missing "name" or "description" in frontmatter.'));
	});

	test("the page needs a login and uploads need the same origin", async () => {
		const { stack: s } = await start();
		const anonymous = await fetch(`${s.web.url}/admin/skills`, { redirect: "manual" });
		expect(anonymous.status).toBe(303);
		expect(anonymous.headers.get("location")).toBe("/login");
		const form = new FormData();
		form.set("kind", "agent");
		form.set("file", new File([REVIEWER], "r.md"));
		const crossSite = await fetch(`${s.web.url}/admin/skills/upload`, { method: "POST", headers: { cookie: s.cookie, origin: "https://evil.example" }, body: form });
		expect(crossSite.status).toBe(403);
	});
});
