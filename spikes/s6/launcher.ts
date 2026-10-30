// Spike S6: launcher talking to the rootless Podman libpod REST API over a unix socket.
// Not production code. Phase 8 ports the API calls into src/launcher.

const SOCKET = process.env.AGENTBOT_PODMAN_SOCKET ?? "/run/podman/podman.sock";
const API = "http://d/v5.0.0/libpod";
const ORCH = process.env.AGENTBOT_ORCHESTRATOR_URL ?? "http://agentbot-spike-s6-stub:8081";
const NETWORK = process.env.AGENTBOT_WORKER_NETWORK ?? "agentbot-spike-s6-net";
const IMAGE = process.env.AGENTBOT_WORKER_IMAGE ?? "localhost/agentbot-spike-s6:latest";
const CAPACITY = Number(process.env.AGENTBOT_WORKER_CAPACITY ?? "4");
const MEMORY = Number(process.env.AGENTBOT_WORKER_MEMORY ?? String(256 * 1024 * 1024));
const SECRET = process.env.AGENTBOT_WORKER_SECRET ?? "agentbot_spike_s6_worker_token";
const SCRATCH = process.env.SPIKE_SCRATCH ?? "none"; // none | storage-opt | tmpfs
const SCRATCH_SIZE = process.env.SPIKE_SCRATCH_SIZE ?? "512m";
const DURATION_MS = Number(process.env.SPIKE_DURATION_MS ?? "20000");
const ROLE_LABEL = "agentbot.role";
const ROLE = "worker";

function log(msg: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), component: "launcher", msg, ...fields }));
}

interface ApiResult<T> {
	status: number;
	json: T;
	text: string;
}

// Only the libpod fields this spike reads.
interface LibpodInfo {
	host: { security: { rootless: boolean }; cgroupVersion: string; cgroupControllers: string[]; idMappings: unknown };
	store: { graphDriverName: string; graphStatus?: Record<string, string> };
	version: { Version: string; APIVersion: string };
}
interface ContainerSummary {
	Id: string;
	Names?: string[];
	State: string;
	Labels?: Record<string, string>;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
	const init = {
		method,
		unix: SOCKET,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	};
	const res = await fetch(`${API}${path}`, init);
	const text = await res.text();
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	// Spike: trust the engine's response shape; phase 8 validates with zod.
	return { status: res.status, json: json as T, text };
}

const readScaleToken = async () => (await Bun.file("/run/secrets/scale_token").text()).trim();

async function checkRootless(): Promise<void> {
	const info = await api<LibpodInfo>("GET", "/info");
	if (info.status !== 200) throw new Error(`GET /info -> ${info.status} ${info.text}`);
	const rootless = info.json.host.security.rootless === true;
	log("engine", {
		rootless,
		version: info.json.version.Version,
		apiVersion: info.json.version.APIVersion,
		cgroupVersion: info.json.host.cgroupVersion,
		cgroupControllers: info.json.host.cgroupControllers,
		graphDriver: info.json.store.graphDriverName,
		backingFs: info.json.store.graphStatus?.["Backing Filesystem"],
		idMappings: info.json.host.idMappings,
	});
	if (!rootless) {
		if (process.env.AGENTBOT_LAUNCHER_ALLOW_ROOTFUL === "1") {
			log("WARNING rootful socket accepted because AGENTBOT_LAUNCHER_ALLOW_ROOTFUL=1");
		} else {
			log("refusing: Podman socket is rootful (LCH-01)");
			process.exit(2);
		}
	}
}

async function listWorkers(status: string[]): Promise<ContainerSummary[]> {
	const filters = encodeURIComponent(JSON.stringify({ label: [`${ROLE_LABEL}=${ROLE}`], status }));
	const r = await api<ContainerSummary[]>("GET", `/containers/json?all=true&filters=${filters}`);
	if (r.status !== 200) throw new Error(`list -> ${r.status} ${r.text}`);
	// Defence in depth: never act on a container whose label we did not verify ourselves.
	return r.json.filter((c) => c.Labels?.[ROLE_LABEL] === ROLE);
}

async function reap(): Promise<void> {
	for (const c of await listWorkers(["exited", "stopped"])) {
		const r = await api("DELETE", `/containers/${c.Id}?force=false&v=true`);
		log("reaped", { id: c.Id.slice(0, 12), name: c.Names?.[0], state: c.State, status: r.status });
	}
}

// Variants of the size-limited checkout area (STO-06) tried by the spike.
function scratchSpec(): Record<string, unknown> {
	switch (SCRATCH) {
		case "storage-opt":
			return { storage_opts: { size: SCRATCH_SIZE } };
		case "tmpfs":
			return { mounts: [tmpfs("/work", SCRATCH_SIZE)] };
		default:
			return {};
	}
}

function tmpfs(destination: string, size: string): Record<string, unknown> {
	return {
		destination,
		type: "tmpfs",
		source: "tmpfs",
		options: ["rw", "nosuid", "nodev", "noexec", `size=${size}`, "mode=0700", "U"],
	};
}

async function startWorker(): Promise<void> {
	const name = `agentbot-spike-s6-worker-${crypto.randomUUID().slice(0, 8)}`;
	const { mounts: scratchMounts = [], ...scratch } = scratchSpec() as { mounts?: unknown[] };
	const spec = {
		name,
		image: IMAGE,
		command: ["worker.ts"],
		user: "10001:10001",
		labels: { [ROLE_LABEL]: ROLE },
		remove: true,
		netns: { nsmode: "bridge" },
		Networks: { [NETWORK]: {} },
		portmappings: [],
		publish_image_ports: false,
		env: { AGENTBOT_ORCHESTRATOR_URL: ORCH, SPIKE_SCRATCH: SCRATCH },
		resource_limits: { memory: { limit: MEMORY, swap: MEMORY } },
		mounts: [tmpfs("/run/agentbot", "64m"), ...scratchMounts],
		secrets: [{ source: SECRET, target: "worker_token", uid: 10001, gid: 10001, mode: 0o400 }],
		...scratch,
	};
	log("create", { spec });
	const created = await api<{ Id: string; Warnings: string[] }>("POST", "/containers/create", spec);
	if (created.status !== 201) {
		log("create failed", { status: created.status, body: created.text });
		return;
	}
	const started = await api("POST", `/containers/${created.json.Id}/start`);
	log("started", { name, id: created.json.Id.slice(0, 12), createStatus: created.status, startStatus: started.status, warnings: created.json.Warnings, body: started.text || undefined });
}

async function tick(): Promise<void> {
	const res = await fetch(`${ORCH}/internal/scale`, { headers: { authorization: `Bearer ${await readScaleToken()}` } });
	if (!res.ok) {
		log("scale failed", { status: res.status });
		return;
	}
	const { pendingRuns } = (await res.json()) as { pendingRuns: number };
	// Valid libpod list states: created, running, paused, stopping, stopped, exited, removing, unknown.
	const running = (await listWorkers(["created", "running", "paused", "stopping"])).length;
	const toStart = Math.max(0, Math.min(pendingRuns, CAPACITY) - running);
	log("tick", { pendingRuns, running, toStart });
	for (let i = 0; i < toStart; i++) await startWorker();
}

log("start", { socket: SOCKET, uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() });
await checkRootless();
await reap();
const deadline = Date.now() + DURATION_MS;
while (Date.now() < deadline) {
	await tick();
	await Bun.sleep(2000);
}
await reap();
log("done");
