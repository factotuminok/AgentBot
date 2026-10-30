#!/usr/bin/env bun
// Chaos tests on the rootless compose stack (implementation.md §4 Phase 11; wiki/verification.md NFR-02/03/04). The stack is
// compose.yaml plus compose.chaos.yaml: the chaos image (test/e2e/chaos/Containerfile) as orchestrator and workers (the
// real internals with fake Discord and the fixture agent host), the real web and launcher, and the fake GitHub as its
// own service, so both fakes outlive orchestrator restarts. No Discord, GitHub or model credentials are needed.
//   chaos   per seed: ISSUES issues through the phase 5 flow (label → plan → approve → implement → push CI green →
//           PR → review comment → revise → merge → done, thread archived) while a seeded RNG crashes the orchestrator,
//           web, launcher or a worker at random points (a crash is SIGKILL to every process but the container's init,
//           so the restart policy brings the service back; the orchestrator at most once per re-attach grace). The
//           seed fixes the crash times and targets; which run a worker crash hits depends on timing. A job failed by
//           its second lost worker (RUN-04) gets the user's Retry click. Asserts every issue done, no duplicated PRs,
//           comments, Discord messages or pushes, no run left unfinished, no worker container left.
//   limits  one issue fills its checkout past AGENTBOT_WORKER_DISK, one OOM-kills its agent host, one OOM-kills a tool
//           process and finishes, one is ordinary: each failure is reported for its run only, the others finish.
//
// Usage: bun test/e2e/chaos/run.ts [chaos] [limits]       (default both, chaos first)
// Env:
//   SEEDS          comma-separated seeds of the chaos rounds (default one random seed; printed)
//   ISSUES         issues per chaos round (default 4)
//   KILL_MIN_S, KILL_MAX_S  seconds between crashes (default 5, 20)
//   SKIP_BUILD=1   use localhost/agentbot:dev and localhost/agentbot-chaos:dev as they are on the rootless engine
//   KEEP=1         leave the stack running afterwards
//   ROOTLESS_CONNECTION  Podman connection of the rootless engine (default podman-machine-default; empty = local podman)
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, type Subprocess } from "bun";

const root = join(import.meta.dir, "..", "..", "..");
const conn = process.env.ROOTLESS_CONNECTION ?? "podman-machine-default";
const baseImage = "localhost/agentbot:dev";
const chaosImage = "localhost/agentbot-chaos:dev";
const project = "agentbot-chaos";
const network = "agentbot-chaos";
const workerSecret = "agentbot_chaos_worker_token";
const ORCH_PORT = 18181;
const GITHUB_PORT = 18191;
const WEB_PORT = 18180;
const LEASE_MS = 10_000;
// Rootless Podman gives a restarted orchestrator a new address: workers notice their dead connection by the
// keepalive (up to 30 s), then may need another 30 s for Bun's DNS cache to let go of the old address. The product
// default re-attach grace, 90 s, covers both.
const REATTACH_GRACE_MS = 90_000;
const ISSUES = Number(process.env.ISSUES || 4);
const KILL_MIN_S = Number(process.env.KILL_MIN_S || 5);
const KILL_MAX_S = Number(process.env.KILL_MAX_S || 20);
const ROUND_TIMEOUT_MS = 20 * 60_000;
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ["chaos", "limits"];
const seeds = (process.env.SEEDS || String(Math.floor(Math.random() * 1e9))).split(",").map(Number);

const t0 = Date.now();
const stamp = () => `${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const say = (msg: string) => console.log(`${stamp()} ${msg}`);
const podman = conn ? ["podman", "--connection", conn] : ["podman"];

/** mulberry32: small, seedable, good enough to pick kill times and targets reproducibly. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A failure `until` does not retry: the round is lost. */
class Fatal extends Error {}

async function until<T>(get: () => Promise<T | undefined | false>, what: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await get().catch(err => {
			if (err instanceof Fatal) throw err;
			return undefined;
		});
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
		await Bun.sleep(1_000);
	}
}

// ---- stack ----------------------------------------------------------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), "agentbot-chaos-"));
// The compose provider talks to DOCKER_HOST: the rootless socket, forwarded over the connection's ssh (test/e2e/compose/README.md).
const forward = Bun.spawn(
	[
		"bash",
		"-c",
		'. "$1/test/e2e/compose/rootless-socket.sh" && forward_rootless_socket "$2" "$3" || exit 1; echo "host_sock=$host_sock"; echo "docker_host=$DOCKER_HOST"; echo "forward_pid=$forward_pid"; echo ready; exec sleep 86400',
		"_",
		root,
		conn,
		work,
	],
	{ stdout: "pipe", stderr: "inherit" },
);
const forwardVars: Record<string, string> = {};
{
	const reader = forward.stdout.getReader();
	let text = "";
	while (!text.includes("ready\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the rootless socket forward failed: ${text}`);
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) forwardVars[line.slice(0, eq)] = line.slice(eq + 1);
	}
}

const stackEnv: Record<string, string> = {
	...(process.env as Record<string, string>),
	...(conn ? { CONTAINER_CONNECTION: conn } : {}),
	DOCKER_HOST: forwardVars.docker_host!,
	PODMAN_COMPOSE_WARNING_LOGS: "false",
	AGENTBOT_IMAGE: chaosImage,
	AGENTBOT_BASE_IMAGE: baseImage,
	AGENTBOT_NETWORK: network,
	AGENTBOT_WORKER_SECRET: workerSecret,
	AGENTBOT_WEB_HOST_PORT: String(WEB_PORT),
	AGENTBOT_HOST_PODMAN_SOCKET: forwardVars.host_sock!,
	AGENTBOT_SECRETS_DIR: join(work, "secrets"),
	AGENTBOT_WORKER_CAPACITY: "4",
	// Small enough for the limits scenario, roomy for the fixture's runs: a worker and its agent host use ~150 MB.
	AGENTBOT_WORKER_MEMORY: "512m",
	AGENTBOT_WORKER_DISK: "2m",
	CHAOS_ORCH_PORT: String(ORCH_PORT),
	CHAOS_GITHUB_PORT: String(GITHUB_PORT),
	E2E_LEASE_MS: String(LEASE_MS),
	E2E_REATTACH_GRACE_MS: String(REATTACH_GRACE_MS),
	E2E_MAX_CONCURRENT_JOBS: "4",
};
const composeArgs = ["compose", "-f", join(root, "compose.yaml"), "-f", join(import.meta.dir, "compose.chaos.yaml"), "-p", project];
const compose = (...args: string[]) => $`${podman} ${composeArgs} ${args}`.env(stackEnv).quiet();
const pm = (...args: string[]) => $`${podman} ${args}`.env(stackEnv).quiet().nothrow();

async function serviceContainer(service: string): Promise<string | undefined> {
	const out = await pm("ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`);
	return out.stdout.toString().trim().split("\n").filter(Boolean)[0];
}
async function workerContainers(all = false): Promise<string[]> {
	// Workers join the stack's worker network, `<AGENTBOT_NETWORK>-workers` (compose.yaml).
	const out = await pm("ps", ...(all ? ["-a"] : []), "--filter", "label=agentbot.role=worker", "--filter", `network=${network}-workers`, "--format", "{{.Names}}");
	return out.stdout.toString().trim().split("\n").filter(Boolean);
}

/** Workers are removed when they exit: each one's log is followed into the work dir while it lives (`saveLogs`). */
const workerLogs = join(work, "workers");
await mkdir(workerLogs, { recursive: true });
const followers = new Map<string, Subprocess>();
let following = false;
const followWorkers = setInterval(async () => {
	if (following) return;
	following = true;
	for (const name of await workerContainers().catch(() => [])) {
		if (followers.has(name)) continue;
		followers.set(name, Bun.spawn(["sh", "-c", 'exec "$@" >"$0" 2>&1', join(workerLogs, `${name}.log`), ...podman, "logs", "-f", name], { env: stackEnv }));
	}
	following = false;
}, 2_000);

async function teardown(): Promise<void> {
	await compose("down", "-v", "--remove-orphans").nothrow();
	for (const w of await workerContainers(true)) await pm("rm", "-f", w);
	await pm("secret", "rm", workerSecret);
}

async function cleanup(): Promise<void> {
	if (process.env.KEEP) {
		say(`KEEP=1: the stack keeps running. Remove it with: DOCKER_HOST=${stackEnv.DOCKER_HOST} podman ${composeArgs.join(" ")} down -v; podman secret rm ${workerSecret}`);
		return;
	}
	clearInterval(followWorkers);
	for (const follower of followers.values()) follower.kill();
	await teardown();
	if (forwardVars.forward_pid) process.kill(Number(forwardVars.forward_pid));
	forward.kill();
	await rm(work, { recursive: true, force: true });
}

say(`clean state (project ${project}, network ${network})`);
await teardown();
if (!process.env.SKIP_BUILD) {
	say(`build ${baseImage} and ${chaosImage} (rootless)`);
	await $`${podman} build -q -t ${baseImage} ${root}`.quiet();
	await $`${podman} build -q -f ${join(import.meta.dir, "Containerfile")} --ignorefile ${join(import.meta.dir, "Containerfile.containerignore")} --build-arg BASE_IMAGE=${baseImage} -t ${chaosImage} ${root}`.quiet();
}
await $`${join(root, "scripts", "init-secrets.sh")}`.env(stackEnv).quiet();
const webToken = (await readFile(join(work, "secrets", "agentbot_web_api_token"), "utf8")).trim();
const upStart = Date.now();
await compose("up", "-d");

// ---- clients ----------------------------------------------------------------------------------------------------------

async function control<T>(path: string, body?: object): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${ORCH_PORT}/internal/admin/e2e/${path}`, {
		method: body ? "POST" : "GET",
		headers: { authorization: `Bearer ${webToken}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}
async function github<T>(path: string, body?: object): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${GITHUB_PORT}${path}`, {
		method: body ? "POST" : "GET",
		headers: { "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`github ${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

interface Message {
	id: string;
	bot: boolean;
	content: string;
	buttons: string[];
}
interface IssueView {
	number: number;
	state: string | null;
	branch: string | null;
	pr: number | null;
	job: { kind: string; status: string; result: string | null; error: string | null } | null;
	thread: { id: string; archived: boolean; messages: Message[] } | null;
}
interface Run {
	id: string;
	kind: string;
	issue: number | null;
	state: string;
	outcome: string | null;
	worker: string | null;
}
interface State {
	phase: string;
	runs: Run[];
}
interface GhIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	labels: string[];
	pull: { head: string; merged: boolean } | null;
	comments: { id: number; login: string; body: string }[];
}
interface GhState {
	issues: GhIssue[];
	pushes: { at: number; old: string; sha: string; ref: string; forced: boolean }[];
	branches: Record<string, { sha: string; log: string[] }>;
	mutating: Record<string, number>;
}

const issuesView = (numbers: number[]) => control<IssueView[]>(`issues?numbers=${numbers.join(",")}`);
const said = (v: IssueView, text: string) => v.thread?.messages.some(m => m.bot && m.content.includes(text)) ?? false;

await until(async () => (await control<State>("state")).phase === "running", "the engine to run", 180_000);
await until(async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`)).ok, "web /healthz", 120_000);
say(`stack up in ${((Date.now() - upStart) / 1000).toFixed(0)} s: ${(await pm("ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}")).stdout.toString().trim().split("\n").join(", ")}`);

// ---- crashes --------------------------------------------------------------------------------------------------------

const SERVICES = ["orchestrator", "web", "launcher"] as const;
type Target = (typeof SERVICES)[number] | "worker";
interface Kill {
	at: string;
	target: Target;
	container: string;
	downMs?: number;
}

/** The container's state as Podman sees it; undefined once it is gone (a worker is removed when it exits). */
async function containerState(id: string): Promise<{ status: string; startedAt: string } | undefined> {
	const out = await pm("inspect", id, "--format", "{{.State.Status}} {{.State.StartedAt}}");
	if (out.exitCode !== 0) return undefined;
	const [status = "", ...startedAt] = out.stdout.toString().trim().split(" ");
	return { status, startedAt: startedAt.join(" ") };
}

/** Waits until the service's container was started again after the crash and answers; its downtime. */
async function recovered(target: Target, container: string, startedBefore: string, killedAt: number): Promise<number> {
	if (target === "worker") return 0;
	await until(
		async () => {
			// The same container, restarted by its restart policy: a new start time.
			const state = await containerState(container);
			if (state?.status !== "running" || state.startedAt === startedBefore) return false;
			if (target === "orchestrator") return (await control<State>("state")).phase === "running";
			if (target === "web") return (await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`)).ok;
			return (await pm("exec", container, "agentbot", "health")).exitCode === 0;
		},
		`${target} to come back`,
		180_000,
	);
	return Date.now() - killedAt;
}

async function chaosMonkey(random: () => number, done: () => boolean, kills: Kill[]): Promise<void> {
	let orchestratorCrashedAt = 0;
	while (!done()) {
		const waitMs = (KILL_MIN_S + random() * (KILL_MAX_S - KILL_MIN_S)) * 1000;
		const pick = random();
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline && !done()) await Bun.sleep(500);
		if (done()) return;
		const targets: Target[] = [...SERVICES, "worker"];
		let target = targets[Math.floor(pick * targets.length)]!;
		let container: string | undefined;
		if (target === "worker") {
			const workers = await workerContainers();
			container = workers[Math.floor(random() * workers.length)];
			// No worker running at this moment: crash the orchestrator instead, the other run-carrying process.
			if (!container) target = "orchestrator";
		}
		// Every orchestrator start graces every lease for the re-attach grace (RUN-07): crashing it again sooner keeps
		// the lease of a run whose worker died alive forever. Web or the launcher go down instead.
		if (target === "orchestrator" && Date.now() - orchestratorCrashedAt < REATTACH_GRACE_MS) target = pick < 0.5 ? "web" : "launcher";
		if (target === "orchestrator") orchestratorCrashedAt = Date.now();
		container ??= await serviceContainer(target);
		if (!container) continue;
		const before = await containerState(container);
		if (before?.status !== "running") continue;
		const at = Date.now();
		// SIGKILL to every process but the container's init (the shell's `kill`: procps' cannot parse `-9 -1`). Not
		// `podman kill`: Podman records that as a stop by the user and never restarts the container, whatever its restart
		// policy; a crash is what restart policies are for. The exec itself fails as its container dies under it, so the
		// crash is judged by the container's state.
		await pm("exec", container, "sh", "-c", "kill -9 -1");
		const crashed = await until(
			async () => {
				const state = await containerState(container);
				return (!state || state.status !== "running" || state.startedAt !== before.startedAt) && "yes";
			},
			`${target} to die`,
			10_000,
		).catch(() => undefined);
		if (!crashed) {
			say(`crash of ${target} ${container.slice(0, 12)} did not take`);
			continue;
		}
		const kill: Kill = { at: new Date(at).toISOString(), target, container: container.slice(0, 20) };
		kills.push(kill);
		say(`💥 crashed ${target} (${kill.container})`);
		kill.downMs = await recovered(target, container, before.startedAt, at);
		if (target !== "worker") say(`   ${target} back after ${(kill.downMs / 1000).toFixed(1)} s`);
	}
}

// ---- the phase 5 flow per issue ---------------------------------------------------------------------------------------

interface Flow {
	number: number;
	approvedAt?: number;
	commentedAt?: number;
	mergedAt?: number;
	doneAt?: number;
	startedAt: number;
	/** Retry clicks after a job failed on its second lost worker (RUN-04). */
	retries: number;
	retriedAt?: number;
}

const REVIEW = "/agentbot please tidy this up fixture:auto";

/** One step of an issue's flow; true when it is done and archived. */
async function step(f: Flow, v: IssueView): Promise<boolean> {
	if (v.state === "done" && v.thread?.archived) {
		f.doneAt ??= Date.now();
		return true;
	}
	// RUN-04: a job whose worker is lost twice fails with a Retry button; the user's way on is to click it.
	if (v.state === "failed" && /worker running this was lost/.test(v.job?.error ?? "")) {
		if (!f.retriedAt || Date.now() - f.retriedAt > 15_000) {
			say(`   #${f.number}: ${v.job?.kind} job failed on its second lost worker (RUN-04); clicking Retry`);
			await control("click", { issue: f.number, label: "Retry" }).catch(err => say(`   #${f.number}: Retry: ${err}`));
			f.retries++;
			f.retriedAt = Date.now();
		}
		return false;
	}
	if (v.state === "failed" || v.state === "cancelled") throw new Fatal(`issue #${f.number} ended ${v.state}: ${v.job?.kind} job ${v.job?.status}: ${v.job?.error ?? ""}`);
	const planMsg = v.thread?.messages.findLast(m => m.bot && m.content.includes("Plan ready for your approval") && m.buttons.includes("Approve"));
	// Approve; again after a while if the click was lost in a crash.
	if (v.state === "awaiting_approval" && planMsg && (!f.approvedAt || Date.now() - f.approvedAt > 15_000)) {
		await control("approve", { issue: f.number }).catch(() => undefined);
		f.approvedAt = Date.now();
	}
	if (v.state === "in_review" && v.pr && !f.commentedAt && said(v, "Implementation complete")) {
		await github("/comment", { number: v.pr, body: REVIEW });
		f.commentedAt = Date.now();
	}
	if (v.state === "in_review" && v.pr && f.commentedAt && !f.mergedAt && said(v, "Review feedback addressed")) {
		await github("/merge", { number: v.pr });
		f.mergedAt = Date.now();
	}
	return false;
}

async function fileIssues(bodies: string[]): Promise<number[]> {
	const numbers: number[] = [];
	for (const body of bodies) numbers.push(...(await github<{ numbers: number[] }>("/issues", { body })).numbers);
	return numbers;
}

/** Fingerprint of a bot message for duplicate detection: its text without the volatile parts. */
const fingerprint = (content: string) => content.replace(/\b[0-9a-f]{7,40}\b/g, "<sha>").replace(/\d+(\.\d+)?\s?(s|ms|min)\b/g, "<t>");

interface Check {
	ok: boolean;
	line: string;
}

/** `retried`: issues whose job the driver re-ran with Retry, which repeats its Discord messages legitimately. */
async function verify(numbers: number[], expectRevise: boolean, retried: ReadonlySet<number> = new Set()): Promise<Check[]> {
	const checks: Check[] = [];
	const check = (ok: boolean, line: string) => checks.push({ ok, line: `${ok ? "ok  " : "FAIL"} ${line}` });
	const views = await issuesView(numbers);
	const gh = await github<GhState>("/state");
	for (const v of views) {
		const tag = `#${v.number}`;
		check(v.state === "done", `${tag} done (state ${v.state})`);
		check(v.thread?.archived === true, `${tag} thread archived`);
		const pulls = gh.issues.filter(i => i.pull && i.pull.head === v.branch);
		check(pulls.length === 1, `${tag} exactly one PR for ${v.branch} (${pulls.map(p => `#${p.number}`).join(", ")})`);
		const issue = gh.issues.find(i => i.number === v.number)!;
		const planComments = issue.comments.filter(c => c.body.startsWith("<!-- agentbot:plan -->"));
		check(planComments.length === 1, `${tag} one plan comment on the issue (${planComments.length})`);
		for (const target of [issue, ...pulls]) {
			const bodies = target.comments.filter(c => c.login.endsWith("[bot]")).map(c => c.body);
			const dupes = bodies.filter((b, i) => bodies.indexOf(b) !== i);
			check(dupes.length === 0, `${tag} no duplicated bot comment on #${target.number} (${bodies.length} bot comments${dupes.length ? `; duplicated: ${dupes.map(d => JSON.stringify(d.slice(0, 80))).join(", ")}` : ""})`);
		}
		const botMessages = (v.thread?.messages ?? []).filter(m => m.bot);
		const prints = botMessages.map(m => fingerprint(m.content));
		const dupes = prints.filter((p, i) => prints.indexOf(p) !== i);
		const repeats = `${botMessages.length} bot messages${dupes.length ? `; repeated: ${dupes.map(d => JSON.stringify(d.slice(0, 80))).join(", ")}` : ""}`;
		if (retried.has(v.number)) check(true, `${tag} Discord messages repeated only by the Retry click (${repeats})`);
		else check(dupes.length === 0, `${tag} no duplicated Discord message (${repeats})`);
		const branch = v.branch ? gh.branches[v.branch] : undefined;
		const log = branch?.log ?? [];
		const revisions = log.filter(s => s === "Address the follow-up").length;
		check(revisions === (expectRevise ? 1 : 0), `${tag} branch log has ${revisions} revise commit(s): ${log.join(" ← ")}`);
		const pushes = gh.pushes.filter(p => p.ref === `refs/heads/${v.branch}`);
		const forced = pushes.filter(p => p.forced);
		check(forced.length === 0, `${tag} ${pushes.length} push(es) to ${v.branch}, ${forced.length} forced`);
	}
	const state = await control<State>("state");
	const open = state.runs.filter(r => !["finished", "lost"].includes(r.state));
	check(open.length === 0, `no run left unfinished (${open.map(r => `${r.kind}/${r.state}`).join(", ") || "none"})`);
	const left = await until(async () => (await workerContainers(true)).length === 0 && "none", "worker containers to go", 120_000).catch(async () => (await workerContainers(true)).join(", "));
	check(left === "none", `no worker container left (${left})`);
	return checks;
}

const results: string[] = [];
let failed = false;

async function chaosRound(seed: number): Promise<void> {
	const random = rng(seed);
	say(`== chaos round, seed ${seed}: ${ISSUES} issues, a crash every ${KILL_MIN_S}-${KILL_MAX_S} s`);
	const bodies = Array.from({ length: ISSUES }, () => {
		const plan = 10 + Math.floor(random() * 30);
		const implement = 15 + Math.floor(random() * 45);
		return `Please make a change. fixture:slow fixture-plan-seconds:${plan} fixture-implement-seconds:${implement}`;
	});
	const started = Date.now();
	const numbers = await fileIssues(bodies);
	say(`filed ${numbers.map(n => `#${n}`).join(" ")}: ${bodies.map(b => b.replace(/.*fixture:slow /, "")).join(" | ")}`);
	const flows: Flow[] = numbers.map(number => ({ number, startedAt: started, retries: 0 }));
	const kills: Kill[] = [];
	let finished = false;
	const monkey = chaosMonkey(random, () => finished, kills);
	let lastLine = "";
	try {
		await until(
			async () => {
				const views = await issuesView(numbers).catch(() => undefined);
				if (!views) return false;
				const line = views.map(v => `#${v.number}:${v.state}${v.thread?.archived ? "(archived)" : ""}`).join(" ");
				if (line !== lastLine) say(`   ${line}`);
				lastLine = line;
				let all = true;
				for (const [i, v] of views.entries()) all = (await step(flows[i]!, v)) && all;
				return all;
			},
			"every issue to be done",
			ROUND_TIMEOUT_MS,
		);
	} finally {
		finished = true;
		await monkey;
	}
	const totalS = ((Date.now() - started) / 1000).toFixed(0);
	const killList = kills.map(k => `${k.target}@+${((Date.parse(k.at) - started) / 1000).toFixed(0)}s${k.downMs ? `(back in ${(k.downMs / 1000).toFixed(1)}s)` : ""}`).join(", ");
	say(`all done in ${totalS} s; ${kills.length} crashes: ${killList || "none"}`);
	for (const f of flows) say(`   #${f.number}: done after ${(((f.doneAt ?? Date.now()) - f.startedAt) / 1000).toFixed(0)} s${f.retries ? `, ${f.retries} Retry click(s) (RUN-04)` : ""}`);
	// The issues just finished; give the last Discord writes and worker removals a moment.
	await Bun.sleep(5_000);
	const checks = await verify(numbers, true, new Set(flows.filter(f => f.retries > 0).map(f => f.number)));
	for (const c of checks) say(`   ${c.line}`);
	const bad = checks.filter(c => !c.ok).length;
	if (bad) {
		failed = true;
		await saveLogs();
	}
	const retries = flows.reduce((n, f) => n + f.retries, 0);
	results.push(`chaos seed ${seed}: ${bad ? `FAIL (${bad} checks)` : "PASS"}, ${ISSUES} issues in ${totalS} s, ${retries} Retry click(s), ${kills.length} crashes: ${killList}`);
}

async function limitsRound(): Promise<void> {
	say("== limits round: a full disk, an OOM-killed agent host, an OOM-killed tool process, an ordinary issue");
	const started = Date.now();
	const [disk, oomHost, oomChild, plain] = await fileIssues([
		"Please fill the disk. fixture:fillDisk",
		"Please use too much memory. fixture:oomHost",
		"Please run a memory hog. fixture:oomChild",
		"Please make a change. fixture:auto",
	]);
	say(`filed disk #${disk}, oomHost #${oomHost}, oomChild #${oomChild}, plain #${plain}`);
	const flows = new Map<number, Flow>([oomChild!, plain!].map(number => [number, { number, startedAt: started, retries: 0 }]));
	const numbers = [disk!, oomHost!, oomChild!, plain!];
	let lastLine = "";
	await until(
		async () => {
			const views = await issuesView(numbers);
			const line = views.map(v => `#${v.number}:${v.state}`).join(" ");
			if (line !== lastLine) say(`   ${line}`);
			lastLine = line;
			let all = views.slice(0, 2).every(v => v.state === "failed");
			for (const v of views.slice(2)) all = (await step(flows.get(v.number)!, v)) && all;
			return all;
		},
		"the limits round",
		10 * 60_000,
	);
	const totalS = ((Date.now() - started) / 1000).toFixed(0);
	const views = await issuesView(numbers);
	const gh = await github<GhState>("/state");
	const checks: Check[] = [];
	const check = (ok: boolean, line: string) => checks.push({ ok, line: `${ok ? "ok  " : "FAIL"} ${line}` });
	const byNumber = (n: number) => views.find(v => v.number === n)!;
	const threadText = (n: number) => (byNumber(n).thread?.messages ?? []).filter(m => m.bot).map(m => m.content).join("\n");
	const diskView = byNumber(disk!);
	check(/ran out of disk space/.test(diskView.job?.error ?? ""), `disk #${disk}: job ${diskView.job?.kind}/${diskView.job?.status}: ${diskView.job?.error}`);
	check(/ran out of disk space/.test(threadText(disk!)), `disk #${disk}: the thread reports the full disk`);
	const hostView = byNumber(oomHost!);
	check(/most likely ran out of memory/.test(hostView.job?.error ?? ""), `oomHost #${oomHost}: job ${hostView.job?.kind}/${hostView.job?.status}: ${hostView.job?.error}`);
	check(/ran out of memory/.test(threadText(oomHost!)), `oomHost #${oomHost}: the thread reports the OOM kill`);
	const childView = byNumber(oomChild!);
	const childPr = gh.issues.find(i => i.number === childView.pr);
	check(childView.state === "done", `oomChild #${oomChild}: done (state ${childView.state})`);
	check(!!childPr?.body.includes("Local verification incomplete"), `oomChild #${oomChild}: PR #${childView.pr} body carries the OOM warning (AGT-19)`);
	check(threadText(oomChild!).includes("Local verification incomplete"), `oomChild #${oomChild}: the Discord message carries the OOM warning`);
	const plainView = byNumber(plain!);
	check(plainView.state === "done", `plain #${plain}: done (state ${plainView.state})`);
	check(!threadText(plain!).includes("Local verification incomplete") && !/out of (disk|memory)/.test(threadText(plain!)), `plain #${plain}: no OOM or disk report`);
	for (const c of await verify([oomChild!, plain!], true)) checks.push(c);
	for (const c of checks) say(`   ${c.line}`);
	const bad = checks.filter(c => !c.ok).length;
	if (bad) {
		failed = true;
		await saveLogs();
	}
	results.push(`limits: ${bad ? `FAIL (${bad} checks)` : "PASS"} in ${totalS} s`);
}

/** Every service's whole log and the orchestrator's run history, kept after the stack is gone. */
async function saveLogs(): Promise<void> {
	const logs = await mkdtemp(join(tmpdir(), "agentbot-chaos-logs-"));
	for (const s of ["orchestrator", "web", "launcher", "github"]) {
		await Bun.write(join(logs, `${s}.log`), (await compose("logs", "--no-color", "--timestamps", s).nothrow()).stdout);
	}
	await Bun.write(join(logs, "state.json"), JSON.stringify(await control<State>("state").catch(e => ({ error: String(e) })), null, 1));
	await cp(workerLogs, join(logs, "workers"), { recursive: true });
	say(`logs in ${logs}`);
}

try {
	if (scenarios.includes("chaos")) for (const seed of seeds) await chaosRound(seed);
	if (scenarios.includes("limits")) await limitsRound();
} catch (err) {
	failed = true;
	say(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
	await saveLogs();
} finally {
	console.log("\n=== results ===");
	for (const r of results) console.log(r);
	await cleanup();
}
process.exit(failed ? 1 : 0);
