/**
 * Running git for the orchestrator and the worker (WS-02). Every call gets `GIT_TERMINAL_PROMPT=0` and ignores the system
 * and global git config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), so no credential helper or user setting
 * can answer an auth challenge or change the protocol; tokens reach git only through the per-process `env` the caller
 * passes (`GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`), never through argv or a config file.
 */

export interface GitRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitOptions {
	cwd?: string;
	/** Added to the process environment for this call only. */
	env?: Record<string, string>;
	stdin?: Uint8Array;
	signal?: AbortSignal;
}

export class GitError extends Error {
	override name = "GitError";
	constructor(
		readonly args: string[],
		readonly exitCode: number,
		readonly stderr: string,
	) {
		super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim().slice(-2000)}`);
	}
}

/** The environment of every git call: the process env, isolated from system and global config, plus `extra`. */
export function gitEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
	return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
}

/** `git <args>`; never throws for a non-zero exit. */
export async function gitRun(args: string[], opts: GitOptions = {}): Promise<GitRun> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: opts.cwd,
		env: gitEnv(opts.env),
		stdin: opts.stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: opts.signal,
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { exitCode, stdout, stderr };
}

/** `git <args>`; returns the trimmed stdout, throws `GitError` on a non-zero exit. */
export async function git(args: string[], opts: GitOptions = {}): Promise<string> {
	const result = await gitRun(args, opts);
	if (result.exitCode !== 0) throw new GitError(args, result.exitCode, result.stderr || result.stdout);
	return result.stdout.trim();
}
