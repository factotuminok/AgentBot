import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/shared/git";
import { CHECKPOINT_REF, type CheckoutSpec } from "../../src/shared/wire";
import {
	diskUsage,
	endpointRemote,
	type GitRemote,
	makeCheckout,
	restoreCheckout,
	runSetupCommand,
	writeCheckpoint,
	writeResult,
} from "../../src/worker/checkout";
import { hostEnv, makeRunDirs } from "../../src/worker/runner";

const ID = { name: "AgentBot", email: "bot@example.invalid" };
const SECRET = "tok_SECRET_value_123";
let root: string;
let source: string;
let start: string;
let remote: GitRemote;
let n = 0;

function spec(branch = "agentbot/run-1"): CheckoutSpec {
	return { repo: "o/r", startRef: "refs/heads/main", startCommit: start, branch, writesCode: true, restore: false, identity: ID };
}

async function fresh(branch = "agentbot/run-1", env: Record<string, string> = {}): Promise<string> {
	const dir = join(root, `co-${n++}`);
	await makeCheckout(dir, spec(branch), { ...remote, env });
	return dir;
}

async function commitFile(dir: string, name: string, body: string, msg: string): Promise<void> {
	await writeFile(join(dir, name), body);
	await git(["add", name], { cwd: dir });
	await git(["commit", "-q", "-m", msg], { cwd: dir });
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "agentbot-checkout-"));
	source = join(root, "source");
	await mkdir(source);
	await git(["init", "-q", "-b", "main"], { cwd: source });
	await git(["config", "user.name", "Dev"], { cwd: source });
	await git(["config", "user.email", "dev@example.invalid"], { cwd: source });
	await git(["config", "uploadpack.allowReachableSHA1InWant", "true"], { cwd: source });
	await writeFile(join(source, ".gitignore"), "ignored.txt\n");
	await git(["add", ".gitignore"], { cwd: source });
	await commitFile(source, "a.txt", "a1\n", "first");
	await commitFile(source, "a.txt", "a2\n", "second");
	start = await git(["rev-parse", "HEAD"], { cwd: source });
	await commitFile(source, "a.txt", "a3\n", "after start");
	remote = { url: `file://${source}`, env: {} };
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("endpointRemote", () => {
	test("url and scoped auth header env", () => {
		const r = endpointRemote("http://orch:8080/", SECRET, "own/name");
		expect(r.url).toBe("http://orch:8080/internal/git/own/name.git");
		expect(r.url).not.toContain(SECRET);
		expect(r.env).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.http://orch:8080/internal/git/.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${SECRET}`,
		});
	});
});

describe("makeCheckout", () => {
	test("shallow, on branch, identity set, token not stored", async () => {
		const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${SECRET}` };
		const dir = await fresh("agentbot/run-1", env);
		expect(await git(["rev-parse", "--is-shallow-repository"], { cwd: dir })).toBe("true");
		expect(await git(["rev-list", "--count", "HEAD"], { cwd: dir })).toBe("1");
		expect(await git(["rev-parse", "HEAD"], { cwd: dir })).toBe(start);
		expect(await git(["symbolic-ref", "HEAD"], { cwd: dir })).toBe("refs/heads/agentbot/run-1");
		expect(await git(["config", "user.name"], { cwd: dir })).toBe(ID.name);
		expect(await git(["config", "user.email"], { cwd: dir })).toBe(ID.email);
		expect(await readFile(join(dir, ".git", "config"), "utf8")).not.toContain(SECRET);
		const fetchHead = join(dir, ".git", "FETCH_HEAD");
		if (existsSync(fetchHead)) expect(await readFile(fetchHead, "utf8")).not.toContain(SECRET);
	});
});

async function lsTree(dir: string, ref: string): Promise<string[]> {
	return (await git(["ls-tree", "-r", "--name-only", ref], { cwd: dir })).split("\n").filter(Boolean);
}

describe("checkpoint and restore", () => {
	test("checkpoint snapshots worktree without touching index; round trip restores it", async () => {
		const dir = await fresh();
		await commitFile(dir, "b.txt", "b\n", "run commit");
		await writeFile(join(dir, "a.txt"), "modified\n");
		await writeFile(join(dir, "staged.txt"), "staged\n");
		await git(["add", "staged.txt"], { cwd: dir });
		await writeFile(join(dir, "new.txt"), "untracked\n");
		await writeFile(join(dir, "ignored.txt"), "ignored\n");
		const before = await git(["status", "--porcelain"], { cwd: dir });
		const file = join(root, "cp.bundle");
		await writeCheckpoint(dir, start, file);
		expect(await git(["status", "--porcelain"], { cwd: dir })).toBe(before);
		expect(existsSync(join(dir, ".git", "agentbot-checkpoint.index"))).toBe(false);
		const files = await lsTree(dir, CHECKPOINT_REF);
		expect(files).toContain("new.txt");
		expect(files).toContain("staged.txt");
		expect(files).not.toContain("ignored.txt");
		expect(await git(["show", `${CHECKPOINT_REF}:a.txt`], { cwd: dir })).toBe("modified");
		expect((await git(["bundle", "list-heads", file], { cwd: dir })).split(" ")[1]).toBe(CHECKPOINT_REF);

		// Orchestrator: import into a bare runs repo, serve back a bundle.
		const runs = join(root, `runs-${n++}`);
		await git(["init", "-q", "--bare", runs]);
		await git(["fetch", "-q", `file://${source}`, `${start}:refs/agentbot/base`], { cwd: runs });
		await git(["fetch", "-q", file, `${CHECKPOINT_REF}:refs/agentbot/checkpoints/x`], { cwd: runs });
		const served = join(root, "served-cp.bundle");
		await git(["bundle", "create", "-q", served, `${start}..refs/agentbot/checkpoints/x`], { cwd: runs });

		const dir2 = await fresh("agentbot/run-2");
		expect(await restoreCheckout(dir2, "agentbot/run-2", served)).toBe("checkpoint");
		expect(await git(["symbolic-ref", "HEAD"], { cwd: dir2 })).toBe("refs/heads/agentbot/run-2");
		expect(await git(["log", "--format=%s", "-1"], { cwd: dir2 })).toBe("run commit");
		const status = (await git(["status", "--porcelain"], { cwd: dir2 })).split("\n").map(l => l.trim()).sort();
		expect(status).toEqual(["?? new.txt", "?? staged.txt", "M a.txt"]);
		expect(await readFile(join(dir2, "a.txt"), "utf8")).toBe("modified\n");
	});

	test("result bundle restores without reset", async () => {
		const dir = await fresh("agentbot/run-3");
		await commitFile(dir, "c.txt", "c\n", "result commit");
		const file = join(root, "res.bundle");
		expect(await writeResult(dir, start, "agentbot/run-3", undefined, file)).toBe(1);
		const runs = join(root, `runs-${n++}`);
		await git(["init", "-q", "--bare", runs]);
		await git(["fetch", "-q", `file://${source}`, `${start}:refs/agentbot/base`], { cwd: runs });
		await git(["fetch", "-q", file, "refs/heads/agentbot/run-3:refs/agentbot/runs/r3"], { cwd: runs });
		const served = join(root, "served-res.bundle");
		await git(["bundle", "create", "-q", served, `${start}..refs/agentbot/runs/r3`], { cwd: runs });
		const dir2 = await fresh("agentbot/run-4");
		expect(await restoreCheckout(dir2, "agentbot/run-4", served)).toBe("result");
		expect(await git(["log", "--format=%s", "-1"], { cwd: dir2 })).toBe("result commit");
		expect(await git(["status", "--porcelain"], { cwd: dir2 })).toBe("");
	});

	test("rejects a bundle with an unexpected head", async () => {
		const dir = await fresh("agentbot/run-5");
		await commitFile(dir, "d.txt", "d\n", "x");
		const file = join(root, "bad.bundle");
		await writeResult(dir, start, "agentbot/run-5", undefined, file);
		const dir2 = await fresh("agentbot/run-6");
		await expect(restoreCheckout(dir2, "agentbot/run-6", file)).rejects.toThrow(/unexpected restore bundle head/);
	});
});

describe("writeResult", () => {
	test("commits leftovers with message and bot identity", async () => {
		const dir = await fresh("agentbot/run-7");
		await commitFile(dir, "e.txt", "e\n", "work");
		await writeFile(join(dir, "left.txt"), "left\n");
		const file = join(root, "r7.bundle");
		expect(await writeResult(dir, start, "agentbot/run-7", "leftovers", file)).toBe(2);
		expect(await git(["log", "-1", "--format=%s|%an|%ae"], { cwd: dir })).toBe(`leftovers|${ID.name}|${ID.email}`);
		expect(await git(["status", "--porcelain"], { cwd: dir })).toBe("");
		const verify = await git(["bundle", "verify", file], { cwd: dir });
		expect(verify).toContain(start);
	});

	test("no commits → 0 and no file", async () => {
		const dir = await fresh("agentbot/run-8");
		const file = join(root, "r8.bundle");
		expect(await writeResult(dir, start, "agentbot/run-8", "leftovers", file)).toBe(0);
		expect(existsSync(file)).toBe(false);
	});

	test("amended start commit: bundle does not list start as prerequisite", async () => {
		const dir = await fresh("agentbot/run-9");
		await writeFile(join(dir, "a.txt"), "amended\n");
		await git(["commit", "-q", "-a", "--amend", "-m", "amended"], { cwd: dir });
		const file = join(root, "r9.bundle");
		const count = await writeResult(dir, start, "agentbot/run-9", undefined, file);
		expect(count).toBeGreaterThan(0);
		const header = (await readFile(file, "latin1")).split("\n\n")[0] ?? "";
		const prereqs = header.split("\n").filter(l => l.startsWith("-"));
		expect(prereqs.some(l => l.includes(start))).toBe(false);
	});
});

describe("runSetupCommand", () => {
	test("success", async () => {
		const r = await runSetupCommand(root, "echo hi; echo err >&2", { env: { PATH: process.env.PATH } });
		expect(r.exitCode).toBe(0);
		expect(r.tail).toContain("hi");
		expect(r.tail).toContain("err");
	});

	test("failure keeps the output tail", async () => {
		const r = await runSetupCommand(root, "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done; exit 3", {
			env: { PATH: process.env.PATH },
		});
		expect(r.exitCode).toBe(3);
		expect(r.tail.length).toBe(4000);
		expect(r.tail).toContain("line1999");
		expect(r.tail).not.toContain("line0\n");
	});

	test("abort kills it", async () => {
		const ac = new AbortController();
		const t0 = Date.now();
		// runSetupCommand spawns synchronously, so aborting right after the call kills a running process.
		const pending = runSetupCommand(root, "sleep 30", { env: { PATH: process.env.PATH }, signal: ac.signal });
		ac.abort();
		const r = await pending;
		expect(r.exitCode).not.toBe(0);
		expect(Date.now() - t0).toBeLessThan(5000);
	});

	test("with the host environment, package-manager caches land on the run root, not the run-local tmpfs", async () => {
		const runRoot = join(root, "run-root");
		const runLocal = join(root, "run-local");
		const dirs = await makeRunDirs(runRoot, runLocal, false);
		const env = hostEnv(dirs, "marker");
		expect(env.HOME).toStartWith(runLocal);
		expect(env.XDG_CACHE_HOME).toBe(join(runRoot, "cache"));
		expect(env.npm_config_cache).toStartWith(runRoot);
		// What `bun install` in a setupCommand uses: before, $HOME/.bun/install/cache on the 256 MiB tmpfs (ENOSPC).
		await writeFile(join(runRoot, "package.json"), '{"name":"x","private":true}');
		const r = await runSetupCommand(runRoot, "bun pm cache", { env });
		expect(r.exitCode).toBe(0);
		// (macOS reports the temp dir through /private.)
		expect(r.tail.trim()).toEndWith(join(runRoot, "cache", ".bun", "install", "cache"));
		expect(r.tail).not.toContain("run-local");
	});
});

describe("diskUsage", () => {
	test("grows with a 2 MiB file; 0 for missing", async () => {
		const dir = join(root, "du");
		await mkdir(dir);
		const before = await diskUsage(dir);
		await writeFile(join(dir, "big"), new Uint8Array(2 * 1024 * 1024).fill(7));
		expect((await diskUsage(dir)) - before).toBeGreaterThanOrEqual(2 * 1024 * 1024);
		expect(await diskUsage(join(root, "missing"))).toBe(0);
	});
});
