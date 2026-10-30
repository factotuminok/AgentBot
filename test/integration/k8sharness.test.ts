import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { workerRoot } from "../../src/worker/status";

/**
 * The Kubernetes scenario orchestrator (test/e2e/k8s/orchestrator.ts) as plain processes: started with the env and token
 * files the chart gives it, with a stand-in for KEDA that starts one worker process (test/fixtures/worker-process.ts)
 * per pending run. Checks what test/e2e/k8s/scenarios.sh relies on: health limits and warnings follow the control
 * API's limits, labelled `fixture:slow` issues are planned on workers, and a worker stopped with SIGTERM mid-implement
 * is replaced by one that resumes from the checkpoint.
 */

const ORCHESTRATOR = join(import.meta.dir, "..", "e2e", "k8s", "orchestrator.ts");
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const WEB_TOKEN = "k8s-harness-web-token";
const WORKER_TOKEN = "k8s-harness-worker-token";
const SCALE_TOKEN = "k8s-harness-scale-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(get: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

interface State {
	phase: string;
	issues: { repo: string; number: number; state: string; branch: string | null; pr: number | null }[];
	runs: {
		id: string;
		kind: string;
		repo: string | null;
		issue: number | null;
		state: string;
		outcome: string | null;
		worker: string | null;
		continues: string | null;
		claimedAt: string | null;
		startedAt: string | null;
	}[];
	pendingRuns: number;
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = probe.port!;
	await probe.stop(true);
	return port;
}

async function boot() {
	const root = await mkdtemp(join(tmpdir(), "agentbot-k8sharness-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const files: Record<string, string> = { master: crypto.randomUUID() + crypto.randomUUID(), web: WEB_TOKEN, worker: WORKER_TOKEN, scale: SCALE_TOKEN };
	for (const [name, value] of Object.entries(files)) await writeFile(join(root, name), value);
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	let output = "";
	const orchestrator = Bun.spawn(["bun", ORCHESTRATOR], {
		env: {
			...process.env,
			AGENTBOT_STATE_DIR: join(root, "state"),
			AGENTBOT_INTERNAL_HOST: "127.0.0.1",
			AGENTBOT_INTERNAL_PORT: String(port),
			AGENTBOT_MASTER_KEY_FILE: join(root, "master"),
			AGENTBOT_WEB_API_TOKEN_FILE: join(root, "web"),
			AGENTBOT_WORKER_TOKEN_FILE: join(root, "worker"),
			AGENTBOT_SCALE_TOKEN_FILE: join(root, "scale"),
			AGENTBOT_WORKER_CAPACITY: "10",
			// Every worker process connects from 127.0.0.1 here; in kind each pod has its own address.
			AGENTBOT_WORKER_ADDRESS_BINDING: "off",
			// Short dispatcher timings and polling: a SIGTERM'd worker counts as lost after 1.5 s, not the product's 45 s.
			E2E_LEASE_MS: "1500",
			E2E_SWEEP_MS: "50",
			E2E_POLL_SECONDS: "1",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	for (const stream of [orchestrator.stdout, orchestrator.stderr]) {
		void (async () => {
			for await (const chunk of stream) output += new TextDecoder().decode(chunk);
		})();
	}
	cleanups.push(async () => {
		orchestrator.kill("SIGKILL");
		await orchestrator.exited;
		// HARNESS_LOG=<file> keeps the orchestrator's log for a failing run.
		if (process.env.HARNESS_LOG) await Bun.write(process.env.HARNESS_LOG, output);
	});

	const control = async (path: string, body?: object) => {
		const res = await fetch(`${url}/internal/admin/e2e/${path}`, {
			method: body ? "POST" : "GET",
			headers: { authorization: `Bearer ${WEB_TOKEN}`, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
		return res.json();
	};
	const state = () => control("state") as Promise<State>;
	const health = async () => (await fetch(`${url}/readyz`)).json() as Promise<{ limits: Record<string, number> | null; warnings: string[] }>;

	// The stand-in for KEDA: `pendingRuns` from the scale endpoint, minus workers started but not yet claimed.
	const workers: { proc: Subprocess<"ignore", "pipe", "pipe">; id: string; startedAt: number; output: string }[] = [];
	const scaler = setInterval(async () => {
		const res = await fetch(`${url}/internal/scale`, { headers: { authorization: `Bearer ${SCALE_TOKEN}` } }).catch(() => undefined);
		if (!res?.ok) return;
		const { pendingRuns } = (await res.json()) as { pendingRuns: number };
		const starting = workers.filter(w => w.proc.exitCode === null && Date.now() - w.startedAt < 3_000).length;
		for (let i = starting; i < pendingRuns; i++) {
			const id = `harness-worker-${workers.length}`;
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: { ...process.env, AGENTBOT_ORCHESTRATOR_URL: url, TEST_WORKER_TOKEN: WORKER_TOKEN, TEST_WORKER_ID: id, TEST_CLAIM_TIMEOUT_MS: "4000" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const worker = { proc, id, startedAt: Date.now(), output: "" };
			for (const stream of [proc.stdout, proc.stderr]) {
				void (async () => {
					for await (const chunk of stream) worker.output += new TextDecoder().decode(chunk);
				})();
			}
			workers.push(worker);
		}
	}, 100);
	cleanups.push(async () => {
		clearInterval(scaler);
		for (const w of workers) {
			w.proc.kill("SIGKILL");
			await w.proc.exited;
			await rm(workerRoot(join(tmpdir(), "agentbot-worker"), w.proc.pid), { recursive: true, force: true });
		}
	});

	await until(async () => (await fetch(`${url}/readyz`).catch(() => undefined))?.ok, "the orchestrator", 30_000).catch(err => {
		throw new Error(`${(err as Error).message}\n${output}`);
	});
	await until(async () => (await state()).phase === "running", "the engine", 30_000);
	return { control, state, health, workers, output: () => output };
}

describe("k8s scenario harness", () => {
	test("limits and warnings in health, slow plans on workers, and a SIGTERM'd implement resumed from its checkpoint", async () => {
		const h = await boot();

		// Seeded at the product defaults: below the capacity of 10, with the warning (RUN-11, RUN-12).
		expect(await h.health()).toMatchObject({ limits: { maxConcurrentJobs: 2, maxChatSessions: 2, workerCapacity: 10, effectiveConcurrency: 4 } });
		expect((await h.health()).warnings.join("\n")).toContain("below worker capacity (10)");
		await h.control("limits", { maxConcurrentJobs: 10, maxChatSessions: 2 });
		expect(await h.health()).toMatchObject({ limits: { maxConcurrentJobs: 10, effectiveConcurrency: 10 }, warnings: [] });

		const { numbers } = (await h.control("issues", { count: 3, planSeconds: 1, implementSeconds: 120 })) as { numbers: number[] };
		await until(async () => (await h.state()).issues.filter(i => i.state === "awaiting_approval").length === 3, "three plans", 20_000);
		// Each plan ran on its own worker (one run per worker, architecture §4.4).
		const plans = (await h.state()).runs.filter(r => r.kind === "plan" && r.outcome === "succeeded");
		expect(new Set(plans.map(r => r.worker)).size).toBe(3);

		const issue = numbers[0]!;
		await h.control("approve", { issue });
		const first = await until(async () => (await h.state()).runs.find(r => r.issue === issue && r.kind === "implement" && r.state === "running"), "the implement run", 20_000);
		// The fixture logs this once it has committed and written its uncommitted file; then evict the worker (RUN-18).
		const evicted = h.workers.find(w => w.id === first.worker)!;
		await until(() => evicted.output.includes('"fixture holding"'), "the fixture's commit", 20_000);
		evicted.proc.kill("SIGTERM");
		expect(await evicted.proc.exited).toBe(0);

		// The lease runs out, the job is requeued with resume (RUN-04), and a new worker resumes from the checkpoint.
		const resumed = await until(async () => (await h.state()).runs.find(r => r.continues === first.id && r.outcome === "succeeded"), "the resumed run", 20_000);
		expect(resumed.worker).not.toBe(first.worker);
		const lost = (await h.state()).runs.find(r => r.id === first.id)!;
		expect(lost.outcome).toBe("lost");
		await until(async () => (await h.state()).issues.find(i => i.number === issue)?.state === "in_review", "the PR", 20_000);
		const branch = (await h.control(`branch?issue=${issue}`)) as { log: string[]; resumed: string | null };
		expect(branch.log).toEqual(["Resume from the checkpoint", "Start the slow change", "Initial commit"]);
		expect(branch.resumed).toBe(`run ${resumed.id} resumed from the checkpoint: written by run ${first.id}`);
	}, 60_000);

	test("load-test routes: seeded repos with a setupCommand, Discord REST simulation, timings and the queue in metrics", async () => {
		const h = await boot();
		await h.control("limits", { maxConcurrentJobs: 10, maxChatSessions: 2 });
		await h.control("discord", { latencyMs: 20, perWindow: 2, windowMs: 1000 });
		const seeded = (await h.control("repos", {
			repos: ["load/one", "load/two"],
			textFiles: 30,
			textBytes: 2048,
			binaryFiles: 1,
			binaryBytes: 65_536,
			files: { ".gitignore": "out/\n", ".agentbot.yml": "setupCommand: mkdir -p out && ls src | wc -l > out/count\n" },
		})) as { repos: string[]; packBytes: number };
		expect(seeded.repos).toEqual(["load/one", "load/two"]);
		expect(seeded.packBytes).toBeGreaterThan(65_536);

		const filed: { repo: string; issue: number }[] = [];
		for (const repo of seeded.repos) {
			const { numbers } = (await h.control("issues", { repo, count: 1, planSeconds: 1, implementSeconds: 3, progressSeconds: 1 })) as { numbers: number[] };
			filed.push({ repo, issue: numbers[0]! });
		}
		const issueOf = async (f: { repo: string; issue: number }) => (await h.state()).issues.find(i => i.repo === f.repo && i.number === f.issue);
		for (const f of filed) await until(async () => (await issueOf(f))?.state === "awaiting_approval", `${f.repo}'s plan`, 30_000);
		for (const f of filed) await h.control("approve", f);
		for (const f of filed) await until(async () => (await issueOf(f))?.state === "in_review", `${f.repo}'s PR`, 30_000);

		const implementRuns = (await h.state()).runs.filter(r => r.kind === "implement");
		expect(implementRuns.map(r => r.repo).sort()).toEqual(["load/one", "load/two"]);
		for (const r of implementRuns) {
			expect(r.outcome).toBe("succeeded");
			expect(Date.parse(r.startedAt!)).toBeGreaterThanOrEqual(Date.parse(r.claimedAt!));
		}
		for (const f of filed) {
			const branch = (await h.control(`branch?repo=${f.repo}&issue=${f.issue}`)) as { log: string[]; files: string[] };
			expect(branch.log).toEqual(["Finish the slow change", "Start the slow change", "Initial commit"]);
			expect(branch.files).not.toContain("out");
		}
		// The setupCommand ran in every checkout (the worker logs its exit code).
		expect(h.workers.filter(w => w.output.includes('"setup command finished"') && w.output.includes('"exitCode":0')).length).toBeGreaterThanOrEqual(4);

		const metrics = (await h.control("metrics")) as {
			process: { rss: number };
			discordRest: { writes: number; rateLimited: number };
			queueSeconds: { length: number }[];
			timings: { op: string; repo?: string; ms: number; bytes?: number }[];
		};
		expect(metrics.process.rss).toBeGreaterThan(0);
		expect(metrics.discordRest.writes).toBeGreaterThan(0);
		expect(metrics.discordRest.rateLimited).toBeGreaterThan(0);
		expect(Math.max(...metrics.queueSeconds.map(q => q.length))).toBeGreaterThan(0);
		const ops = new Set(metrics.timings.map(t => `${t.op} ${t.repo}`));
		for (const repo of seeded.repos) for (const op of ["mirror-fetch", "push", "git git-upload-pack"]) expect(ops).toContain(`${op} ${repo}`);
		expect(metrics.timings.find(t => t.op === "git git-upload-pack")!.bytes).toBeGreaterThan(0);
	}, 90_000);
});
