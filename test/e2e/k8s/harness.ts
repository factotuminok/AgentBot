// The driver side of the Kubernetes e2e runs on the shared kind cluster (test/e2e/k8s/scenarios.ts, load.ts): builds the
// scenario image (test/e2e/k8s/Containerfile), installs the chart with it, port-forwards the orchestrator and web, talks
// to the scenario orchestrator's control API (test/e2e/k8s/orchestrator.ts) and samples the worker pods.
// Env:
//   SKIP_BUILD=1   use the images already on the rootful Podman connection
//   KEEP=1         leave the release installed afterwards (default: uninstall and delete the namespace)
//   NAMESPACE      default agentbot-k8s-e2e; RELEASE default agentbot; IMAGE default localhost/agentbot-k8s-e2e:dev
//   CONTAINER_CONNECTION  Podman connection the images are built on (default podman-machine-default-root)
// Prerequisites: podman (rootful machine), kubectl, .tools/kind (v0.30.0) and .tools/helm; test/e2e/k8s/kind.sh creates
// the cluster `agentbot-e2e` with KEDA when it is missing.
import { join } from "node:path";
import { $, type Subprocess } from "bun";

export const root = join(import.meta.dir, "..", "..", "..");
const kindSh = join(import.meta.dir, "kind.sh");
const helm = process.env.HELM ?? join(root, ".tools", "helm");
export const ctx = `kind-${process.env.CLUSTER ?? "agentbot-e2e"}`;
export const ns = process.env.NAMESPACE ?? "agentbot-k8s-e2e";
const release = process.env.RELEASE ?? "agentbot";
const image = process.env.IMAGE ?? "localhost/agentbot-k8s-e2e:dev";
const connection = process.env.CONTAINER_CONNECTION ?? "podman-machine-default-root";
export const full = release.includes("agentbot") ? release : `${release}-agentbot`;
const workerSelector = `app.kubernetes.io/instance=${release},app.kubernetes.io/component=worker`;
const ORCH_PORT = 18081;
const WEB_PORT = 18080;

const t0 = Date.now();
const stamp = () => `${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
export const say = (msg: string) => console.log(`${stamp()} ${msg}`);
export const kubectl = (...args: string[]) => $`kubectl --context ${ctx} -n ${ns} ${args}`.quiet();

export function fail(msg: string): never {
	throw new Error(msg);
}

export async function until<T>(get: () => Promise<T | undefined | false>, what: string, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get().catch(() => undefined);
		if (value) return value;
		if (Date.now() > end) fail(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
		await Bun.sleep(1000);
	}
}

// ---- setup ----------------------------------------------------------------------------------------------------------

const forwards: Subprocess[] = [];
let webToken = "";

async function portForward(target: string, local: number, remote: number): Promise<void> {
	const proc = Bun.spawn(["kubectl", "--context", ctx, "-n", ns, "port-forward", target, `${local}:${remote}`], { stdout: "ignore", stderr: "ignore" });
	forwards.push(proc);
	await until(async () => (await fetch(`http://127.0.0.1:${local}/healthz`)).ok, `port-forward ${target}`, 30_000);
}

/**
 * Builds the images (unless SKIP_BUILD), brings the cluster up with the scenario image loaded, installs the chart fresh
 * with `valuesFile`, port-forwards the orchestrator and web, and waits for the engine to run.
 */
export async function setUp(valuesFile: string): Promise<void> {
	if (!process.env.SKIP_BUILD) {
		say(`building localhost/agentbot:dev and ${image} on ${connection}`);
		await $`podman --connection ${connection} build -q -t localhost/agentbot:dev ${root}`.quiet();
		await $`podman --connection ${connection} build -q -f ${join(import.meta.dir, "Containerfile")} --ignorefile ${join(import.meta.dir, "Containerfile.containerignore")} -t ${image} ${root}`.quiet();
	}
	say("cluster up, loading the scenario image");
	await $`${kindSh} up ${image}`;

	say(`fresh install: release ${release} in namespace ${ns}`);
	await $`kubectl --context ${ctx} delete namespace ${ns} --ignore-not-found --wait=true`.quiet();
	const [repository, tag] = [image.slice(0, image.lastIndexOf(":")), image.slice(image.lastIndexOf(":") + 1)];
	await $`${helm} --kube-context ${ctx} install ${release} ${join(root, "deploy", "helm", "agentbot")} -n ${ns} --create-namespace -f ${valuesFile} --set image.repository=${repository} --set image.tag=${tag} --wait --timeout 5m`;
	webToken = Buffer.from((await kubectl("get", "secret", full, "-o", "jsonpath={.data.web-api-token}").text()).trim(), "base64").toString();

	// Port-forwards die when their pod goes; both pods stay for the whole run.
	await portForward(`deploy/${full}-orchestrator`, ORCH_PORT, 8081);
	await portForward(`deploy/${full}-web`, WEB_PORT, 8080);
	await until(async () => (await state()).phase === "running", "the engine to run", 60_000);
}

/** Stops the pod sampler and the port-forwards; uninstalls the release unless KEEP. */
export async function tearDown(): Promise<void> {
	sampling = false;
	await sampler;
	for (const f of forwards) f.kill();
	if (!process.env.KEEP) {
		say(`uninstalling; deleting namespace ${ns}`);
		await $`${helm} --kube-context ${ctx} uninstall ${release} -n ${ns} --wait`.quiet().nothrow();
		await $`kubectl --context ${ctx} delete namespace ${ns} --wait=true`.quiet().nothrow();
	}
}

// ---- the scenario orchestrator's control API ------------------------------------------------------------------------

export interface Run {
	id: string;
	kind: string;
	issue: number | null;
	repo: string | null;
	state: string;
	outcome: string | null;
	worker: string | null;
	continues: string | null;
	hasCheckpoint: boolean;
	createdAt: string;
	claimedAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
}
export interface Transition {
	at: string;
	run: string;
	kind: string;
	issue: number | null;
	state: string;
	outcome: string | null;
	worker: string | null;
	continues: string | null;
}
export interface State {
	phase: string;
	pendingRuns: number;
	issues: { repo: string; number: number; state: string; branch: string | null; pr: number | null }[];
	runs: Run[];
	transitions: Transition[];
}
export interface Health {
	status: string;
	phase: string;
	runs: { pending: number; running: number };
	limits: { maxConcurrentJobs: number; maxChatSessions: number; maxConcurrentRuns: number; workerCapacity: number; effectiveConcurrency: number } | null;
	warnings: string[];
}

/** A control API request; GETs are retried twice on a dropped connection (kubectl port-forward drops one now and then). */
export async function control<T>(path: string, body?: object): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(`http://127.0.0.1:${ORCH_PORT}/internal/admin/e2e/${path}`, {
				method: body ? "POST" : "GET",
				headers: { authorization: `Bearer ${webToken}`, "content-type": "application/json" },
				...(body ? { body: JSON.stringify(body) } : {}),
			});
		} catch (err) {
			if (!body && attempt < 3) continue;
			fail(`control ${path}: ${(err as Error).message}`);
		}
		if (!res.ok) fail(`control ${path}: ${res.status} ${await res.text()}`);
		return (await res.json()) as T;
	}
}
/** GET on the orchestrator's admin API (`/internal/admin/<path>`) with the web token. */
export async function adminGet<T>(path: string): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${ORCH_PORT}/internal/admin/${path}`, { headers: { authorization: `Bearer ${webToken}` } });
	if (!res.ok) fail(`admin ${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}
export const state = () => control<State>("state");
export const health = async () => (await (await fetch(`http://127.0.0.1:${ORCH_PORT}/readyz`)).json()) as Health;
export const webHealth = async () =>
	(await (await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`)).json()) as { status: string; orchestrator: { reachable: boolean; phase: string; limits: Health["limits"] } };

export function printTransitions(all: Transition[], filter: (t: Transition) => boolean): void {
	for (const t of all.filter(filter))
		console.log(`    ${t.at.slice(11, 19)} run ${t.run.slice(0, 8)} ${t.kind.padEnd(9)} #${t.issue ?? "-"} ${t.state}${t.outcome ? `/${t.outcome}` : ""} worker=${t.worker ?? "-"}${t.continues ? ` continues=${t.continues.slice(0, 8)}` : ""}`);
}

/** The last 80 lines of the orchestrator's log, for a failure report. */
export async function orchestratorLogTail(): Promise<string> {
	const logs = await kubectl("logs", `deploy/${full}-orchestrator`, "--tail", "80").nothrow();
	return `${logs.stdout}${logs.stderr}`;
}

// ---- worker pod sampler ---------------------------------------------------------------------------------------------

export interface Pods {
	at: number;
	/** Phase Running, not being deleted. */
	running: string[];
	/** Every worker pod still in the API (Pending, Running, Completed, terminating). */
	all: string[];
	/** Running and Ready: the worker has claimed a run (readiness `agentbot health --claimed`). */
	ready: string[];
}
/** The fields of kubectl's pod JSON the drivers read. */
export interface PodJson {
	metadata: { name: string; creationTimestamp: string; deletionTimestamp?: string };
	spec: { nodeName?: string };
	status: {
		phase: string;
		conditions?: { type: string; status: string; lastTransitionTime?: string }[];
		containerStatuses?: { state: { running?: { startedAt: string }; terminated?: { startedAt: string; finishedAt: string; exitCode: number } } }[];
	};
}
/** The latest sample; a live binding, refreshed about every second once `startPodSampler` ran. */
export let pods: Pods = { at: 0, running: [], all: [], ready: [] };
/** Every worker pod seen so far, with its latest JSON. */
export const seenPods = new Map<string, PodJson>();
let lastLine = "";
let sampling = false;
let sampler: Promise<void> | undefined;

export function startPodSampler(): void {
	sampling = true;
	sampler = (async () => {
		while (sampling) {
			try {
				const { items }: { items: PodJson[] } = await kubectl("get", "pods", "-l", workerSelector, "-o", "json").json();
				const live = items.filter(p => p.status.phase === "Running" && !p.metadata.deletionTimestamp);
				pods = {
					at: Date.now(),
					running: live.map(p => p.metadata.name),
					all: items.map(p => p.metadata.name),
					ready: live.filter(p => p.status.conditions?.some(c => c.type === "Ready" && c.status === "True")).map(p => p.metadata.name),
				};
				for (const p of items) seenPods.set(p.metadata.name, p);
				const phases = new Map<string, number>();
				for (const p of items) {
					const key = p.metadata.deletionTimestamp ? "Terminating" : p.status.phase;
					phases.set(key, (phases.get(key) ?? 0) + 1);
				}
				const line = `worker pods: ${items.length} [${[...phases].map(([k, v]) => `${k}=${v}`).join(" ") || "none"}] ready=${pods.ready.length}`;
				if (line !== lastLine) say(line);
				lastLine = line;
			} catch (err) {
				say(`pod sample failed: ${(err as Error).message}`);
			}
			await Bun.sleep(1000);
		}
	})();
}
export const freshPods = (since: number) => until(async () => pods.at > since && pods, "a fresh pod sample", 30_000);
