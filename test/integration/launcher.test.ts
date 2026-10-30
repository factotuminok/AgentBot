import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, type LauncherOptions, workersToStart } from "../../src/launcher/main";
import { type ContainerSummary, PodmanClient, type WorkerContainerSpec } from "../../src/launcher/podman";
import { LAUNCHER_STALE_MS, type LauncherStatus, runLauncherHealth, writeLauncherStatus } from "../../src/launcher/status";

const SCALE_TOKEN = "scale-token-for-tests";
const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-launcher-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

interface FakeContainer {
	Id: string;
	Names: string[];
	State: string;
	Labels: Record<string, string>;
	Created: string;
}

interface FakePodman {
	socket: string;
	containers: FakeContainer[];
	creates: WorkerContainerSpec[];
	requests: string[];
	/** Reply to `GET /info`. */
	info: { status: number; body: unknown };
	/** Serve list results without applying the filters, to exercise the client-side label check. */
	ignoreFilters: boolean;
	startStatus: number;
}

function container(id: string, state: string, labels: Record<string, string>, ageMs = 0): FakeContainer {
	return { Id: `${id}${"0".repeat(64 - id.length)}`, Names: [id], State: state, Labels: labels, Created: new Date(Date.now() - ageMs).toISOString() };
}

const WORKER = { "agentbot.role": "worker" };
const rootlessInfo = (rootless: boolean) => ({ status: 200, body: { host: { security: { rootless }, cgroupVersion: "v2" }, version: { Version: "6.1.4" } } });

/** A libpod API on a unix socket, with the routes and replies the launcher uses (spike S6). */
function fakePodman(): FakePodman {
	const socket = join(tempDir(), "podman.sock");
	const fake: FakePodman = { socket, containers: [], creates: [], requests: [], info: rootlessInfo(true), ignoreFilters: false, startStatus: 204 };
	let next = 0;
	const server = Bun.serve({
		unix: socket,
		async fetch(req) {
			const url = new URL(req.url);
			fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
			const path = url.pathname.replace(/^\/v5\.0\.0\/libpod/, "");
			if (path === url.pathname) return new Response("page not found", { status: 404 });
			if (req.method === "GET" && path === "/info") return Response.json(fake.info.body, { status: fake.info.status });
			if (req.method === "GET" && path === "/containers/json") {
				const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[]; status?: string[] };
				const list = fake.ignoreFilters
					? fake.containers
					: fake.containers.filter(
							c => (filters.status ?? []).includes(c.State) && (filters.label ?? []).every(l => c.Labels[l.split("=")[0]!] === l.split("=")[1]),
						);
				return Response.json(list);
			}
			if (req.method === "POST" && path === "/containers/create") {
				const spec = (await req.json()) as WorkerContainerSpec;
				fake.creates.push(spec);
				const created = container(`c${++next}`, "created", spec.labels);
				created.Names = [spec.name];
				fake.containers.push(created);
				return Response.json({ Id: created.Id, Warnings: [] }, { status: 201 });
			}
			const start = /^\/containers\/([^/]+)\/start$/.exec(path);
			if (req.method === "POST" && start) {
				const found = fake.containers.find(c => c.Id === start[1]);
				if (!found) return Response.json({ message: "no such container" }, { status: 404 });
				if (fake.startStatus !== 204) return Response.json({ message: "start failed" }, { status: fake.startStatus });
				found.State = "running";
				return new Response(null, { status: 204 });
			}
			const remove = /^\/containers\/([^/]+)$/.exec(path);
			if (req.method === "DELETE" && remove) {
				const index = fake.containers.findIndex(c => c.Id === remove[1]);
				if (index < 0) return Response.json({ message: "no such container" }, { status: 404 });
				fake.containers.splice(index, 1);
				return Response.json([{ Id: remove[1] }]);
			}
			return Response.json({ message: "not found" }, { status: 404 });
		},
	});
	cleanups.push(() => server.stop(true));
	return fake;
}

interface FakeOrchestrator {
	url: string;
	pendingRuns: number;
	auth: (string | null)[];
}

function fakeOrchestrator(): FakeOrchestrator {
	const orch: FakeOrchestrator = { url: "", pendingRuns: 0, auth: [] };
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			if (new URL(req.url).pathname !== "/internal/scale") return new Response("not found", { status: 404 });
			orch.auth.push(req.headers.get("authorization"));
			if (req.headers.get("authorization") !== `Bearer ${SCALE_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
			return Response.json({ pendingRuns: orch.pendingRuns });
		},
	});
	orch.url = `http://127.0.0.1:${server.port}`;
	cleanups.push(() => server.stop(true));
	return orch;
}

const WORKER_SETTINGS = {
	image: "ghcr.io/example/agentbot:1.2.3",
	network: "agentbot",
	secret: "agentbot_worker_token",
	memoryBytes: 4 * 1024 ** 3,
	cpus: 2,
	diskBytes: 20 * 1024 ** 3,
	claimTimeoutMs: 15_000,
	orchestratorUrl: "http://orchestrator:8081",
};

function launcher(podman: FakePodman, orchestratorUrl: string, overrides: Partial<LauncherOptions> = {}): { launcher: Launcher; statusPath: string } {
	const statusPath = join(tempDir(), "status.json");
	const instance = new Launcher({
		podman: new PodmanClient(podman.socket),
		orchestratorUrl,
		scaleToken: SCALE_TOKEN,
		capacity: 4,
		allowRootful: false,
		worker: WORKER_SETTINGS,
		version: "1.2.3",
		statusPath,
		...overrides,
	});
	cleanups.push(() => instance.stop());
	return { launcher: instance, statusPath };
}

describe("rootless check (LCH-01)", () => {
	test("accepts a rootless Podman socket", async () => {
		const podman = fakePodman();
		expect(await launcher(podman, "http://127.0.0.1:1").launcher.checkEngine()).toBe(true);
		expect(podman.requests[0]).toBe("GET /v5.0.0/libpod/info");
	});

	test("refuses a rootful socket unless overridden", async () => {
		const podman = fakePodman();
		podman.info = rootlessInfo(false);
		expect(await launcher(podman, "http://127.0.0.1:1").launcher.checkEngine()).toBe(false);
		expect(await launcher(podman, "http://127.0.0.1:1", { allowRootful: true }).launcher.checkEngine()).toBe(true);
	});

	test("refuses replies that are not libpod's, even with the override", async () => {
		const podman = fakePodman();
		for (const info of [
			{ status: 404, body: { message: "page not found" } },
			{ status: 500, body: { cause: "boom" } },
			{ status: 200, body: { host: { security: {} } } },
			{ status: 200, body: { ServerVersion: "27.0.0" } },
		]) {
			podman.info = info;
			expect(await launcher(podman, "http://127.0.0.1:1", { allowRootful: true }).launcher.checkEngine()).toBe(false);
		}
	});

	test("refuses a docker-like socket without /libpod routes", async () => {
		const socket = join(tempDir(), "docker.sock");
		const docker = Bun.serve({ unix: socket, fetch: req => (new URL(req.url).pathname === "/info" ? Response.json({ ServerVersion: "27" }) : new Response("page not found", { status: 404 })) });
		cleanups.push(() => docker.stop(true));
		const instance = new Launcher({
			podman: new PodmanClient(socket),
			orchestratorUrl: "http://127.0.0.1:1",
			scaleToken: SCALE_TOKEN,
			capacity: 4,
			allowRootful: true,
			worker: WORKER_SETTINGS,
			version: "1.2.3",
			statusPath: join(tempDir(), "status.json"),
		});
		expect(await instance.checkEngine()).toBe(false);
	});

	test("refuses a socket that cannot be reached", async () => {
		const podman = fakePodman();
		podman.socket = join(tempDir(), "missing.sock");
		expect(await launcher(podman, "http://127.0.0.1:1", { allowRootful: true }).launcher.start()).toBe(false);
	});
});

describe("scaling (LCH-02)", () => {
	const now = Date.now();
	const active = (fresh: number, claimed: number): ContainerSummary[] => [
		...Array.from({ length: fresh }, (_, i) => container(`f${i}`, "running", WORKER, 1_000)),
		...Array.from({ length: claimed }, (_, i) => container(`o${i}`, "running", WORKER, 60_000)),
	];

	test("min(pendingRuns, capacity) - active while every worker may still be claiming", () => {
		expect(workersToStart(3, active(0, 0), 4, 25_000, now)).toBe(3);
		expect(workersToStart(10, active(0, 0), 4, 25_000, now)).toBe(4);
		expect(workersToStart(10, active(1, 0), 4, 25_000, now)).toBe(3);
		expect(workersToStart(2, active(2, 0), 4, 25_000, now)).toBe(0);
		expect(workersToStart(0, active(0, 0), 4, 25_000, now)).toBe(0);
		expect(workersToStart(1, active(4, 0), 4, 25_000, now)).toBe(0);
	});

	test("workers past the claim window hold claimed runs, which pendingRuns no longer counts", () => {
		expect(workersToStart(2, active(0, 2), 4, 25_000, now)).toBe(2);
		expect(workersToStart(5, active(0, 2), 4, 25_000, now)).toBe(2);
		expect(workersToStart(2, active(1, 2), 4, 25_000, now)).toBe(1);
		expect(workersToStart(3, active(0, 4), 4, 25_000, now)).toBe(0);
	});

	test("a tick starts min(pendingRuns, capacity) - active workers with the scale token", async () => {
		const podman = fakePodman();
		const orch = fakeOrchestrator();
		podman.containers.push(container("busy", "running", WORKER, 1_000), container("other", "running", { "agentbot.role": "web" }));
		orch.pendingRuns = 9;
		const { launcher: instance } = launcher(podman, orch.url, { capacity: 3 });
		await instance.tick();
		expect(orch.auth).toEqual([`Bearer ${SCALE_TOKEN}`]);
		expect(podman.creates).toHaveLength(2);
		expect(podman.containers.filter(c => c.Labels["agentbot.role"] === "worker" && c.State === "running")).toHaveLength(3);
		const list = podman.requests.find(r => r.startsWith("GET /v5.0.0/libpod/containers/json"))!;
		expect(JSON.parse(new URL(`http://d${list.slice(4)}`).searchParams.get("filters")!)).toEqual({
			label: ["agentbot.role=worker"],
			status: ["created", "running", "paused", "stopping"],
		});
		// At capacity: nothing more, whatever is pending.
		await instance.tick();
		expect(podman.creates).toHaveLength(2);
	});

	test("creates each worker with the S6 spec", async () => {
		const podman = fakePodman();
		const orch = fakeOrchestrator();
		orch.pendingRuns = 1;
		await launcher(podman, orch.url).launcher.tick();
		expect(podman.creates).toHaveLength(1);
		const spec = podman.creates[0]!;
		expect(spec.name).toMatch(/^agentbot-worker-[0-9a-f]{8}$/);
		expect(spec).toEqual({
			name: spec.name,
			hostname: spec.name,
			image: "ghcr.io/example/agentbot:1.2.3",
			entrypoint: ["agentbot"],
			command: ["worker"],
			user: "10001:10001",
			labels: { "agentbot.role": "worker" },
			remove: true,
			init: true,
			netns: { nsmode: "bridge" },
			Networks: { agentbot: {} },
			portmappings: [],
			publish_image_ports: false,
			env: {
				AGENTBOT_ORCHESTRATOR_URL: "http://orchestrator:8081",
				AGENTBOT_WORKER_TOKEN_FILE: "/run/secrets/worker_token",
				AGENTBOT_WORKER_DISK: String(20 * 1024 ** 3),
				AGENTBOT_WORKER_CLAIM_TIMEOUT: "15000ms",
			},
			resource_limits: {
				memory: { limit: 4 * 1024 ** 3, swap: 4 * 1024 ** 3 },
				cpu: { quota: 200_000, period: 100_000 },
				pids: { limit: 4096 },
			},
			// F7: no privilege gain through setuid binaries, no capabilities.
			no_new_privileges: true,
			cap_drop: ["all"],
			// OBS-01: `agentbot health` every 30 s, timeout 5 s, start period 30 s, 3 retries (nanoseconds).
			healthconfig: { Test: ["CMD", "agentbot", "health"], Interval: 30e9, Timeout: 5e9, StartPeriod: 30e9, Retries: 3 },
			mounts: [{ destination: "/run/agentbot", type: "tmpfs", source: "tmpfs", options: ["rw", "nosuid", "nodev", "size=256m", "mode=0700", "U"] }],
			secrets: [{ source: "agentbot_worker_token", target: "worker_token", uid: 10001, gid: 10001, mode: 256 }],
		});
	});

	test("AGENTBOT_WORKER_CPUS becomes the CPU quota per 100 ms period (F7)", async () => {
		const podman = fakePodman();
		const orch = fakeOrchestrator();
		orch.pendingRuns = 1;
		await launcher(podman, orch.url, { worker: { ...WORKER_SETTINGS, cpus: 1.5 } }).launcher.tick();
		expect(podman.creates[0]?.resource_limits.cpu).toEqual({ quota: 150_000, period: 100_000 });
	});

	test("a worker that fails to start is removed so it does not hold capacity", async () => {
		const podman = fakePodman();
		const orch = fakeOrchestrator();
		orch.pendingRuns = 2;
		podman.startStatus = 500;
		await launcher(podman, orch.url).launcher.tick();
		expect(podman.creates).toHaveLength(1);
		expect(podman.containers).toHaveLength(0);
	});

	test("tolerates an unreachable or refusing orchestrator and recovers", async () => {
		const podman = fakePodman();
		const { launcher: down } = launcher(podman, "http://127.0.0.1:1");
		await down.tick();
		await down.tick();
		expect(podman.creates).toHaveLength(0);

		const orch = fakeOrchestrator();
		orch.pendingRuns = 1;
		const { launcher: wrongToken } = launcher(podman, orch.url, { scaleToken: "wrong" });
		await wrongToken.tick();
		expect(podman.creates).toHaveLength(0);

		const { launcher: up } = launcher(podman, orch.url);
		await up.tick();
		expect(podman.creates).toHaveLength(1);
	});

	test("the loop ticks until stopped and leaves workers running", async () => {
		const podman = fakePodman();
		const orch = fakeOrchestrator();
		orch.pendingRuns = 2;
		const { launcher: instance } = launcher(podman, orch.url, { tickMs: 20 });
		expect(await instance.start()).toBe(true);
		const deadline = Date.now() + 5_000;
		while (podman.creates.length < 2 && Date.now() < deadline) await Bun.sleep(10);
		await instance.stop();
		expect(podman.creates).toHaveLength(2);
		expect(podman.containers.filter(c => c.State === "running")).toHaveLength(2);
		expect(podman.requests.some(r => r.startsWith("DELETE"))).toBe(false);
	});
});

describe("reaper (LCH-03)", () => {
	test("removes only finished containers labelled agentbot.role=worker", async () => {
		const podman = fakePodman();
		podman.containers.push(
			container("exited", "exited", WORKER),
			container("stopped", "stopped", WORKER),
			container("running", "running", WORKER),
			container("created", "created", WORKER),
			container("web", "exited", { "agentbot.role": "web" }),
			container("plain", "exited", {}),
		);
		const { launcher: instance } = launcher(podman, "http://127.0.0.1:1");
		await instance.reap();
		expect(podman.containers.map(c => c.Names[0])).toEqual(["running", "created", "web", "plain"]);
		const list = podman.requests.find(r => r.startsWith("GET /v5.0.0/libpod/containers/json"))!;
		expect(JSON.parse(new URL(`http://d${list.slice(4)}`).searchParams.get("filters")!)).toEqual({ label: ["agentbot.role=worker"], status: ["exited", "stopped"] });
		expect(podman.requests.filter(r => r.startsWith("DELETE"))).toEqual([
			`DELETE /v5.0.0/libpod/containers/${"exited".padEnd(64, "0")}?force=false&v=true`,
			`DELETE /v5.0.0/libpod/containers/${"stopped".padEnd(64, "0")}?force=false&v=true`,
		]);
	});

	test("checks the label itself even when the engine ignores the filter", async () => {
		const podman = fakePodman();
		podman.ignoreFilters = true;
		podman.containers.push(container("web", "exited", { "agentbot.role": "web" }), container("plain", "exited", {}), container("worker", "exited", WORKER));
		await launcher(podman, "http://127.0.0.1:1").launcher.reap();
		expect(podman.containers.map(c => c.Names[0])).toEqual(["web", "plain"]);
	});

	test("start reaps before the first tick", async () => {
		const podman = fakePodman();
		podman.containers.push(container("old", "exited", WORKER));
		const { launcher: instance } = launcher(podman, "http://127.0.0.1:1", { tickMs: 60_000 });
		expect(await instance.start()).toBe(true);
		expect(podman.containers).toHaveLength(0);
	});
});

describe("agentbot health (launcher)", () => {
	const status = (socketOkAt: Date): LauncherStatus => ({ version: "1.2.3", rootless: true, workers: 2, capacity: 4, socketOkAt: socketOkAt.toISOString() });

	test("exit 0 while the socket was reached recently, 1 when stale or absent", () => {
		const path = join(tempDir(), "agentbot-launcher", "status.json");
		const lines: string[] = [];
		expect(runLauncherHealth(path, Date.now(), line => lines.push(line))).toBe(1);
		writeLauncherStatus(path, status(new Date()));
		expect(runLauncherHealth(path, Date.now(), line => lines.push(line))).toBe(0);
		expect(runLauncherHealth(path, Date.now() + LAUNCHER_STALE_MS + 1_000, line => lines.push(line))).toBe(1);
		expect(lines.map(line => JSON.parse(line))).toEqual([
			{ status: "down" },
			{ status: "ok", version: "1.2.3", rootless: true, workers: 2, capacity: 4 },
			{ status: "stale", version: "1.2.3", rootless: true, workers: 2, capacity: 4 },
		]);
	});

	test("ticks keep the status file fresh with the worker count", async () => {
		const podman = fakePodman();
		podman.containers.push(container("busy", "running", WORKER, 60_000));
		const { launcher: instance, statusPath } = launcher(podman, "http://127.0.0.1:1");
		expect(await instance.start()).toBe(true);
		await instance.tick();
		const lines: string[] = [];
		expect(runLauncherHealth(statusPath, Date.now(), line => lines.push(line))).toBe(0);
		expect(JSON.parse(lines[0]!)).toEqual({ status: "ok", version: "1.2.3", rootless: true, workers: 1, capacity: 4 });
	});

	function cli(args: string[], env: Record<string, string>): { exitCode: number; stdout: string } {
		const proc = Bun.spawnSync(["bun", CLI, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
		return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
	}

	test("the CLI reports the launcher in a launcher container and the worker otherwise", () => {
		const tmp = tempDir();
		expect(cli(["health"], { TMPDIR: tmp, AGENTBOT_WORKER_RUN_DIR: join(tmp, "run") })).toEqual({ exitCode: 1, stdout: `${JSON.stringify({ status: "down" })}\n` });
		writeLauncherStatus(join(tmp, "agentbot-launcher", "status.json"), status(new Date()));
		const ok = cli(["health"], { TMPDIR: tmp });
		expect(ok.exitCode).toBe(0);
		expect(JSON.parse(ok.stdout)).toEqual({ status: "ok", version: "1.2.3", rootless: true, workers: 2, capacity: 4 });
		const other = tempDir();
		expect(cli(["health"], { TMPDIR: other, AGENTBOT_ROLE: "launcher" }).exitCode).toBe(1);
	});
});

describe("agentbot launcher", () => {
	function launcherEnv(socket: string, extra: Record<string, string> = {}): Record<string, string> {
		const dir = tempDir();
		const tokenFile = join(dir, "scale_token");
		writeFileSync(tokenFile, `${SCALE_TOKEN}\n`);
		return {
			PATH: process.env.PATH ?? "",
			TMPDIR: dir,
			AGENTBOT_PODMAN_SOCKET: socket,
			AGENTBOT_SCALE_TOKEN_FILE: tokenFile,
			AGENTBOT_WORKER_NETWORK: "agentbot",
			AGENTBOT_IMAGE: "ghcr.io/example/agentbot:1.2.3",
			AGENTBOT_ORCHESTRATOR_URL: "http://127.0.0.1:1",
			...extra,
		};
	}

	test("exits 2 on a rootful socket", async () => {
		const podman = fakePodman();
		podman.info = rootlessInfo(false);
		const proc = Bun.spawn(["bun", CLI, "launcher"], { env: launcherEnv(podman.socket), stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(2);
		expect(await new Response(proc.stdout).text()).toContain("refusing to start: the Podman socket is rootful (LCH-01)");
	});

	test("with the override it warns, runs, and stops on SIGTERM with exit 0", async () => {
		const podman = fakePodman();
		podman.info = rootlessInfo(false);
		const proc = Bun.spawn(["bun", CLI, "launcher"], { env: launcherEnv(podman.socket, { AGENTBOT_LAUNCHER_ALLOW_ROOTFUL: "1" }), stdout: "pipe", stderr: "pipe" });
		const deadline = Date.now() + 10_000;
		while (!podman.requests.some(r => r.startsWith("GET /v5.0.0/libpod/containers/json")) && Date.now() < deadline) await Bun.sleep(20);
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(0);
		const out = await new Response(proc.stdout).text();
		expect(out).toContain('"level":"warn","msg":"the Podman socket is rootful and AGENTBOT_LAUNCHER_ALLOW_ROOTFUL is set');
		expect(out).toContain("launcher stopping; running workers finish their runs");
	});

	test("fails without the worker network", async () => {
		const podman = fakePodman();
		const env = launcherEnv(podman.socket);
		delete env.AGENTBOT_WORKER_NETWORK;
		const proc = Bun.spawn(["bun", CLI, "launcher"], { env, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(1);
		expect(await new Response(proc.stdout).text()).toContain("AGENTBOT_WORKER_NETWORK must be set");
	});
});
