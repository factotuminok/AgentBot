import { z } from "zod";
import { git } from "../../shared/git";
import { errorMessage, log } from "../../shared/log";
import { TERMINAL_STATES } from "../engine/state";
import { type RefKind, type Repos, runRef } from "../git/repos";
import type { Db, RunOutcome, RunRow } from "../store/db";
import { type CheckoutRequest, type RunRequest, writesCode } from "./dispatcher";

/**
 * The orchestrator side of checkouts (architecture §4.6): fixing a run's start commit before it becomes pending
 * (RUN-17, GH-26), and the lifetime of the temporary refs the runs repos keep (RUN-20, WS-07, WS-08, WS-01's mirror
 * expiry). The git work itself is `git/repos.ts`; this module decides when it happens and keeps the `runs` flags in step.
 */

/** GH-26: the repository's own configuration on its default branch. */
export const REPO_CONFIG_FILE = ".agentbot.yml";
export const MAX_REPO_CONFIG_BYTES = 64 * 1024;
/** WS-01: a mirror with no tracked issue and no kept run is deleted after this long unused. */
export const MIRROR_IDLE_MS = 14 * 24 * 3_600_000;

const RepoConfigSchema = z
	.object({
		baseBranch: z.string().trim().min(1).optional(),
		setupCommand: z.string().trim().min(1).optional(),
	})
	.strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

/** Parses `.agentbot.yml` (GH-26); an empty file is an empty configuration. Throws with the problem. */
export function parseRepoConfig(text: string): RepoConfig {
	let raw: unknown;
	try {
		raw = Bun.YAML.parse(text);
	} catch (err) {
		throw new Error(`${REPO_CONFIG_FILE} is not valid YAML: ${errorMessage(err)}`);
	}
	const parsed = RepoConfigSchema.safeParse(raw ?? {});
	if (!parsed.success) {
		const problems = parsed.error.issues.map(i => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
		throw new Error(`${REPO_CONFIG_FILE}: ${problems.join("; ")}`);
	}
	return parsed.data;
}

/** A run's checkout as fixed when it becomes pending (RUN-17). */
export interface PreparedCheckout {
	repo: string;
	startRef: string;
	startCommit: string;
	setupCommand?: string;
	/** The earlier run whose kept refs this run restores. */
	continuesRunId?: string;
}

/** The issue an issue-job run belongs to. */
function issueOf(db: Db, row: Pick<RunRow, "job_id">): number | undefined {
	return row.job_id ? db.getJob(row.job_id)?.issue_id : undefined;
}

/** A repository's settings as runs see them: `.agentbot.yml` on the default branch, with the base branch resolved (GH-26). */
export interface ResolvedRepoConfig {
	baseBranch: string;
	setupCommand?: string;
	defaultBranch: string;
	/** The default branch's head in the freshly fetched mirror. */
	defaultHead: string;
}

/** Fetches the mirror and reads `.agentbot.yml` from the default branch (GH-26, WS-01). Throws with the problem. */
export async function readRepoConfig(repos: Repos, checkout: CheckoutRequest): Promise<ResolvedRepoConfig> {
	const { repo } = checkout;
	const [token, defaultBranch] = await Promise.all([checkout.gitToken(), checkout.defaultBranch()]);
	await repos.fetch(repo, token);
	const defaultHead = await repos.branchHead(repo, defaultBranch);
	if (!defaultHead) throw new Error(`The default branch ${defaultBranch} of ${repo} was not found on GitHub`);
	const text = await repos.readFile(repo, defaultHead, REPO_CONFIG_FILE, MAX_REPO_CONFIG_BYTES);
	let config: RepoConfig;
	try {
		config = text === undefined ? {} : parseRepoConfig(text);
	} catch (err) {
		throw new Error(`${repo}: ${errorMessage(err)}`);
	}
	return {
		baseBranch: config.baseBranch ?? defaultBranch,
		...(config.setupCommand ? { setupCommand: config.setupCommand } : {}),
		defaultBranch,
		defaultHead,
	};
}

/**
 * RUN-17: fetches the mirror, reads `.agentbot.yml` from the default branch, and fixes the start ref and commit:
 * - a code-writing run that resumes (requeued after a lost worker, or a Retry) continues the issue's newest run that
 *   still keeps refs, from that run's start commit, so its checkpoint applies;
 * - otherwise revise and fix_ci start from the issue branch, which must exist;
 * - a resumed implement starts from the issue branch when it exists (a Retry after a rejected push);
 * - everything else starts from the base branch.
 */
export async function prepareCheckout(repos: Repos, db: Db, req: RunRequest): Promise<PreparedCheckout> {
	const checkout = req.checkout;
	if (!checkout) throw new Error(`${req.kind} runs need a repository checkout`);
	const { repo } = checkout;
	const { baseBranch: base, setupCommand, defaultBranch, defaultHead } = await readRepoConfig(repos, checkout);
	const setup = setupCommand ? { setupCommand } : {};
	const code = writesCode(req.kind);
	if (code && req.resume && req.owner.kind === "job") {
		const issueId = issueOf(db, { job_id: req.owner.jobId });
		const kept = issueId === undefined ? undefined : db.keptRuns(issueId).find(r => r.repo === repo && r.start_ref && r.start_commit);
		if (kept) return { repo, startRef: kept.start_ref!, startCommit: kept.start_commit!, ...setup, continuesRunId: kept.id };
	}
	const issueBranch = checkout.issueBranch;
	if (code && issueBranch && req.kind !== "implement") {
		const head = await repos.branchHead(repo, issueBranch);
		if (!head) throw new Error(`The branch ${issueBranch} does not exist on GitHub`);
		return { repo, startRef: `refs/heads/${issueBranch}`, startCommit: head, ...setup };
	}
	if (code && issueBranch && req.resume) {
		const head = await repos.branchHead(repo, issueBranch);
		if (head) return { repo, startRef: `refs/heads/${issueBranch}`, startCommit: head, ...setup };
	}
	const baseHead = base === defaultBranch ? defaultHead : await repos.branchHead(repo, base);
	if (!baseHead) throw new Error(`The base branch ${base} (${REPO_CONFIG_FILE} baseBranch) was not found in ${repo}`);
	return { repo, startRef: `refs/heads/${base}`, startCommit: baseHead, ...setup };
}

/** The refs a run keeps in its runs repo, by its flags. */
function keptKinds(row: RunRow): RefKind[] {
	const kinds: RefKind[] = [];
	if (row.has_checkpoint) kinds.push("checkpoint");
	if (row.has_result) kinds.push("result");
	return kinds;
}

export interface RunRefs {
	/** RUN-18, RUN-19: an imported bundle is kept. */
	kept(runId: string, kind: RefKind): void;
	/** The restore source for a run that continues `previous`: its checkpoint, else its unpushed result (RUN-17). */
	restoreKind(previous: RunRow): RefKind | undefined;
	/** Commits of a kept result over its start commit. */
	resultCommits(row: RunRow): Promise<number>;
	/** RUN-20 when a run finishes. Never throws. */
	settle(runId: string, outcome: RunOutcome): Promise<void>;
	/** Deletes the given refs of a run and clears their flags. Never throws. */
	release(row: RunRow, kinds?: RefKind[]): Promise<void>;
	/** WS-08: every ref the issue's runs keep. Never throws. */
	releaseIssue(issueId: number): Promise<void>;
	/** WS-07, RUN-20 at start: deletes refs of runs that are finished and not kept for Retry. Never throws. */
	prune(): Promise<void>;
	/** WS-01: deletes mirrors unused for `MIRROR_IDLE_MS` with no tracked issue and no unfinished or kept run. Never throws. */
	expireMirrors(now?: Date): Promise<void>;
}

export function createRunRefs(db: Db, repos: Repos): RunRefs {
	/** Whether a run's refs must stay: unfinished, or finished with kept refs on an issue that is not over. */
	function keeps(row: RunRow): boolean {
		if (row.state !== "finished") return true;
		if (!row.has_checkpoint && !row.has_result) return false;
		const issueId = issueOf(db, row);
		const state = issueId === undefined ? undefined : db.getIssue(issueId)?.state;
		return state !== undefined && !TERMINAL_STATES[state];
	}

	async function release(row: RunRow, kinds: RefKind[] = ["checkpoint", "result"]): Promise<void> {
		if (!row.repo || kinds.length === 0) return;
		try {
			await repos.deleteRefs(row.repo, row.id, kinds);
			db.updateRun(row.id, {
				...(kinds.includes("checkpoint") ? { has_checkpoint: 0 } : {}),
				...(kinds.includes("result") ? { has_result: 0 } : {}),
			});
			log("info", "run refs deleted", { run: row.id, repo: row.repo, refs: kinds });
		} catch (err) {
			log("warn", "deleting run refs failed", { run: row.id, repo: row.repo, refs: kinds, error: errorMessage(err) });
		}
	}

	async function releaseIssue(issueId: number): Promise<void> {
		for (const row of db.keptRuns(issueId)) await release(row, keptKinds(row));
	}

	return {
		kept(runId, kind) {
			db.updateRun(runId, kind === "checkpoint" ? { has_checkpoint: 1 } : { has_result: 1 });
		},
		restoreKind(previous) {
			if (previous.has_checkpoint) return "checkpoint";
			if (previous.has_result) return "result";
			return undefined;
		},
		async resultCommits(row) {
			if (!row.repo || !row.has_result || !row.start_commit) return 0;
			const out = await git(["rev-list", "--count", `${row.start_commit}..${runRef(row.id, "result")}`], { cwd: repos.runsPath(row.repo) });
			return Number(out);
		},
		async settle(runId, outcome) {
			const row = db.getRun(runId);
			if (!row?.repo || !writesCode(row.kind)) return;
			if (!keeps(row)) {
				// The issue ended while the run was finishing (WS-08 already ran): nothing is kept.
				await release(row, keptKinds(row));
				return;
			}
			if (outcome === "succeeded") await release(row, row.has_checkpoint ? ["checkpoint"] : []);
			// A run that kept its own work supersedes what earlier runs of the issue kept (RUN-20: until the Retry's run finishes).
			const current = db.getRun(runId)!;
			if (outcome !== "succeeded" && !current.has_checkpoint && !current.has_result) return;
			const issueId = issueOf(db, row);
			if (issueId === undefined) return;
			for (const other of db.keptRuns(issueId)) if (other.id !== runId) await release(other, keptKinds(other));
		},
		release,
		releaseIssue: async issueId => {
			try {
				await releaseIssue(issueId);
			} catch (err) {
				log("warn", "releasing the issue's run refs failed", { issue_id: issueId, error: errorMessage(err) });
			}
		},
		async prune() {
			// Never throws: a broken runs repo is logged and skipped (WS-07).
			const refs = await repos.listRunRefs();
			let deleted = 0;
			for (const ref of refs) {
				try {
					const row = db.getRun(ref.runId);
					const flagged = ref.kind === "checkpoint" ? row?.has_checkpoint : row?.has_result;
					if (row && row.repo === ref.repo && (row.state !== "finished" || (keeps(row) && flagged))) continue;
					await repos.deleteRefs(ref.repo, ref.runId, [ref.kind]);
					if (row) db.updateRun(row.id, ref.kind === "checkpoint" ? { has_checkpoint: 0 } : { has_result: 0 });
					deleted++;
				} catch (err) {
					log("warn", "pruning a run ref failed", { repo: ref.repo, run: ref.runId, ref: ref.kind, error: errorMessage(err) });
				}
			}
			log("info", "run refs pruned", { checked: refs.length, deleted });
		},
		async expireMirrors(now = new Date()) {
			try {
				const inUse = new Set([...db.openIssues().map(i => i.repo), ...db.reposInUse()].map(r => r.toLowerCase()));
				for (const mirror of await repos.mirrors()) {
					if (inUse.has(mirror.repo.toLowerCase()) || now.getTime() - mirror.lastUsed.getTime() < MIRROR_IDLE_MS) continue;
					try {
						await repos.remove(mirror.repo);
						log("info", "unused mirror deleted", { repo: mirror.repo, lastUsed: mirror.lastUsed.toISOString() });
					} catch (err) {
						log("warn", "deleting an unused mirror failed", { repo: mirror.repo, error: errorMessage(err) });
					}
				}
			} catch (err) {
				log("warn", "mirror expiry failed", { error: errorMessage(err) });
			}
		},
	};
}
