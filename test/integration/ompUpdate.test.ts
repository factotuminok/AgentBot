import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { encodeId } from "../../src/orchestrator/discord/render";
import { STALE_UPDATE } from "../../src/orchestrator/discord/ompUpdate";
import { createWorkerDispatcher, type WorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { createRepos } from "../../src/orchestrator/git/repos";
import type { CopyInstaller } from "../../src/orchestrator/omp/runtime";
import { createOmpUpdater, type OmpUpdater, UNSUPPORTED } from "../../src/orchestrator/omp/updates";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import { openSignins, type Signins } from "../../src/orchestrator/store/signins";
import { openVault } from "../../src/orchestrator/store/vault";
import { parseSettings } from "../../src/shared/config";
import { setLogSink } from "../../src/shared/log";
import { OMP_PACKAGE } from "../../src/shared/ompPins";
import { workerRoot } from "../../src/worker/status";
import { createFakeDiscord, type Emitted, type FakeDiscord, type FakeMessage } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";
import { TEST_IDENTITY } from "../fakes/ompUpdates";

/**
 * Phase 10 exit (implementation.md §4, requirements UPD-02 to UPD-05, architecture UPD-06 to UPD-10): approving an omp
 * update in Discord makes the next worker use the new omp while a running worker keeps the image's; a broken copy falls
 * back within the run and re-offers the update; outside the image updates are refused. The real controller, worker
 * dispatcher, internal API and worker processes (`test/fixtures/worker-process.ts`), fake Discord and GitHub, a fake npm
 * registry, and an injected installer whose tree the real updater checks, packs, serves and the worker unpacks.
 */

const WORKER_TOKEN = "upd-worker-token";
const SCALE_TOKEN = "upd-scale-token";
const WORK = "work-channel";
const ASK = "ask-channel";
const ALICE = "u-alice";
const IMAGE_OMP = "18.12.1";
const NEW_OMP = "99.1.0";
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const FIXTURE_HOST = join(import.meta.dir, "..", "fixtures", "agent-host.ts");
/** The worker fixture announces this omp version for the image's omp. */
const WORKER_IMAGE_OMP = "test";
const BROKEN_STDERR = "SyntaxError: Export named 'createAgentSession' not found in module";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Polls for a state reached by other OS processes (the workers and their hosts) over real I/O: there is no event to await. */
async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

/**
 * Writes the tree the real installer would: a host entry, `package.json`, `bun.lock` and omp's `package.json`. A good
 * copy's host is the fixture agent host; a broken one exits before it registers, like an omp that fails to load.
 */
function fakeInstaller(h: { copy: "good" | "broken"; gate?: Promise<void> }): CopyInstaller {
	return async ({ dir, version }) => {
		await h.gate;
		mkdirSync(join(dir, "src", "worker", "host"), { recursive: true });
		const host =
			h.copy === "good"
				? `await import(${JSON.stringify(FIXTURE_HOST)});\n`
				: `process.stderr.write(${JSON.stringify(`${BROKEN_STDERR}\n`)});\nprocess.exit(3);\n`;
		writeFileSync(join(dir, "src", "worker", "host", "host.ts"), host);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [OMP_PACKAGE]: version } }));
		writeFileSync(join(dir, "bun.lock"), "lock");
		mkdirSync(join(dir, "node_modules", OMP_PACKAGE), { recursive: true });
		writeFileSync(join(dir, "node_modules", OMP_PACKAGE, "package.json"), JSON.stringify({ name: OMP_PACKAGE, version }));
		return { output: `installed ${OMP_PACKAGE}@${version}\n` };
	};
}

interface Worker {
	proc: Subprocess<"ignore", "pipe", "pipe">;
	root: string;
	stderr: Promise<string>;
	exited: Promise<number>;
}

interface Harness {
	stateDir: string;
	runtimeDir: string | undefined;
	discord: FakeDiscord;
	db: Db;
	updater: OmpUpdater;
	dispatcher: WorkerDispatcher;
	/** What the fake npm registry answers as `latest`. */
	registry: { latest: string };
	install: { copy: "good" | "broken"; gate?: Promise<void> };
	spawnWorker(): Worker;
}

async function boot(opts: { inImage?: boolean } = {}): Promise<Harness> {
	const stateDir = await mkdtemp(join(tmpdir(), "agentbot-upd-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	setLogSink(() => {});
	cleanups.push(() => setLogSink(undefined));
	const ompDir = join(stateDir, "omp");
	await ensureOmpAssetsDir(ompDir);
	const gh: FakeGitHub = startFakeGitHub();
	cleanups.push(() => gh.stop());
	const discord = createFakeDiscord({ guildId: "g1", channels: [{ id: WORK, name: "work" }, { id: ASK, name: "ask" }] });
	const registry = { latest: NEW_OMP };
	const npm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ name: OMP_PACKAGE, version: registry.latest }) });
	cleanups.push(() => npm.stop(true));

	const db = openDb(dbPath(stateDir));
	const vault = await openVault(db, Buffer.from(crypto.randomUUID() + crypto.randomUUID(), "utf8"));
	await vault.initialize("admin", "correct horse battery");
	vault.writeSettings(
		parseSettings({
			config: {
				discord: { guildId: "g1", allowedUserIds: [ALICE], workChannelId: WORK, askChannelIds: [ASK] },
				github: { appId: gh.appId, pollIntervalSeconds: 60 },
			},
			secrets: { discordToken: "discord-token", githubAppPrivateKey: gh.privateKey },
		}),
	);
	const settings = () => vault.readSettings();
	const signins: Signins = await openSignins(stateDir);
	const install: Harness["install"] = { copy: "good" };
	const runtimeDir = opts.inImage === false ? undefined : join(stateDir, "omp-runtime");
	const updater = createOmpUpdater({
		db,
		runtimeDir,
		identity: TEST_IDENTITY,
		imageOmpVersion: IMAGE_OMP,
		imageAppDir: stateDir,
		installer: (p => fakeInstaller(install)(p)) satisfies CopyInstaller,
		registryUrl: npm.url.href,
	});
	updater.start();
	const dispatcher = createWorkerDispatcher({
		db,
		stateDir,
		// Every worker here connects from 127.0.0.1 (architecture §6 address binding is tested in dispatch.test.ts).
		bindWorkerAddresses: false,
		limits: () => ({ maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 4 }),
		reattachGraceMs: 10_000,
		spec: {
			stateDir,
			ompConfig: () => vault.readOmpConfig(),
			providerKeys: () => settings()?.secrets.providerKeys ?? {},
			credentials: () => signins.snapshotForRun(),
			skillsHash: async () => (await skillsBundle(ompDir)).hash,
		},
		skills: () => skillsBundle(ompDir),
		credentialRequest: req => signins.handleCredentialRequest(req),
		leaseMs: 1_500,
		sweepMs: 50,
		repos: createRepos({ stateDir }),
		ompRuntime: updater,
	});
	let controller: Controller | undefined;
	const api: InternalApi = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir,
		db,
		version: TEST_IDENTITY.version,
		workerCapacity: 4,
		phase: () => controller?.status().phase ?? "starting",
		config: () => settings()?.config,
		dispatcher,
		admin: { handle: async () => new Response("admin") },
		workers: dispatcher,
		workerToken: WORKER_TOKEN,
		scaleToken: SCALE_TOKEN,
	});
	controller = createController({
		stateDir,
		db,
		vault,
		agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
		dispatcher,
		connectDiscord: () => discord,
		connectGitHub: ({ appId, privateKey, labels }) => createGitHub({ appId, privateKey, labels, baseUrl: gh.url, throttle: false }),
		ompUpdates: updater,
	});
	await controller.apply();
	expect(controller.status()).toMatchObject({ phase: "running" });

	const workers: Worker[] = [];
	cleanups.push(async () => {
		await api.stop();
		dispatcher.close();
		updater.stop();
		await controller.stop();
		signins.close();
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
			await w.exited;
			await rm(w.root, { recursive: true, force: true });
		}
		db.close();
	});
	return {
		stateDir,
		runtimeDir,
		discord,
		db,
		updater,
		dispatcher,
		registry,
		install,
		spawnWorker() {
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: { ...process.env, AGENTBOT_ORCHESTRATOR_URL: api.url, TEST_WORKER_TOKEN: WORKER_TOKEN },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			void new Response(proc.stdout).text();
			const w: Worker = { proc, root: workerRoot(join(tmpdir(), "agentbot-worker"), proc.pid), stderr: new Response(proc.stderr).text(), exited: proc.exited };
			workers.push(w);
			return w;
		},
	};
}

const alice = (h: Harness) => h.discord.actor(ALICE, { username: "alice" });

async function ask(h: Harness, prompt: string): Promise<string> {
	const e = await h.discord.emitCommand({ command: "ask", options: { prompt }, attachments: [], actor: alice(h), channelId: ASK });
	const threadId = /<#(\d+)>/.exec(e.responses.find(r => r.type === "editReply")?.msg?.content ?? "")?.[1];
	if (!threadId) throw new Error(`no thread started: ${JSON.stringify(e.responses)}`);
	return threadId;
}

const said = (h: Harness, channelId: string, text: string) => h.discord.messages(channelId).filter(m => m.content.includes(text));
const approveId = (version: string) => encodeId({ type: "omp", version, action: "approve" });
/** Work-channel messages that carry an Approve button for `version`. */
const notices = (h: Harness, version: string) =>
	h.discord.messages(WORK).filter(m => m.components.some(row => row.components.some(c => "custom_id" in c && c.custom_id === approveId(version))));
const click = (h: Harness, m: FakeMessage, actor = alice(h)) => h.discord.emitComponent({ message: { channelId: m.channelId, messageId: m.id }, customId: approveId(NEW_OMP), actor });
const answer = (e: Emitted) => e.responses.findLast(r => r.type === "reply" || r.type === "followUp")?.msg?.content ?? "";

/** A held `/ask` run on its own worker, `registered` (state `running`). */
async function heldRun(h: Harness, label: string): Promise<{ threadId: string; runId: string; worker: Worker }> {
	const threadId = await ask(h, `fixture:chatHeld ${label}`);
	const worker = h.spawnWorker();
	await until(() => h.db.currentRun("chat_thread_id", threadId)?.state === "running", `${label} to run`);
	return { threadId, runId: h.db.currentRun("chat_thread_id", threadId)!.id, worker };
}

async function finish(h: Harness, run: { threadId: string; worker: Worker }): Promise<void> {
	await h.discord.emitMessage({ channelId: run.threadId, content: "please finish now", actor: alice(h) });
	await until(() => said(h, run.threadId, "✅ **Done.**").length === 1, "the chat to finish");
	expect(await run.worker.exited).toBe(0);
	expect(existsSync(run.worker.root)).toBe(false);
}

describe("in-place omp updates for workers (phase 10)", () => {
	test("approve: a running worker keeps the image's omp, the next downloads the copy; members, stale and concurrent approvals", async () => {
		const h = await boot();
		const first = await heldRun(h, "before the update");
		expect(h.db.getRun(first.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);

		// UPD-02: the check finds a newer omp, and the notice goes to the work channel.
		await h.updater.check();
		await until(() => notices(h, NEW_OMP).length === 1, "the update notice");
		const [notice] = notices(h, NEW_OMP);
		expect(notice!.content).toContain(`**omp ${NEW_OMP}** is available (workers use ${IMAGE_OMP})`);

		// DSC-02: a member who is not allowed is refused.
		const stranger = await click(h, notice!, h.discord.actor("u-stranger", { username: "mallory" }));
		expect(answer(stranger)).toBe("Not authorized.");
		expect(h.updater.status().lastAttempt).toBeUndefined();

		// UPD-03: a second approval while the first installs is refused.
		const release = Promise.withResolvers<void>();
		h.install.gate = release.promise;
		const approving = click(h, notice!);
		await until(() => h.updater.status().installing !== undefined, "the install to start");
		const second = await click(h, notice!);
		expect(answer(second)).toContain(`omp ${NEW_OMP} is already being installed (approved by @alice)`);
		release.resolve();
		await approving;
		await until(() => said(h, WORK, `✅ omp ${NEW_OMP} is installed for workers (approved by @alice)`).length === 1, "the installed message");
		await h.discord.settled();
		expect(h.discord.message(notice!.id)?.components).toEqual([]);
		expect(h.discord.message(notice!.id)?.content).toContain(`Approved by @alice: installing omp ${NEW_OMP} for workers`);
		const active = h.updater.status().active!;
		expect(active).toMatchObject({ version: NEW_OMP, by: "@alice" });
		expect(existsSync(join(h.runtimeDir!, active.copy, "runtime.tar.gz"))).toBe(true);
		expect(existsSync(join(h.runtimeDir!, active.copy, "app"))).toBe(false);
		expect(h.updater.status().available).toBeUndefined();

		// A stale approval (the update is installed now) is refused.
		const stale = await click(h, notice!);
		expect(answer(stale)).toBe(STALE_UPDATE);

		// The running worker already chose; the next one downloads the copy and reports its version (UPD-07).
		const second2 = await heldRun(h, "after the update");
		expect(h.db.getRun(second2.runId)?.omp_version).toBe(NEW_OMP);
		expect(h.db.getRun(first.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		expect(readdirSync(join(second2.worker.root, "omp-runtime"))).toEqual(expect.arrayContaining(["node_modules", "src", "package.json", "bun.lock"]));
		await finish(h, first);
		await finish(h, second2);
		expect(h.db.getRun(second2.runId)).toMatchObject({ state: "finished", outcome: "succeeded", omp_version: NEW_OMP });
	}, 40_000);

	test("a broken copy: the worker falls back to the image's omp in the same run; the copy is failed and the update re-offered (UPD-08)", async () => {
		const h = await boot();
		h.install.copy = "broken";
		await h.updater.check();
		await until(() => notices(h, NEW_OMP).length === 1, "the update notice");
		await click(h, notices(h, NEW_OMP)[0]!);
		await until(() => h.updater.status().active?.version === NEW_OMP, "the copy to be active");
		const copy = h.updater.status().active!.copy;

		const run = await heldRun(h, "on the canary");
		// run-info came twice: the copy's version, then the image's after the fallback.
		expect(h.db.getRun(run.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		expect(h.updater.status().active).toBeUndefined();
		expect(h.updater.status().lastAttempt).toMatchObject({ version: NEW_OMP, outcome: "failed", copy, by: "@alice" });
		expect(h.updater.status().lastAttempt?.error).toContain(`the agent host from omp ${NEW_OMP} exited with code 3 before it registered`);

		// The failure is posted with a fresh Approve button; the earlier notice lost its button.
		await until(() => notices(h, NEW_OMP).some(m => m.content.includes("exited with code 3")), "the failure notice");
		const failure = notices(h, NEW_OMP).find(m => m.content.includes("exited with code 3"))!;
		expect(failure.content).toContain(BROKEN_STDERR);
		expect(notices(h, NEW_OMP)).toHaveLength(1);
		expect(h.updater.status().lastAttempt?.reported).toBe(true);

		// The run goes on with the image's omp, once (no second fallback).
		await finish(h, run);
		expect(h.db.getRun(run.runId)).toMatchObject({ state: "finished", outcome: "succeeded" });
		expect(await run.worker.stderr).toContain(BROKEN_STDERR);

		// The failed copy is deleted once no assigned run may still download it (UPD-09).
		await until(() => !existsSync(join(h.runtimeDir!, copy)), "the failed copy to be deleted");

		// The next run uses the image's omp straight away.
		const next = await heldRun(h, "after the failure");
		expect(h.db.getRun(next.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		await finish(h, next);
	}, 40_000);

	test("a newer omp supersedes the older notice, whose button is then stale (UPD-02)", async () => {
		const h = await boot();
		await h.updater.check();
		await until(() => notices(h, NEW_OMP).length === 1, "the first notice");
		const first = notices(h, NEW_OMP)[0]!;
		h.registry.latest = "99.2.0";
		await h.updater.check();
		await until(() => notices(h, "99.2.0").length === 1, "the newer notice");
		await h.discord.settled();
		expect(h.discord.message(first.id)).toMatchObject({ components: [] });
		expect(h.discord.message(first.id)?.content).toContain("Superseded by omp 99.2.0.");
		// A repeated check with nothing new posts nothing.
		await h.updater.check();
		await h.discord.settled();
		expect(h.discord.messages(WORK).filter(m => m.content.includes("is available"))).toHaveLength(2);
		expect(answer(await click(h, first))).toBe(STALE_UPDATE);
		expect(h.updater.status().lastAttempt).toBeUndefined();
	}, 20_000);

	test("outside the image updates are refused and no notice is posted (UPD-05)", async () => {
		const h = await boot({ inImage: false });
		const view = await h.updater.check();
		expect(view).toMatchObject({ supported: false, unsupportedReason: UNSUPPORTED, latest: NEW_OMP, available: NEW_OMP });
		await h.discord.settled();
		expect(notices(h, NEW_OMP)).toHaveLength(0);
		expect(await h.updater.install(NEW_OMP, "@alice")).toEqual({ ok: false, error: UNSUPPORTED, refused: true });
		// An Approve click (an old notice) is refused the same way.
		const sent = await h.discord.send(WORK, { content: "old notice" });
		const e = await h.discord.emitComponent({ message: sent, customId: approveId(NEW_OMP), actor: alice(h) });
		expect(answer(e)).toBe(UNSUPPORTED);
		expect(h.updater.forRun("any")).toBeUndefined();
	}, 20_000);
});
