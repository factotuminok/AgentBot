#!/usr/bin/env bun
// Phase 9 exit scenarios on the shared kind cluster (implementation.md §4 Phase 9), with the chart and the scenario image
// (test/e2e/k8s/Containerfile: the real orchestrator internals with fake Discord and GitHub, real workers with the
// fixture agent host). No Discord, GitHub or model credentials are needed.
//   A  limits raised to 10: 10 labelled issues are planned on 10 concurrent worker pods, then the pods drop to 0
//   B  maxConcurrentJobs 2 with capacity 10: orchestrator health shows the limits and the below-capacity warning, and web
//      /healthz relays the same limits
//   C  a worker pod deleted mid-implement: the run is lost, re-queued, claimed by a NEW pod, resumed from the checkpoint
//      and finished
//
// Usage: bun test/e2e/k8s/scenarios.ts [A] [B] [C]     (default: all three, in that order)
// Env and prerequisites: test/e2e/k8s/harness.ts.
import { join } from "node:path";
import {
	control,
	fail,
	freshPods,
	health,
	kubectl,
	orchestratorLogTail,
	pods,
	printTransitions,
	say,
	seenPods,
	setUp,
	startPodSampler,
	state,
	tearDown,
	until,
	webHealth,
} from "./harness";

const scenarios = process.argv.slice(2).length ? process.argv.slice(2).map(s => s.toUpperCase()) : ["A", "B", "C"];

await setUp(join(import.meta.dir, "scenarios.values.yaml"));
startPodSampler();

const results: string[] = [];

// ---- A: 10 issues on 10 pods, then 0 ---------------------------------------------------------------------------------

async function scenarioA(): Promise<void> {
	say("A: limits raised to 10 (maxConcurrentJobs 10, maxChatSessions 2, capacity 10)");
	await control("limits", { maxConcurrentJobs: 10, maxChatSessions: 2 });
	const h = await health();
	say(`A: /readyz limits=${JSON.stringify(h.limits)} warnings=${JSON.stringify(h.warnings)}`);
	if (h.limits?.effectiveConcurrency !== 10 || h.warnings.length) fail("A: health should report effectiveConcurrency 10 and no warnings");
	await until(async () => (await freshPods(Date.now())).all.length === 0, "no worker pods before A", 180_000);
	const before = new Set(seenPods.keys());

	const filed = Date.now();
	const { numbers } = await control<{ numbers: number[] }>("issues", { count: 10, planSeconds: 45 });
	say(`A: filed 10 labelled issues ${numbers.map(n => `#${n}`).join(" ")} (fixture:slow, 45 s plans)`);
	let maxRunning = 0;
	let maxReady = 0;
	let tenAt: number | undefined;
	await until(
		async () => {
			maxRunning = Math.max(maxRunning, pods.running.length);
			maxReady = Math.max(maxReady, pods.ready.length);
			if (pods.running.length >= 10 && tenAt === undefined) tenAt = Date.now();
			const s = await state();
			return numbers.every(n => s.issues.find(i => i.number === n)?.state === "awaiting_approval");
		},
		"10 plans awaiting approval",
		300_000,
	);
	const planned = Date.now();
	const s = await state();
	const planRuns = s.runs.filter(r => r.kind === "plan" && numbers.includes(r.issue ?? -1));
	const succeeded = planRuns.filter(r => r.outcome === "succeeded");
	const workers = new Set(succeeded.map(r => r.worker));
	say(`A: all 10 plans done; plan runs ${succeeded.length}/${planRuns.length} succeeded on ${workers.size} distinct pods`);
	printTransitions(s.transitions, t => numbers.includes(t.issue ?? -1));

	await until(async () => (await freshPods(Date.now())).running.length === 0 && pods, "running worker pods to drop to 0", 120_000);
	const runningZero = Date.now();
	await until(async () => (await freshPods(Date.now())).all.length === 0 && pods, "every worker pod and Job to be gone (ttlSecondsAfterFinished 60)", 240_000);
	const allZero = Date.now();
	const started = [...seenPods.keys()].filter(p => !before.has(p));
	say(`A: max concurrent Running worker pods ${maxRunning}, max Ready (claimed) ${maxReady}, worker pods created ${started.length}`);
	if (maxRunning !== 10) fail(`A: expected 10 concurrent worker pods, saw ${maxRunning}`);
	if (succeeded.length !== 10 || workers.size !== 10) fail("A: expected 10 succeeded plan runs on 10 different pods");
	if (started.length > 10) say(`A: note: ${started.length - 10} extra pod(s) started (KEDA claim-between-polls; each exits 0 after the claim timeout)`);
	results.push(
		`A PASS: 10 issues → ${maxRunning} concurrent worker pods (time to 10 pods ${((tenAt! - filed) / 1000).toFixed(0)} s after filing), ` +
			`10/10 plans succeeded on 10 pods (${((planned - filed) / 1000).toFixed(0)} s); Running pods 0 ${((runningZero - planned) / 1000).toFixed(0)} s after the last plan, ` +
			`all worker pods/Jobs gone ${((allZero - planned) / 1000).toFixed(0)} s after it; pods created ${started.length}`,
	);
}

// ---- B: limits below capacity → warning -----------------------------------------------------------------------------

async function scenarioB(): Promise<void> {
	say("B: maxConcurrentJobs 2, maxChatSessions 2 with capacity 10");
	await control("limits", { maxConcurrentJobs: 2, maxChatSessions: 2 });
	const h = await health();
	const w = await until(async () => {
		const body = await webHealth();
		return body.orchestrator.limits?.maxConcurrentJobs === 2 && body;
	}, "web /healthz to relay the new limits", 30_000);
	console.log(`    orchestrator /readyz: ${JSON.stringify(h)}`);
	console.log(`    web /healthz:         ${JSON.stringify(w)}`);
	const expected = { maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 10, workerCapacity: 10, effectiveConcurrency: 4 };
	if (JSON.stringify(h.limits) !== JSON.stringify(expected)) fail(`B: orchestrator limits ${JSON.stringify(h.limits)}, expected ${JSON.stringify(expected)}`);
	if (!h.warnings.some(x => x.includes("(4) is below worker capacity (10)"))) fail(`B: no below-capacity warning in ${JSON.stringify(h.warnings)}`);
	if (JSON.stringify(w.orchestrator.limits) !== JSON.stringify(expected)) fail("B: web /healthz does not relay the same limits");
	results.push(`B PASS: /readyz limits ${JSON.stringify(h.limits)}, warning "${h.warnings[0]}"; web /healthz relays the same limits`);
}

// ---- C: a worker pod deleted mid-run → re-queued, new pod, resumed ---------------------------------------------------

async function scenarioC(): Promise<void> {
	say("C: one issue with a short plan and a 150 s implement run");
	const { numbers } = await control<{ numbers: number[] }>("issues", { count: 1, planSeconds: 2, implementSeconds: 150 });
	const issue = numbers[0]!;
	await until(async () => (await state()).issues.find(i => i.number === issue)?.state === "awaiting_approval", `#${issue}'s plan`, 180_000);
	await control("approve", { issue });
	say(`C: approved #${issue}'s plan`);
	const first = await until(async () => (await state()).runs.find(r => r.issue === issue && r.kind === "implement" && r.state === "running" && r.worker), "the implement run to start", 180_000);
	const victim = first.worker!;
	if (!pods.running.includes(victim)) await until(async () => pods.running.includes(victim), `pod ${victim}`, 30_000);
	// Let the fixture commit `slow-start.txt` and write the uncommitted `wip-slow.txt` (it does so right after starting).
	await Bun.sleep(5_000);
	const killed = Date.now();
	say(`C: kubectl delete pod ${victim} (run ${first.id})`);
	await kubectl("delete", "pod", victim, "--wait=false");

	const lostAt = await until(async () => (await state()).transitions.find(t => t.run === first.id && t.outcome === "lost"), "the run to be lost", 180_000);
	say(`C: run ${first.id.slice(0, 8)} lost at ${lostAt.at.slice(11, 19)}`);
	// A resumed `fixture:slow` implement finishes within a second or two of its claim: match any state once claimed.
	const second = await until(async () => (await state()).runs.find(r => r.continues === first.id && r.worker && r.claimedAt), "a new pod to claim the re-queued run", 180_000);
	const claimedAt = Date.parse(second.claimedAt!);
	say(`C: resumed run ${second.id.slice(0, 8)} claimed by pod ${second.worker} at ${second.claimedAt!.slice(11, 19)}`);
	const done = await until(async () => (await state()).runs.find(r => r.id === second.id && r.state === "finished" && r), "the resumed run to finish", 180_000);
	const finishedAt = Date.parse(done.finishedAt!);
	await until(async () => (await state()).issues.find(i => i.number === issue)?.state === "in_review", `#${issue}'s PR`, 120_000);
	const branch = await control<{ branch: string; log: string[]; files: string[]; resumed: string | null }>(`branch?issue=${issue}`);
	const s = await state();
	printTransitions(s.transitions, t => t.issue === issue);
	console.log(`    issue branch ${branch.branch}: ${branch.log.join(" ← ")}`);
	console.log(`    files: ${branch.files.join(", ")}`);
	console.log(`    resumed.txt: ${branch.resumed}`);
	if (second.worker === victim) fail("C: the resumed run ran on the deleted pod");
	if (done.outcome !== "succeeded") fail(`C: resumed run outcome ${done.outcome}`);
	if (!branch.resumed?.includes(`written by run ${first.id}`)) fail("C: resumed.txt does not show the checkpointed file of the first run");
	if (JSON.stringify(branch.log) !== JSON.stringify(["Resume from the checkpoint", "Start the slow change", "Initial commit"])) fail(`C: unexpected branch log ${branch.log}`);
	results.push(
		`C PASS: pod ${victim} deleted mid-run → run ${first.id.slice(0, 8)} lost ${((Date.parse(lostAt.at) - killed) / 1000).toFixed(0)} s later (lease), ` +
			`new pod ${second.worker} claimed the resume ${((claimedAt - killed) / 1000).toFixed(0)} s after the kill, finished ${((finishedAt - killed) / 1000).toFixed(0)} s after it, ` +
			`with the first run's commit and uncommitted file restored from the checkpoint`,
	);
}

let failed: unknown;
try {
	for (const s of scenarios) {
		if (s === "A") await scenarioA();
		else if (s === "B") await scenarioB();
		else if (s === "C") await scenarioC();
		else fail(`unknown scenario ${s}`);
	}
} catch (err) {
	failed = err;
	say(`FAILED: ${(err as Error).message}`);
	const s = await state().catch(() => undefined);
	if (s) printTransitions(s.transitions, () => true);
	console.log(`--- orchestrator log (last 80 lines) ---\n${await orchestratorLogTail()}`);
}
console.log("\n=== results ===");
for (const r of results) console.log(r);
await tearDown();
process.exit(failed ? 1 : 0);
