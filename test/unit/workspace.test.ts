import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleRejected, createRepos, isRepoName, type Repos } from "../../src/orchestrator/git/repos";
import { git, gitRun } from "../../src/shared/git";

const ID = {
	GIT_AUTHOR_NAME: "Human",
	GIT_AUTHOR_EMAIL: "human@example.invalid",
	GIT_COMMITTER_NAME: "Human",
	GIT_COMMITTER_EMAIL: "human@example.invalid",
};
const REPO = "acme/widget";
const TOKEN = "ghs_secretTokenValue123";

let root: string;
let github: string;
let seed: string;
let repos: Repos;
let n = 0;

async function commitFile(dir: string, file: string, content: string, message: string): Promise<string> {
	await mkdir(join(dir, file, ".."), { recursive: true });
	await writeFile(join(dir, file), content);
	await git(["-C", dir, "add", "--", file]);
	await git(["-C", dir, "commit", "-q", "-m", message], { env: ID });
	return git(["-C", dir, "rev-parse", "HEAD"]);
}

/** A worker-like clone on `agentbot/run-<runId>` at `start`. */
async function worker(start: string, runId: string): Promise<string> {
	const dir = join(root, `w${++n}`);
	await git(["clone", "-q", github, dir]);
	await git(["-C", dir, "checkout", "-q", "-b", `agentbot/run-${runId}`, start]);
	return dir;
}

async function bundle(dir: string, range: string): Promise<string> {
	const file = join(root, `b${++n}.bundle`);
	await git(["-C", dir, "bundle", "create", "-q", file, range]);
	return file;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "agentbot-workspace-"));
	github = join(root, "github", "acme", "widget.git");
	await mkdir(github, { recursive: true });
	await git(["init", "-q", "--bare", "-b", "main", github]);
	seed = join(root, "seed");
	await git(["clone", "-q", github, seed]);
	await git(["-C", seed, "checkout", "-q", "-b", "main"]);
	await commitFile(seed, "README.md", "# widget\n", "c1");
	await commitFile(seed, "big.txt", "x".repeat(5000), "c2");
	await git(["-C", seed, "push", "-q", "origin", "main"]);
	await git(["-C", seed, "tag", "v1"]);
	await git(["-C", seed, "push", "-q", "origin", "v1"]);
	repos = createRepos({ stateDir: join(root, "state"), remoteUrl: () => `file://${github}` });
	await repos.fetch(REPO, TOKEN);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("names and paths", () => {
	test("isRepoName", () => {
		expect(isRepoName("acme/widget")).toBe(true);
		expect(isRepoName("a_b/c.d-e")).toBe(true);
		for (const bad of ["acme", "a/b/c", "../x", "acme/..", ".acme/w", "acme/.w", "a/", "/b", "a b/c", "acme/w..x"]) expect(isRepoName(bad)).toBe(false);
	});
	test("paths and validation", async () => {
		expect(repos.mirrorPath(REPO)).toBe(join(root, "state", "repos", "acme__widget.git"));
		expect(repos.runsPath(REPO)).toBe(join(root, "state", "repos", "acme__widget.runs.git"));
		expect(() => repos.mirrorPath("../etc")).toThrow();
		await expect(repos.branchHead("a/../b", "main")).rejects.toThrow();
	});
});

describe("fetch", () => {
	test("mirror config: heads and tags only, no mirror flag, no pruning of loose objects", async () => {
		const m = repos.mirrorPath(REPO);
		expect((await git(["-C", m, "config", "--get-all", "remote.origin.fetch"])).split("\n")).toEqual([
			"+refs/heads/*:refs/heads/*",
			"+refs/tags/*:refs/tags/*",
		]);
		expect((await gitRun(["-C", m, "config", "--get", "remote.origin.mirror"])).exitCode).not.toBe(0);
		expect(await git(["-C", m, "config", "--get", "gc.pruneExpire"])).toBe("never");
		expect(await git(["-C", m, "rev-parse", "refs/tags/v1"])).toBeTruthy();
		const alternates = await readFile(join(repos.runsPath(REPO), "objects", "info", "alternates"), "utf8");
		expect(alternates.trim()).toBe(join(m, "objects"));
		expect(existsSync(join(root, "state", "repos")) && (await Array.fromAsync(new Bun.Glob("*.tmp-*").scan(join(root, "state", "repos"))))).toEqual([]);
	});

	test("token never lands in config files", async () => {
		const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
		for (const dir of [repos.mirrorPath(REPO), repos.runsPath(REPO)]) {
			const cfg = await readFile(join(dir, "config"), "utf8");
			expect(cfg).not.toContain(TOKEN);
			expect(cfg).not.toContain(b64);
			expect(cfg).not.toContain("extraheader");
		}
	});

	test("fetch --prune keeps runs-repo refs and leaves refs/agentbot out of the mirror", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await worker(start, "keep");
		await commitFile(w, "k.txt", "k\n", "keep");
		await repos.importBundle(REPO, "keep", "result", await bundle(w, `${start}..agentbot/run-keep`), start);
		await git(["-C", seed, "push", "-q", "origin", "main:gone"]);
		await repos.fetch(REPO, TOKEN);
		await git(["-C", seed, "push", "-q", "origin", ":gone"]);
		await repos.fetch(REPO, TOKEN);
		expect(await repos.branchHead(REPO, "gone")).toBeUndefined();
		expect(await repos.hasRef(REPO, "keep", "result")).toBe(true);
		expect(await git(["-C", repos.mirrorPath(REPO), "for-each-ref", "refs/agentbot"])).toBe("");
		await repos.deleteRefs(REPO, "keep", ["result"]);
	});
});

describe("reading the mirror", () => {
	test("branchHead", async () => {
		expect(await repos.branchHead(REPO, "main")).toBe(await git(["-C", seed, "rev-parse", "main"]));
		expect(await repos.branchHead(REPO, "nope")).toBeUndefined();
	});
	test("readFile", async () => {
		const head = (await repos.branchHead(REPO, "main")) ?? "";
		expect(await repos.readFile(REPO, head, "README.md", 1000)).toBe("# widget\n");
		expect(await repos.readFile(REPO, head, "missing.md", 1000)).toBeUndefined();
		await expect(repos.readFile(REPO, head, "big.txt", 100)).rejects.toThrow(/limit/);
	});
});

describe("importBundle", () => {
	test("result and checkpoint import; re-import replaces the checkpoint", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await worker(start, "r1");
		await commitFile(w, "a.txt", "a\n", "a");
		await commitFile(w, "b.txt", "b\n", "b");
		expect(await repos.importBundle(REPO, "r1", "result", await bundle(w, `${start}..agentbot/run-r1`), start)).toEqual({ commits: 2 });
		expect(await repos.hasRef(REPO, "r1", "result")).toBe(true);
		expect(await gitRun(["-C", repos.mirrorPath(REPO), "cat-file", "-e", await git(["-C", w, "rev-parse", "HEAD"])])).toMatchObject({ exitCode: 1 });

		await git(["-C", w, "update-ref", "refs/agentbot/checkpoint", "HEAD~1"]);
		expect(await repos.importBundle(REPO, "r1", "checkpoint", await bundle(w, `${start}..refs/agentbot/checkpoint`), start)).toEqual({ commits: 1 });
		await git(["-C", w, "update-ref", "refs/agentbot/checkpoint", "HEAD"]);
		expect(await repos.importBundle(REPO, "r1", "checkpoint", await bundle(w, `${start}..refs/agentbot/checkpoint`), start)).toEqual({ commits: 2 });
		expect(await git(["-C", repos.runsPath(REPO), "rev-parse", "refs/agentbot/checkpoints/r1"])).toBe(await git(["-C", w, "rev-parse", "HEAD"]));
		await repos.deleteRefs(REPO, "r1", ["result", "checkpoint"]);
	});

	test("rejects a wrong prerequisite", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await worker(start, "r2");
		await commitFile(w, "a.txt", "a\n", "a");
		await commitFile(w, "b.txt", "b\n", "b");
		const file = await bundle(w, "HEAD~1..agentbot/run-r2");
		await expect(repos.importBundle(REPO, "r2", "result", file, start)).rejects.toThrow("the run rewrote the start commit");
		expect(await repos.hasRef(REPO, "r2", "result")).toBe(false);
	});

	test("rejects an amended start commit (no prerequisite)", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = join(root, "amend");
		await git(["init", "-q", w]);
		await commitFile(w, "only.txt", "x\n", "root");
		await git(["-C", w, "checkout", "-q", "-b", "agentbot/run-r3"]);
		const file = await bundle(w, "agentbot/run-r3");
		const err = await repos.importBundle(REPO, "r3", "result", file, start).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BundleRejected);
		expect((err as Error).message).toBe("the run rewrote the start commit");
	});

	test("rejects a wrong head and a non-bundle", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await worker(start, "r4");
		await commitFile(w, "a.txt", "a\n", "a");
		await expect(repos.importBundle(REPO, "other", "result", await bundle(w, `${start}..agentbot/run-r4`), start)).rejects.toBeInstanceOf(BundleRejected);
		await expect(repos.importBundle(REPO, "r4", "checkpoint", await bundle(w, `${start}..agentbot/run-r4`), start)).rejects.toBeInstanceOf(BundleRejected);
		const junk = join(root, "junk.bundle");
		await writeFile(junk, "hello\n\n");
		await expect(repos.importBundle(REPO, "r4", "result", junk, start)).rejects.toBeInstanceOf(BundleRejected);
	});
});

describe("push", () => {
	test("creates a branch, fast-forwards, rejects a moved branch before and after a mirror fetch", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await worker(start, "p1");
		const head = await commitFile(w, "p.txt", "p\n", "p");
		await repos.importBundle(REPO, "p1", "result", await bundle(w, `${start}..agentbot/run-p1`), start);
		expect(await repos.push(REPO, "p1", "agentbot/issue-1", TOKEN)).toEqual({ pushed: true, sha: head });
		expect(await git(["-C", github, "rev-parse", "refs/heads/agentbot/issue-1"])).toBe(head);
		expect(await repos.hasRef(REPO, "p1", "result")).toBe(true);
		await repos.deleteRefs(REPO, "p1", ["result"]);

		// fast-forward of an existing branch
		await repos.fetch(REPO, TOKEN);
		const w2 = await worker(head, "p2");
		const head2 = await commitFile(w2, "p2.txt", "p2\n", "p2");
		await repos.importBundle(REPO, "p2", "result", await bundle(w2, `${head}..agentbot/run-p2`), head);
		expect(await repos.push(REPO, "p2", "agentbot/issue-1", TOKEN)).toEqual({ pushed: true, sha: head2 });

		// a human moves the branch meanwhile
		const w3 = await worker(head2, "p3");
		await commitFile(w3, "p3.txt", "p3\n", "p3");
		await repos.importBundle(REPO, "p3", "result", await bundle(w3, `${head2}..agentbot/run-p3`), head2);
		await git(["-C", seed, "fetch", "-q", "origin"]);
		await git(["-C", seed, "checkout", "-q", "-B", "issue", "origin/agentbot/issue-1"]);
		const human = await commitFile(seed, "human.txt", "h\n", "human");
		await git(["-C", seed, "push", "-q", "origin", "issue:agentbot/issue-1"]);
		expect(await repos.push(REPO, "p3", "agentbot/issue-1", TOKEN)).toEqual({ pushed: false });
		await repos.fetch(REPO, TOKEN);
		expect(await repos.hasRef(REPO, "p3", "result")).toBe(true);
		expect(await repos.push(REPO, "p3", "agentbot/issue-1", TOKEN)).toEqual({ pushed: false });
		expect(await git(["-C", github, "rev-parse", "refs/heads/agentbot/issue-1"])).toBe(human);
		await repos.deleteRefs(REPO, "p2", ["result"]);
		await repos.deleteRefs(REPO, "p3", ["result"]);
	});
});

describe("refs and repos bookkeeping", () => {
	test("deleteRefs is idempotent; listRunRefs lists refs and skips broken repos", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await worker(start, "l1");
		await commitFile(w, "l.txt", "l\n", "l");
		await repos.importBundle(REPO, "l1", "result", await bundle(w, `${start}..agentbot/run-l1`), start);
		await git(["-C", w, "update-ref", "refs/agentbot/checkpoint", "HEAD"]);
		await repos.importBundle(REPO, "l1", "checkpoint", await bundle(w, `${start}..refs/agentbot/checkpoint`), start);
		await mkdir(join(root, "state", "repos", "broken__repo.runs.git"));
		expect((await repos.listRunRefs()).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
			{ repo: REPO, runId: "l1", kind: "checkpoint" },
			{ repo: REPO, runId: "l1", kind: "result" },
		]);
		await repos.deleteRefs(REPO, "l1", ["result", "checkpoint"]);
		await repos.deleteRefs(REPO, "l1", ["result", "checkpoint"]);
		await repos.deleteRefs("nobody/none", "l1", ["result"]);
		expect(await repos.listRunRefs()).toEqual([]);
		await rm(join(root, "state", "repos", "broken__repo.runs.git"), { recursive: true });
	});

	test("mirrors() and remove()", async () => {
		const before = Date.now();
		await repos.fetch(REPO, TOKEN);
		const list = await repos.mirrors();
		expect(list.map((m) => m.repo)).toEqual([REPO]);
		expect(list[0]?.lastUsed.getTime()).toBeGreaterThanOrEqual(before - 2000);
		await repos.remove(REPO);
		expect(existsSync(repos.mirrorPath(REPO))).toBe(false);
		expect(existsSync(repos.runsPath(REPO))).toBe(false);
		expect(await repos.mirrors()).toEqual([]);
		await repos.fetch(REPO, TOKEN);
		expect(await repos.branchHead(REPO, "main")).toBeTruthy();
	});

	test("operations on one repository wait for each other in order; other repositories are not held up (WS-01, STO-03)", async () => {
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// A GitHub that hangs on the clone of acme/slow until the test releases it.
		const slow = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async () => {
				requested.resolve();
				await release.promise;
				return new Response("not found", { status: 404 });
			},
		});
		try {
			const locked = createRepos({
				stateDir: join(root, "state-lock"),
				remoteUrl: repo => (repo === "acme/slow" ? `http://127.0.0.1:${slow.port}/acme/slow.git` : `file://${github}`),
			});
			const order: string[] = [];
			const fetched = locked.fetch("acme/slow", TOKEN).then(
				() => order.push("fetch"),
				() => order.push("fetch failed"),
			);
			await requested.promise;
			const head = locked.branchHead("acme/slow", "main").then(() => order.push("branchHead"));
			const removed = locked.remove("acme/slow").then(() => order.push("remove"));

			// Another repository's mirror is cloned and read while acme/slow is held.
			await locked.fetch(REPO, TOKEN);
			expect(await locked.branchHead(REPO, "main")).toBeTruthy();
			expect(order).toEqual([]);

			release.resolve();
			await Promise.all([fetched, head, removed]);
			expect(order).toEqual(["fetch failed", "branchHead", "remove"]);
		} finally {
			release.resolve();
			slow.stop(true);
		}
	});
});
