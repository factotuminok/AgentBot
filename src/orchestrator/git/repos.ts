/**
 * The orchestrator's git repositories (WS-01, WS-07, RUN-18..RUN-20, STO-03, STO-06): per GitHub repo a bare mirror
 * `<state>/repos/<owner>__<name>.git` (heads and tags only, served to workers by the git endpoint) and a runs repo
 * `<owner>__<name>.runs.git` that borrows the mirror's objects through `objects/info/alternates` and holds the imported
 * run results (`refs/agentbot/runs/<id>`) and checkpoints (`refs/agentbot/checkpoints/<id>`). Run objects never enter
 * the mirror, so a lease token can't fetch another run's work. Commands follow spike S3 (wiki/spikes/S3.md).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitError, git, gitEnv, gitRun } from "../../shared/git";
import { errorMessage, log } from "../../shared/log";
import { CHECKPOINT_REF, runBranch } from "../../shared/wire";

export type RefKind = "result" | "checkpoint";

/** A bundle that breaks the run's rules; the message is shown to users. */
export class BundleRejected extends Error {
	override name = "BundleRejected";
}

export interface ReposOptions {
	/** Repos live in `<stateDir>/repos`. */
	stateDir: string;
	/** Default `https://github.com/<repo>.git`; tests pass `file://` URLs. */
	remoteUrl?(repo: string): string;
}

export interface Repos {
	mirrorPath(repo: string): string;
	runsPath(repo: string): string;
	fetch(repo: string, token: string): Promise<void>;
	branchHead(repo: string, branch: string): Promise<string | undefined>;
	readFile(repo: string, commit: string, path: string, maxBytes: number): Promise<string | undefined>;
	importBundle(repo: string, runId: string, kind: RefKind, file: string, startCommit: string): Promise<{ commits: number }>;
	hasRef(repo: string, runId: string, kind: RefKind): Promise<boolean>;
	bundleStream(repo: string, runId: string, kind: RefKind, startCommit: string): Promise<ReadableStream<Uint8Array> | undefined>;
	push(repo: string, runId: string, branch: string, token: string): Promise<{ pushed: true; sha: string } | { pushed: false }>;
	deleteRefs(repo: string, runId: string, kinds: RefKind[]): Promise<void>;
	listRunRefs(): Promise<{ repo: string; runId: string; kind: RefKind }[]>;
	mirrors(): Promise<{ repo: string; lastUsed: Date }[]>;
	remove(repo: string): Promise<void>;
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const RUN_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const LAST_USED = "agentbot-last-used";

/** `owner/name`, each part a safe path segment (no leading dot, no traversal). */
export function isRepoName(repo: string): boolean {
	const parts = repo.split("/");
	return parts.length === 2 && parts.every((p) => NAME.test(p) && !p.includes(".."));
}

/** The runs-repo ref holding a run's result or checkpoint. */
export function runRef(runId: string, kind: RefKind): string {
	return kind === "result" ? `refs/agentbot/runs/${runId}` : `refs/agentbot/checkpoints/${runId}`;
}

/** WS-02: the GitHub token reaches git only as per-process config in the environment. */
export function githubTokenEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
	};
}

export interface BundleHeader {
	prerequisites: string[];
	heads: { sha: string; ref: string }[];
}

/** Parses a v2/v3 bundle header without git; throws `BundleRejected` on anything malformed. */
export async function readBundleHeader(file: string): Promise<BundleHeader> {
	let head: Buffer;
	try {
		head = Buffer.from(await Bun.file(file).slice(0, 1024 * 1024).arrayBuffer());
	} catch (err) {
		throw new BundleRejected(`the bundle could not be read: ${errorMessage(err)}`);
	}
	const end = head.indexOf("\n\n");
	if (end < 0) throw new BundleRejected("the bundle header is malformed");
	const lines = head.subarray(0, end).toString("utf8").split("\n");
	if (!/^# v[23] git bundle$/.test(lines[0] ?? "")) throw new BundleRejected("the upload is not a git bundle");
	const out: BundleHeader = { prerequisites: [], heads: [] };
	for (const line of lines.slice(1)) {
		if (line.startsWith("@")) continue;
		const pre = /^-([0-9a-f]{40}|[0-9a-f]{64})(?: .*)?$/.exec(line);
		if (pre?.[1]) {
			out.prerequisites.push(pre[1]);
			continue;
		}
		const ref = /^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line);
		if (!ref?.[1] || !ref[2]) throw new BundleRejected("the bundle header is malformed");
		out.heads.push({ sha: ref[1], ref: ref[2] });
	}
	return out;
}

export function createRepos(opts: ReposOptions): Repos {
	const reposDir = join(opts.stateDir, "repos");
	const remoteUrl = opts.remoteUrl ?? ((repo: string) => `https://github.com/${repo}.git`);
	const locks = new Map<string, Promise<unknown>>();

	function slug(repo: string): string {
		if (!isRepoName(repo)) throw new Error(`invalid repo name: ${JSON.stringify(repo)}`);
		return repo.replace("/", "__");
	}
	const mirrorPath = (repo: string) => join(reposDir, `${slug(repo)}.git`);
	const runsPath = (repo: string) => join(reposDir, `${slug(repo)}.runs.git`);

	function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
		if (!isRepoName(repo)) return Promise.reject(new Error(`invalid repo name: ${JSON.stringify(repo)}`));
		const next = (locks.get(repo) ?? Promise.resolve()).then(fn, fn);
		locks.set(
			repo,
			next.catch(() => undefined),
		);
		return next;
	}

	function checkRunId(runId: string): void {
		if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
	}

	async function refSha(dir: string, ref: string): Promise<string | undefined> {
		if (!existsSync(join(dir, "HEAD"))) return undefined;
		const r = await gitRun(["-C", dir, "rev-parse", "-q", "--verify", `${ref}^{commit}`]);
		return r.exitCode === 0 ? r.stdout.trim() : undefined;
	}

	async function touch(mirror: string): Promise<void> {
		const marker = join(mirror, LAST_USED);
		const now = new Date();
		try {
			await utimes(marker, now, now);
		} catch {
			await writeFile(marker, "");
		}
	}

	return {
		mirrorPath,
		runsPath,

		fetch(repo, token) {
			return withRepoLock(repo, async () => {
				const mirror = mirrorPath(repo);
				const runs = runsPath(repo);
				const env = githubTokenEnv(token);
				await mkdir(reposDir, { recursive: true });
				if (!existsSync(join(mirror, "HEAD"))) {
					const tmp = `${mirror}.tmp-${process.pid}-${Date.now()}`;
					await rm(mirror, { recursive: true, force: true });
					try {
						await git(["clone", "-q", "--bare", remoteUrl(repo), tmp], { env });
						await git(["-C", tmp, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
						await git(["-C", tmp, "config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
						await git(["-C", tmp, "config", "gc.pruneExpire", "never"]);
						// Another process (an orchestrator still stopping) may have finished the same clone meanwhile: keep that one.
						if (!existsSync(join(mirror, "HEAD"))) {
							await rename(tmp, mirror).catch(err => {
								if (!existsSync(join(mirror, "HEAD"))) throw err;
							});
						}
					} finally {
						await rm(tmp, { recursive: true, force: true });
					}
					log("info", "mirror cloned", { repo });
				}
				if (!existsSync(join(runs, "HEAD"))) {
					await rm(runs, { recursive: true, force: true });
					await git(["init", "-q", "--bare", runs]);
					await mkdir(join(runs, "objects", "info"), { recursive: true });
					await writeFile(join(runs, "objects", "info", "alternates"), `${join(mirror, "objects")}\n`);
				}
				await git(["-C", mirror, "fetch", "-q", "--prune", "origin"], { env });
				await touch(mirror);
			});
		},

		branchHead(repo, branch) {
			return withRepoLock(repo, () => refSha(mirrorPath(repo), `refs/heads/${branch}`));
		},

		readFile(repo, commit, path, maxBytes) {
			return withRepoLock(repo, async () => {
				const mirror = mirrorPath(repo);
				const spec = `${commit}:${path}`;
				const size = await gitRun(["-C", mirror, "cat-file", "-s", spec]);
				if (size.exitCode !== 0) return undefined;
				const bytes = Number(size.stdout.trim());
				if (bytes > maxBytes) throw new Error(`${path} is ${bytes} bytes, over the ${maxBytes}-byte limit`);
				const r = await gitRun(["-C", mirror, "cat-file", "blob", spec]);
				if (r.exitCode !== 0) return undefined;
				return r.stdout;
			});
		},

		async importBundle(repo, runId, kind, file, startCommit) {
			checkRunId(runId);
			return withRepoLock(repo, async () => {
				const runs = runsPath(repo);
				const header = await readBundleHeader(file);
				if (header.prerequisites.length !== 1 || header.prerequisites[0] !== startCommit)
					throw new BundleRejected("the run rewrote the start commit");
				const expected = kind === "result" ? `refs/heads/${runBranch(runId)}` : CHECKPOINT_REF;
				if (header.heads.length !== 1 || header.heads[0]?.ref !== expected)
					throw new BundleRejected(
						`the bundle must carry exactly ${expected} (it has ${header.heads.map((h) => h.ref).join(", ") || "no heads"})`,
					);
				if (!existsSync(join(runs, "HEAD"))) throw new Error(`no runs repo for ${repo}; fetch it first`);
				const verify = await gitRun(["-C", runs, "bundle", "verify", "-q", file]);
				if (verify.exitCode !== 0) throw new BundleRejected(`the bundle failed verification: ${verify.stderr.trim().slice(-500)}`);
				const target = runRef(runId, kind);
				await git(["-C", runs, "fetch", "-q", "--no-tags", "--no-write-fetch-head", file, `+${expected}:${target}`]);
				const commits = Number(await git(["-C", runs, "rev-list", "--count", `${startCommit}..${target}`]));
				return { commits };
			});
		},

		async hasRef(repo, runId, kind) {
			checkRunId(runId);
			return withRepoLock(repo, async () => (await refSha(runsPath(repo), runRef(runId, kind))) !== undefined);
		},

		async bundleStream(repo, runId, kind, startCommit) {
			checkRunId(runId);
			return withRepoLock(repo, async () => {
				const runs = runsPath(repo);
				const ref = runRef(runId, kind);
				if ((await refSha(runs, ref)) === undefined) return undefined;
				const proc = Bun.spawn(["git", "-C", runs, "bundle", "create", "-q", "-", `${startCommit}..${ref}`], {
					env: gitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				void Promise.all([new Response(proc.stderr).text(), proc.exited]).then(([stderr, exitCode]) => {
					if (exitCode !== 0) log("warn", "bundle create failed", { repo, run: runId, kind, exitCode, stderr: stderr.trim().slice(-2000) });
				});
				return proc.stdout;
			});
		},

		async push(repo, runId, branch, token) {
			checkRunId(runId);
			return withRepoLock(repo, async () => {
				const runs = runsPath(repo);
				const ref = runRef(runId, "result");
				const sha = await git(["-C", runs, "rev-parse", "--verify", `${ref}^{commit}`]);
				const args = ["-C", runs, "push", "--porcelain", remoteUrl(repo), `${ref}:refs/heads/${branch}`];
				const r = await gitRun(args, { env: githubTokenEnv(token) });
				if (r.exitCode === 0) return { pushed: true as const, sha };
				if (/^!\t.*\[rejected\]/m.test(r.stdout)) return { pushed: false as const };
				throw new GitError(args, r.exitCode, r.stderr || r.stdout);
			});
		},

		async deleteRefs(repo, runId, kinds) {
			checkRunId(runId);
			return withRepoLock(repo, async () => {
				const runs = runsPath(repo);
				if (!existsSync(join(runs, "HEAD"))) return;
				for (const kind of kinds) {
					const ref = runRef(runId, kind);
					if ((await gitRun(["-C", runs, "show-ref", "-q", "--verify", ref])).exitCode !== 0) continue;
					await git(["-C", runs, "update-ref", "-d", ref]);
				}
			});
		},

		async listRunRefs() {
			const out: { repo: string; runId: string; kind: RefKind }[] = [];
			let names: string[];
			try {
				names = await readdir(reposDir);
			} catch {
				return out;
			}
			for (const name of names) {
				const m = /^(.+?)__(.+)\.runs\.git$/.exec(name);
				if (!m) continue;
				const repo = `${m[1]}/${m[2]}`;
				if (!isRepoName(repo)) continue;
				try {
					const refs = await withRepoLock(repo, () =>
						git(["-C", join(reposDir, name), "for-each-ref", "--format=%(refname)", "refs/agentbot/runs", "refs/agentbot/checkpoints"]),
					);
					for (const ref of refs.split("\n")) {
						const r = /^refs\/agentbot\/(runs|checkpoints)\/(.+)$/.exec(ref);
						if (r?.[2]) out.push({ repo, runId: r[2], kind: r[1] === "runs" ? "result" : "checkpoint" });
					}
				} catch (err) {
					log("warn", "runs repo unreadable; skipped", { repo, error: errorMessage(err) });
				}
			}
			return out;
		},

		async mirrors() {
			const out: { repo: string; lastUsed: Date }[] = [];
			let names: string[];
			try {
				names = await readdir(reposDir);
			} catch {
				return out;
			}
			for (const name of names) {
				if (name.endsWith(".runs.git")) continue;
				const m = /^(.+?)__(.+)\.git$/.exec(name);
				if (!m) continue;
				const repo = `${m[1]}/${m[2]}`;
				if (!isRepoName(repo)) continue;
				const dir = join(reposDir, name);
				try {
					const s = await stat(join(dir, LAST_USED)).catch(() => stat(dir));
					out.push({ repo, lastUsed: s.mtime });
				} catch (err) {
					log("warn", "mirror unreadable; skipped", { repo, error: errorMessage(err) });
				}
			}
			return out;
		},

		remove(repo) {
			return withRepoLock(repo, async () => {
				await rm(mirrorPath(repo), { recursive: true, force: true });
				await rm(runsPath(repo), { recursive: true, force: true });
				log("info", "repo removed", { repo });
			});
		},
	};
}
