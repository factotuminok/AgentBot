import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DryRunError, dryRun, type DryRunOptions } from "../../scripts/dry-run";
import { git } from "../../src/shared/git";
import { seedAuthStore } from "../../src/worker/auth";

const FIXTURE_HOST = join(import.meta.dir, "..", "fixtures", "agent-host.ts");
const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "dry-run.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A repository with three commits; returns its path. */
async function makeRepo(): Promise<string> {
	const repo = tempDir("dryrun-repo-");
	await git(["init", "-q", "-b", "main"], { cwd: repo });
	for (const n of [1, 2, 3]) {
		writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
		await git(["add", "."], { cwd: repo });
		await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `commit ${n}`], { cwd: repo });
	}
	return repo;
}

/** An omp agent dir with one API-key sign-in, so a model is available without the environment. */
async function makeAgentDir(): Promise<string> {
	const dir = tempDir("dryrun-agent-");
	await seedAuthStore(dir, [{ id: 1, provider: "anthropic", credential: { type: "api_key", key: "sk-ant-test" } }]);
	return dir;
}

/** What the fixture host's `dryRun` script yields: a plan plus what it saw. */
interface FixturePlan {
	summary: string;
	checkout: { branch: string; log: string[] } & Record<string, unknown>;
}

function text(stream: PassThrough): () => string {
	let collected = "";
	stream.on("data", chunk => {
		collected += String(chunk);
	});
	return () => collected;
}

async function setup(issueBody: string) {
	const repo = await makeRepo();
	const issueFile = join(tempDir("dryrun-issue-"), "issue.md");
	writeFileSync(issueFile, `# Add a greeting\n\n${issueBody}\n`);
	const runParent = tempDir("dryrun-tmp-");
	const input = new PassThrough();
	const out = new PassThrough();
	const err = new PassThrough();
	const opts: DryRunOptions = { repo, issueFile, agentDir: await makeAgentDir(), tmpDir: runParent, hostEntry: FIXTURE_HOST, input, out, err };
	return { opts, input, out: text(out), err: text(err), errStream: err, runParent, repo };
}

describe("dry run (OPS-06)", () => {
	test("plans on a shallow checkout, answers questions from stdin, prints plan and usage, cleans up", async () => {
		const { opts, input, out, err, runParent } = await setup("Say hello. fixture:dryRun");
		// Both answers piped before the questions are asked: neither is lost.
		input.write("2\nAda\n");
		const result = await dryRun({ ...opts, model: "claude-haiku", thinking: "low" });
		// The fixture host's `dryRun` script output.
		const output: FixturePlan = result.output as FixturePlan;
		expect(output.summary).toBe("Plan for large scope by Ada.");
		// AGT-13: only the start commit is visible; the profile and settings are the plan job's.
		expect(output.checkout).toMatchObject({ shallow: "true", commits: 1, log: ["commit 3"], status: [], profile: "plan", thinking: "low", model: "claude-haiku" });
		expect(output.checkout.branch.startsWith("agentbot/run-")).toBe(true);
		const printed = out();
		expect(JSON.parse(printed.slice(0, printed.lastIndexOf("}") + 1))).toEqual(output);
		expect(printed).toContain("cost: $0.2500 · tokens in 1200 / out 340 / cache read 50 / cache write 7");
		expect(err()).toContain("Which scope?\n  1. small\n  2. large");
		expect(err()).toContain("Your name?");
		expect(err()).toContain("read — Reading the issue");
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("checks out --ref", async () => {
		const { opts, input, runParent } = await setup("fixture:dryRun");
		input.write("1\nBo\n");
		const result = await dryRun({ ...opts, ref: "HEAD~2" });
		const output: FixturePlan = result.output as FixturePlan;
		expect(output.checkout.log).toEqual(["commit 1"]);
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("a failed run is reported and the checkout removed", async () => {
		const { opts, out, runParent } = await setup("fixture:failure");
		await expect(dryRun(opts)).rejects.toThrow("the agent run failed (Error): model exploded");
		expect(out()).toBe("");
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("an interrupt aborts the run as the user's and cleans up", async () => {
		const { opts, out, errStream, runParent } = await setup("fixture:steerable");
		const planning = Promise.withResolvers<void>();
		errStream.on("data", chunk => String(chunk).includes("dry run: planning") && planning.resolve());
		const interrupt = new AbortController();
		const running = dryRun({ ...opts, signal: interrupt.signal });
		await planning.promise;
		expect(readdirSync(runParent)).toHaveLength(1);
		interrupt.abort();
		const result = await running;
		expect(result.aborted).toBe("user");
		expect(out()).toContain("aborted: user");
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("clear errors for a missing repo, issue, ref, model or a bad thinking level", async () => {
		const { opts, runParent } = await setup("fixture:dryRun");
		const notRepo = tempDir("dryrun-plain-");
		await expect(dryRun({ ...opts, repo: join(notRepo, "missing") })).rejects.toThrow(`--repo ${join(notRepo, "missing")}: no such directory`);
		await expect(dryRun({ ...opts, repo: notRepo })).rejects.toThrow("not a git repository");
		await expect(dryRun({ ...opts, issueFile: join(notRepo, "nope.md") })).rejects.toThrow("no such file");
		await expect(dryRun({ ...opts, ref: "no-such-branch" })).rejects.toThrow("--ref no-such-branch: no such commit");
		await expect(dryRun({ ...opts, model: "no-such-model-xyz" })).rejects.toThrow("--model no-such-model-xyz: no available model matches");
		await expect(dryRun({ ...opts, thinking: "loud" })).rejects.toBeInstanceOf(DryRunError);
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("the CLI reports missing credentials clearly", async () => {
		const { opts } = await setup("fixture:dryRun");
		const home = tempDir("dryrun-home-");
		const proc = Bun.spawn([process.execPath, SCRIPT, "--repo", opts.repo, "--issue", opts.issueFile, "--agent-dir", join(home, "agent")], {
			// No provider keys from the developer's environment.
			env: { PATH: process.env.PATH, HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(2);
		expect(stderr).toContain("dry-run: no model credentials:");
	});

	test("the CLI requires --repo and --issue", async () => {
		const proc = Bun.spawn([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(2);
		expect(stderr).toContain("--repo and --issue are required");
	});
});
