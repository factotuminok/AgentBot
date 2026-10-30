import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CopyInstaller, openOmpRuntimes } from "../../src/orchestrator/omp/runtime";
import { createOmpUpdater } from "../../src/orchestrator/omp/updates";
import { openDb } from "../../src/orchestrator/store/db";
import { setLogSink } from "../../src/shared/log";
import { OMP_PACKAGE } from "../../src/shared/ompPins";
import { sha256File, unpackRuntime } from "../../src/shared/ompRuntime";

const IDENTITY = { version: "1.0.0", hash: "image-a" };
const dirs: string[] = [];
const closers: (() => void)[] = [];

afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	setLogSink(undefined);
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-omp-runtime-"));
	dirs.push(dir);
	return dir;
}

/** Writes a minimal app tree with omp `version` (or `installs` when the install should claim another version). */
const installer =
	(opts: { installs?: string; error?: string } = {}): CopyInstaller =>
	async ({ dir, version }) => {
		if (opts.error) return { output: "npm ERR! 404\n", error: opts.error };
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "x.ts"), "export {};\n");
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "bun.lock"), "lock");
		mkdirSync(join(dir, "node_modules", OMP_PACKAGE), { recursive: true });
		writeFileSync(join(dir, "node_modules", OMP_PACKAGE, "package.json"), JSON.stringify({ version: opts.installs ?? version }));
		return { output: "ok\n" };
	};

function store(dir: string, assigned: { ids: string[] }, identity = IDENTITY) {
	setLogSink(() => {});
	const runtimes = openOmpRuntimes({ dir, identity, assignedRuns: () => assigned.ids });
	closers.push(() => runtimes.close());
	return runtimes;
}

describe("omp runtime copies (UPD-06, UPD-09)", () => {
	test("a copy is installed, checked, packed with its identity and hash, and activated; the archive unpacks to the tree", async () => {
		const dir = tempDir();
		const runtimes = store(dir, { ids: [] });
		const made = await runtimes.create({ version: "2.0.0", by: "@alice", installer: installer() });
		if (!made.ok) throw new Error(made.error);
		expect(made.copy).toMatchObject({ version: "2.0.0", identity: IDENTITY, by: "@alice" });
		expect(runtimes.active()?.copy).toBe(made.copy.copy);
		expect(readFileSync(join(dir, "active"), "utf8").trim()).toBe(made.copy.copy);
		const archive = join(dir, made.copy.copy, "runtime.tar.gz");
		expect(await sha256File(archive)).toBe(made.copy.sha256);
		expect(existsSync(join(dir, made.copy.copy, "app"))).toBe(false);
		const out = join(tempDir(), "unpacked");
		await unpackRuntime(archive, out);
		expect(JSON.parse(readFileSync(join(out, "node_modules", OMP_PACKAGE, "package.json"), "utf8")).version).toBe("2.0.0");
		expect(runtimes.forRun("r1")).toEqual({ copy: made.copy.copy, version: "2.0.0", identity: IDENTITY, sha256: made.copy.sha256, size: made.copy.size });
	});

	test("a failed install or a wrong installed version leaves the current copy active and nothing behind", async () => {
		const dir = tempDir();
		const runtimes = store(dir, { ids: [] });
		const good = await runtimes.create({ version: "2.0.0", by: "@a", installer: installer() });
		if (!good.ok) throw new Error(good.error);
		expect(await runtimes.create({ version: "3.0.0", by: "@a", installer: installer({ error: "bun install --omit=dev failed (exit 1)" }) })).toEqual({
			ok: false,
			error: "bun install --omit=dev failed (exit 1)",
			output: "npm ERR! 404\n",
		});
		const wrong = await runtimes.create({ version: "3.0.0", by: "@a", installer: installer({ installs: "2.9.0" }) });
		expect(wrong).toMatchObject({ ok: false, error: `the installed ${OMP_PACKAGE} is 2.9.0, expected 3.0.0` });
		expect(runtimes.active()?.version).toBe("2.0.0");
		expect(readdirSync(dir).sort()).toEqual(["active", good.copy.copy].sort());
	});

	test("at start, copies from another image and every non-active copy are deleted once no assigned run may download them", async () => {
		const dir = tempDir();
		const assigned = { ids: [] as string[] };
		const before = store(dir, assigned);
		const old = await before.create({ version: "2.0.0", by: "@a", installer: installer() });
		const current = await before.create({ version: "2.1.0", by: "@a", installer: installer() });
		if (!old.ok || !current.ok) throw new Error("install failed");
		before.close();
		// The orchestrator died while `old` was still being deleted, and during another install.
		mkdirSync(join(dir, old.copy.copy), { recursive: true });
		writeFileSync(join(dir, old.copy.copy, "copy.json"), JSON.stringify(old.copy));
		mkdirSync(join(dir, "2.2.0-unfinished", "app"), { recursive: true });

		// Same image: the active copy stays; the rest is marked, but a run assigned before this start may download any.
		assigned.ids = ["run-from-before"];
		const after = store(dir, assigned);
		after.reconcile();
		expect(existsSync(join(dir, old.copy.copy))).toBe(true);
		assigned.ids = [];
		after.sweep();
		expect(existsSync(join(dir, old.copy.copy))).toBe(false);
		expect(existsSync(join(dir, "2.2.0-unfinished"))).toBe(false);
		expect(after.active()?.copy).toBe(current.copy.copy);

		// A new image: the active copy is dropped (workers use the image's omp) and deleted.
		const newImage = store(dir, assigned, { version: "1.0.1", hash: "image-b" });
		newImage.reconcile();
		expect(newImage.active()).toBeUndefined();
		expect(existsSync(join(dir, "active"))).toBe(false);
		expect(existsSync(join(dir, current.copy.copy))).toBe(false);
	});

	test("a failed copy stops being given to runs and is deleted only after the runs given it leave `assigned` (UPD-08, UPD-09)", async () => {
		const dir = tempDir();
		const assigned = { ids: [] as string[] };
		const runtimes = store(dir, assigned);
		const made = await runtimes.create({ version: "2.0.0", by: "@a", installer: installer() });
		if (!made.ok) throw new Error(made.error);
		assigned.ids = ["r1", "r2"];
		expect(runtimes.forRun("r1")?.copy).toBe(made.copy.copy);
		expect(runtimes.markFailed(made.copy.copy, "exited before registered")).toBe(true);
		expect(runtimes.markFailed(made.copy.copy, "again")).toBe(false);
		expect(runtimes.forRun("r2")).toBeUndefined();
		expect(readFileSync(join(dir, made.copy.copy, "FAILED"), "utf8")).toContain("exited before registered");
		// r1 may still be downloading it.
		expect(runtimes.archive("r1")?.size).toBe(made.copy.size);
		runtimes.sweep();
		expect(existsSync(join(dir, made.copy.copy))).toBe(true);
		assigned.ids = ["r2"];
		runtimes.sweep();
		expect(existsSync(join(dir, made.copy.copy))).toBe(false);
	});
});

describe("omp update checks (UPD-02)", () => {
	test("checks after the start delay and then on the interval; errors are stored and shown, never thrown", async () => {
		setLogSink(() => {});
		const answers: (() => Response)[] = [() => Response.json({ version: "18.13.0" }), () => new Response("busy", { status: 503 }), () => Response.json({ version: "x" })];
		let calls = 0;
		const checked = Promise.withResolvers<void>();
		const npm = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				const answer = answers[Math.min(calls++, answers.length - 1)]!();
				if (calls === 3) checked.resolve();
				return answer;
			},
		});
		closers.push(() => npm.stop(true));
		const db = openDb(":memory:");
		closers.push(() => db.close());
		const updater = createOmpUpdater({ db, identity: IDENTITY, imageOmpVersion: "18.12.1", imageAppDir: tempDir(), registryUrl: npm.url.href, checkDelayMs: 1, checkIntervalMs: 1 });
		const views: (string | undefined)[] = [];
		updater.subscribe(() => views.push(updater.status().checkError));
		updater.start();
		closers.push(() => updater.stop());
		await checked.promise;
		await updater.check();
		updater.stop();
		expect(views.slice(0, 3)).toEqual([undefined, "the npm registry answered 503", "the npm registry returned no valid version"]);
		// The last good answer stays; the update is offered against the image's omp.
		expect(updater.status()).toMatchObject({ latest: "18.13.0", available: "18.13.0", checkError: "the npm registry returned no valid version", supported: false });
	});
});
