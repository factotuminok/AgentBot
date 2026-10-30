#!/usr/bin/env bun
/**
 * Spike S3 — git over the internal API (architecture RUN-17..RUN-20, WS-02, §4.5).
 *
 * Self-contained: creates a fake "GitHub" bare repo, an orchestrator mirror, a Bun smart-HTTP
 * endpoint around `git upload-pack --stateless-rpc`, and worker checkouts, all in one temp dir,
 * then removes it. Exits 0 when every check passes, 1 otherwise.
 *
 *   bun spikes/s3/run.ts            # run
 *   S3_KEEP=1 bun spikes/s3/run.ts  # keep the temp dir for inspection
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------------------------

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

type Env = Record<string, string>;

let baseEnv: Env = {};

async function run(cmd: string[], opts: { cwd?: string; env?: Env; stdin?: Uint8Array } = {}): Promise<RunResult> {
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		env: { ...baseEnv, ...opts.env },
		stdin: opts.stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

class GitFailed extends Error {
	constructor(
		readonly args: string[],
		readonly result: RunResult,
	) {
		super(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
	}
}

/** `git <args>` in `cwd`; throws unless exit 0. Returns trimmed stdout. */
async function git(cwd: string, args: string[], env?: Env): Promise<string> {
	const r = await run(["git", ...args], { cwd, env });
	if (r.code !== 0) throw new GitFailed(args, r);
	return r.stdout.trim();
}

/** `git <args>` that may fail; returns the raw result. */
function gitTry(cwd: string, args: string[], env?: Env): Promise<RunResult> {
	return run(["git", ...args], { cwd, env });
}

/**
 * WS-02 / RUN-17: the lease token reaches git only through per-command GIT_CONFIG_* env.
 * The header is scoped to the endpoint's URL prefix so git never sends it anywhere else.
 */
function leaseEnv(endpointPrefix: string, token: string): Env {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${endpointPrefix}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
	};
}

// ---------------------------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✔" : "✘"} ${name}${detail ? `\n    ${detail.replace(/\n/g, "\n    ")}` : ""}`);
}

function note(label: string, text: string): void {
	console.log(`  · ${label}: ${text.trim().replace(/\n/g, "\n      ")}`);
}

function section(title: string): void {
	console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------------------------
// git endpoint (orchestrator side): /internal/git/<owner>/<repo>.git/…
// ---------------------------------------------------------------------------------------------

interface Lease {
	runId: string;
	owner: string;
	repo: string;
}

interface EndpointStats {
	requests: { method: string; path: string; status: number; protocol: string; gzip: boolean }[];
}

interface EndpointOptions {
	reposDir: string;
	/** keyed by sha256(token) hex: the lookup never compares raw tokens. */
	leases: Map<string, Lease>;
	/** `-c key=value` pairs given to `git upload-pack`. */
	uploadPackConfig: string[];
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const ROUTE = /^\/internal\/git\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_PROTOCOL = /^[A-Za-z0-9=:._-]{1,256}$/;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function tokenKey(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Bearer <token>, or Basic with the token as password (any user name). */
function bearerToken(header: string | null): string | undefined {
	if (!header) return undefined;
	const [scheme, value] = header.split(/\s+/, 2);
	if (!scheme || !value) return undefined;
	if (scheme.toLowerCase() === "bearer") return value;
	if (scheme.toLowerCase() === "basic") {
		const decoded = Buffer.from(value, "base64").toString("utf8");
		const colon = decoded.indexOf(":");
		return colon >= 0 ? decoded.slice(colon + 1) : undefined;
	}
	return undefined;
}

function lookupLease(leases: Map<string, Lease>, token: string): Lease | undefined {
	const key = tokenKey(token);
	const lease = leases.get(key);
	if (!lease) return undefined;
	// constant-time confirm of the hash match (SEC-14 wants constant-time token comparison)
	return timingSafeEqual(Buffer.from(key), Buffer.from(tokenKey(token))) ? lease : undefined;
}

function pktLine(s: string): string {
	return (s.length + 4).toString(16).padStart(4, "0") + s;
}

/** Reads a request body (gunzipping `Content-Encoding: gzip`), capped at MAX_REQUEST_BYTES after decompression. */
async function readBody(req: Request): Promise<Uint8Array | undefined> {
	if (!req.body) return new Uint8Array();
	const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
	let stream: ReadableStream<Uint8Array> = req.body;
	// lib.dom types DecompressionStream's writable side as BufferSource; request chunks are Uint8Array.
	if (encoding === "gzip" || encoding === "x-gzip")
		stream = stream.pipeThrough(new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
	else if (encoding !== "" && encoding !== "identity") return undefined;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.byteLength;
		if (total > MAX_REQUEST_BYTES) return undefined;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function startEndpoint(opts: EndpointOptions) {
	const stats: EndpointStats = { requests: [] };

	async function handle(req: Request): Promise<{ res: Response; protocol: string; gzip: boolean }> {
		const url = new URL(req.url);
		const protoHeader = req.headers.get("git-protocol") ?? "";
		const protocol = GIT_PROTOCOL.test(protoHeader) ? protoHeader : "";
		const gzip = /gzip/i.test(req.headers.get("content-encoding") ?? "");
		const done = (res: Response) => ({ res, protocol, gzip });

		const m = ROUTE.exec(url.pathname);
		if (!m) return done(new Response("not found\n", { status: 404 }));
		const [, owner = "", repo = "", action] = m;
		if (!NAME.test(owner) || !NAME.test(repo)) return done(new Response("not found\n", { status: 404 }));

		const token = bearerToken(req.headers.get("authorization"));
		const lease = token ? lookupLease(opts.leases, token) : undefined;
		if (!lease) return done(new Response("unauthorized\n", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="agentbot"' } }));
		if (lease.owner !== owner || lease.repo !== repo) return done(new Response("forbidden\n", { status: 403 }));

		// upload-pack only: receive-pack is refused whatever the method.
		if (action === "git-receive-pack") return done(new Response("forbidden\n", { status: 403 }));
		const dir = join(opts.reposDir, `${owner}__${repo}.git`);
		if (!existsSync(dir)) return done(new Response("not found\n", { status: 404 }));

		const env: Env = protocol ? { GIT_PROTOCOL: protocol } : {};
		const v2 = /(^|:)version=2(:|$)/.test(protocol);

		if (action === "info/refs") {
			if (req.method !== "GET" && req.method !== "HEAD") return done(new Response(null, { status: 405 }));
			if (url.searchParams.get("service") !== "git-upload-pack") return done(new Response("forbidden\n", { status: 403 }));
			const r = await run(["git", ...opts.uploadPackConfig, "upload-pack", "--stateless-rpc", "--http-backend-info-refs", dir], { env });
			if (r.code !== 0) {
				console.error(`  [endpoint] info/refs upload-pack exit ${r.code}: ${r.stderr.trim()}`);
				return done(new Response("upload-pack failed\n", { status: 500 }));
			}
			// v0/v1 smart HTTP prefixes the advertisement with the service line; v2 does not (as git http-backend).
			const body = v2 ? r.stdout : `${pktLine("# service=git-upload-pack\n")}0000${r.stdout}`;
			return done(
				new Response(body, {
					headers: { "Content-Type": "application/x-git-upload-pack-advertisement", "Cache-Control": "no-cache" },
				}),
			);
		}

		// POST git-upload-pack
		if (req.method !== "POST") return done(new Response(null, { status: 405 }));
		if (req.headers.get("content-type") !== "application/x-git-upload-pack-request")
			return done(new Response("bad content type\n", { status: 415 }));
		const body = await readBody(req);
		if (!body) return done(new Response("bad request body\n", { status: 400 }));
		const proc = Bun.spawn(["git", ...opts.uploadPackConfig, "upload-pack", "--stateless-rpc", dir], {
			env: { ...baseEnv, ...env },
			stdin: body,
			stdout: "pipe",
			stderr: "pipe",
		});
		void Promise.all([new Response(proc.stderr).text(), proc.exited]).then(([stderr, code]) => {
			if (code !== 0) console.error(`  [endpoint] upload-pack exit ${code}: ${stderr.trim()}`);
		});
		return done(
			new Response(proc.stdout, {
				headers: { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" },
			}),
		);
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 120,
		maxRequestBodySize: MAX_REQUEST_BYTES,
		async fetch(req) {
			const { res, protocol, gzip } = await handle(req);
			stats.requests.push({ method: req.method, path: new URL(req.url).pathname, status: res.status, protocol, gzip });
			return res;
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	return {
		stats,
		base,
		prefix: `${base}/internal/git/`,
		repoUrl: (owner: string, repo: string) => `${base}/internal/git/${owner}/${repo}.git`,
		stop: () => server.stop(true),
	};
}

// ---------------------------------------------------------------------------------------------
// bundle header (orchestrator side, RUN-19 step 1)
// ---------------------------------------------------------------------------------------------

interface BundleHeader {
	version: number;
	prerequisites: string[];
	heads: { sha: string; ref: string }[];
}

/** Parses a v2/v3 bundle header without git. Throws on anything malformed. */
async function readBundleHeader(path: string): Promise<BundleHeader> {
	const file = Bun.file(path);
	const head = Buffer.from(await file.slice(0, 1024 * 1024).arrayBuffer());
	const end = head.indexOf("\n\n");
	if (end < 0) throw new Error("bundle header not terminated");
	const lines = head.subarray(0, end).toString("utf8").split("\n");
	const sig = /^# v([23]) git bundle$/.exec(lines[0] ?? "");
	if (!sig) throw new Error(`not a git bundle: ${lines[0]}`);
	const out: BundleHeader = { version: Number(sig[1]), prerequisites: [], heads: [] };
	for (const line of lines.slice(1)) {
		if (line.startsWith("@")) continue; // v3 capabilities, e.g. @object-format=sha1
		const pre = /^-([0-9a-f]{40,64})(?: .*)?$/.exec(line);
		if (pre?.[1]) {
			out.prerequisites.push(pre[1]);
			continue;
		}
		const ref = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
		if (!ref?.[1] || !ref[2]) throw new Error(`bad bundle header line: ${line}`);
		out.heads.push({ sha: ref[1], ref: ref[2] });
	}
	return out;
}

/** RUN-19 step 1: the only prerequisite is the start commit, and the bundle carries the expected head. */
function checkBundle(h: BundleHeader, startSha: string, ref: string): string | undefined {
	if (h.prerequisites.length !== 1 || h.prerequisites[0] !== startSha)
		return `prerequisites ${JSON.stringify(h.prerequisites)} != [${startSha}]`;
	if (!h.heads.some((x) => x.ref === ref)) return `bundle has no ${ref} (heads: ${h.heads.map((x) => x.ref).join(", ")})`;
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// worker side
// ---------------------------------------------------------------------------------------------

const BOT = { name: "AgentBot", email: "agentbot@example.invalid" };

/** RUN-17 steps 1-4: empty repo, depth-1 fetch of the start sha, checkout, temp branch. */
async function workerCheckout(dir: string, repoUrl: string, env: Env, startSha: string, runId: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await git(dir, ["init", "-q"]);
	await git(dir, ["config", "user.name", BOT.name]);
	await git(dir, ["config", "user.email", BOT.email]);
	await git(dir, ["fetch", "-q", "--depth=1", "--no-tags", repoUrl, startSha], env);
	await git(dir, ["checkout", "-q", "-b", `agentbot/run-${runId}`, startSha]);
}

/**
 * RUN-18: one commit on top of the temp branch holding the whole working tree (tracked +
 * untracked non-ignored), built in a throwaway index so the real index/working tree are untouched.
 */
async function workerCheckpoint(dir: string, startSha: string, out: string): Promise<string> {
	const index = join(dir, ".git", "agentbot-checkpoint.index");
	const env = { GIT_INDEX_FILE: index };
	try {
		await git(dir, ["read-tree", "HEAD"], env);
		await git(dir, ["add", "-A"], env);
		const tree = await git(dir, ["write-tree"], env);
		const commit = await git(dir, ["commit-tree", tree, "-p", "HEAD", "-m", "AgentBot checkpoint"]);
		await git(dir, ["update-ref", "refs/agentbot/checkpoint", commit]);
		await git(dir, ["bundle", "create", "-q", out, `${startSha}..refs/agentbot/checkpoint`]);
		return commit;
	} finally {
		await rm(index, { force: true });
	}
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<string> {
	await mkdir(join(dir, file, ".."), { recursive: true });
	await writeFile(join(dir, file), content);
	await git(dir, ["add", "--", file]);
	await git(dir, ["commit", "-q", "-m", message]);
	return git(dir, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------------------------
// orchestrator side
// ---------------------------------------------------------------------------------------------

/** RUN-19 steps 1-2: verify the header, then fetch the bundle head into a temp ref (forced: the ref is run-private). */
async function importBundle(mirror: string, bundle: string, startSha: string, bundleRef: string, targetRef: string) {
	const header = await readBundleHeader(bundle);
	const problem = checkBundle(header, startSha, bundleRef);
	if (problem) throw new Error(`bundle rejected: ${problem}`);
	await git(mirror, ["bundle", "verify", "-q", bundle]);
	await git(mirror, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, `+${bundleRef}:${targetRef}`]);
	const count = Number(await git(mirror, ["rev-list", "--count", `${startSha}..${targetRef}`]));
	return { header, count, head: await git(mirror, ["rev-parse", targetRef]) };
}

/** RUN-19 step 3: fast-forward only (no `+`, no --force). Pushes to the URL, not to the mirror's remote name. */
function pushFastForward(mirror: string, githubUrl: string, srcRef: string, branch: string) {
	return gitTry(mirror, ["push", "--porcelain", githubUrl, `${srcRef}:refs/heads/${branch}`]);
}

// ---------------------------------------------------------------------------------------------
// the spike
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "agentbot-spike-s3-"));
	const home = join(root, "home");
	await mkdir(home);
	await writeFile(join(home, "gitconfig"), "");
	// Isolate git from the host: no system/global config, no credential helpers, no prompts.
	baseEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
	};
	const endpoints: { stop(): void }[] = [];
	console.log(`temp dir: ${root}\n${(await git(root, ["--version"]))}`);

	try {
		// ---------------------------------------------------------------- fake GitHub
		section("1. fake GitHub + mirror (WS-01)");
		const githubUrl = join(root, "github", "acme", "widget.git");
		await mkdir(githubUrl, { recursive: true });
		await git(githubUrl, ["init", "-q", "--bare", "-b", "main"]);
		const seed = join(root, "seed");
		await git(root, ["clone", "-q", githubUrl, seed]);
		await git(seed, ["config", "user.name", "Human"]);
		await git(seed, ["config", "user.email", "human@example.invalid"]);
		await writeFile(join(seed, ".gitignore"), "*.log\n");
		await git(seed, ["add", ".gitignore"]);
		await git(seed, ["commit", "-q", "-m", "c1: gitignore"]);
		await commitFile(seed, "README.md", "# widget\n", "c2: readme");
		await commitFile(seed, "src/main.txt", "main v1\n", "c3: main");
		await git(seed, ["push", "-q", "origin", "main"]);
		await git(seed, ["checkout", "-q", "-b", "agentbot/issue-1-x"]);
		await commitFile(seed, "src/issue.txt", "issue 1 start\n", "i1: issue branch");
		await git(seed, ["push", "-q", "origin", "agentbot/issue-1-x"]);
		await git(seed, ["checkout", "-q", "main"]);
		await commitFile(seed, "src/main.txt", "main v2\n", "c4: main moves");
		await git(seed, ["push", "-q", "origin", "main"]);
		check("fake GitHub has main and agentbot/issue-1-x", true, await git(githubUrl, ["for-each-ref", "--format=%(refname) %(objectname:short)"]));

		const reposDir = join(root, "state", "repos");
		await mkdir(reposDir, { recursive: true });
		const mirror = join(reposDir, "acme__widget.git");
		await git(root, ["clone", "-q", "--mirror", githubUrl, mirror]);
		note("mirror config after clone --mirror", await git(mirror, ["config", "--get-regexp", "^remote\\.origin\\."]));

		// Hazard: a --mirror refspec (+refs/*:refs/*) with --prune deletes refs/agentbot/* (WS-07 says keep them).
		await git(mirror, ["update-ref", "refs/agentbot/runs/probe", "refs/heads/main"]);
		await git(mirror, ["fetch", "-q", "--prune", "origin"]);
		const probeGone = (await gitTry(mirror, ["rev-parse", "-q", "--verify", "refs/agentbot/runs/probe"])).code !== 0;
		check("hazard confirmed: --mirror refspec + fetch --prune deletes refs/agentbot/runs/*", probeGone);

		// Fix: track heads and tags only; --prune then only prunes those namespaces.
		await git(mirror, ["config", "--unset", "remote.origin.mirror"]);
		await git(mirror, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
		await git(mirror, ["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
		await git(mirror, ["update-ref", "refs/agentbot/runs/probe", "refs/heads/main"]);
		await git(mirror, ["fetch", "-q", "--prune", "origin"]);
		const probeKept = (await gitTry(mirror, ["rev-parse", "-q", "--verify", "refs/agentbot/runs/probe"])).code === 0;
		check("fixed refspec (+refs/heads/*, +refs/tags/*) keeps refs/agentbot/* across fetch --prune", probeKept);
		await git(mirror, ["update-ref", "-d", "refs/agentbot/runs/probe"]);

		// ---------------------------------------------------------------- endpoint
		section("2. git endpoint");
		const leases = new Map<string, Lease>();
		const newLease = (runId: string, owner: string, repo: string) => {
			const token = randomBytes(32).toString("base64url");
			leases.set(tokenKey(token), { runId, owner, repo });
			return token;
		};
		const UPLOAD_PACK_CONFIG = ["-c", "uploadpack.allowReachableSHA1InWant=true", "-c", "uploadpack.hideRefs=refs/agentbot"];
		const ep = startEndpoint({ reposDir, leases, uploadPackConfig: UPLOAD_PACK_CONFIG });
		endpoints.push(ep);
		const repoUrl = ep.repoUrl("acme", "widget");
		note("endpoint", repoUrl);

		// ---------------------------------------------------------------- run r1
		section("3. run r1 (worker W1): shallow fetch, commits, checkpoint");
		await git(mirror, ["fetch", "-q", "--prune", "origin"]);
		const start1 = await git(mirror, ["rev-parse", "refs/heads/agentbot/issue-1-x"]);
		const lease1 = newLease("r1", "acme", "widget");
		const env1 = leaseEnv(ep.prefix, lease1);
		const w1 = join(root, "w1");
		const before = ep.stats.requests.length;
		await workerCheckout(w1, repoUrl, env1, start1, "r1");
		const fetchReqs = ep.stats.requests.slice(before);
		check(
			"W1 depth-1 fetch of start sha + checkout + temp branch",
			(await git(w1, ["rev-parse", "HEAD"])) === start1 &&
				(await git(w1, ["rev-parse", "--is-shallow-repository"])) === "true" &&
				(await git(w1, ["rev-list", "--count", "HEAD"])) === "1" &&
				(await git(w1, ["branch", "--show-current"])) === "agentbot/run-r1",
			`requests: ${fetchReqs.map((r) => `${r.method} ${r.path.replace(/^.*\.git/, "")} ${r.status} proto=${r.protocol || "v0"} gzip=${r.gzip}`).join("; ")}\n` +
				`git log: ${await git(w1, ["log", "--oneline"])}\n.git/shallow: ${(await readFile(join(w1, ".git", "shallow"), "utf8")).trim()}`,
		);
		const cfg = await readFile(join(w1, ".git", "config"), "utf8");
		check("lease token absent from .git/config and from FETCH_HEAD", !cfg.includes(lease1) && !cfg.includes("extraHeader") && !(await readFile(join(w1, ".git", "FETCH_HEAD"), "utf8")).includes(lease1));

		// No commits yet: git refuses an empty bundle, so the worker must report "no commits" itself.
		const empty = await gitTry(w1, ["bundle", "create", "-q", join(root, "empty.bundle"), `${start1}..agentbot/run-r1`]);
		check("empty range: `git bundle create` refuses (worker reports no commits instead)", empty.code !== 0, empty.stderr.trim());

		await commitFile(w1, "README.md", "# widget\n\nrun r1 edit\n", "r1: edit readme");
		const w1Head = await commitFile(w1, "src/feature.txt", "feature\n", "r1: add feature");
		// dirty state: unstaged edit, staged new file, untracked file, ignored file
		await writeFile(join(w1, "README.md"), "# widget\n\nrun r1 edit\nuncommitted line\n");
		await mkdir(join(w1, "notes"));
		await writeFile(join(w1, "notes", "todo.txt"), "staged todo\n");
		await git(w1, ["add", "notes/todo.txt"]);
		await writeFile(join(w1, "scratch.txt"), "untracked\n");
		await writeFile(join(w1, "debug.log"), "ignored\n");
		const statusBefore = await git(w1, ["status", "--porcelain"]);
		const cpBundle = join(root, "w1-checkpoint.bundle");
		const cpCommit = await workerCheckpoint(w1, start1, cpBundle);
		const statusAfter = await git(w1, ["status", "--porcelain"]);
		const cpFiles = await git(w1, ["ls-tree", "-r", "--name-only", cpCommit]);
		check(
			"checkpoint commit holds tracked + untracked non-ignored files; index and working tree untouched",
			statusBefore === statusAfter &&
				(await git(w1, ["rev-parse", "HEAD"])) === w1Head &&
				cpFiles.includes("scratch.txt") &&
				cpFiles.includes("notes/todo.txt") &&
				!cpFiles.includes("debug.log"),
			`status: ${statusBefore.replace(/\n/g, " | ")}\ncheckpoint tree: ${cpFiles.replace(/\n/g, " ")}`,
		);
		const cpHeader = await readBundleHeader(cpBundle);
		check("checkpoint bundle's only prerequisite is the start commit", checkBundle(cpHeader, start1, "refs/agentbot/checkpoint") === undefined, JSON.stringify(cpHeader));

		// orchestrator stores it as refs/agentbot/checkpoints/r1 (forced: each checkpoint replaces the last)
		const cpImport = await importBundle(mirror, cpBundle, start1, "refs/agentbot/checkpoint", "refs/agentbot/checkpoints/r1");
		check("orchestrator imported checkpoint as refs/agentbot/checkpoints/r1", cpImport.head === cpCommit, `${cpImport.count} commits on top of start`);

		// W1 is lost.
		await rm(w1, { recursive: true, force: true });

		section("4. run r1 resumed (worker W2): restore checkpoint, leftover commit, result bundle");
		const w2 = join(root, "w2");
		await workerCheckout(w2, repoUrl, env1, start1, "r1");
		// Orchestrator serves the checkpoint from the mirror ref (run artifact endpoint, GET checkpoint bundle).
		const cpServed = join(root, "served-checkpoint.bundle");
		await git(mirror, ["bundle", "create", "-q", cpServed, `${start1}..refs/agentbot/checkpoints/r1`]);
		await git(w2, ["fetch", "-q", "--no-tags", cpServed, "refs/agentbot/checkpoints/r1"]);
		const cpFetched = await git(w2, ["rev-parse", "FETCH_HEAD"]);
		await git(w2, ["checkout", "-q", "-B", "agentbot/run-r1", cpFetched]);
		await git(w2, ["reset", "-q", "--mixed", "HEAD~1"]);
		const w2Status = (await gitTry(w2, ["status", "--porcelain", "--untracked-files=all"])).stdout.trimEnd();
		check(
			"restore: checkout checkpoint + mixed reset → run commits kept, work uncommitted again, ignored file not restored",
			cpFetched === cpCommit &&
				(await git(w2, ["rev-parse", "HEAD"])) === w1Head &&
				(await git(w2, ["branch", "--show-current"])) === "agentbot/run-r1" &&
				(await readFile(join(w2, "README.md"), "utf8")).includes("uncommitted line") &&
				w2Status.split("\n").sort().join("|") === [" M README.md", "?? notes/todo.txt", "?? scratch.txt"].join("|") &&
				!existsSync(join(w2, "debug.log")) &&
				(await git(w2, ["rev-parse", "--is-shallow-repository"])) === "true",
			`status: ${w2Status.replace(/\n/g, " | ")}\nlog: ${(await git(w2, ["log", "--oneline"])).replace(/\n/g, " | ")}`,
		);

		await git(w2, ["add", "-A"]);
		await git(w2, ["commit", "-q", "-m", "AgentBot: remaining changes for #1"]);
		const r1Head = await git(w2, ["rev-parse", "HEAD"]);
		const r1Bundle = join(root, "r1.bundle");
		await git(w2, ["bundle", "create", "-q", r1Bundle, `${start1}..agentbot/run-r1`]);
		const listHeads = await git(w2, ["bundle", "list-heads", r1Bundle]);
		const verify = await gitTry(w2, ["bundle", "verify", r1Bundle]);
		const r1Header = await readBundleHeader(r1Bundle);
		check(
			"result bundle (start..agentbot/run-r1) from the shallow checkout: only prerequisite = start",
			verify.code === 0 && checkBundle(r1Header, start1, "refs/heads/agentbot/run-r1") === undefined,
			`list-heads: ${listHeads}\nverify (in W2): ${(verify.stdout + verify.stderr).trim().replace(/\n/g, " | ")}\nheader: ${JSON.stringify(r1Header)}`,
		);

		section("5. orchestrator: import + fast-forward push");
		const r1Import = await importBundle(mirror, r1Bundle, start1, "refs/heads/agentbot/run-r1", "refs/agentbot/runs/r1");
		check("bundle imported as refs/agentbot/runs/r1", r1Import.head === r1Head && r1Import.count === 3, `${r1Import.count} new commits`);
		const push1 = await pushFastForward(mirror, githubUrl, "refs/agentbot/runs/r1", "agentbot/issue-1-x");
		const ghHead1 = await git(githubUrl, ["rev-parse", "refs/heads/agentbot/issue-1-x"]);
		check("fast-forward push to agentbot/issue-1-x succeeds", push1.code === 0 && ghHead1 === r1Head, push1.stdout.trim());
		// RUN-20: successful run → delete runs/<id> after push, checkpoints/<id> when the run finishes.
		await git(mirror, ["update-ref", "-d", "refs/agentbot/runs/r1"]);
		await git(mirror, ["update-ref", "-d", "refs/agentbot/checkpoints/r1"]);
		await rm(w2, { recursive: true, force: true });

		// ---------------------------------------------------------------- run r2: moved branch
		section("6. run r2: issue branch moves on GitHub during the run");
		await git(mirror, ["fetch", "-q", "--prune", "origin"]);
		const start2 = await git(mirror, ["rev-parse", "refs/heads/agentbot/issue-1-x"]);
		const lease2 = newLease("r2", "acme", "widget");
		const env2 = leaseEnv(ep.prefix, lease2);
		const w3 = join(root, "w3");
		await workerCheckout(w3, repoUrl, env2, start2, "r2");
		const r2Head = await commitFile(w3, "src/review.txt", "addressed review\n", "AgentBot: follow-up changes for #1");
		const r2Bundle = join(root, "r2.bundle");
		await git(w3, ["bundle", "create", "-q", r2Bundle, `${start2}..agentbot/run-r2`]);

		// A human pushes to the issue branch meanwhile.
		await git(seed, ["fetch", "-q", "origin"]);
		await git(seed, ["checkout", "-q", "-B", "agentbot/issue-1-x", "origin/agentbot/issue-1-x"]);
		const humanHead = await commitFile(seed, "src/human.txt", "human\n", "human: concurrent change");
		await git(seed, ["push", "-q", "origin", "agentbot/issue-1-x"]);

		const r2Import = await importBundle(mirror, r2Bundle, start2, "refs/heads/agentbot/run-r2", "refs/agentbot/runs/r2");
		check("r2 bundle imported as refs/agentbot/runs/r2", r2Import.head === r2Head && r2Import.count === 1);

		// ------------------------------------------------ hidden refs (while runs/r2 exists, unpushed)
		section("7. hideRefs and wants");
		for (const v of ["0", "2"]) {
			const ls = await git(root, ["-c", `protocol.version=${v}`, "ls-remote", repoUrl], env2);
			const mirrorRefs = await git(mirror, ["for-each-ref", "--format=%(refname)", "refs/agentbot"]);
			check(
				`protocol v${v}: ls-remote shows no refs/agentbot/* while the mirror has them`,
				!ls.includes("refs/agentbot") && mirrorRefs.includes("refs/agentbot/runs/r2") && ls.includes("refs/heads/main"),
				`ls-remote: ${ls.replace(/\n/g, " | ")}\nmirror refs/agentbot: ${mirrorRefs}`,
			);
		}

		const probeFetch = async (label: string, url: string, env: Env, sha: string, v: string) => {
			const dir = join(root, `probe-${label}-v${v}`);
			await mkdir(dir);
			await git(dir, ["init", "-q"]);
			const r = await gitTry(dir, ["-c", `protocol.version=${v}`, "fetch", "-q", "--depth=1", "--no-tags", url, sha], env);
			await rm(dir, { recursive: true, force: true });
			return r;
		};

		// Which wants does upload-pack honour? Targets: a non-tip sha reachable from main, a sha reachable
		// only from the hidden refs/agentbot/runs/r2, and a dangling commit no ref reaches.
		const nonTip = await git(mirror, ["rev-parse", "refs/heads/main~1"]);
		const dangling = await git(mirror, ["-c", "user.name=x", "-c", "user.email=x@example.invalid", "commit-tree", "refs/heads/main^{tree}", "-p", "refs/heads/main", "-m", "dangling"]);
		const epNoReach = startEndpoint({ reposDir, leases, uploadPackConfig: ["-c", "uploadpack.hideRefs=refs/agentbot"] });
		endpoints.push(epNoReach);
		const configs = [
			{ label: "allowReachableSHA1InWant+hideRefs", ep },
			{ label: "hideRefs only (control)", ep: epNoReach },
		];
		const targets = { "non-tip (main~1)": nonTip, "hidden-only (runs/r2)": r2Head, dangling };
		// Observed with git 2.50.1 (see wiki/spikes/S3.md); pinned so a git upgrade that changes it shows up.
		const expected: Record<string, boolean> = {
			"allowReachableSHA1InWant+hideRefs v0 non-tip (main~1)": true,
			"allowReachableSHA1InWant+hideRefs v0 hidden-only (runs/r2)": true,
			"allowReachableSHA1InWant+hideRefs v0 dangling": false,
			"allowReachableSHA1InWant+hideRefs v2 non-tip (main~1)": true,
			"allowReachableSHA1InWant+hideRefs v2 hidden-only (runs/r2)": true,
			"allowReachableSHA1InWant+hideRefs v2 dangling": true,
			"hideRefs only (control) v0 non-tip (main~1)": false,
			"hideRefs only (control) v0 hidden-only (runs/r2)": false,
			"hideRefs only (control) v0 dangling": false,
			"hideRefs only (control) v2 non-tip (main~1)": true,
			"hideRefs only (control) v2 hidden-only (runs/r2)": true,
			"hideRefs only (control) v2 dangling": true,
		};
		for (const c of configs) {
			for (const v of ["0", "2"]) {
				for (const [t, sha] of Object.entries(targets)) {
					const key = `${c.label} v${v} ${t}`;
					const r = await probeFetch(key.replace(/[^a-z0-9]+/gi, "-"), c.ep.repoUrl("acme", "widget"), leaseEnv(c.ep.prefix, lease2), sha, v);
					const fetched = r.code === 0;
					check(
						`want ${key}: ${fetched ? "served" : "refused"}`,
						fetched === expected[key],
						fetched ? undefined : r.stderr.trim().split("\n").pop(),
					);
				}
			}
		}

		// Strict variant: keep run refs in a separate bare repo that borrows the mirror's objects via
		// alternates. The endpoint serves only the mirror, whose object store never holds run objects.
		section("7b. strict variant: run refs in <owner>__<repo>.runs.git (alternates → mirror)");
		const runsRepo = join(reposDir, "acme__widget.runs.git");
		await git(root, ["init", "-q", "--bare", runsRepo]);
		await writeFile(join(runsRepo, "objects", "info", "alternates"), `${join(mirror, "objects")}\n`);
		const start5 = await git(mirror, ["rev-parse", "refs/heads/main"]);
		const w5 = join(root, "w5");
		await workerCheckout(w5, repoUrl, env2, start5, "r5");
		const r5Head = await commitFile(w5, "src/two.txt", "issue 2\n", "AgentBot: issue 2");
		const r5Bundle = join(root, "r5.bundle");
		await git(w5, ["bundle", "create", "-q", r5Bundle, `${start5}..agentbot/run-r5`]);
		await rm(w5, { recursive: true, force: true });
		const r5Import = await importBundle(runsRepo, r5Bundle, start5, "refs/heads/agentbot/run-r5", "refs/agentbot/runs/r5");
		const inMirror = (await gitTry(mirror, ["cat-file", "-e", r5Head])).code === 0;
		const r5Fetch = await Promise.all(["0", "2"].map((v) => probeFetch(`runsrepo-${v}`, repoUrl, env2, r5Head, v)));
		check(
			"bundle imported into the runs repo; object absent from the mirror; endpoint refuses it on v0 and v2",
			r5Import.head === r5Head && !inMirror && r5Fetch.every((r) => r.code !== 0),
			r5Fetch.map((r, i) => `v${i === 0 ? 0 : 2}: exit ${r.code} ${r.stderr.trim().split("\n").pop()}`).join("\n"),
		);
		const push5 = await pushFastForward(runsRepo, githubUrl, "refs/agentbot/runs/r5", "agentbot/issue-2-y");
		check(
			"fast-forward push from the runs repo creates agentbot/issue-2-y on GitHub",
			push5.code === 0 && (await git(githubUrl, ["rev-parse", "refs/heads/agentbot/issue-2-y"])) === r5Head,
			push5.stdout.trim(),
		);
		await git(runsRepo, ["update-ref", "-d", "refs/agentbot/runs/r5"]);

		// ------------------------------------------------ the push is rejected
		section("8. fast-forward push of a moved branch");
		const push2 = await pushFastForward(mirror, githubUrl, "refs/agentbot/runs/r2", "agentbot/issue-1-x");
		check(
			"push rejected while the mirror has not seen the new head (fetch first)",
			push2.code !== 0 && /^!\s.*\[rejected\] \(fetch first\)/m.test(push2.stdout),
			`exit ${push2.code}\nstdout: ${push2.stdout.trim()}\nstderr: ${push2.stderr.trim()}`,
		);
		await git(mirror, ["fetch", "-q", "--prune", "origin"]);
		const keptAfterPrune = (await gitTry(mirror, ["rev-parse", "-q", "--verify", "refs/agentbot/runs/r2"])).code === 0;
		const push3 = await pushFastForward(mirror, githubUrl, "refs/agentbot/runs/r2", "agentbot/issue-1-x");
		check(
			"after mirror fetch --prune: refs/agentbot/runs/r2 survives, push rejected (non-fast-forward)",
			keptAfterPrune && push3.code !== 0 && /^!\s.*\[rejected\] \(non-fast-forward\)/m.test(push3.stdout),
			`exit ${push3.code}\nstdout: ${push3.stdout.trim()}`,
		);
		check("GitHub branch still at the human's commit", (await git(githubUrl, ["rev-parse", "refs/heads/agentbot/issue-1-x"])) === humanHead);
		await git(mirror, ["update-ref", "-d", "refs/agentbot/runs/r2"]); // RUN-20: rejected push → discard
		await rm(w3, { recursive: true, force: true });

		// ---------------------------------------------------------------- bundle checks
		section("9. bundle prerequisite check rejects other shapes");
		const w4 = join(root, "w4");
		await workerCheckout(w4, repoUrl, env2, humanHead, "r3");
		await commitFile(w4, "a.txt", "a\n", "r3: a");
		await commitFile(w4, "b.txt", "b\n", "r3: b");
		const wrongBundle = join(root, "wrong.bundle");
		await git(w4, ["bundle", "create", "-q", wrongBundle, "HEAD~1..agentbot/run-r3"]);
		const wrongProblem = checkBundle(await readBundleHeader(wrongBundle), humanHead, "refs/heads/agentbot/run-r3");
		check("bundle whose prerequisite is not the start commit is rejected", wrongProblem !== undefined, wrongProblem);
		// Agent rewrote the start commit (amend at the shallow root): prerequisite becomes start's parent.
		await git(w4, ["reset", "-q", "--hard", humanHead]);
		await writeFile(join(w4, "c.txt"), "c\n");
		await git(w4, ["add", "c.txt"]);
		await git(w4, ["commit", "-q", "--amend", "-m", "rewritten start"]);
		const rewritten = join(root, "rewritten.bundle");
		const rw = await gitTry(w4, ["bundle", "create", "-q", rewritten, `${humanHead}..agentbot/run-r3`]);
		const rwProblem = rw.code === 0 ? checkBundle(await readBundleHeader(rewritten), humanHead, "refs/heads/agentbot/run-r3") : `bundle create failed: ${rw.stderr.trim()}`;
		check("rewritten start commit (amend) → bundle rejected", rwProblem !== undefined, rwProblem);
		await rm(w4, { recursive: true, force: true });

		// ---------------------------------------------------------------- endpoint security
		section("10. endpoint auth and scope");
		const otherToken = newLease("r9", "acme", "other");
		const lsWith = (env: Env) => gitTry(root, ["ls-remote", repoUrl], env);
		const otherRepo = await lsWith(leaseEnv(ep.prefix, otherToken));
		check("token leased for acme/other is refused on acme/widget (403)", otherRepo.code !== 0 && /403/.test(otherRepo.stderr), otherRepo.stderr.trim());
		const badToken = await lsWith(leaseEnv(ep.prefix, "not-a-lease"));
		check("unknown token refused (401, no prompt)", badToken.code !== 0, badToken.stderr.trim());
		const noToken = await lsWith({});
		check("no token refused (401, no prompt)", noToken.code !== 0, noToken.stderr.trim());
		const basic = await lsWith({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `http.${ep.prefix}.extraHeader`,
			GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${lease2}`).toString("base64")}`,
		});
		check("basic x-access-token:<lease> also accepted", basic.code === 0);

		const pushDir = join(root, "pusher");
		await git(root, ["clone", "-q", "--depth=1", repoUrl, pushDir], env2);
		await git(pushDir, ["config", "user.name", BOT.name]);
		await git(pushDir, ["config", "user.email", BOT.email]);
		await commitFile(pushDir, "evil.txt", "x\n", "should not land");
		const pushEp = await gitTry(pushDir, ["push", "origin", "HEAD:refs/heads/evil"], env2);
		check(
			"git push to the endpoint (receive-pack) is refused",
			pushEp.code !== 0 && (await gitTry(mirror, ["rev-parse", "-q", "--verify", "refs/heads/evil"])).code !== 0,
			pushEp.stderr.trim(),
		);
		const auth = { Authorization: `Bearer ${lease2}` };
		const rp = await fetch(`${repoUrl}/info/refs?service=git-receive-pack`, { headers: auth });
		const dumb = await fetch(`${repoUrl}/info/refs`, { headers: auth });
		const head = await fetch(`${repoUrl}/HEAD`, { headers: auth });
		const traversal = await fetch(`${ep.base}/internal/git/acme/..%2F..%2Fsecret.git/info/refs?service=git-upload-pack`, { headers: auth });
		check(
			"receive-pack advertisement 403, dumb HTTP 403/404, traversal 403/404",
			rp.status === 403 && dumb.status === 403 && head.status === 404 && (traversal.status === 404 || traversal.status === 403),
			`receive-pack ${rp.status}, info/refs w/o service ${dumb.status}, /HEAD ${head.status}, traversal ${traversal.status}`,
		);

		// gzip request body, protocol v2 ls-refs by hand
		const lsRefs = `${pktLine("command=ls-refs\n")}0001${pktLine("ref-prefix refs/\n")}0000`;
		const gz = await fetch(`${repoUrl}/git-upload-pack`, {
			method: "POST",
			headers: {
				...auth,
				"Content-Type": "application/x-git-upload-pack-request",
				"Content-Encoding": "gzip",
				"Git-Protocol": "version=2",
			},
			body: Bun.gzipSync(Buffer.from(lsRefs)),
		});
		const gzText = await gz.text();
		check(
			"gzip-encoded v2 ls-refs POST is decoded and answered; hidden refs absent",
			gz.status === 200 && gzText.includes("refs/heads/main") && !gzText.includes("refs/agentbot"),
			gzText.trim().replace(/\n/g, " | "),
		);

		// Real git gzips larger upload-pack requests (many `have` lines): fetch main into a repo with
		// 200 unrelated local commits, so negotiation sends long have lists.
		const haves = join(root, "haves");
		await mkdir(haves);
		await git(haves, ["init", "-q"]);
		let stream = "";
		for (let i = 0; i < 200; i++) stream += `commit refs/heads/local\ncommitter x <x@example.invalid> ${i} +0000\ndata 2\n${i % 10}\n\n`;
		const imported = await run(["git", "fast-import", "--quiet"], { cwd: haves, stdin: Buffer.from(stream) });
		if (imported.code !== 0) throw new Error(`fast-import failed: ${imported.stderr}`);
		const gzBefore = ep.stats.requests.length;
		const havesFetch = await gitTry(haves, ["fetch", "-q", "--no-tags", repoUrl, "refs/heads/main"], env2);
		const havesReqs = ep.stats.requests.slice(gzBefore).filter((r) => r.method === "POST");
		check(
			"real git sends gzip-encoded POST bodies during negotiation; endpoint decodes them",
			havesFetch.code === 0 && havesReqs.some((r) => r.gzip),
			`${havesReqs.length} POSTs, gzip: ${havesReqs.map((r) => r.gzip).join(",")}`,
		);

		// ---------------------------------------------------------------- summary
		section("endpoint traffic seen from git (method path status protocol gzip)");
		const seen = new Map<string, number>();
		for (const r of [...ep.stats.requests, ...epNoReach.stats.requests]) {
			const k = `${r.method} ${r.path.replace(/^.*\.git/, ".git")} ${r.status} ${r.protocol || "v0"} gzip=${r.gzip}`;
			seen.set(k, (seen.get(k) ?? 0) + 1);
		}
		for (const [k, n] of seen) console.log(`  ${n}× ${k}`);
	} finally {
		for (const e of endpoints) e.stop();
		if (process.env.S3_KEEP) console.log(`\nkept ${root}`);
		else await rm(root, { recursive: true, force: true });
	}

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${failed.length === 0 ? "S3 PASS" : `S3 FAIL (${failed.length} failed)`}: ${results.length - failed.length}/${results.length} checks`);
	if (failed.length > 0) process.exit(1);
}

try {
	await main();
} catch (err) {
	console.error(`\nS3 ERROR: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
