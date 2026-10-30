#!/usr/bin/env bun
// Phase 11 load test on the shared kind cluster (implementation.md §4 Phase 11, wiki/load-test.md), with the chart and
// the scenario image (test/e2e/k8s/Containerfile: the real orchestrator internals with fake Discord and GitHub, real
// workers with the fixture agent host). No Discord, GitHub or model credentials are needed.
//   same   10 issues on ONE seeded repository: 10 concurrent plans, then 10 concurrent implement runs, each pushing its
//          own issue branch and opening a PR
//   multi  1 issue on each of 10 seeded repositories, the same way
//   heavy  3 issues on one repository whose lockfile is a typical web app's (next, aws-sdk, eslint, vitest, ...:
//          ~450 MB of node_modules), to see how a large `bun install` fares in a worker
// Limits 10/2 with capacity 10. Each repository has a few thousand files and tens of MB (generated), and a
// `setupCommand` that installs a real lockfile from the npm registry and transpiles every source file. The fake Discord
// simulates REST latency and per-channel rate limits, and the fixture reports progress every 2 s, so the outbound queue
// (DSC-32) is exercised. Measured per run (NFR-06): pending → pod created → scheduled → container started → claimed →
// checkout made → setupCommand done → agent registered → finished; plus mirror fetch, push and git endpoint timings,
// orchestrator cgroup CPU and memory, and the Discord queue per second.
//
// Usage: bun test/e2e/k8s/load.ts [same] [multi] [heavy]     (default: same and multi, in that order)
// Env (besides test/e2e/k8s/harness.ts's):
//   LOAD_IMPLEMENT_SECONDS  how long each fixture implement run holds (default 60)
//   LOAD_TEXT_FILES / LOAD_TEXT_BYTES / LOAD_BINARY_FILES / LOAD_BINARY_BYTES  the generated repository (default 3000 ×
//                           8 KiB source files and 8 × 2 MiB random assets)
//   LOAD_OUT                where the raw measurements go (JSON; default $TMPDIR/agentbot-load-<time>.json)
//   LOAD_SQLITE_SYNC        NORMAL: run with the orchestrator database's PRAGMA synchronous=NORMAL (an experiment)
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusReport } from "../../../src/shared/adminApi";
import {
	adminGet,
	control,
	ctx,
	fail,
	freshPods,
	health,
	kubectl,
	ns,
	orchestratorLogTail,
	type PodJson,
	pods,
	printTransitions,
	type Run,
	type State,
	say,
	seenPods,
	setUp,
	startPodSampler,
	state,
	tearDown,
	until,
} from "./harness";

const scenarios = process.argv.slice(2).length ? process.argv.slice(2).map(s => s.toLowerCase()) : ["same", "multi"];
const env = (name: string, fallback: number) => Number(process.env[name] || fallback);
const implementSeconds = env("LOAD_IMPLEMENT_SECONDS", 60);
/** A seeded repository: the control API's `repos` body minus the names. */
interface Seed {
	textFiles: number;
	textBytes: number;
	binaryFiles: number;
	binaryBytes: number;
	files: Record<string, string>;
}
/** The generated repository with `package.json` + `bun.lock` of `deps`, and a `setupCommand` installing and building. */
async function seedWith(deps: { dependencies: Record<string, string>; devDependencies: Record<string, string> }, lockfile: string): Promise<Seed> {
	return {
		textFiles: env("LOAD_TEXT_FILES", 3000),
		textBytes: env("LOAD_TEXT_BYTES", 8192),
		binaryFiles: env("LOAD_BINARY_FILES", 8),
		binaryBytes: env("LOAD_BINARY_BYTES", 2 * 1024 * 1024),
		files: {
			".gitignore": "node_modules/\ndist/\n",
			".agentbot.yml": "setupCommand: bun install --frozen-lockfile && bun run build\n",
			"package.json": `${JSON.stringify({ name: "load-app", private: true, scripts: { build: "bun build.ts" }, ...deps }, null, 2)}\n`,
			"bun.lock": await Bun.file(join(import.meta.dir, lockfile)).text(),
			// The "build": transpile every source file (CPU work proportional to the repository's size).
			"build.ts": [
				'import { Glob } from "bun";',
				'const transpiler = new Bun.Transpiler({ loader: "ts" });',
				"let files = 0;",
				"let bytes = 0;",
				'for await (const path of new Glob("src/**/*.ts").scan(".")) {',
				"\tbytes += transpiler.transformSync(await Bun.file(path).text()).length;",
				"\tfiles++;",
				"}",
				"console.log(`built ${files} files, ${bytes} bytes`);",
				"",
			].join("\n"),
		},
	};
}
/** ~80 MB of node_modules, 7 packages. */
const lightSeed = await seedWith(
	{ dependencies: { "date-fns": "4.1.0", lodash: "4.17.21", react: "19.1.0", "react-dom": "19.1.0", zod: "3.25.76" }, devDependencies: { typescript: "5.9.2" } },
	"load.bun.lock",
);
/** ~450 MB of node_modules, 247 packages: a typical web app. */
const heavySeed = await seedWith(
	{
		dependencies: { next: "15.5.2", react: "19.1.0", "react-dom": "19.1.0", "@aws-sdk/client-s3": "3.879.0", zod: "3.25.76", "date-fns": "4.1.0", lodash: "4.17.21" },
		devDependencies: { typescript: "5.9.2", eslint: "9.34.0", vitest: "3.2.4", "@types/node": "24.3.0", prettier: "3.6.2" },
	},
	"load-heavy.bun.lock",
);
const DISCORD = { latencyMs: 100, perWindow: 5, windowMs: 5000 };
const out = process.env.LOAD_OUT ?? join(tmpdir(), `agentbot-load-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

// ---- samplers ---------------------------------------------------------------------------------------------------------

interface Metrics {
	at: string;
	cgroup: { cpuUsageUsec: number | null; memoryCurrent: number | null; memoryPeak: number | null; memoryAnon: number | null; memoryFile: number | null };
	process: { rss: number };
	pressure: { io: number | null; cpu: number | null; nodeIo: number | null; nodeCpu: number | null };
	discordQueue: { length: number; oldestAgeMs: number | null };
	discordRest: { writes: number; rateLimited: number };
	queueSeconds: { at: string; length: number; oldestAgeMs: number; lagMs: number }[];
	/** The state volume's worst append (no fsync) and write + fsync latency per second. */
	diskSeconds: { at: string; appendMs: number; fsyncMs: number }[];
	timings: { at: string; op: string; repo?: string; ms: number; bytes?: number; status?: number }[];
}
type Sample = Omit<Metrics, "queueSeconds" | "diskSeconds" | "timings">;
const samples: Sample[] = [];
/** `setupMs` per run as the status API reported it while the run was active (NFR-06's status page figure). */
const statusSetupMs = new Map<string, number>();
let sampling = true;
/** Every 2 s until the end: the metrics, and `setupMs` of the active runs from the status API. */
async function sampleMetrics(): Promise<void> {
	while (sampling) {
		try {
			const { queueSeconds: _q, diskSeconds: _d, timings: _t, ...sample } = await control<Metrics>("metrics");
			samples.push(sample);
			const status = await adminGet<StatusReport>("status?window=24h");
			for (const run of status.activeRuns) if (run.setupMs !== undefined) statusSetupMs.set(run.id, run.setupMs);
		} catch (err) {
			say(`metrics sample failed: ${(err as Error).message}`);
		}
		await Bun.sleep(2000);
	}
}

/** Worker logs (JSON lines), streamed from each pod as soon as its container started: the pods go 60 s after the run. */
const podLogs = new Map<string, Promise<string>>();
async function streamWorkerLogs(): Promise<void> {
	while (sampling) {
		for (const [name, pod] of seenPods) {
			if (podLogs.has(name) || !pod.status.containerStatuses?.some(c => c.state.running || c.state.terminated)) continue;
			const proc = Bun.spawn(["kubectl", "--context", ctx, "-n", ns, "logs", "-f", name], {
				stdout: "pipe",
				stderr: "ignore",
			});
			podLogs.set(name, new Response(proc.stdout).text());
		}
		await Bun.sleep(500);
	}
}

interface LogLine {
	ts: string;
	level: string;
	msg: string;
	run?: string;
	exitCode?: number;
}
async function workerLog(pod: string): Promise<LogLine[]> {
	const text = (await podLogs.get(pod)) ?? "";
	return text
		.split("\n")
		.filter(line => line.startsWith("{"))
		.map(line => JSON.parse(line) as LogLine);
}

// ---- measurement ------------------------------------------------------------------------------------------------------

const ms = (from: string | null | undefined, to: string | null | undefined) => (from && to ? Date.parse(to) - Date.parse(from) : null);
const percentile = (values: number[], p: number) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
};

/** One run's startup breakdown, in ms between consecutive steps; `null` when a step was not observed. */
interface RunTiming {
	run: string;
	kind: string;
	repo: string | null;
	issue: number | null;
	pod: string | null;
	outcome: string | null;
	steps: Record<(typeof STEPS)[number], number | null>;
	/** claim → agent registered: the setup time NFR-06 shows on the status page. */
	setupMs: number | null;
	/** The same, as the status API reported it during the run. */
	statusSetupMs: number | null;
	/** pending → agent registered. */
	startupMs: number | null;
	/** Issue filed (plan) or plan approved (implement) → agent registered: what the user waits for. */
	fromTriggerMs: number | null;
	setupExit: number | null;
}
const STEPS = ["trigger→pending", "pending→pod", "pod→scheduled", "scheduled→started", "started→claimed", "claimed→checkout", "checkout→setup", "setup→registered", "registered→finished"] as const;

/** When each issue was filed and its plan approved, by `<repo>#<issue>/<plan|implement>`. */
const triggers = new Map<string, string>();

async function timeRun(run: Run): Promise<RunTiming> {
	const trigger = triggers.get(`${run.repo}#${run.issue}/${run.kind}`);
	const pod: PodJson | undefined = run.worker ? seenPods.get(run.worker) : undefined;
	const scheduled = pod?.status.conditions?.find(c => c.type === "PodScheduled")?.lastTransitionTime;
	const container = pod?.status.containerStatuses?.[0]?.state;
	const started = container?.running?.startedAt ?? container?.terminated?.startedAt;
	const lines = run.worker ? (await workerLog(run.worker)).filter(l => l.run === run.id) : [];
	const checkout = lines.find(l => l.msg === "checkout made")?.ts;
	const setup = lines.find(l => l.msg === "setup command finished");
	return {
		run: run.id,
		kind: run.kind,
		repo: run.repo,
		issue: run.issue,
		pod: run.worker,
		outcome: run.outcome,
		steps: {
			"trigger→pending": ms(trigger, run.createdAt),
			"pending→pod": ms(run.createdAt, pod?.metadata.creationTimestamp),
			"pod→scheduled": ms(pod?.metadata.creationTimestamp, scheduled),
			"scheduled→started": ms(scheduled, started),
			"started→claimed": ms(started, run.claimedAt),
			"claimed→checkout": ms(run.claimedAt, checkout),
			"checkout→setup": ms(checkout, setup?.ts),
			"setup→registered": ms(setup?.ts, run.startedAt),
			"registered→finished": ms(run.startedAt, run.finishedAt),
		},
		setupMs: ms(run.claimedAt, run.startedAt),
		statusSetupMs: statusSetupMs.get(run.id) ?? null,
		startupMs: ms(run.createdAt, run.startedAt),
		fromTriggerMs: ms(trigger, run.startedAt),
		setupExit: setup?.exitCode ?? null,
	};
}

const fmt = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(1)} s`);
const mib = (v: number | null) => (v === null ? "—" : `${(v / 1048576).toFixed(0)} MiB`);
function breakdownTable(timings: RunTiming[]): string {
	const rows: [string, (t: RunTiming) => number | null][] = [
		...STEPS.map(step => [step, (t: RunTiming) => t.steps[step]] as [string, (t: RunTiming) => number | null]),
		["setup (claim→registered, NFR-06)", t => t.setupMs],
		["startup (pending→registered)", t => t.startupMs],
		["user wait (trigger→registered)", t => t.fromTriggerMs],
	];
	const lines = ["| Step | p50 | p95 | max |", "|---|---|---|---|"];
	for (const [name, get] of rows) {
		const values = timings.map(get).filter((v): v is number => v !== null);
		lines.push(`| ${name} | ${fmt(percentile(values, 50))} | ${fmt(percentile(values, 95))} | ${fmt(values.length ? Math.max(...values) : null)} |`);
	}
	return lines.join("\n");
}
function opTable(timings: Metrics["timings"]): string {
	const ops = [...new Set(timings.map(t => t.op))].sort();
	const lines = ["| Operation | count | p50 | p95 | max | bytes p50 |", "|---|---|---|---|---|---|"];
	for (const op of ops) {
		const of = timings.filter(t => t.op === op);
		const values = of.map(t => t.ms);
		const bytes = of.map(t => t.bytes).filter((b): b is number => b !== undefined);
		lines.push(
			`| ${op} | ${of.length} | ${values.length ? `${percentile(values, 50)} ms` : "—"} | ${percentile(values, 95)} ms | ${Math.max(...values)} ms | ${bytes.length ? `${((percentile(bytes, 50) ?? 0) / 1024).toFixed(0)} KiB` : "—"} |`,
		);
	}
	return lines.join("\n");
}

interface ScenarioResult {
	name: string;
	/** The seeded repository, file contents left out. */
	seed: Omit<Seed, "files"> & { files: string[]; packageJson: string };
	repos: string[];
	packBytes: number;
	seedMs: number;
	window: { from: string; to: string };
	plans: RunTiming[];
	implements: RunTiming[];
	queue: { maxLength: number; maxOldestMs: number; rest: { writes: number; rateLimited: number }; seconds: Metrics["queueSeconds"] };
	disk: Metrics["diskSeconds"];
	orchestrator: { cpuPeakPct: number | null; cpuAvgPct: number | null; memoryPeak: number | null; memoryMax: number | null; anonMax: number | null; rssMax: number | null };
	timings: Metrics["timings"];
	/** The metrics samples of the scenario's window (every 2 s). */
	samples: Sample[];
	branches: { repo: string; issue: number; branch: string; log: string[]; files: number; pr: number | null }[];
	podsCreated: number;
	maxRunningPods: number;
}
const results: ScenarioResult[] = [];

/** Files 1 issue per entry of `repos` (one repo may repeat), plans them, approves every plan at once and waits for the PRs. */
async function scenario(name: string, repos: string[], seed: Seed): Promise<void> {
	await until(async () => (await freshPods(Date.now())).running.length === 0 && pods, "no running worker pods before the scenario", 240_000);
	const distinct = [...new Set(repos)];
	say(`${name}: seeding ${distinct.length} repositor${distinct.length === 1 ? "y" : "ies"} (${seed.textFiles} × ${seed.textBytes} B sources, ${seed.binaryFiles} × ${seed.binaryBytes} B assets)`);
	const seeded = await control<{ repos: string[]; packBytes: number; seedMs: number }>("repos", { repos: distinct, ...seed });
	say(`${name}: seeded in ${(seeded.seedMs / 1000).toFixed(1)} s, pack ${(seeded.packBytes / 1048576).toFixed(1)} MiB`);
	const before = new Set(seenPods.keys());
	const from = new Date().toISOString();
	const before0 = samples.at(-1)?.discordRest ?? { writes: 0, rateLimited: 0 };

	const filed: { repo: string; issue: number }[] = [];
	for (const repo of distinct) {
		const count = repos.filter(r => r === repo).length;
		const at = new Date().toISOString();
		const { numbers } = await control<{ numbers: number[] }>("issues", { repo, count, planSeconds: 2, implementSeconds, progressSeconds: 2 });
		for (const issue of numbers) {
			filed.push({ repo, issue });
			triggers.set(`${repo}#${issue}/plan`, at);
		}
	}
	say(`${name}: filed ${filed.length} issues; waiting for their plans`);
	const mine = (s: State) => s.issues.filter(i => filed.some(f => f.repo === i.repo && f.issue === i.number));
	let maxRunningPods = 0;
	const watchPods = () => {
		maxRunningPods = Math.max(maxRunningPods, pods.running.length);
	};
	/** A run of `kind` for these issues that ended other than succeeded (`until` swallows throws, so it is returned). */
	const failedRun = (s: State, kind: string) => s.runs.find(r => r.kind === kind && filed.some(f => f.repo === r.repo && f.issue === r.issue) && r.outcome && r.outcome !== "succeeded");
	/** Fails with the run and its worker's warnings and errors (a log snapshot: the pod may still be running). */
	const failWith = async (run: Run): Promise<never> => {
		const snapshot = run.worker ? (await kubectl("logs", run.worker).nothrow()).stdout.toString() : "";
		const lines = snapshot.split("\n").filter(line => line.includes('"level":"warn"') || line.includes('"level":"error"'));
		fail(`${name}: ${run.kind} run ${run.id} for ${run.repo}#${run.issue} on ${run.worker} ended ${run.outcome}:\n${lines.join("\n")}`);
	};
	const planned = await until(
		async () => {
			watchPods();
			const s = await state();
			return failedRun(s, "plan") ?? (mine(s).length === filed.length && mine(s).every(i => i.state === "awaiting_approval") && "ok");
		},
		"every plan awaiting approval",
		600_000,
	);
	if (planned !== "ok") await failWith(planned);
	say(`${name}: all plans ready; waiting for the plan pods to go before approving (cold start for every implement run)`);
	await until(async () => (await freshPods(Date.now())).running.length === 0 && pods, "plan pods to exit", 240_000);
	// One after another, as an admin clicks them (and so that the port-forward does not drop held requests).
	for (const f of filed) {
		triggers.set(`${f.repo}#${f.issue}/implement`, new Date().toISOString());
		await control("approve", { repo: f.repo, issue: f.issue });
	}
	say(`${name}: approved ${filed.length} plans`);
	const implemented = await until(
		async () => {
			watchPods();
			const s = await state();
			return failedRun(s, "implement") ?? (mine(s).every(i => i.state === "in_review") && "ok");
		},
		"every implement run to open its PR",
		900_000,
	);
	if (implemented !== "ok") await failWith(implemented);
	const to = new Date().toISOString();
	say(`${name}: every issue in review`);
	// Let the pod sampler see the finished pods' final container state, and the log streams end.
	await Bun.sleep(3000);

	const s = await state();
	const runsOf = (kind: string) => s.runs.filter(r => r.kind === kind && filed.some(f => f.repo === r.repo && f.issue === r.issue));
	const plans = await Promise.all(runsOf("plan").map(timeRun));
	const implementRuns = runsOf("implement");
	const implementTimings = await Promise.all(implementRuns.map(timeRun));
	if (implementRuns.length !== filed.length || implementRuns.some(r => r.outcome !== "succeeded")) fail(`${name}: expected ${filed.length} succeeded implement runs`);
	if (implementTimings.some(t => t.setupExit !== 0)) fail(`${name}: a setupCommand did not exit 0: ${JSON.stringify(implementTimings.map(t => t.setupExit))}`);

	// The push path: every issue has its own branch with the fixture's two commits on the seed, and its own PR.
	const branches: ScenarioResult["branches"] = [];
	for (const f of filed) {
		const b = await control<{ branch: string; log: string[]; files: string[] }>(`branch?repo=${encodeURIComponent(f.repo)}&issue=${f.issue}`);
		const issue = s.issues.find(i => i.repo === f.repo && i.number === f.issue);
		branches.push({ repo: f.repo, issue: f.issue, branch: b.branch, log: b.log, files: b.files.length, pr: issue?.pr ?? null });
		if (JSON.stringify(b.log) !== JSON.stringify(["Finish the slow change", "Start the slow change", "Initial commit"])) fail(`${name}: ${f.repo}#${f.issue} branch log ${b.log}`);
		if (b.files.includes("node_modules")) fail(`${name}: ${f.repo}#${f.issue} committed node_modules`);
	}
	if (new Set(branches.map(b => `${b.repo}:${b.branch}`)).size !== filed.length) fail(`${name}: issue branches are not distinct`);
	if (new Set(branches.map(b => `${b.repo}:${b.pr}`)).size !== filed.length || branches.some(b => !b.pr)) fail(`${name}: PRs are not one per issue`);

	const metrics = await control<Metrics>("metrics");
	const inWindow = (at: string) => at >= from.slice(0, at.length) && at <= to.slice(0, at.length);
	const seconds = metrics.queueSeconds.filter(q => inWindow(q.at));
	const window = samples.filter(x => inWindow(x.at));
	const cpu: number[] = [];
	for (let i = 1; i < window.length; i++) {
		const [a, b] = [window[i - 1]!, window[i]!];
		if (a.cgroup.cpuUsageUsec !== null && b.cgroup.cpuUsageUsec !== null)
			cpu.push(((b.cgroup.cpuUsageUsec - a.cgroup.cpuUsageUsec) / 1000 / (Date.parse(b.at) - Date.parse(a.at))) * 100);
	}
	const max = (values: (number | null)[]) => {
		const seen = values.filter((v): v is number => v !== null);
		return seen.length ? Math.max(...seen) : null;
	};
	const restNow = metrics.discordRest;
	const created = [...seenPods.keys()].filter(p => !before.has(p));
	const result: ScenarioResult = {
		name,
		seed: { ...seed, files: Object.keys(seed.files), packageJson: seed.files["package.json"] ?? "" },
		repos: distinct,
		packBytes: seeded.packBytes,
		seedMs: seeded.seedMs,
		window: { from, to },
		plans,
		implements: implementTimings,
		queue: {
			maxLength: Math.max(0, ...seconds.map(q => q.length)),
			maxOldestMs: Math.max(0, ...seconds.map(q => q.oldestAgeMs)),
			rest: { writes: restNow.writes - before0.writes, rateLimited: restNow.rateLimited - before0.rateLimited },
			seconds,
		},
		disk: metrics.diskSeconds.filter(q => inWindow(q.at)),
		orchestrator: {
			cpuPeakPct: cpu.length ? Math.max(...cpu) : null,
			cpuAvgPct: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : null,
			memoryPeak: metrics.cgroup.memoryPeak,
			memoryMax: max(window.map(x => x.cgroup.memoryCurrent)),
			anonMax: max(window.map(x => x.cgroup.memoryAnon)),
			rssMax: max(window.map(x => x.process.rss)),
		},
		timings: metrics.timings.filter(t => inWindow(t.at)),
		samples: window,
		branches,
		podsCreated: created.length,
		maxRunningPods,
	};
	results.push(result);
	report(result);
	await Bun.write(out, JSON.stringify({ implementSeconds, discord: DISCORD, results }, null, 2));
}

function report(r: ScenarioResult): void {
	console.log(`\n=== ${r.name}: ${r.implements.length} implement runs on ${r.repos.length} repositor${r.repos.length === 1 ? "y" : "ies"} ===`);
	console.log(`pods created ${r.podsCreated}, max Running ${r.maxRunningPods}; pack ${(r.packBytes / 1048576).toFixed(1)} MiB`);
	console.log("\nimplement runs:\n" + breakdownTable(r.implements));
	console.log("\nplan runs:\n" + breakdownTable(r.plans));
	console.log("\nper implement run (s): run pod | steps... | setup | status setupMs");
	for (const t of r.implements)
		console.log(`  ${t.run.slice(0, 8)} ${t.repo}#${t.issue} ${t.pod} | ${STEPS.map(s => fmt(t.steps[s])).join(" | ")} | ${fmt(t.setupMs)} | ${fmt(t.statusSetupMs)}`);
	console.log("\norchestrator-side operations:\n" + opTable(r.timings));
	console.log(
		`\nDiscord queue: max length ${r.queue.maxLength}, max oldest ${fmt(r.queue.maxOldestMs)}; REST writes ${r.queue.rest.writes}, simulated 429s ${r.queue.rest.rateLimited}`,
	);
	const o = r.orchestrator;
	console.log(
		`orchestrator: CPU peak ${o.cpuPeakPct?.toFixed(0) ?? "—"} % (2 s samples), avg ${o.cpuAvgPct?.toFixed(0) ?? "—"} %; memory (cgroup) max ${mib(o.memoryMax)}, of it anonymous max ${mib(o.anonMax)}; orchestrator process RSS max ${mib(o.rssMax)}; cgroup peak since start ${mib(o.memoryPeak)}`,
	);
	const worst = r.queue.seconds.reduce((a, b) => (b.lagMs > a.lagMs ? b : a), { at: "-", length: 0, oldestAgeMs: 0, lagMs: 0 });
	const stalls = r.queue.seconds.filter(q => q.lagMs >= 1000);
	const peak = (get: (p: Sample["pressure"]) => number | null) => Math.max(0, ...r.samples.map(x => get(x.pressure) ?? 0));
	console.log(
		`event loop: worst lag ${worst.lagMs} ms at ${worst.at.slice(11)}, ${stalls.length} s with a lag ≥ 1 s; PSI some avg10 peaks: container io ${peak(p => p.io)} %, cpu ${peak(p => p.cpu)} %; node io ${peak(p => p.nodeIo)} %, cpu ${peak(p => p.nodeCpu)} %`,
	);
	const worstDisk = (from: number, to: number) =>
		r.disk
			.filter(d => Date.parse(`${d.at}Z`) >= from - 1000 && Date.parse(`${d.at}Z`) <= to)
			.reduce((a, b) => ({ appendMs: Math.max(a.appendMs, b.appendMs), fsyncMs: Math.max(a.fsyncMs, b.fsyncMs) }), { appendMs: 0, fsyncMs: 0 });
	const all = worstDisk(0, Number.POSITIVE_INFINITY);
	console.log(`state volume: worst append ${all.appendMs} ms, worst write+fsync ${all.fsyncMs} ms (500 ms probes)`);
	for (const s of stalls) {
		const end = Date.parse(`${s.at}Z`) + 1000;
		const d = worstDisk(end - s.lagMs - 1000, end);
		console.log(`  stall: ${s.lagMs} ms ending ${s.at.slice(11)}; meanwhile worst append ${d.appendMs} ms, write+fsync ${d.fsyncMs} ms`);
	}
	const gaps = r.samples.slice(1).map((x, i) => ({ at: x.at, gap: Date.parse(x.at) - Date.parse(r.samples[i]!.at) })).filter(g => g.gap > 6000);
	if (gaps.length) console.log(`metrics sampling gaps (driver → port-forward → orchestrator): ${gaps.map(g => `${g.at.slice(11, 19)} ${fmt(g.gap)}`).join(", ")}`);
	console.log(`branches: ${r.branches.map(b => `${b.repo}#${b.issue}→${b.branch} PR #${b.pr}`).join(", ")}`);
}

// ---- run -----------------------------------------------------------------------------------------------------------

let failed: unknown;
const background: Promise<void>[] = [];
try {
	await setUp(join(import.meta.dir, "load.values.yaml"));
	startPodSampler();
	background.push(sampleMetrics(), streamWorkerLogs());
	await control("limits", { maxConcurrentJobs: 10, maxChatSessions: 2 });
	const h = await health();
	if (h.limits?.effectiveConcurrency !== 10) fail(`effectiveConcurrency ${h.limits?.effectiveConcurrency}, expected 10`);
	await control("discord", DISCORD);
	if (process.env.LOAD_SQLITE_SYNC) say(`SQLite synchronous: ${JSON.stringify(await control("sqlite", { synchronous: process.env.LOAD_SQLITE_SYNC }))}`);
	say(`limits 10/2, capacity 10; fake Discord: ${DISCORD.latencyMs} ms per write, ${DISCORD.perWindow} writes per ${DISCORD.windowMs / 1000} s per channel`);
	for (const s of scenarios) {
		if (s === "same") await scenario("same", Array.from({ length: 10 }, () => "load/same"), lightSeed);
		else if (s === "multi") await scenario("multi", Array.from({ length: 10 }, (_, i) => `load/repo${String(i + 1).padStart(2, "0")}`), lightSeed);
		else if (s === "heavy") await scenario("heavy", Array.from({ length: 3 }, () => "load/heavy"), heavySeed);
		else fail(`unknown scenario ${s}`);
	}
} catch (err) {
	failed = err;
	say(`FAILED: ${(err as Error).message}`);
	const s = await state().catch(() => undefined);
	if (s) printTransitions(s.transitions, () => true);
	console.log(`--- orchestrator log (last 80 lines) ---\n${await orchestratorLogTail()}`);
	const problems = await kubectl("get", "pods", "-o", "wide").nothrow();
	console.log(`--- pods ---\n${problems.stdout}`);
} finally {
	sampling = false;
	await Promise.all(background);
}
console.log(`\nraw measurements: ${out}`);
await tearDown();
process.exit(failed ? 1 : 0);
