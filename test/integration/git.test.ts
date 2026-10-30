/** Spike S3 as an integration test: the git endpoint, worker checkouts, bundles, import, restore and push. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitEndpoint, MAX_GIT_REQUESTS_PER_LEASE } from "../../src/orchestrator/git/endpoint";
import { createRepos, type Repos } from "../../src/orchestrator/git/repos";
import { git, gitRun } from "../../src/shared/git";
import { CHECKPOINT_REF, GIT_PATH_PREFIX, runBranch } from "../../src/shared/wire";
import { endpointRemote, makeCheckout } from "../../src/worker/checkout";

const ID = {
	GIT_AUTHOR_NAME: "AgentBot",
	GIT_AUTHOR_EMAIL: "agentbot@example.invalid",
	GIT_COMMITTER_NAME: "AgentBot",
	GIT_COMMITTER_EMAIL: "agentbot@example.invalid",
};
const REPO = "acme/widget";

let root: string;
let github: string;
let seed: string;
let repos: Repos;
let server: Server<undefined>;
let base: string;
let repoUrl: string;
const leases = new Map<string, string>();
const requests: { path: string; status: number; protocol: string; gzip: boolean; authorization: string }[] = [];
let n = 0;

function leaseEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${base}${GIT_PATH_PREFIX}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
	};
}

function lease(repo: string): string {
	const token = crypto.randomUUID();
	leases.set(token, repo);
	return token;
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<string> {
	await mkdir(join(dir, file, ".."), { recursive: true });
	await writeFile(join(dir, file), content);
	await git(["-C", dir, "add", "--", file]);
	await git(["-C", dir, "commit", "-q", "-m", message], { env: ID });
	return git(["-C", dir, "rev-parse", "HEAD"]);
}

/** S3 §Worker commands: empty repo, depth-1 fetch of the start sha, temp branch. */
async function workerCheckout(token: string, start: string, runId: string, extra: string[] = []): Promise<string> {
	const dir = join(root, `w${++n}`);
	await mkdir(dir);
	await git(["init", "-q", dir]);
	await git(["-C", dir, ...extra, "fetch", "-q", "--depth=1", "--no-tags", repoUrl, start], { env: leaseEnv(token) });
	await git(["-C", dir, "checkout", "-q", "-b", runBranch(runId), start]);
	return dir;
}

/** S3 checkpoint: a commit of the whole working tree built in a throwaway index, bundled as start..CHECKPOINT_REF. */
async function workerCheckpoint(dir: string, start: string): Promise<{ commit: string; file: string }> {
	const env = { GIT_INDEX_FILE: join(dir, ".git", "agentbot-checkpoint.index") };
	try {
		await git(["-C", dir, "read-tree", "HEAD"], { env });
		await git(["-C", dir, "add", "-A"], { env });
		const tree = await git(["-C", dir, "write-tree"], { env });
		const commit = await git(["-C", dir, "commit-tree", tree, "-p", "HEAD", "-m", "AgentBot checkpoint"], { env: ID });
		await git(["-C", dir, "update-ref", CHECKPOINT_REF, commit]);
		const file = join(root, `cp${++n}.bundle`);
		await git(["-C", dir, "bundle", "create", "-q", file, `${start}..${CHECKPOINT_REF}`]);
		return { commit, file };
	} finally {
		await rm(env.GIT_INDEX_FILE, { force: true });
	}
}

async function probe(token: string, sha: string, version: string) {
	const dir = join(root, `probe${++n}`);
	await git(["init", "-q", dir]);
	const r = await gitRun(["-C", dir, "-c", `protocol.version=${version}`, "fetch", "-q", "--depth=1", "--no-tags", repoUrl, sha], {
		env: leaseEnv(token),
	});
	await rm(dir, { recursive: true, force: true });
	return r;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "agentbot-git-"));
	github = join(root, "github", "acme", "widget.git");
	await mkdir(github, { recursive: true });
	await git(["init", "-q", "--bare", "-b", "main", github]);
	seed = join(root, "seed");
	await git(["clone", "-q", github, seed]);
	await git(["-C", seed, "checkout", "-q", "-b", "main"]);
	await writeFile(join(seed, ".gitignore"), "*.log\n");
	await git(["-C", seed, "add", ".gitignore"]);
	await git(["-C", seed, "commit", "-q", "-m", "c1"], { env: ID });
	await commitFile(seed, "README.md", "# widget\n", "c2");
	await commitFile(seed, "src/main.txt", "main v1\n", "c3");
	await git(["-C", seed, "push", "-q", "origin", "main"]);
	repos = createRepos({ stateDir: join(root, "state"), remoteUrl: () => `file://${github}` });
	await repos.fetch(REPO, "unused");
	const handler = createGitEndpoint({ repos, authorize: (token) => leases.get(token) });
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 120,
		async fetch(req) {
			const res = await handler(req);
			requests.push({
				path: new URL(req.url).pathname,
				status: res.status,
				protocol: req.headers.get("git-protocol") ?? "",
				gzip: /gzip/i.test(req.headers.get("content-encoding") ?? ""),
				authorization: req.headers.get("authorization") ?? "",
			});
			return res;
		},
	});
	base = `http://127.0.0.1:${server.port}`;
	repoUrl = `${base}${GIT_PATH_PREFIX}acme/widget.git`;
});

afterAll(async () => {
	server?.stop(true);
	await rm(root, { recursive: true, force: true });
});

describe("run flow", () => {
	test("checkout, checkpoint, restore, result import, push (protocol v2)", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const token = lease(REPO);
		const w1 = await workerCheckout(token, start, "r1");
		expect(await git(["-C", w1, "rev-parse", "--is-shallow-repository"])).toBe("true");
		expect(await readFile(join(w1, ".git", "config"), "utf8")).not.toContain(token);
		expect(requests.some((r) => r.protocol.includes("version=2"))).toBe(true);

		const w1Head = await commitFile(w1, "src/feature.txt", "feature\n", "r1: feature");
		await writeFile(join(w1, "README.md"), "# widget\nuncommitted\n");
		await writeFile(join(w1, "scratch.txt"), "untracked\n");
		await writeFile(join(w1, "debug.log"), "ignored\n");
		const cp = await workerCheckpoint(w1, start);
		expect(await repos.importBundle(REPO, "r1", "checkpoint", cp.file, start)).toEqual({ commits: 2 });
		await rm(w1, { recursive: true, force: true });

		// resumed on another worker: restore from the served checkpoint bundle
		const w2 = await workerCheckout(token, start, "r1");
		const stream = await repos.bundleStream(REPO, "r1", "checkpoint", start);
		expect(stream).toBeDefined();
		const served = join(root, "served.bundle");
		await Bun.write(served, new Response(stream));
		await git(["-C", w2, "fetch", "-q", "--no-tags", served, "refs/agentbot/checkpoints/r1"]);
		const fetched = await git(["-C", w2, "rev-parse", "FETCH_HEAD"]);
		expect(fetched).toBe(cp.commit);
		await git(["-C", w2, "checkout", "-q", "-B", runBranch("r1"), fetched]);
		await git(["-C", w2, "reset", "-q", "--mixed", "HEAD~1"]);
		expect(await git(["-C", w2, "rev-parse", "HEAD"])).toBe(w1Head);
		expect(await readFile(join(w2, "README.md"), "utf8")).toContain("uncommitted");
		expect(existsSync(join(w2, "scratch.txt"))).toBe(true);
		expect(existsSync(join(w2, "debug.log"))).toBe(false);
		expect(await repos.bundleStream(REPO, "r1", "result", start)).toBeUndefined();

		await git(["-C", w2, "add", "-A"]);
		await git(["-C", w2, "commit", "-q", "-m", "AgentBot: remaining changes"], { env: ID });
		const head = await git(["-C", w2, "rev-parse", "HEAD"]);
		const result = join(root, "r1.bundle");
		await git(["-C", w2, "bundle", "create", "-q", result, `${start}..${runBranch("r1")}`]);
		expect(await repos.importBundle(REPO, "r1", "result", result, start)).toEqual({ commits: 2 });
		expect(await repos.push(REPO, "r1", "agentbot/issue-1-x", "unused")).toEqual({ pushed: true, sha: head });
		expect(await git(["-C", github, "rev-parse", "refs/heads/agentbot/issue-1-x"])).toBe(head);
		await repos.deleteRefs(REPO, "r1", ["result", "checkpoint"]);
	});

	test("protocol v0 checkout and ls-remote hide refs/agentbot", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const token = lease(REPO);
		const w = await workerCheckout(token, start, "r0", ["-c", "protocol.version=0"]);
		await commitFile(w, "x.txt", "x\n", "x");
		const file = join(root, "r0.bundle");
		await git(["-C", w, "bundle", "create", "-q", file, `${start}..${runBranch("r0")}`]);
		await repos.importBundle(REPO, "r0", "result", file, start);
		for (const v of ["0", "2"]) {
			const ls = await git(["-c", `protocol.version=${v}`, "ls-remote", repoUrl], { env: leaseEnv(token) });
			expect(ls).toContain("refs/heads/main");
			expect(ls).not.toContain("refs/agentbot");
		}
		await repos.deleteRefs(REPO, "r0", ["result"]);
	});

	test("gzipped negotiation", async () => {
		await git(["-C", seed, "checkout", "-q", "-b", "big", "main"]);
		for (let i = 0; i < 3; i++) await commitFile(seed, "src/main.txt", `main ${i}\n`, `m${i}`);
		await git(["-C", seed, "push", "-q", "origin", "big:main"]);
		await repos.fetch(REPO, "unused");
		const token = lease(REPO);
		const dir = join(root, "gz");
		await git(["init", "-q", dir]);
		for (let i = 0; i < 200; i++) await git(["-C", dir, "commit", "-q", "--allow-empty", "-m", `local ${i}`], { env: ID });
		const before = requests.length;
		await git(["-C", dir, "fetch", "-q", "--no-tags", repoUrl, "main"], { env: leaseEnv(token) });
		expect(requests.slice(before).some((r) => r.gzip && r.status === 200)).toBe(true);
		expect(await git(["-C", dir, "rev-parse", "FETCH_HEAD"])).toBe((await repos.branchHead(REPO, "main")) ?? "");
	}, 60_000);
});

describe("auth and routing", () => {
	const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
	const refs = `${GIT_PATH_PREFIX}acme/widget.git/info/refs?service=git-upload-pack`;

	test("negatives", async () => {
		const token = lease(REPO);
		const other = lease("acme/other");
		const bearer = { Authorization: `Bearer ${token}` };
		const noAuth = await get(refs);
		expect(noAuth.status).toBe(401);
		expect(noAuth.headers.get("www-authenticate")).toBe('Basic realm="agentbot"');
		expect((await get(refs, { Authorization: "Bearer nope" })).status).toBe(401);
		expect((await get(refs, { Authorization: `Bearer ${other}` })).status).toBe(403);
		expect((await get(refs, bearer)).status).toBe(200);
		expect((await get(refs, { Authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` })).status).toBe(200);
		expect((await get(`${GIT_PATH_PREFIX}acme/widget.git/info/refs?service=git-receive-pack`, bearer)).status).toBe(403);
		expect((await get(`${GIT_PATH_PREFIX}acme/widget.git/info/refs`, bearer)).status).toBe(403);
		expect((await fetch(`${base}${GIT_PATH_PREFIX}acme/widget.git/git-receive-pack`, { method: "POST", headers: bearer })).status).toBe(403);
		expect((await get(`${GIT_PATH_PREFIX}acme/widget.git/HEAD`, bearer)).status).toBe(404);
		expect((await get(`${GIT_PATH_PREFIX}acme/widget.git/objects/info/packs`, bearer)).status).toBe(404);
		expect((await get(`${GIT_PATH_PREFIX}acme/..%2F..%2Fx.git/info/refs?service=git-upload-pack`, bearer)).status).toBe(404);
		expect((await get(`${GIT_PATH_PREFIX}../widget.git/info/refs?service=git-upload-pack`, bearer)).status).toBe(404);
		expect((await get(`${GIT_PATH_PREFIX}acme/other.git/info/refs?service=git-upload-pack`, { Authorization: `Bearer ${other}` })).status).toBe(404);
		expect((await fetch(`${base}${GIT_PATH_PREFIX}acme/widget.git/git-upload-pack`, { headers: bearer })).status).toBe(405);
		expect((await fetch(`${base}${GIT_PATH_PREFIX}acme/widget.git/git-upload-pack`, { method: "POST", headers: bearer, body: "x" })).status).toBe(415);
		const v0 = await (await get(refs, bearer)).text();
		expect(v0.startsWith("001e# service=git-upload-pack\n0000")).toBe(true);
		const v2 = await (await get(refs, { ...bearer, "Git-Protocol": "version=2" })).text();
		expect(v2.startsWith("000eversion 2\n")).toBe(true);
	});

	test("a lease has at most two git requests in flight; request bodies stream into upload-pack", async () => {
		const token = lease(REPO);
		const bearer = { Authorization: `Bearer ${token}` };
		const upload = `${base}${GIT_PATH_PREFIX}acme/widget.git/git-upload-pack`;
		const before = requests.length;
		// Two negotiations whose bodies never end: each holds a slot (and an upload-pack) while its body streams in.
		const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
		const held = Array.from({ length: MAX_GIT_REQUESTS_PER_LEASE }, () =>
			fetch(upload, {
				method: "POST",
				headers: { ...bearer, "Content-Type": "application/x-git-upload-pack-request" },
				body: new ReadableStream<Uint8Array>({ start: c => void bodies.push(c) }),
			}),
		);
		const deadline = Date.now() + 5000;
		while (requests.slice(before).filter(r => r.path.endsWith("git-upload-pack") && r.status === 200).length < held.length) {
			if (Date.now() > deadline) throw new Error("the held requests never reached the endpoint");
			await Bun.sleep(5);
		}
		const refused = await get(refs, bearer);
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("1");
		// Per lease: another run's lease is not affected.
		expect((await get(refs, { Authorization: `Bearer ${lease(REPO)}` })).status).toBe(200);
		// Ending the bodies ends their upload-packs and frees the slots.
		for (const c of bodies) {
			c.enqueue(new TextEncoder().encode("0000"));
			c.close();
		}
		for (const res of await Promise.all(held)) await res.arrayBuffer();
		let status = 0;
		while (status !== 200 && Date.now() < deadline + 5000) {
			status = (await get(refs, bearer)).status;
			if (status !== 200) await Bun.sleep(10);
		}
		expect(status).toBe(200);
	});

	test("wants: a non-tip mirror commit is served, a runs-repo-only object is refused on v0 and v2", async () => {
		const token = lease(REPO);
		const nonTip = await git(["-C", repos.mirrorPath(REPO), "rev-parse", "refs/heads/main~1"]);
		for (const v of ["0", "2"]) expect((await probe(token, nonTip, v)).exitCode).toBe(0);

		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const w = await workerCheckout(token, start, "r5");
		const head = await commitFile(w, "five.txt", "5\n", "five");
		const file = join(root, "r5.bundle");
		await git(["-C", w, "bundle", "create", "-q", file, `${start}..${runBranch("r5")}`]);
		await repos.importBundle(REPO, "r5", "result", file, start);
		expect((await gitRun(["-C", repos.mirrorPath(REPO), "cat-file", "-e", head])).exitCode).not.toBe(0);
		for (const v of ["0", "2"]) {
			const r = await probe(token, head, v);
			expect(r.exitCode).not.toBe(0);
			expect(r.stderr).toContain("not our ref");
		}
		await repos.deleteRefs(REPO, "r5", ["result"]);
	});
});

describe("tokens reach git only as per-process config (WS-02)", () => {
	/** One recorded git process: its argv and its environment. */
	interface GitCall {
		argv: string[];
		env: Record<string, string>;
	}

	/** Puts a `git` on PATH that records argv and environment as JSON lines, then runs the real git. */
	async function recordGit(): Promise<{ calls(): Promise<GitCall[]>; restore(): void }> {
		const real = Bun.which("git");
		if (!real) throw new Error("git not found");
		const bin = join(root, `gitwrap${++n}`);
		await mkdir(bin);
		const log = join(bin, "calls.jsonl");
		await writeFile(
			join(bin, "git"),
			`#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");\nconst r = Bun.spawnSync([${JSON.stringify(real)}, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] });\nprocess.exit(r.exitCode ?? 1);\n`,
			{ mode: 0o755 },
		);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		return {
			calls: async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map(l => JSON.parse(l) as GitCall) : []),
			restore: () => {
				process.env.PATH = path;
			},
		};
	}

	test("the worker checkout: lease token only in the fetch's GIT_CONFIG env as a Bearer header; never argv, config or the global env", async () => {
		const start = (await repos.branchHead(REPO, "main")) ?? "";
		const token = lease(REPO);
		const dir = join(root, `ws02-${++n}`);
		const recorder = await recordGit();
		const before = requests.length;
		try {
			await makeCheckout(dir, { repo: REPO, startRef: "refs/heads/main", startCommit: start, branch: runBranch("ws02"), writesCode: true, restore: false, identity: { name: "Bot", email: "bot@example.invalid" } }, endpointRemote(base, token, REPO));
		} finally {
			recorder.restore();
		}
		const calls = await recorder.calls();
		// The fetch's own git subprocesses (`git -c …`) inherit its environment; these five calls are the checkout's.
		const ours = calls.filter(c => c.argv[0] !== "-c");
		expect(ours.map(c => c.argv[0])).toEqual(["init", "config", "config", "fetch", "checkout"]);
		for (const call of calls) {
			expect(call.argv.join(" ")).not.toContain(token);
			expect(call.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
		}
		const fetchCall = ours.find(c => c.argv[0] === "fetch")!;
		expect(fetchCall.env).toMatchObject({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `http.${base}${GIT_PATH_PREFIX}.extraHeader`,
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		});
		// Only the fetch carries it; the other calls and this process's own environment never do.
		for (const call of ours.filter(c => c !== fetchCall)) expect(JSON.stringify(call.env)).not.toContain(token);
		expect(JSON.stringify(process.env)).not.toContain(token);
		expect(Object.keys(process.env).filter(k => k.startsWith("GIT_CONFIG_"))).toEqual([]);
		expect(await readFile(join(dir, ".git", "config"), "utf8")).not.toContain(token);
		// What reached the endpoint: the header, on every request of the fetch.
		const seen = requests.slice(before);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(r => r.authorization === `Bearer ${token}`)).toBe(true);
	}, 60_000);

	test("the orchestrator's mirror fetch: the installation token only as an x-access-token basic header in GIT_CONFIG env", async () => {
		const token = "ghs_ws02_secret";
		const recorder = await recordGit();
		try {
			await repos.fetch(REPO, token);
		} finally {
			recorder.restore();
		}
		const calls = await recorder.calls();
		const remote = calls.filter(c => c.argv.includes("fetch"));
		expect(remote.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.argv.join(" ")).not.toContain(token);
			expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
		}
		for (const call of remote) {
			expect(call.env).toMatchObject({
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
				GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
			});
		}
		expect(JSON.stringify(process.env)).not.toContain(token);
		for (const file of [join(repos.mirrorPath(REPO), "config"), join(repos.mirrorPath(REPO), "FETCH_HEAD")]) {
			if (existsSync(file)) expect(await readFile(file, "utf8")).not.toContain(token);
		}
	}, 60_000);
});
