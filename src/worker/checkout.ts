/**
 * The worker's private checkout (RUN-17 to RUN-19, WS-01, WS-02, WS-07): a shallow fetch of the start commit onto the
 * run's temporary branch, checkpoints and results as git bundles, restore from a bundle. Command sequences are those
 * proven by spike S3 (wiki/spikes/S3.md).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../shared/git";
import { CHECKPOINT_REF, type CheckoutSpec, GIT_PATH_PREFIX } from "../shared/wire";

export interface GitRemote {
	url: string;
	env: Record<string, string>;
}

/** RUN-17/WS-02: the endpoint URL and the per-command env carrying the lease token (never argv or config files). */
export function endpointRemote(orchestratorUrl: string, token: string, repo: string): GitRemote {
	const base = orchestratorUrl.replace(/\/+$/, "");
	return {
		url: `${base}${GIT_PATH_PREFIX}${repo}.git`,
		env: {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `http.${base}${GIT_PATH_PREFIX}.extraHeader`,
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		},
	};
}

/** RUN-17: shallow checkout of `spec.startCommit` on `spec.branch`, with the repo-local bot identity. */
export async function makeCheckout(dir: string, spec: CheckoutSpec, remote: GitRemote): Promise<void> {
	await mkdir(dir, { recursive: true });
	await git(["init", "-q"], { cwd: dir });
	await git(["config", "user.name", spec.identity.name], { cwd: dir });
	await git(["config", "user.email", spec.identity.email], { cwd: dir });
	await git(["fetch", "-q", "--depth=1", "--no-tags", remote.url, spec.startCommit], { cwd: dir, env: remote.env });
	await git(["checkout", "-q", "-b", spec.branch, spec.startCommit], { cwd: dir });
}

/** RUN-17: restores a checkpoint (as uncommitted changes) or an unpushed result bundle onto `branch`. */
export async function restoreCheckout(dir: string, branch: string, bundleFile: string): Promise<"checkpoint" | "result"> {
	const heads = (await git(["bundle", "list-heads", bundleFile], { cwd: dir }))
		.split("\n")
		.filter(Boolean)
		.map(line => line.split(" ")[1] ?? "");
	if (heads.length !== 1) throw new Error(`restore bundle must have exactly one head, has ${heads.length}`);
	const head = heads[0] as string;
	let kind: "checkpoint" | "result";
	if (/^refs\/agentbot\/checkpoints\/[^/]+$/.test(head)) kind = "checkpoint";
	else if (/^refs\/agentbot\/runs\/[^/]+$/.test(head)) kind = "result";
	else throw new Error(`unexpected restore bundle head ${head}`);
	await git(["fetch", "-q", "--no-tags", bundleFile, head], { cwd: dir });
	await git(["checkout", "-q", "-B", branch, "FETCH_HEAD"], { cwd: dir });
	if (kind === "checkpoint") await git(["reset", "-q", "--mixed", "HEAD~1"], { cwd: dir });
	return kind;
}

const TAIL_CHARS = 4000;

/** WS-05: runs the repository's setup command; combined output tail and exit code. SIGKILLed on abort. */
export async function runSetupCommand(
	dir: string,
	command: string,
	opts: { env: Record<string, string | undefined>; signal?: AbortSignal },
): Promise<{ exitCode: number; tail: string }> {
	const proc = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], {
		cwd: dir,
		env: opts.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		detached: true,
	});
	const kill = () => {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	};
	if (opts.signal?.aborted) kill();
	opts.signal?.addEventListener("abort", kill, { once: true });
	try {
		let tail = "";
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) {
			tail = (tail + decoder.decode(chunk, { stream: true })).slice(-TAIL_CHARS);
		}
		tail = (tail + decoder.decode()).slice(-TAIL_CHARS);
		const exitCode = await proc.exited;
		return { exitCode, tail };
	} finally {
		opts.signal?.removeEventListener("abort", kill);
	}
}

/** RUN-18: snapshot the whole working tree as one commit on HEAD at CHECKPOINT_REF and bundle it, index untouched. */
export async function writeCheckpoint(dir: string, startCommit: string, file: string): Promise<void> {
	const indexFile = join(dir, ".git", "agentbot-checkpoint.index");
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		await git(["read-tree", "HEAD"], { cwd: dir, env });
		await git(["add", "-A"], { cwd: dir, env });
		const tree = await git(["write-tree"], { cwd: dir, env });
		const commit = await git(["commit-tree", tree, "-p", "HEAD", "-m", "AgentBot checkpoint"], { cwd: dir });
		await git(["update-ref", CHECKPOINT_REF, commit], { cwd: dir });
	} finally {
		await rm(indexFile, { force: true });
	}
	await git(["bundle", "create", "-q", file, `${startCommit}..${CHECKPOINT_REF}`], { cwd: dir });
}

/** RUN-19: commits leftovers (when `message` is given) and bundles the run's commits; returns their count (0: no file). */
export async function writeResult(
	dir: string,
	startCommit: string,
	branch: string,
	message: string | undefined,
	file: string,
): Promise<number> {
	if (message !== undefined && (await git(["status", "--porcelain"], { cwd: dir })) !== "") {
		await git(["add", "-A"], { cwd: dir });
		await git(["commit", "-q", "-m", message], { cwd: dir });
	}
	const range = `${startCommit}..refs/heads/${branch}`;
	const count = Number(await git(["rev-list", "--count", range], { cwd: dir }));
	if (count === 0) return 0;
	await git(["bundle", "create", "-q", file, range], { cwd: dir });
	return count;
}

/** STO-06: bytes used by `dir`, 0 when it doesn't exist. */
export async function diskUsage(dir: string): Promise<number> {
	try {
		await stat(dir);
	} catch {
		return 0;
	}
	const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" });
	const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	const kib = Number.parseInt(out, 10);
	if (exitCode !== 0 && Number.isNaN(kib)) throw new Error(`du -sk ${dir} failed (exit ${exitCode})`);
	return (Number.isNaN(kib) ? 0 : kib) * 1024;
}
