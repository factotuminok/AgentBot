// The REAL in-place omp update path (architecture UPD-06, UPD-07) outside the tests' injected installer, with network:
// `imageInstaller` copies this app's `src/`, `package.json` and `bun.lock`, pins omp to a newer version, runs
// `bun install --omit=dev` and smoke-loads the worker modules; the copy is packed, unpacked like a worker does, and the
// agent host is spawned from it and driven until it relays `registered` (the canary, UPD-08), then aborted.
//
//   bun test/e2e/omp-update/real-install.ts [version]     default: npm's latest omp
//
// In the image (rootless podman, `localhost/agentbot:dev` built with `--build-arg AGENTBOT_OMP=pin`):
//   podman run --rm --entrypoint bun -v ./test:/app/test:ro localhost/agentbot:dev /app/test/e2e/omp-update/real-install.ts
//
// Prints one JSON summary line (versions, timings, archive size) and exits 0 when the host from the copy registered.
import type { Subprocess } from "bun";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestVersion } from "../../../scripts/omp-latest";
import { imageInstaller, openOmpRuntimes } from "../../../src/orchestrator/omp/runtime";
import { REGISTRY_URL } from "../../../src/orchestrator/omp/updates";
import { emptyOmpConfig } from "../../../src/shared/ompconfig";
import { installedOmpVersion } from "../../../src/shared/ompPins";
import { sha256File, unpackRuntime } from "../../../src/shared/ompRuntime";
import type { ChildMessage, ParentMessage } from "../../../src/shared/protocol";
import { APP_ROOT, appIdentity } from "../../../src/shared/version";
import { OMP_RUNTIME_HOST_ENTRY } from "../../../src/shared/wire";

const HOST_TIMEOUT_MS = 120_000;

function fail(message: string, detail?: string): never {
	process.stderr.write(`real-install: ${message}\n${detail ? `${detail}\n` : ""}`);
	process.exit(1);
}

async function duSize(path: string): Promise<number> {
	const out = Bun.spawnSync(["du", "-sk", path]).stdout.toString();
	return Number(out.split(/\s+/)[0]) * 1024;
}

const image = installedOmpVersion(APP_ROOT);
const latest = latestVersion(await (await fetch(REGISTRY_URL)).text());
const version = process.argv[2] ?? latest ?? fail("the npm registry returned no usable latest version");
if (Bun.semver.order(version, image) <= 0) fail(`omp ${version} is not newer than this app's omp ${image}`);
const work = await mkdtemp(join(tmpdir(), "agentbot-real-install-"));
const summary: Record<string, unknown> = { image, latest, version, work };
try {
	// Orchestrator side: install, check, pack, activate (UPD-06).
	const runtimes = openOmpRuntimes({ dir: join(work, "omp-runtime"), identity: await appIdentity(), assignedRuns: () => [] });
	const installStarted = Date.now();
	const made = await runtimes.create({ version, by: "real-install", installer: imageInstaller({ imageAppDir: APP_ROOT }) });
	runtimes.close();
	if (!made.ok) fail(`install of omp ${version} failed: ${made.error}`, made.output.slice(-4000));
	Object.assign(summary, { installMs: Date.now() - installStarted, copy: made.copy.copy, archiveBytes: made.copy.size, sha256: made.copy.sha256 });

	// Worker side: download (here a copy), check the hash, unpack (UPD-07).
	const root = join(work, "worker");
	const archive = join(root, "omp-runtime.tar.gz");
	await mkdir(root, { recursive: true });
	await Bun.write(archive, Bun.file(join(runtimes.dir, made.copy.copy, "runtime.tar.gz")));
	if ((await sha256File(archive)) !== made.copy.sha256) fail("the archive's hash does not match");
	const unpackStarted = Date.now();
	const copyDir = join(root, "omp-runtime");
	await unpackRuntime(archive, copyDir);
	Object.assign(summary, { unpackMs: Date.now() - unpackStarted, unpackedBytes: await duSize(copyDir), copyOmp: installedOmpVersion(copyDir) });
	const resolved = Bun.spawnSync([process.execPath, "-e", 'console.log(Bun.resolveSync("@oh-my-pi/pi-coding-agent", process.cwd()))'], { cwd: copyDir }).stdout.toString().trim();
	summary.resolvedFromCopy = realpathSync(resolved).startsWith(realpathSync(copyDir));

	// The agent host from the copy, as the worker spawns it, run until it registers (the canary), then aborted.
	const dirs = { home: join(root, "home"), auth: join(root, "auth"), tmp: join(root, "tmp"), sessions: join(root, "sessions"), omp: join(root, "omp"), cwd: join(root, "work") };
	for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
	const events: string[] = [];
	const ended = Promise.withResolvers<ChildMessage | undefined>();
	let proc: Subprocess | undefined;
	const send = (msg: ParentMessage) => proc?.send(msg);
	const hostStarted = Date.now();
	proc = Bun.spawn({
		cmd: [process.execPath, join(copyDir, OMP_RUNTIME_HOST_ENTRY)],
		cwd: root,
		env: { ...process.env, HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.auth, TMPDIR: dirs.tmp },
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		serialization: "json",
		ipc: raw => {
			const msg = raw as ChildMessage;
			if (msg.t !== "transcript" && msg.t !== "log") events.push(msg.t);
			if (msg.t === "session_file") send({ t: "reply", id: msg.id, ok: true });
			if (msg.t === "registered") {
				summary.registeredMs = Date.now() - hostStarted;
				send({ t: "abort", id: 1, reason: "user" });
			}
			if (msg.t === "done" || msg.t === "failed") ended.resolve(msg);
		},
		onExit: () => ended.resolve(undefined),
	});
	send({
		t: "start",
		// An invalid key: the session is created and registers; the model call after it fails or is aborted.
		runtime: { agentDir: dirs.auth, ompDir: dirs.omp, providerKeys: { anthropic: "sk-ant-invalid-real-install" } },
		opts: {
			runId: "real-install",
			cwd: dirs.cwd,
			sessionDir: dirs.sessions,
			profile: "plan",
			modelPattern: "anthropic/claude-sonnet-4-5",
			thinking: "off",
			prompt: "Say hello.",
			limits: { minutes: 1, costUsd: 0.01 },
			omp: emptyOmpConfig(),
			wantLoadout: false,
		},
	});
	const timer = setTimeout(() => ended.resolve(undefined), HOST_TIMEOUT_MS);
	const end = await ended.promise;
	clearTimeout(timer);
	proc.kill("SIGKILL");
	Object.assign(summary, { hostEvents: [...new Set(events)], hostEnd: end ? (end.t === "failed" ? `failed: ${end.message}` : "done") : "exited or timed out" });
	process.stdout.write(`${JSON.stringify(summary)}\n`);
	if (!events.includes("registered")) fail("the agent host from the copy did not register");
} finally {
	await rm(work, { recursive: true, force: true });
}
