import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { createWorkerDispatcher, type WorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { createRepos } from "../../src/orchestrator/git/repos";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import { openSignins, type Signins } from "../../src/orchestrator/store/signins";
import { openVault } from "../../src/orchestrator/store/vault";
import { parseSettings } from "../../src/shared/config";
import { git } from "../../src/shared/git";
import { setLogSink } from "../../src/shared/log";
import { workerRoot } from "../../src/worker/status";
import { createFakeDiscord, type Emitted, type FakeDiscord, type FakeMessage } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

/**
 * Phase 5 exit (implementation.md §4) on the fake surfaces: the real controller, bot, scheduler, dispatcher, git
 * endpoint, mirrors and runs repos, with worker processes (`test/fixtures/worker-process.ts`) running the fixture agent
 * host. Its `auto` script plays whatever each run's output schema asks for, driven by a `fixture:auto` marker in the
 * issue or request. "GitHub" is the fake API server over local bare repositories: what the orchestrator pushes is what
 * the API reports. The orchestrator is restarted at every step of each flow; nothing may be lost or done twice (NFR-03).
 */

const WORKER_TOKEN = "phase5-worker-token";
const WORK = "work-channel";
const ALICE = "u-alice";
const LEASE_MS = 1_500;
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const MARKER = "fixture:auto";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!(await cond())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

interface Orchestrator {
	db: Db;
	dispatcher: WorkerDispatcher;
	api: InternalApi;
	controller: Controller;
	stop(): Promise<void>;
}

interface Harness {
	discord: FakeDiscord;
	gh: FakeGitHub;
	orch: Orchestrator;
	/** Where the bare "GitHub" repositories live. */
	gitRoot: string;
	/** The test's temp root; agent hosts dump what they see to `<root>/host-dumps` (SEC-01). */
	root: string;
	restart(): Promise<void>;
	/** Head of `branch` on "GitHub", or undefined. */
	head(repo: string, branch: string): Promise<string | undefined>;
	/** Commit subjects of `branch` on "GitHub", newest first. */
	log(repo: string, branch: string): Promise<string[]>;
	work(subcommand: string, options: Record<string, string | number>, channelId?: string): Promise<Emitted>;
	click(m: FakeMessage, label: string): Promise<Emitted>;
}

/** A bare repository on "GitHub" with one commit on `main`. */
async function seedRepo(gitRoot: string, repo: string): Promise<void> {
	const bare = join(gitRoot, `${repo}.git`);
	const work = join(gitRoot, "seed", repo);
	await mkdir(bare, { recursive: true });
	await mkdir(work, { recursive: true });
	await git(["init", "-q", "--bare", "-b", "main", bare]);
	await git(["init", "-q", "-b", "main"], { cwd: work });
	await writeFile(join(work, "README.md"), `# ${repo}\n`);
	await git(["add", "-A"], { cwd: work });
	await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Initial commit"], { cwd: work });
	await git(["push", "-q", bare, "main"], { cwd: work });
}

async function boot(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "agentbot-phase5-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	// The in-process components log a lot; keep the test output readable.
	setLogSink(() => {});
	cleanups.push(() => setLogSink(undefined));
	const stateDir = join(root, "state");
	const gitRoot = join(root, "github");
	await mkdir(stateDir, { recursive: true });
	const ompDir = join(stateDir, "omp");
	await ensureOmpAssetsDir(ompDir);
	const masterKey = Buffer.from(crypto.randomUUID() + crypto.randomUUID(), "utf8");

	const gh = startFakeGitHub({ gitRoot });
	cleanups.push(() => gh.stop());
	const discord = createFakeDiscord({ guildId: "g1", channels: [{ id: WORK, name: "work" }] });
	const alice = discord.actor(ALICE, { username: "alice" });

	let port = 0;
	async function start(first: boolean): Promise<Orchestrator> {
		const db = openDb(dbPath(stateDir));
		const vault = await openVault(db, masterKey);
		if (first) {
			await vault.initialize("admin", "correct horse battery");
			vault.writeSettings(
				parseSettings({
					config: {
						discord: { guildId: "g1", allowedUserIds: [ALICE], workChannelId: WORK },
						github: { appId: gh.appId, pollIntervalSeconds: 1 },
					},
					secrets: { discordToken: "discord-token", githubAppPrivateKey: gh.privateKey },
				}),
			);
		}
		const settings = () => vault.readSettings();
		const signins: Signins = await openSignins(stateDir);
		const dispatcher = createWorkerDispatcher({
			db,
			stateDir,
			// Every worker here connects from 127.0.0.1 (architecture §6 address binding is tested in dispatch.test.ts).
			bindWorkerAddresses: false,
			limits: () => {
				const config = settings()?.config;
				if (!config) return undefined;
				return { maxConcurrentJobs: config.limits.maxConcurrentJobs, maxChatSessions: config.limits.maxChatSessions, maxConcurrentRuns: 4 };
			},
			reattachGraceMs: 10_000,
			spec: {
				stateDir,
				ompConfig: () => vault.readOmpConfig(),
				providerKeys: () => ({}),
				credentials: () => signins.snapshotForRun(),
				skillsHash: async () => (await skillsBundle(ompDir)).hash,
			},
			skills: () => skillsBundle(ompDir),
			credentialRequest: req => signins.handleCredentialRequest(req),
			leaseMs: LEASE_MS,
			sweepMs: 50,
			repos: createRepos({ stateDir, remoteUrl: repo => `file://${join(gitRoot, `${repo}.git`)}` }),
		});
		const api = startInternalApi({
			host: "127.0.0.1",
			port,
			stateDir,
			db,
			version: "0.0.0-test",
			workerCapacity: 4,
			phase: () => controller.status().phase,
			config: () => settings()?.config,
			dispatcher,
			admin: { handle: async () => new Response("admin") },
			workers: dispatcher,
			workerToken: WORKER_TOKEN,
		});
		port = Number(new URL(api.url).port);
		const controller = createController({
			stateDir,
			db,
			vault,
			agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
			dispatcher,
			connectDiscord: () => discord,
			connectGitHub: ({ appId, privateKey, labels }) => createGitHub({ appId, privateKey, labels, baseUrl: gh.url, throttle: false }),
		});
		await controller.apply();
		expect(controller.status()).toMatchObject({ phase: "running", error: undefined });
		let stopped = false;
		const stop = async () => {
			if (stopped) return;
			stopped = true;
			// main.ts's shutdown order (RUN-09): runs keep going on their workers.
			await api.stop();
			dispatcher.close();
			await controller.stop();
			signins.close();
			db.close();
		};
		cleanups.push(stop);
		return { db, dispatcher, api, controller, stop };
	}

	// A stand-in for the launcher (LCH-02): a worker for each pending run, one per 3 s at most while the run is unclaimed.
	const workers: { proc: Subprocess<"ignore", "pipe", "pipe">; root: string; startedAt: number }[] = [];
	const launcher = setInterval(() => {
		let pending: number;
		try {
			pending = h.orch.dispatcher.pendingRuns();
		} catch {
			// The orchestrator is restarting: its database is closed for a moment.
			return;
		}
		const starting = workers.filter(w => Date.now() - w.startedAt < 3_000).length;
		for (let i = starting; i < pending; i++) {
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: {
					...process.env,
					AGENTBOT_ORCHESTRATOR_URL: h.orch.api.url,
					TEST_WORKER_TOKEN: WORKER_TOKEN,
					TEST_CLAIM_TIMEOUT_MS: "4000",
					// Every agent host records what its agent can read (SEC-01, AGT-02).
					TEST_HOST_DUMP_DIR: join(root, "host-dumps"),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			void new Response(proc.stdout).text();
			void new Response(proc.stderr).text();
			workers.push({ proc, root: workerRoot(join(tmpdir(), "agentbot-worker"), proc.pid), startedAt: Date.now() });
		}
	}, 100);
	cleanups.push(async () => {
		clearInterval(launcher);
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
			await w.proc.exited;
			await rm(w.root, { recursive: true, force: true });
		}
	});

	const h: Harness = {
		discord,
		gh,
		gitRoot,
		root,
		orch: await start(true),
		async restart() {
			await h.orch.stop();
			h.orch = await start(false);
		},
		async head(repo, branch) {
			const r = await git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`], { cwd: join(gitRoot, `${repo}.git`) });
			return r || undefined;
		},
		async log(repo, branch) {
			return (await git(["log", "--format=%s", branch], { cwd: join(gitRoot, `${repo}.git`) })).split("\n");
		},
		work: (subcommand, options, channelId = WORK) => discord.emitCommand({ command: "work", subcommand, options, actor: alice, channelId }),
		click(m, label) {
			const button = m.components.flatMap(row => row.components).find(b => "label" in b && b.label === label);
			if (!button || !("custom_id" in button)) throw new Error(`no ${label} button`);
			return discord.emitComponent({ message: { channelId: m.channelId, messageId: m.id }, customId: button.custom_id, actor: alice });
		},
	};
	return h;
}

/** The newest message in `threadId` with buttons whose content includes `text`. */
function withButtons(h: Harness, threadId: string, text: string): FakeMessage | undefined {
	return h.discord.messages(threadId).findLast(m => m.content.includes(text) && m.components.length > 0);
}

function said(h: Harness, threadId: string, text: string): boolean {
	return h.discord.messages(threadId).some(m => m.content.includes(text));
}

/** Pull requests filed on the fake repository. */
function pulls(h: Harness, repo: string) {
	return [...h.gh.getRepo(repo).issues.values()].filter(i => i.pull);
}

describe("phase 5 exit", () => {
	test("label → plan → approve → push CI → PR → review → revise → merge, with a restart at each step", async () => {
		const h = await boot();
		const repo = "acme/app";
		await seedRepo(h.gitRoot, repo);
		h.gh.addRepo(repo);
		h.gh.getRepo(repo).workflows.push({ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active", source: "on: push\njobs: {}\n" });
		const ghIssue = h.gh.addIssue(repo, { title: "Add a thing", body: `Please add a thing. ${MARKER}` });

		await h.work("start", { repo, issue: ghIssue.number });
		const issueId = h.orch.db.findIssue(repo, ghIssue.number)!.id;
		const threadId = h.orch.db.getIssue(issueId)!.thread_id!;
		await h.restart();

		// 1. The plan, on a worker, awaiting approval.
		await until(() => h.orch.db.getIssue(issueId)?.state === "awaiting_approval", "the plan");
		await until(() => !!withButtons(h, threadId, "Plan ready for your approval"), "the plan message");
		await h.restart();
		await h.click(withButtons(h, threadId, "Plan ready for your approval")!, "Approve");

		// 2. Implement on a worker, pushed to the issue branch, then the CI gate waits for push CI.
		await until(() => said(h, threadId, "Waiting for CI"), "the CI wait", 40_000);
		const branch = h.orch.db.getIssue(issueId)!.branch!;
		expect(branch).toStartWith(`agentbot/issue-${ghIssue.number}-add-a-thing`);
		const pushed = (await h.head(repo, branch))!;
		expect(await h.log(repo, branch)).toEqual(["Implement the change", "Initial commit"]);
		await h.restart();
		h.gh.addCheckRun(repo, pushed, { name: "build", status: "completed", conclusion: "success" });

		// 3. Green CI opens the PR exactly once.
		await until(() => h.orch.db.getIssue(issueId)?.state === "in_review", "the PR", 30_000);
		const pr = h.orch.db.getIssue(issueId)!.pr_number!;
		expect(pulls(h, repo).map(p => p.number)).toEqual([pr]);
		expect(h.gh.getIssue(repo, pr).body).toContain(`Closes #${ghIssue.number}`);
		await until(() => said(h, threadId, "Implementation complete"), "Implementation complete");
		await h.restart();

		// 4. A review comment with the keyword makes the revise run push a follow-up commit.
		h.gh.addIssueComment(repo, pr, { body: `/agentbot please tidy this up ${MARKER}`, login: "alice", association: "MEMBER" });
		await until(async () => (await h.log(repo, branch))[0] === "Address the follow-up", "the revise push", 40_000);
		await until(() => said(h, threadId, "Review feedback addressed"), "the revise message");
		await h.restart();
		expect(await h.log(repo, branch)).toEqual(["Address the follow-up", "Implement the change", "Initial commit"]);

		// 5. Merging the PR finishes the issue and archives the thread.
		h.gh.getIssue(repo, pr).pull!.merged = true;
		h.gh.updateIssue(repo, pr, { state: "closed" });
		await until(() => h.orch.db.getIssue(issueId)?.state === "done", "done");
		await until(() => h.discord.channels().find(c => c.id === threadId)?.archived === true, "the archived thread");
		expect(pulls(h, repo)).toHaveLength(1);
		expect(h.gh.getIssue(repo, ghIssue.number).comments.filter(c => c.body.startsWith("<!-- agentbot:plan -->"))).toHaveLength(1);

		// The issue branch is still on "GitHub" after done: nothing deletes remote branches (WS-06).
		expect(await h.head(repo, branch)).toBeDefined();
		expect(h.gh.requests.filter(r => r.method === "DELETE" && r.path.includes("/git/refs"))).toEqual([]);

		// Installation tokens were minted for the orchestrator, yet no run's agent saw one, nor the Discord token or the
		// App key (SEC-01, AGT-02): plan, implement and revise runs, each dumped by the fixture host.
		expect(h.gh.requests.some(r => r.method === "POST" && r.path.endsWith("/access_tokens"))).toBe(true);
		const dumps = await readdir(join(h.root, "host-dumps"));
		expect(dumps.length).toBeGreaterThanOrEqual(3);
		for (const name of dumps) {
			const seen = await readFile(join(h.root, "host-dumps", name), "utf8");
			expect(seen).not.toContain("discord-token");
			expect(seen).not.toContain("ghs_");
			expect(seen).not.toContain("PRIVATE KEY");
			for (const line of h.gh.privateKey.split("\n").filter(l => l.length > 20)) expect(seen).not.toContain(line);
		}
	}, 180_000);

	test("/work plan → Execute → PR, and /work issue → filed and planned, with restarts", async () => {
		const h = await boot();
		const repo = "acme/lib";
		await seedRepo(h.gitRoot, repo);
		h.gh.addRepo(repo);

		// /work plan, restarted while planning.
		await h.work("plan", { repo, prompt: `Add a changelog. ${MARKER}` });
		const planThread = h.discord.channels().find(c => c.kind === "thread")!.id;
		await h.restart();
		await until(() => !!withButtons(h, planThread, "Plan ready for your review"), "the request plan", 30_000);
		await h.restart();
		await h.click(withButtons(h, planThread, "Plan ready for your review")!, "Execute");

		// Execute files the issue, binds this thread, and implements it: no push CI, so the PR opens at once.
		await until(() => h.orch.db.issueByThread(planThread)?.state === "in_review", "the executed plan's PR", 40_000);
		const executed = h.orch.db.issueByThread(planThread)!;
		expect(h.gh.getIssue(repo, executed.number).labels).toContain("agentbot");
		expect(pulls(h, repo)).toHaveLength(1);
		expect(await h.log(repo, executed.branch!)).toEqual(["Implement the change", "Initial commit"]);

		// /work issue, restarted while drafting: filed once, tracked, and planned.
		const issues = h.gh.getRepo(repo).issues.size;
		await h.work("issue", { repo, request: `Document the release steps. ${MARKER}` });
		await h.restart();
		await until(() => h.orch.db.openIssues().some(i => i.repo === repo && i.number !== executed.number && i.state === "awaiting_approval"), "the drafted issue's plan", 40_000);
		const drafted = h.orch.db.openIssues().find(i => i.repo === repo && i.number !== executed.number)!;
		const filed = h.gh.getIssue(repo, drafted.number);
		expect(filed.title).toBe("Fixture drafted issue");
		expect(filed.labels).toContain("agentbot");
		expect(filed.body).toContain("> Document the release steps.");
		// One issue filed by the draft, one PR from Execute; nothing else.
		expect(h.gh.getRepo(repo).issues.size).toBe(issues + 1);
	}, 180_000);
});
