// The orchestrator of the Kubernetes scenario image (test/e2e/k8s/Containerfile): `src/orchestrator/main.ts`'s wiring —
// the real internal API (health, worker WebSocket, scale, git and run artifacts), worker dispatcher, engine, poller
// and admin API, with the chart's mounted token files and env read exactly like the real one — but with the fake
// Discord (`test/fakes/discord.ts`) and the fake GitHub API (`test/fakes/github.ts`) over bare repositories under the
// state volume in-process, and the settings seeded into the vault at every start. So the chart runs it unchanged, and
// workers, KEDA and the probes see the real product; only Discord, GitHub and the model are fake.
//
// Settings seeded from env (all optional):
//   E2E_MAX_CONCURRENT_JOBS  limits.maxConcurrentJobs (default 2, the product default)
//   E2E_MAX_CHAT_SESSIONS    limits.maxChatSessions (default 2)
//   E2E_REPO                 the watched repository (default acme/app)
//   E2E_POLL_SECONDS         github.pollIntervalSeconds (default 2)
// Dispatcher timings, for the plain-process test (test/integration/k8sharness.test.ts); unset = the product's defaults,
// as in the kind scenarios:
//   E2E_LEASE_MS             run lease (default LEASE_MS, 45 s): how long a vanished worker takes to count as lost
//   E2E_SWEEP_MS             how often expired leases are swept (default 1 s)
//   E2E_REATTACH_GRACE_MS    re-attach grace after a restart (default workers.reattachGraceSeconds)
// For the chaos stack (test/e2e/chaos), where the fakes must outlive the orchestrator:
//   E2E_GITHUB_URL           use the fake GitHub service at this URL instead of one in-process (its control API at
//                            E2E_GITHUB_CONTROL_URL, default http://github:8091, gives the app key and repo id)
//   E2E_GIT_ROOT             the bare repositories (default <state>/e2e-github; the service's volume with E2E_GITHUB_URL)
//   E2E_DISCORD_STATE        keep the fake Discord's channels and messages in this file across restarts
//   GET /internal/admin/e2e/issues?numbers=<n,...>  issues in any state with their job and their thread's messages
//
// A control API for the driver (test/e2e/k8s/scenarios.sh) sits under `/internal/admin/e2e/`, guarded by the web token
// like the rest of `/internal/admin/`:
//   POST /internal/admin/e2e/issues   {count, planSeconds?, implementSeconds?}  files `count` labelled `fixture:slow` issues
//   POST /internal/admin/e2e/limits   {maxConcurrentJobs?, maxChatSessions?}    saves the settings and restarts the engine
//   POST /internal/admin/e2e/approve  {issue}                                   clicks Approve on the issue's plan
//   POST /internal/admin/e2e/click    {issue, label}                            clicks the newest bot button so labelled
//        in the issue's thread (the chaos driver's Retry)
//   GET  /internal/admin/e2e/state                                              issues, runs, run state transitions, limits
//   GET  /internal/admin/e2e/branch?issue=<n>                                   the issue branch on "GitHub": log, resumed.txt
// For the load test (test/e2e/k8s/load.ts):
//   POST /internal/admin/e2e/repos    {repos, files?, textFiles?, textBytes?, binaryFiles?, binaryBytes?}  creates, seeds
//        and watches more repositories (each with its own watch channel); `issues`, `approve` and `branch` take a `repo`
//   POST /internal/admin/e2e/discord  {latencyMs?, perWindow, windowMs} | {}  simulates Discord's REST latency and
//        per-channel rate limits in the fake (`{}` turns it off)
//   POST /internal/admin/e2e/sqlite   {synchronous: "FULL" | "NORMAL"}  sets the database's PRAGMA synchronous (an experiment)
//   GET  /internal/admin/e2e/metrics  the container's cgroup CPU, memory and pressure, the Discord queue and event-loop
//        lag per second, the state volume's append/fsync latency per second (test/e2e/k8s/diskprobe.ts), mirror fetch /
//        push and git endpoint timings
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { createAdminApi, loadWebApiToken } from "../../../src/orchestrator/api/admin";
import { createAdminFeatures } from "../../../src/orchestrator/api/features";
import { loadInternalToken, startInternalApi } from "../../../src/orchestrator/api/server";
import { sameToken } from "../../../src/orchestrator/dispatch/leases";
import { createWorkerDispatcher, dispatchLimits, type WorkerDispatcher } from "../../../src/orchestrator/dispatch/workers";
import { createController } from "../../../src/orchestrator/engine/controller";
import { createGitHub } from "../../../src/orchestrator/github/app";
import { createRepos, type Repos } from "../../../src/orchestrator/git/repos";
import { openAgentLog } from "../../../src/orchestrator/store/agentlog";
import { dbPath, openDb, type RunRow } from "../../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../../src/orchestrator/store/ompAssets";
import { openSignins } from "../../../src/orchestrator/store/signins";
import { loadMasterKey, openVault } from "../../../src/orchestrator/store/vault";
import { ADMIN_PREFIX } from "../../../src/shared/adminApi";
import { parseSettings } from "../../../src/shared/config";
import { loadEnv } from "../../../src/shared/env";
import { git } from "../../../src/shared/git";
import { errorMessage, log } from "../../../src/shared/log";
import { openRollingFiles } from "../../../src/shared/rollinglog";
import { createOmpUpdater } from "../../../src/orchestrator/omp/updates";
import { installedOmpVersion } from "../../../src/shared/ompPins";
import { APP_ROOT, appIdentity, versionInfo } from "../../../src/shared/version";
import { createFakeDiscord } from "../../fakes/discord";
import { startFakeGitHub } from "../../fakes/github";

const GUILD = "e2e-guild";
const WORK_CHANNEL = "e2e-work";
const WATCH_CHANNEL = "e2e-watch";
const ADMIN_USER = "e2e-admin";
const CONTROL_PREFIX = `${ADMIN_PREFIX}/e2e/`;
const ALL_RUN_STATES = ["pending", "assigned", "running", "finishing", "finished", "lost"] as const;

const env = loadEnv();
const repo = process.env.E2E_REPO || "acme/app";
const seededLimits = {
	maxConcurrentJobs: Number(process.env.E2E_MAX_CONCURRENT_JOBS || 2),
	maxChatSessions: Number(process.env.E2E_MAX_CHAT_SESSIONS || 2),
};
const optionalMs = (name: string): number | undefined => (process.env[name] ? Number(process.env[name]) : undefined);

/** Load-test timings (`GET e2e/metrics`): mirror fetches and pushes, git endpoint requests. */
interface Timing {
	at: string;
	op: string;
	repo?: string;
	ms: number;
	bytes?: number;
	status?: number;
}
const timings: Timing[] = [];
async function timed<T>(op: string, name: string, work: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		return await work();
	} finally {
		timings.push({ at: new Date().toISOString(), op, repo: name, ms: Math.round(performance.now() - start) });
	}
}
/** `repos` with its mirror fetches and pushes timed. */
function timedRepos(repos: Repos): Repos {
	return {
		...repos,
		fetch: (name, token) => timed("mirror-fetch", name, () => repos.fetch(name, token)),
		push: (name, runId, branch, token) => timed("push", name, () => repos.push(name, runId, branch, token)),
	};
}

await mkdir(join(env.stateDir, "logs", "orchestrator"), { recursive: true });
const processLog = openRollingFiles({ dir: join(env.stateDir, "logs", "orchestrator"), prefix: "orchestrator" });
const db = openDb(dbPath(env.stateDir));
const agentLog = await openAgentLog({ dir: join(env.stateDir, "logs", "agent") });
const vault = await openVault(db, await loadMasterKey(env.masterKeyFile));
const { agentbot: version } = await versionInfo();

// "GitHub": bare repositories on the state volume, served by the fake API in this process; or, with E2E_GITHUB_URL,
// the fake GitHub service of the chaos stack (test/e2e/chaos/github.ts), which owns the repositories under E2E_GIT_ROOT.
const githubUrl = process.env.E2E_GITHUB_URL;
const gitRoot = process.env.E2E_GIT_ROOT || join(env.stateDir, "e2e-github");
const bare = join(gitRoot, `${repo}.git`);
if (!githubUrl && !(await Bun.file(join(bare, "HEAD")).exists())) {
	const seed = join(gitRoot, "seed", repo);
	await mkdir(bare, { recursive: true });
	await mkdir(seed, { recursive: true });
	await git(["init", "-q", "--bare", "-b", "main", bare]);
	await git(["init", "-q", "-b", "main"], { cwd: seed });
	await Bun.write(join(seed, "README.md"), `# ${repo}\n`);
	await git(["add", "-A"], { cwd: seed });
	await git(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "Initial commit"], { cwd: seed });
	await git(["push", "-q", bare, "main"], { cwd: seed });
}
const gh = githubUrl ? undefined : startFakeGitHub({ gitRoot });
/** The app and repository the orchestrator is configured with, in-process or from the service's control API. */
interface GitHubApp {
	url: string;
	appId: number;
	privateKey: string;
	repoId: number;
}
async function remoteGitHub(url: string, controlUrl: string): Promise<GitHubApp> {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(`${controlUrl}/app`, { signal: AbortSignal.timeout(2_000) });
			if (res.ok) return { url, ...((await res.json()) as Omit<GitHubApp, "url">) };
		} catch (err) {
			if (attempt >= 60) throw new Error(`the fake GitHub service at ${controlUrl} does not answer: ${errorMessage(err)}`);
		}
		await Bun.sleep(1_000);
	}
}
const github: GitHubApp = gh
	? { url: gh.url, appId: gh.appId, privateKey: gh.privateKey, repoId: gh.addRepo(repo).id }
	: await remoteGitHub(githubUrl!, process.env.E2E_GITHUB_CONTROL_URL || "http://github:8091");
const discord = createFakeDiscord({
	guildId: GUILD,
	channels: [
		{ id: WORK_CHANNEL, name: "work" },
		{ id: WATCH_CHANNEL, name: "watch" },
	],
	persistFile: process.env.E2E_DISCORD_STATE || undefined,
});
const admin = discord.actor(ADMIN_USER, { username: "e2e-admin" });

// Seeded at every start: the fake GitHub's key is new each time (its issues live in memory only).
if (!vault.isInitialized()) await vault.initialize("admin", crypto.randomUUID());
if (!vault.isUnlocked()) throw new Error("the vault is locked: is AGENTBOT_MASTER_KEY_FILE the key it was initialised with?");
function writeSettings(limits: typeof seededLimits): void {
	vault.writeSettings(
		parseSettings({
			config: {
				discord: { guildId: GUILD, allowedUserIds: [ADMIN_USER], workChannelId: WORK_CHANNEL },
				github: { appId: github.appId, pollIntervalSeconds: Number(process.env.E2E_POLL_SECONDS || 2) },
				limits,
			},
			secrets: { discordToken: "e2e-discord-token", githubAppPrivateKey: github.privateKey },
		}),
	);
}
writeSettings(seededLimits);
// The fake gives the repo the same id at every start (it is the first one added).
if (!db.watchByName(repo)) db.watchRepo({ repoId: github.repoId, repo, channelId: WATCH_CHANNEL, createdBy: ADMIN_USER });

const settings = () => {
	try {
		return vault.isUnlocked() ? vault.readSettings() : undefined;
	} catch {
		return undefined;
	}
};
const signins = await openSignins(env.stateDir);
await ensureOmpAssetsDir(env.ompDir);
const dispatcher = createWorkerDispatcher({
	db,
	stateDir: env.stateDir,
	limits: () => dispatchLimits(settings()?.config, env.workerCapacity),
	reattachGraceMs: optionalMs("E2E_REATTACH_GRACE_MS") ?? (settings()?.config.workers.reattachGraceSeconds ?? 90) * 1000,
	leaseMs: optionalMs("E2E_LEASE_MS"),
	sweepMs: optionalMs("E2E_SWEEP_MS"),
	spec: {
		stateDir: env.stateDir,
		ompConfig: () => vault.readOmpConfig(),
		providerKeys: () => settings()?.secrets.providerKeys ?? {},
		credentials: () => signins.snapshotForRun(),
		skillsHash: async () => (await skillsBundle(env.ompDir)).hash,
	},
	skills: () => skillsBundle(env.ompDir),
	credentialRequest: req => signins.handleCredentialRequest(req),
	repos: timedRepos(createRepos({ stateDir: env.stateDir, remoteUrl: name => `file://${join(gitRoot, `${name}.git`)}` })),
	bindWorkerAddresses: env.workerAddressBinding,
});
const controller = createController({
	stateDir: env.stateDir,
	db,
	vault,
	agentLog,
	dispatcher,
	connectDiscord: () => discord,
	connectGitHub: ({ appId, privateKey, labels }) => createGitHub({ appId, privateKey, labels, baseUrl: github.url, throttle: false }),
});
const webToken = await loadWebApiToken(env.webApiTokenFile);
const features = createAdminFeatures({
	db,
	vault,
	signins,
	dispatcher,
	agentLog,
	processLog,
	stateDir: env.stateDir,
	ompDir: env.ompDir,
	controller,
	workerCapacity: env.workerCapacity,
	ompUpdates: createOmpUpdater({ db, identity: await appIdentity(), imageOmpVersion: installedOmpVersion(APP_ROOT), imageAppDir: APP_ROOT }),
});
const adminApi = createAdminApi({
	db,
	vault,
	controller,
	dispatcher,
	version,
	workerCapacity: env.workerCapacity,
	webToken,
	setupToken: undefined,
	routes: features.routes,
	modelAccounts: features.modelAccounts,
	checkChannels: features.checkChannels,
});

/** Every run state change seen, oldest first: the evidence the driver prints. */
interface Transition {
	at: string;
	run: string;
	kind: string;
	issue: number | null;
	state: string;
	outcome: string | null;
	worker: string | null;
	continues: string | null;
}
const transitions: Transition[] = [];
const lastSeen = new Map<string, string>();
const issueOfRun = (run: RunRow): number | null => {
	const issueId = run.job_id ? db.getJob(run.job_id)?.issue_id : undefined;
	return issueId === undefined ? null : (db.getIssue(issueId)?.number ?? null);
};
const recorder = setInterval(() => {
	try {
		for (const run of db.runsInState(...ALL_RUN_STATES)) {
			const key = `${run.state}/${run.outcome ?? ""}/${run.worker_id ?? ""}`;
			if (lastSeen.get(run.id) === key) continue;
			lastSeen.set(run.id, key);
			const t: Transition = {
				at: new Date().toISOString(),
				run: run.id,
				kind: run.kind,
				issue: issueOfRun(run),
				state: run.state,
				outcome: run.outcome,
				worker: run.worker_id,
				continues: run.continues_run_id,
			};
			transitions.push(t);
			log("info", "e2e run transition", { run: t.run, kind: t.kind, issue: t.issue ?? undefined, state: t.state, outcome: t.outcome ?? undefined, worker: t.worker ?? undefined });
		}
	} catch (err) {
		log("warn", "e2e transition recorder failed", { error: errorMessage(err) });
	}
}, 250);

/**
 * Per second: the Discord write queue's longest length and oldest age seen in 200 ms samples, and the event loop's
 * worst lag (how late a 200 ms tick fired: a synchronous stall, e.g. a slow SQLite commit, shows here).
 */
interface QueueSecond {
	at: string;
	length: number;
	oldestAgeMs: number;
	lagMs: number;
}
const queueSeconds: QueueSecond[] = [];
let lastTick = performance.now();
setInterval(() => {
	const now = performance.now();
	const lagMs = Math.max(0, Math.round(now - lastTick - 200));
	lastTick = now;
	const { length, oldestAgeMs } = discord.queueStats();
	const at = new Date().toISOString().slice(0, 19);
	const last = queueSeconds.at(-1);
	if (last?.at === at) {
		last.length = Math.max(last.length, length);
		last.oldestAgeMs = Math.max(last.oldestAgeMs, oldestAgeMs ?? 0);
		last.lagMs = Math.max(last.lagMs, lagMs);
	} else queueSeconds.push({ at, length, oldestAgeMs: oldestAgeMs ?? 0, lagMs });
}, 200).unref();

/** The state volume's write latency per second (test/e2e/k8s/diskprobe.ts, a child process): worst append and fsync. */
interface DiskSecond {
	at: string;
	appendMs: number;
	fsyncMs: number;
}
const diskSeconds: DiskSecond[] = [];
const diskProbe = Bun.spawn(["bun", join(import.meta.dir, "diskprobe.ts"), env.stateDir, String(process.pid)], { stdout: "pipe", stderr: "ignore" });
void (async () => {
	let rest = "";
	for await (const chunk of diskProbe.stdout.pipeThrough(new TextDecoderStream())) {
		const lines = (rest + chunk).split("\n");
		rest = lines.pop() ?? "";
		for (const text of lines) {
			const probe = JSON.parse(text) as DiskSecond;
			const at = probe.at.slice(0, 19);
			const last = diskSeconds.at(-1);
			if (last?.at === at) {
				last.appendMs = Math.max(last.appendMs, probe.appendMs);
				last.fsyncMs = Math.max(last.fsyncMs, probe.fsyncMs);
			} else diskSeconds.push({ at, appendMs: probe.appendMs, fsyncMs: probe.fsyncMs });
		}
	}
})();

/** A cgroup v2 file of this container as text, or null outside one. */
const cgroupFile = (name: string) => readFile(join("/sys/fs/cgroup", name), "utf8").catch(() => null);

/** The worker endpoints with every git endpoint request timed until its response body is sent. */
const timedWorkers: Pick<WorkerDispatcher, "socketData" | "websocket" | "artifact" | "git" | "pendingRuns"> = {
	socketData: address => dispatcher.socketData(address),
	websocket: dispatcher.websocket,
	artifact: req => dispatcher.artifact(req),
	pendingRuns: () => dispatcher.pendingRuns(),
	async git(req) {
		const start = performance.now();
		const { pathname } = new URL(req.url);
		const op = `git ${pathname.slice(pathname.lastIndexOf("/") + 1)}`;
		const name = /\/([^/]+\/[^/]+)\.git\//.exec(pathname)?.[1];
		const res = await dispatcher.git(req);
		const done = (bytes: number) => {
			timings.push({ at: new Date().toISOString(), op, repo: name, ms: Math.round(performance.now() - start), bytes, status: res.status });
		};
		if (!res.body) {
			done(0);
			return res;
		}
		let bytes = 0;
		const counted = res.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, out) {
					bytes += chunk.byteLength;
					out.enqueue(chunk);
				},
				flush: () => done(bytes),
			}),
		);
		return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
	},
};

/** Deterministic filler TypeScript (`export const` lines of identifier-like words), compressing like source code does. */
function fillerText(seed: number, bytes: number): string {
	const words = ["const", "value", "return", "import", "export", "function", "widget", "report", "index", "count", "items", "await", "string", "number", "result", "error"];
	let x = (seed * 7919 + 1) % 2147483648;
	const lines: string[] = [];
	let size = 0;
	while (size < bytes) {
		const parts: string[] = [];
		for (let i = 0; i < 8; i++) {
			x = (x * 48271) % 2147483647;
			parts.push(`${words[x % words.length]}${x % 997}`);
		}
		const line = `export const v${lines.length} = "${parts.join(" ")}";`;
		lines.push(line);
		size += line.length + 1;
	}
	return `${lines.join("\n")}\n`;
}

interface SeedSpec {
	/** Extra files by path (package.json, .agentbot.yml, ...). */
	files?: Record<string, string>;
	textFiles?: number;
	textBytes?: number;
	binaryFiles?: number;
	binaryBytes?: number;
}

/** Creates the bare repositories under `gitRoot` with one generated initial commit; its pack size in bytes. */
async function seedRepos(names: string[], spec: SeedSpec): Promise<number> {
	const seed = join(gitRoot, "seed-load", crypto.randomUUID());
	await mkdir(seed, { recursive: true });
	await git(["init", "-q", "-b", "main"], { cwd: seed });
	for (let i = 0; i < (spec.textFiles ?? 0); i++) await Bun.write(join(seed, "src", `mod${i % 40}`, `file${i}.ts`), fillerText(i, spec.textBytes ?? 4096));
	for (let i = 0; i < (spec.binaryFiles ?? 0); i++) await Bun.write(join(seed, "assets", `blob${i}.bin`), crypto.getRandomValues(new Uint8Array(spec.binaryBytes ?? 1_048_576)));
	for (const [path, content] of Object.entries(spec.files ?? {})) await Bun.write(join(seed, path), content);
	await git(["add", "-A"], { cwd: seed });
	await git(["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-q", "-m", "Initial commit"], { cwd: seed });
	for (const name of names) {
		const target = join(gitRoot, `${name}.git`);
		await mkdir(target, { recursive: true });
		await git(["init", "-q", "--bare", "-b", "main", target]);
		await git(["push", "-q", target, "main"], { cwd: seed });
	}
	const counts = await git(["count-objects", "-v"], { cwd: join(gitRoot, `${names[0]}.git`) });
	// Loose objects (a small push is unpacked) and packs, in KiB.
	return (Number(/^size: (\d+)/m.exec(counts)?.[1] ?? 0) + Number(/^size-pack: (\d+)/m.exec(counts)?.[1] ?? 0)) * 1024;
}

/** A control request's JSON body; every field is optional. */
interface ControlBody extends SeedSpec {
	count?: number;
	planSeconds?: number;
	implementSeconds?: number;
	/** `fixture-progress-seconds`: progress reports every n seconds while the fixture holds. */
	progressSeconds?: number;
	maxConcurrentJobs?: number;
	maxChatSessions?: number;
	issue?: number;
	/** `click`: the button's label. */
	label?: string;
	/** The repository of `issues`, `approve`; default the watched `E2E_REPO`. */
	repo?: string;
	repos?: string[];
	latencyMs?: number;
	perWindow?: number;
	windowMs?: number;
	synchronous?: "FULL" | "NORMAL";
}

async function control(req: Request, path: string): Promise<Response> {
	const body: ControlBody = req.method === "POST" ? ((await req.json()) as ControlBody) : {};
	if (req.method === "GET" && path === "issues") {
		// The chaos driver (test/e2e/chaos/run.ts): issues in any state, with their threads as the fake Discord holds them.
		const numbers = (new URL(req.url).searchParams.get("numbers") ?? "").split(",").filter(Boolean).map(Number);
		return Response.json(
			numbers.map(n => {
				const issue = db.findIssue(repo, n);
				const thread = issue?.thread_id ? discord.channels().find(c => c.id === issue.thread_id) : undefined;
				const job = issue ? db.newestJob(issue.id) : null;
				return {
					number: n,
					state: issue?.state ?? null,
					branch: issue?.branch ?? null,
					pr: issue?.pr_number ?? null,
					job: job ? { kind: job.kind, status: job.status, result: job.result, error: job.error } : null,
					thread: thread
						? {
								id: thread.id,
								archived: thread.archived === true,
								messages: discord.messages(thread.id).map(m => ({
									id: m.id,
									bot: m.authorId === discord.botUserId,
									content: m.content,
									buttons: m.components.flatMap(row => row.components).flatMap(b => ("label" in b && b.label ? [b.label] : [])),
								})),
							}
						: null,
				};
			}),
		);
	}
	if (req.method === "POST" && path === "issues") {
		if (!gh) return Response.json({ error: "with E2E_GITHUB_URL, file issues on the fake GitHub service" }, { status: 409 });
		const numbers: number[] = [];
		for (let i = 0; i < (body.count ?? 1); i++) {
			const markers = [`fixture:slow`, `fixture-plan-seconds:${body.planSeconds ?? 40}`, `fixture-implement-seconds:${body.implementSeconds ?? 40}`];
			if (body.progressSeconds) markers.push(`fixture-progress-seconds:${body.progressSeconds}`);
			numbers.push(gh.addIssue(body.repo ?? repo, { title: `Scenario change ${Date.now()}-${i}`, body: `Please make a change. ${markers.join(" ")}`, labels: ["agentbot"] }).number);
		}
		log("info", "e2e issues filed", { repo: body.repo ?? repo, numbers });
		return Response.json({ repo: body.repo ?? repo, numbers });
	}
	if (req.method === "POST" && path === "limits") {
		const current = settings()?.config.limits ?? seededLimits;
		const limits = { maxConcurrentJobs: body.maxConcurrentJobs ?? current.maxConcurrentJobs, maxChatSessions: body.maxChatSessions ?? current.maxChatSessions };
		writeSettings(limits);
		await controller.apply();
		log("info", "e2e limits saved", { ...limits, phase: controller.status().phase });
		return Response.json({ limits, phase: controller.status().phase });
	}
	if (req.method === "POST" && path === "approve") {
		const issue = db.findIssue(body.repo ?? repo, body.issue ?? 0);
		if (!issue?.thread_id) return Response.json({ error: "no such issue or no thread yet" }, { status: 404 });
		const plan = discord.messages(issue.thread_id).findLast(m => m.content.includes("Plan ready for your approval") && m.components.length > 0);
		const button = plan?.components.flatMap(row => row.components).find(b => "label" in b && b.label === "Approve");
		if (!plan || !button || !("custom_id" in button)) return Response.json({ error: "no plan awaiting approval" }, { status: 409 });
		await discord.emitComponent({ message: { channelId: plan.channelId, messageId: plan.id }, customId: button.custom_id, actor: admin });
		return Response.json({ approved: issue.number });
	}
	if (req.method === "POST" && path === "click") {
		const issue = db.findIssue(body.repo ?? repo, body.issue ?? 0);
		if (!issue?.thread_id) return Response.json({ error: "no such issue or no thread yet" }, { status: 404 });
		const target = discord
			.messages(issue.thread_id)
			.filter(m => m.authorId === discord.botUserId)
			.map(m => ({ message: m, button: m.components.flatMap(row => row.components).find(b => "label" in b && b.label === body.label) }))
			.findLast(t => t.button && "custom_id" in t.button);
		if (!target?.button || !("custom_id" in target.button)) return Response.json({ error: `no ${body.label} button` }, { status: 409 });
		await discord.emitComponent({ message: { channelId: target.message.channelId, messageId: target.message.id }, customId: target.button.custom_id, actor: admin });
		return Response.json({ clicked: body.label, issue: issue.number });
	}
	if (req.method === "GET" && path === "state") {
		return Response.json({
			phase: controller.status().phase,
			pendingRuns: dispatcher.pendingRuns(),
			limits: dispatchLimits(settings()?.config, env.workerCapacity),
			issues: db.openIssues().map(i => ({ repo: i.repo, number: i.number, state: i.state, branch: i.branch, pr: i.pr_number })),
			runs: db.runsInState(...ALL_RUN_STATES).map(r => ({
				id: r.id,
				kind: r.kind,
				issue: issueOfRun(r),
				state: r.state,
				outcome: r.outcome,
				worker: r.worker_id,
				continues: r.continues_run_id,
				hasCheckpoint: r.has_checkpoint === 1,
				createdAt: r.created_at,
				claimedAt: r.claimed_at,
				startedAt: r.started_at,
				finishedAt: r.finished_at,
				repo: r.repo,
			})),
			transitions,
		});
	}
	if (req.method === "GET" && path === "branch") {
		const params = new URL(req.url).searchParams;
		const issue = db.findIssue(params.get("repo") ?? repo, Number(params.get("issue")));
		if (!issue?.branch) return Response.json({ error: "no such issue or no branch yet" }, { status: 404 });
		const cwd = join(gitRoot, `${issue.repo}.git`);
		const subjects = await git(["log", "--format=%s", issue.branch], { cwd }).catch(() => "");
		const resumed = await git(["show", `${issue.branch}:resumed.txt`], { cwd }).catch(() => null);
		const files = await git(["ls-tree", "--name-only", issue.branch], { cwd }).catch(() => "");
		return Response.json({ branch: issue.branch, log: subjects ? subjects.split("\n") : [], files: files ? files.split("\n") : [], resumed });
	}
	if (req.method === "POST" && path === "repos") {
		if (!gh) return Response.json({ error: "not with E2E_GITHUB_URL" }, { status: 409 });
		const names = (body.repos ?? []).filter(name => !db.watchByName(name));
		const started = performance.now();
		const packBytes = names.length ? await seedRepos(names, body) : 0;
		for (const [i, name] of names.entries()) {
			const channelId = `${WATCH_CHANNEL}-${db.listWatches().length + 1}`;
			discord.addChannel({ id: channelId, name: `watch-${i}` });
			db.watchRepo({ repoId: gh.addRepo(name).id, repo: name, channelId, createdBy: ADMIN_USER });
		}
		log("info", "e2e repos seeded", { repos: names, packBytes });
		return Response.json({ repos: names, packBytes, seedMs: Math.round(performance.now() - started) });
	}
	if (req.method === "POST" && path === "sqlite") {
		const mode = body.synchronous === "NORMAL" ? "NORMAL" : "FULL";
		db.raw.run(`PRAGMA synchronous=${mode}`);
		log("info", "e2e SQLite synchronous", { mode });
		return Response.json({ synchronous: db.raw.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous });
	}
	if (req.method === "POST" && path === "discord") {
		const simulate = body.perWindow && body.windowMs ? { latencyMs: body.latencyMs, perWindow: body.perWindow, windowMs: body.windowMs } : undefined;
		discord.simulateRest(simulate);
		log("info", "e2e Discord REST simulation", { simulate: simulate ?? "off" });
		return Response.json({ simulate: simulate ?? null });
	}
	if (req.method === "GET" && path === "metrics") {
		const cpu = await cgroupFile("cpu.stat");
		const memory = await cgroupFile("memory.stat");
		return Response.json({
			at: new Date().toISOString(),
			cgroup: {
				cpuUsageUsec: cpu ? Number(/usage_usec (\d+)/.exec(cpu)?.[1]) : null,
				memoryCurrent: Number(await cgroupFile("memory.current")) || null,
				memoryPeak: Number(await cgroupFile("memory.peak")) || null,
				// Anonymous memory (processes) vs page cache (reclaimable): memory.current counts both.
				memoryAnon: memory ? Number(/^anon (\d+)/m.exec(memory)?.[1]) : null,
				memoryFile: memory ? Number(/^file (\d+)/m.exec(memory)?.[1]) : null,
			},
			// Pressure stall information (`some avg10`, % of time something waited): the container's and the node's.
			pressure: {
				io: Number(/some avg10=([\d.]+)/.exec((await cgroupFile("io.pressure")) ?? "")?.[1] ?? Number.NaN),
				cpu: Number(/some avg10=([\d.]+)/.exec((await cgroupFile("cpu.pressure")) ?? "")?.[1] ?? Number.NaN),
				nodeIo: Number(/some avg10=([\d.]+)/.exec((await readFile("/proc/pressure/io", "utf8").catch(() => "")) ?? "")?.[1] ?? Number.NaN),
				nodeCpu: Number(/some avg10=([\d.]+)/.exec((await readFile("/proc/pressure/cpu", "utf8").catch(() => "")) ?? "")?.[1] ?? Number.NaN),
			},
			process: { rss: process.memoryUsage().rss, cpuUsage: process.cpuUsage() },
			discordQueue: discord.queueStats(),
			discordRest: discord.restStats(),
			queueSeconds,
			diskSeconds,
			timings,
		});
	}
	return Response.json({ error: "not found" }, { status: 404 });
}

const api = startInternalApi({
	host: env.internalHost,
	port: env.internalPort,
	stateDir: env.stateDir,
	db,
	version,
	workerCapacity: env.workerCapacity,
	phase: () => controller.status().phase,
	config: () => settings()?.config,
	dispatcher,
	admin: {
		async handle(req) {
			const { pathname } = new URL(req.url);
			if (!pathname.startsWith(CONTROL_PREFIX)) return adminApi.handle(req);
			const auth = req.headers.get("authorization") ?? "";
			if (!webToken || !auth.startsWith("Bearer ") || !sameToken(auth.slice(7).trim(), webToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
			try {
				return await control(req, pathname.slice(CONTROL_PREFIX.length));
			} catch (err) {
				log("error", "e2e control request failed", { path: pathname, error: errorMessage(err) });
				return Response.json({ error: errorMessage(err) }, { status: 500 });
			}
		},
	},
	workers: timedWorkers,
	workerToken: await loadInternalToken(env.workerTokenFile, "AGENTBOT_WORKER_TOKEN_FILE", "the worker WebSocket"),
	scaleToken: await loadInternalToken(env.scaleTokenFile, "AGENTBOT_SCALE_TOKEN_FILE", "the scale endpoint"),
});
log("info", "e2e orchestrator started", { url: api.url, version, repo, workerCapacity: env.workerCapacity, limits: seededLimits });

postmortem.register(
	"agentbot-e2e-orchestrator-shutdown",
	async reason => {
		log("info", "shutting down", { reason });
		clearInterval(recorder);
		await api.stop();
		dispatcher.close();
		await controller.stop();
		await gh?.stop();
		signins.close();
		db.close();
	},
	{ exitOnly: true },
);

await controller.apply();
log("info", "startup complete", { phase: controller.status().phase });
