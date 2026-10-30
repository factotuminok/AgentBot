// The fake GitHub of the chaos stack (test/e2e/chaos/run.ts) as its own compose service, so it outlives orchestrator
// restarts: `test/fakes/github.ts` on 0.0.0.0:8090 over bare repositories on its own volume, which the orchestrator
// pushes to (`file://`), plus a control API for the driver on 0.0.0.0:8091. A `post-receive` hook in the bare repository
// logs every ref update (`pushes.log` in the repository), so the driver can count pushes.
//   E2E_GIT_ROOT   bare repositories (default /e2e-github)
//   E2E_REPO       the repository (default acme/app); it gets a push-CI workflow, so the CI gate waits for check runs
//   E2E_AUTO_CI    1 (default): every branch head without a check run gets a green `build` check within a second
// Control API (no auth: the port is published on 127.0.0.1 only):
//   GET  /app                           {appId, privateKey, repoId, repo}
//   POST /issues   {count?, body, title?}  files `count` issues labelled `agentbot`; {numbers}
//   POST /comment  {number, body}       a MEMBER comment by alice on an issue or PR
//   POST /merge    {number}             merges and closes a PR
//   GET  /state                         issues and PRs with comments, ref updates, branch logs, mutating request counts
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../../../src/shared/git";
import { errorMessage, log } from "../../../src/shared/log";
import { startFakeGitHub } from "../../fakes/github";

const gitRoot = process.env.E2E_GIT_ROOT || "/e2e-github";
const repo = process.env.E2E_REPO || "acme/app";
const autoCi = (process.env.E2E_AUTO_CI ?? "1") === "1";
const bare = join(gitRoot, `${repo}.git`);
const pushLog = join(bare, "pushes.log");

if (!(await Bun.file(join(bare, "HEAD")).exists())) {
	const seed = join(gitRoot, "seed", repo);
	await mkdir(bare, { recursive: true });
	await mkdir(seed, { recursive: true });
	await git(["init", "-q", "--bare", "-b", "main", bare]);
	await git(["init", "-q", "-b", "main"], { cwd: seed });
	await Bun.write(join(seed, "README.md"), `# ${repo}\n`);
	await git(["add", "-A"], { cwd: seed });
	await git(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "Initial commit"], { cwd: seed });
	await git(["push", "-q", bare, "main"], { cwd: seed });
	// Runs in the pusher's receive-pack, with the bare repository as the working directory.
	const hook = join(bare, "hooks", "post-receive");
	await Bun.write(hook, '#!/bin/sh\nwhile read old new ref; do echo "$(date +%s) $old $new $ref" >> pushes.log; done\n');
	await chmod(hook, 0o755);
}

const gh = startFakeGitHub({ gitRoot, hostname: "0.0.0.0", port: 8090 });
const ghRepo = gh.addRepo(repo);
ghRepo.workflows.push({ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active", source: "on: push\njobs: {}\n" });

/** Branch name → head sha of every branch in the bare repository. */
async function heads(): Promise<Map<string, string>> {
	const out = await git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], { cwd: bare });
	return new Map(out ? out.split("\n").map(line => line.split(" ") as [string, string]) : []);
}

if (autoCi) {
	setInterval(async () => {
		try {
			for (const [branch, sha] of await heads()) {
				if (branch === ghRepo.defaultBranch || ghRepo.checkRuns.has(sha)) continue;
				gh.addCheckRun(repo, sha, { name: "build", status: "completed", conclusion: "success" });
				log("info", "e2e github: CI green", { branch, sha });
			}
		} catch (err) {
			log("warn", "e2e github: CI loop failed", { error: errorMessage(err) });
		}
	}, 500);
}

interface ControlBody {
	count?: number;
	number?: number;
	title?: string;
	body?: string;
}

async function control(req: Request): Promise<Response> {
	const path = new URL(req.url).pathname;
	const body = req.method === "POST" ? ((await req.json()) as ControlBody) : {};
	if (req.method === "GET" && path === "/app") return Response.json({ appId: gh.appId, privateKey: gh.privateKey, repoId: ghRepo.id, repo });
	if (req.method === "POST" && path === "/issues") {
		const numbers: number[] = [];
		for (let i = 0; i < (body.count ?? 1); i++) {
			const title = body.title ?? `Chaos change ${Date.now()}-${i}`;
			numbers.push(gh.addIssue(repo, { title, body: body.body ?? "", labels: ["agentbot"] }).number);
		}
		log("info", "e2e github: issues filed", { numbers });
		return Response.json({ numbers });
	}
	if (req.method === "POST" && path === "/comment") {
		gh.addIssueComment(repo, body.number ?? 0, { body: body.body ?? "", login: "alice", association: "MEMBER" });
		return Response.json({ ok: true });
	}
	if (req.method === "POST" && path === "/merge") {
		const pr = gh.getIssue(repo, body.number ?? 0);
		if (!pr.pull) return Response.json({ error: "not a PR" }, { status: 409 });
		pr.pull.merged = true;
		gh.updateIssue(repo, pr.number, { state: "closed" });
		return Response.json({ ok: true });
	}
	if (req.method === "GET" && path === "/state") {
		const lines = (await Bun.file(pushLog).exists()) ? (await Bun.file(pushLog).text()).split("\n").filter(Boolean) : [];
		const pushes = lines.map(line => {
			const [at, old = "", sha = "", ref = ""] = line.split(" ");
			// A forced update rewrote history: its old head is not an ancestor of the new one.
			const forced = !/^0+$/.test(old) && !/^0+$/.test(sha) && Bun.spawnSync(["git", "merge-base", "--is-ancestor", old, sha], { cwd: bare }).exitCode !== 0;
			return { at: Number(at), old, sha, ref, forced };
		});
		const branches: Record<string, { sha: string; log: string[] }> = {};
		for (const [branch, sha] of await heads()) branches[branch] = { sha, log: (await git(["log", "--format=%s", branch], { cwd: bare })).split("\n") };
		const mutating: Record<string, number> = {};
		for (const r of gh.requests) {
			if (r.method === "GET") continue;
			const key = `${r.method} ${r.path.replace(/\/\d+(?=\/|$)/g, "/{n}")}`;
			mutating[key] = (mutating[key] ?? 0) + 1;
		}
		return Response.json({
			issues: [...ghRepo.issues.values()].map(i => ({
				number: i.number,
				title: i.title,
				body: i.body,
				state: i.state,
				labels: i.labels,
				pull: i.pull ?? null,
				comments: i.comments.map(c => ({ id: c.id, login: c.user.login, body: c.body })),
			})),
			pushes,
			branches,
			mutating,
		});
	}
	return Response.json({ error: "not found" }, { status: 404 });
}

Bun.serve({
	port: 8091,
	hostname: "0.0.0.0",
	async fetch(req) {
		try {
			return await control(req);
		} catch (err) {
			return Response.json({ error: errorMessage(err) }, { status: 500 });
		}
	},
});
log("info", "e2e github started", { api: 8090, control: 8091, repo, gitRoot, autoCi });
