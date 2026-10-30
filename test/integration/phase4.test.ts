import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import type { RunHandle, RunHooks, RunRequest, RunResult, RunUi } from "../../src/orchestrator/dispatch/dispatcher";
import { createWorkerDispatcher, type WorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { createRepos, type Repos, runRef } from "../../src/orchestrator/git/repos";
import type { JobKind } from "../../src/orchestrator/engine/state";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { git } from "../../src/shared/git";
import { setLogSink } from "../../src/shared/log";
import { workerRoot } from "../../src/worker/status";

/**
 * Phase 4 exit (implementation.md §4): code runs on real worker processes (`test/fixtures/worker-process.ts` with the
 * fixture agent host) against the real dispatcher, internal API, git endpoint, mirrors and runs repos. "GitHub" is a
 * local bare repository the mirror fetches from and the result is pushed to. Covers the push of an implement run's
 * commits to the issue branch and the three failure checks: an evicted worker, a human push during the run, and a
 * time limit after committing; plus `setupCommand`, read-only runs and the disk limit.
 */

const WORKER_TOKEN = "phase4-worker-token";
const REPO = "acme/widget";
const ISSUE_BRANCH = "agentbot/issue-1-add-thing";
const LEASE_MS = 1_500;
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const IDENTITY = { name: "agentbot-test[bot]", email: "1+agentbot-test[bot]@users.noreply.github.com" };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

interface Worker {
	proc: Subprocess<"ignore", "pipe", "pipe">;
	root: string;
	exited: Promise<number>;
}

interface Harness {
	stateDir: string;
	db: Db;
	repos: Repos;
	dispatcher: WorkerDispatcher;
	api: InternalApi;
	logs: string[];
	/** The bare repository standing in for GitHub. */
	github: string;
	spawnWorker(env?: Record<string, string>): Worker;
	/** A job of `kind` on issue #1 (created on first use). */
	job(kind: JobKind): string;
	run(req: RunRequest): Run;
	/** A commit pushed to the issue branch on "GitHub" by someone else; returns its sha. */
	humanPush(): Promise<string>;
}

interface Run {
	result: Promise<RunResult>;
	handle: Promise<RunHandle>;
}

async function seed(github: string, repo: string, files: Record<string, string>): Promise<void> {
	const bare = join(github, `${repo}.git`);
	const work = join(github, "seed", repo);
	await mkdir(bare, { recursive: true });
	await mkdir(work, { recursive: true });
	await git(["init", "-q", "--bare", "-b", "main", bare]);
	await git(["init", "-q", "-b", "main"], { cwd: work });
	await writeFile(join(work, "README.md"), "# widget\n");
	await git(["add", "-A"], { cwd: work });
	await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Initial commit"], { cwd: work });
	for (const [name, content] of Object.entries(files)) await writeFile(join(work, name), content);
	await git(["add", "-A"], { cwd: work });
	await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Configure"], { cwd: work });
	await git(["push", "-q", bare, "main"], { cwd: work });
}

async function boot(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "agentbot-phase4-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const logs: string[] = [];
	setLogSink(line => logs.push(line));
	cleanups.push(() => setLogSink(undefined));
	const stateDir = join(root, "state");
	const github = join(root, "github");
	await mkdir(stateDir, { recursive: true });
	await seed(github, REPO, {
		".gitignore": ".setup/\n",
		".agentbot.yml": "setupCommand: mkdir -p .setup && echo ok > .setup/ran\n",
	});
	await seed(github, "acme/broken", { ".agentbot.yml": "setupCommand: echo installing; echo boom >&2; exit 3\n" });

	const db = openDb(dbPath(stateDir));
	const repos = createRepos({ stateDir, remoteUrl: repo => `file://${join(github, `${repo}.git`)}` });
	const dispatcher = createWorkerDispatcher({
		db,
		stateDir,
		// Every worker here connects from 127.0.0.1 (architecture §6 address binding is tested in dispatch.test.ts).
		bindWorkerAddresses: false,
		limits: () => ({ maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 4 }),
		reattachGraceMs: 2_000,
		spec: {
			stateDir,
			ompConfig: () => undefined,
			providerKeys: () => ({}),
			credentials: async () => [],
			skillsHash: async () => "skills-hash",
		},
		skills: async () => ({ hash: "skills-hash", tar: new Uint8Array() }),
		credentialRequest: async () => ({ ok: false, error: "none" }),
		claimWaitMs: 5_000,
		leaseMs: LEASE_MS,
		sweepMs: 50,
		repos,
	});
	const api = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir,
		db,
		version: "0.0.0-test",
		workerCapacity: 4,
		phase: () => "running",
		config: () => undefined,
		dispatcher,
		admin: { handle: async () => new Response("admin") },
		workers: dispatcher,
		workerToken: WORKER_TOKEN,
	});
	const workers: Worker[] = [];
	cleanups.push(async () => {
		dispatcher.close();
		await api.stop();
		for (const w of workers) {
			const children = Bun.spawnSync(["pgrep", "-P", String(w.proc.pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
			w.proc.kill("SIGKILL");
			for (const pid of children) {
				for (const target of [-pid, pid]) {
					try {
						process.kill(target, "SIGKILL");
					} catch {}
				}
			}
			await w.exited;
			await rm(w.root, { recursive: true, force: true });
		}
		db.close();
	});

	const issue = db.insertIssue(REPO, 1, "Add a thing");
	return {
		stateDir,
		db,
		repos,
		dispatcher,
		api,
		logs,
		github,
		spawnWorker(env = {}) {
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: { ...process.env, AGENTBOT_ORCHESTRATOR_URL: api.url, TEST_WORKER_TOKEN: WORKER_TOKEN, ...env },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			void new Response(proc.stdout).text();
			void new Response(proc.stderr).text();
			const w: Worker = { proc, root: workerRoot(join(tmpdir(), "agentbot-worker"), proc.pid), exited: proc.exited };
			workers.push(w);
			return w;
		},
		job: kind => db.insertJob(issue.id, kind).id,
		run(req) {
			const handle = Promise.withResolvers<RunHandle>();
			const hooks: RunHooks = { ui: {} as RunUi, register: h => handle.resolve(h) };
			const result = dispatcher.runAgent(req, hooks);
			result.catch(() => {});
			return { result, handle: handle.promise };
		},
		async humanPush() {
			const clone = join(github, "human");
			await rm(clone, { recursive: true, force: true });
			await git(["clone", "-q", "-b", ISSUE_BRANCH, join(github, `${REPO}.git`), clone]);
			await writeFile(join(clone, "human.txt"), "a human was here\n");
			await git(["add", "-A"], { cwd: clone });
			await git(["-c", "user.name=h", "-c", "user.email=h@h", "commit", "-q", "-m", "Human change"], { cwd: clone });
			await git(["push", "-q", "origin", ISSUE_BRANCH], { cwd: clone });
			return git(["rev-parse", "HEAD"], { cwd: clone });
		},
	};
}

/** A code-writing run of job `jobId` on issue #1 whose fixture script is `prompt`. */
function codeRequest(jobId: string, kind: "implement" | "revise", prompt: string, resume = false, repo = REPO): RunRequest {
	return {
		owner: { kind: "job", jobId },
		kind,
		profile: "implement",
		prompt,
		thinking: "low",
		limits: { minutes: 30, costUsd: 5 },
		session: `issue-1-${kind}`,
		resume,
		checkout: {
			repo,
			defaultBranch: async () => "main",
			issueBranch: ISSUE_BRANCH,
			leftoverMessage: "AgentBot: remaining changes for #1",
			identity: IDENTITY,
			gitToken: async () => "ghs_test_token",
		},
	};
}

/** Commit subjects of `ref` on "GitHub", newest first. */
async function githubLog(h: Harness, ref: string): Promise<string[]> {
	return (await git(["log", "--format=%s", ref], { cwd: join(h.github, `${REPO}.git`) })).split("\n");
}

async function refExists(h: Harness, ref: string): Promise<boolean> {
	return (await git(["for-each-ref", "--format=%(refname)", ref], { cwd: h.repos.runsPath(REPO) })) !== "";
}

interface Seen {
	log: string[];
	status: string[];
	branch: string;
	shallow: string;
	setupRan: boolean;
}

describe("phase 4: checkouts and git", () => {
	test("an implement run's commits reach the issue branch; temp refs go after the push (RUN-17 to RUN-20, WS-05)", async () => {
		const h = await boot();
		const run = h.run(codeRequest(h.job("implement"), "implement", "codeCommit"));
		const w = h.spawnWorker();
		const result = await run.result;
		const seen = result.output as Seen;
		// A shallow checkout of main on the run's temporary branch, after setupCommand ran.
		expect(seen.shallow).toBe("true");
		expect(seen.log).toEqual(["Configure"]);
		expect(seen.branch).toMatch(/^agentbot\/run-/);
		expect(seen.setupRan).toBe(true);
		// The agent's commit plus the leftover commit.
		expect(result.code?.commits).toBe(2);
		const runId = result.code!.runId;
		expect(h.db.getRun(runId)).toMatchObject({ repo: REPO, start_ref: "refs/heads/main", has_result: 1 });
		// The checkpoint goes when the run finishes (RUN-20); the result waits for the push.
		await until(() => h.db.getRun(runId)?.has_checkpoint === 0, "the checkpoint to be released");
		expect(await refExists(h, runRef(runId, "checkpoint"))).toBe(false);
		// The mirror never holds temp refs (WS-07).
		expect(await git(["for-each-ref", "refs/agentbot"], { cwd: h.repos.mirrorPath(REPO) })).toBe("");

		const pushed = await h.dispatcher.pushResult(runId, ISSUE_BRANCH, "ghs_test_token");
		expect(pushed.pushed).toBe(true);
		expect(await githubLog(h, ISSUE_BRANCH)).toEqual(["AgentBot: remaining changes for #1", "Add feature", "Configure", "Initial commit"]);
		expect(await git(["log", "-1", "--format=%an <%ae>", ISSUE_BRANCH], { cwd: join(h.github, `${REPO}.git`) })).toBe(`${IDENTITY.name} <${IDENTITY.email}>`);
		await h.dispatcher.discardResult(runId);
		expect(await refExists(h, runRef(runId, "result"))).toBe(false);
		expect(h.db.getRun(runId)?.has_result).toBe(0);
		// RUN-20: the worker exits 0 and leaves nothing behind.
		expect(await w.exited).toBe(0);
		expect(existsSync(w.root)).toBe(false);
	}, 30_000);

	test("an evicted worker: the next worker resumes with the commits and the uncommitted file intact (RUN-04, RUN-18, JOB-11)", async () => {
		const h = await boot();
		const job = h.job("implement");
		const first = h.run(codeRequest(job, "implement", "codeHeld"));
		const evicted = h.spawnWorker();
		await first.handle;
		await until(() => h.logs.some(l => l.includes('"run started"')), "the run to start");
		evicted.proc.kill("SIGTERM");
		// The SIGTERM checkpoint and the cleanup ran before the process exited (RUN-18, RUN-20).
		await evicted.exited;
		expect(existsSync(evicted.root)).toBe(false);
		// The SIGTERM checkpoint is kept; the lease then expires and the run is lost.
		await expect(first.result).rejects.toThrow("the worker running this was lost");
		const lost = h.db.runsInState("finished").find(r => r.job_id === job)!;
		expect(lost).toMatchObject({ outcome: "lost", has_checkpoint: 1 });

		// The scheduler requeues the job once with `resume: true` (RUN-04).
		const resumed = h.run(codeRequest(job, "implement", "inspect", true));
		h.spawnWorker();
		const seen = (await resumed.result).output as Seen;
		expect(seen.log).toEqual(["Add a", "Configure"]);
		expect(seen.status).toEqual(["?? wip.txt"]);
		const row = h.db.getRun((await resumed.result).code!.runId)!;
		expect(row).toMatchObject({ continues_run_id: lost.id, start_commit: lost.start_commit });
		// The resumed run finished: the lost run's checkpoint is released (RUN-20).
		await until(() => h.db.getRun(lost.id)?.has_checkpoint === 0, "the lost run's checkpoint to be released");
		expect(await refExists(h, runRef(lost.id, "checkpoint"))).toBe(false);
	}, 40_000);

	test("a human push during the run: the push is refused, and Retry starts from the new head (RUN-19)", async () => {
		const h = await boot();
		// The issue branch exists: an earlier implement pushed it.
		const implement = h.run(codeRequest(h.job("implement"), "implement", "codeCommit"));
		h.spawnWorker();
		const first = await implement.result;
		expect((await h.dispatcher.pushResult(first.code!.runId, ISSUE_BRANCH, "t")).pushed).toBe(true);
		await h.dispatcher.discardResult(first.code!.runId);

		const revise = h.run(codeRequest(h.job("revise"), "revise", "codeHeld"));
		h.spawnWorker();
		const handle = await revise.handle;
		await until(() => h.db.runsInState("running").length === 1, "the revise run to start");
		const humanHead = await h.humanPush();
		await handle.steer("finish", "alice");
		const result = await revise.result;
		expect(result.code?.commits).toBe(2);
		expect(await h.dispatcher.pushResult(result.code!.runId, ISSUE_BRANCH, "t")).toEqual({ pushed: false });
		expect(await git(["rev-parse", ISSUE_BRANCH], { cwd: join(h.github, `${REPO}.git`) })).toBe(humanHead);
		await h.dispatcher.discardResult(result.code!.runId);

		// Retry: nothing kept, so the run starts from the issue branch's new head.
		const retry = h.run(codeRequest(h.job("revise"), "revise", "inspect", true));
		h.spawnWorker();
		const seen = (await retry.result).output as Seen;
		expect(seen.log[0]).toBe("Human change");
		const row = h.db.getRun((await retry.result).code!.runId)!;
		expect(row).toMatchObject({ start_ref: `refs/heads/${ISSUE_BRANCH}`, start_commit: humanHead, continues_run_id: null });
	}, 40_000);

	test("a time limit after committing: Retry continues with the commits and the uncommitted work (JOB-11, RUN-20)", async () => {
		const h = await boot();
		const timed = h.run(codeRequest(h.job("implement"), "implement", "codeHeld"));
		h.spawnWorker();
		const handle = await timed.handle;
		await until(() => h.db.runsInState("running").length === 1, "the run to start");
		await handle.abort("time");
		const stopped = await timed.result;
		expect(stopped.aborted).toBe("time");
		expect(stopped.code?.commits).toBe(2);
		const kept = h.db.getRun(stopped.code!.runId)!;
		await Bun.sleep(100);
		// A failed job run keeps both refs, unpushed, for Retry.
		expect(h.db.getRun(kept.id)).toMatchObject({ outcome: "aborted", has_checkpoint: 1, has_result: 1 });
		expect(await refExists(h, runRef(kept.id, "checkpoint"))).toBe(true);

		const retry = h.run(codeRequest(h.job("implement"), "implement", "inspect", true));
		h.spawnWorker();
		const result = await retry.result;
		const seen = result.output as Seen;
		// The checkpoint was taken before the leftover commit: the work comes back uncommitted, not as that commit.
		expect(seen.log).toEqual(["Add a", "Configure"]);
		expect(seen.status).toEqual(["?? wip.txt"]);
		expect(h.db.getRun(result.code!.runId)).toMatchObject({ continues_run_id: kept.id, start_commit: kept.start_commit });
		await until(() => h.db.getRun(kept.id)?.has_checkpoint === 0 && h.db.getRun(kept.id)?.has_result === 0, "the earlier run's refs to be released");
		expect(await refExists(h, runRef(kept.id, "result"))).toBe(false);

		// Pushing the Retry's result creates the issue branch with every commit.
		expect((await h.dispatcher.pushResult(result.code!.runId, ISSUE_BRANCH, "t")).pushed).toBe(true);
		expect(await githubLog(h, ISSUE_BRANCH)).toEqual(["AgentBot: remaining changes for #1", "Continue", "Add a", "Configure", "Initial commit"]);
	}, 40_000);

	test("terminal cleanup and the start-up prune delete kept refs (WS-07, WS-08)", async () => {
		const h = await boot();
		const timed = h.run(codeRequest(h.job("implement"), "implement", "codeHeld"));
		h.spawnWorker();
		const handle = await timed.handle;
		await until(() => h.db.runsInState("running").length === 1, "the run to start");
		await handle.abort("time");
		const kept = (await timed.result).code!.runId;
		await until(() => h.db.getRun(kept)?.has_checkpoint === 1, "kept refs");
		// A ref no run keeps (a crash between import and bookkeeping) goes at the next start.
		await git(["update-ref", "refs/agentbot/runs/orphan", h.db.getRun(kept)!.start_commit!], { cwd: h.repos.runsPath(REPO) });
		const restarted = createWorkerDispatcher({
			db: h.db,
			stateDir: h.stateDir,
			bindWorkerAddresses: false,
			limits: () => undefined,
			reattachGraceMs: 1_000,
			spec: { stateDir: "", ompConfig: () => undefined, providerKeys: () => ({}), credentials: async () => [], skillsHash: async () => "" },
			skills: async () => ({ hash: "", tar: new Uint8Array() }),
			credentialRequest: async () => ({ ok: false, error: "none" }),
			repos: h.repos,
		});
		await restarted.maintenance();
		restarted.close();
		expect(await refExists(h, "refs/agentbot/runs/orphan")).toBe(false);
		expect(await refExists(h, runRef(kept, "checkpoint"))).toBe(true);

		await h.dispatcher.releaseIssue(h.db.findIssue(REPO, 1)!.id);
		expect(await git(["for-each-ref", "refs/agentbot"], { cwd: h.repos.runsPath(REPO) })).toBe("");
		expect(h.db.getRun(kept)).toMatchObject({ has_checkpoint: 0, has_result: 0 });
	}, 30_000);

	test("read-only runs check out the base and keep nothing; a failing setupCommand fails the run with its output (WS-04, WS-05)", async () => {
		const h = await boot();
		const plan = h.run({ ...codeRequest(h.job("plan"), "implement", "inspect"), kind: "plan", profile: "plan", session: "issue-1-plan" });
		h.spawnWorker();
		const result = await plan.result;
		expect((result.output as Seen).log).toEqual(["Configure"]);
		expect(result.code).toBeUndefined();
		const row = h.db.runsInState("finished").find(r => r.kind === "plan")!;
		expect(row).toMatchObject({ has_checkpoint: 0, has_result: 0 });
		expect(await git(["for-each-ref", "refs/agentbot"], { cwd: h.repos.runsPath(REPO) })).toBe("");

		const broken = h.run({ ...codeRequest(h.job("plan"), "implement", "inspect", false, "acme/broken"), kind: "plan", profile: "plan", session: "issue-1-plan" });
		h.spawnWorker();
		const error = await broken.result.then(
			() => "no error",
			err => (err as Error).message,
		);
		expect(error).toStartWith("setupCommand failed (exit 3):");
		expect(error).toContain("installing");
		expect(error).toContain("boom");
	}, 30_000);

	test("a checkout over its disk limit fails the run (STO-06)", async () => {
		const h = await boot();
		const run = h.run(codeRequest(h.job("implement"), "implement", "fillDisk"));
		h.spawnWorker({ TEST_DISK_LIMIT: String(2 * 1024 * 1024) });
		const error = await run.result.then(
			() => "no error",
			err => (err as Error).message,
		);
		expect(error).toStartWith("the run ran out of disk space");
		expect(error).toContain("over the 2.0 MiB limit");
	}, 30_000);
});
