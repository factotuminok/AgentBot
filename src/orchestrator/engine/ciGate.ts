import { collectCiFailures } from "../github/ci";
import { branchCiVerdict, type CiFailure, currentCiRuns, FAILING_WORKFLOW_CONCLUSIONS, summarizeChecks } from "../github/feedback";
import type { GitHub } from "../github/types";

/**
 * The CI wait before the pull request (CI-02 to CI-06), ported from DevForge `src/engine/ciGate.ts`.
 *
 * CI-05: how long a pushed commit may show neither check runs nor workflow runs before the system concludes that no CI
 * run was triggered (a docs-only push filtered by `paths-ignore`, `pull_request`-only workflows) and opens the PR.
 */
export const CI_START_GRACE_MS = 5 * 60_000;

export type CiGateResult =
	| { kind: "passed"; sha: string }
	| { kind: "failed"; sha: string; failures: CiFailure[] }
	| { kind: "no_run"; sha: string }
	| { kind: "timeout"; sha: string };

export interface CiGateOptions {
	github: Pick<GitHub, "getBranchSha" | "listCheckRuns" | "listWorkflowRuns" | "getActionsJobLogTail">;
	repo: string;
	branch: string;
	/** Commit the system pushed; the wait follows the branch head if it moves (CI-02). */
	sha: string;
	/** When `sha` was first seen as head (epoch ms); starts the no-run grace period. */
	shaSeenAt: number;
	/** Start of the wait round (epoch ms); `limitMs` counts from here (CI-06). */
	waitStartedAt: number;
	limitMs: number;
	graceMs: number;
	pollMs: number;
	/** Aborting rejects the wait with `signal.reason`. */
	signal: AbortSignal;
	/** Called when the branch head moved to a new commit, so the caller can checkpoint it (CI-08). */
	onSha(sha: string, at: number): void;
	/** Throws when the issue was closed or cancelled. */
	assertLive(): void;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Sleeps `ms`, rejecting with `signal.reason` on abort. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal.aborted) {
		reject(signal.reason);
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal.reason);
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/**
 * Waits for the CI of a pushed branch. Follows the branch head (a newer push supersedes the run), keeps waiting
 * through cancelled runs, and gives up on a commit that never starts a run after `graceMs`.
 */
export async function waitForBranchCi(opts: CiGateOptions): Promise<CiGateResult> {
	const { github, repo, branch, signal } = opts;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? abortableSleep;
	let sha = opts.sha;
	let shaSeenAt = opts.shaSeenAt;
	for (;;) {
		opts.assertLive();
		signal.throwIfAborted();
		const head = (await github.getBranchSha(repo, branch)) ?? sha;
		if (head !== sha) {
			sha = head;
			shaSeenAt = now();
			opts.onSha(sha, shaSeenAt);
		}
		const [checkRuns, workflowRuns] = await Promise.all([github.listCheckRuns(repo, sha), github.listWorkflowRuns(repo, sha)]);
		const verdict = branchCiVerdict(checkRuns, workflowRuns);
		if (verdict === "passed") return { kind: "passed", sha };
		if (verdict === "failed") {
			const current = currentCiRuns(checkRuns, workflowRuns);
			const failing = summarizeChecks(current.checkRuns)?.failures ?? [];
			if (failing.length > 0) return { kind: "failed", sha, failures: await collectCiFailures(github, repo, failing) };
			// A workflow failed before producing any check run (e.g. a broken workflow file). Workflow runs carry no name here.
			const failures = current.workflowRuns
				.filter(run => run.conclusion !== null && FAILING_WORKFLOW_CONCLUSIONS[run.conclusion])
				.map(run => ({
					checkRunId: run.id,
					name: `workflow run #${run.run_number}`,
					conclusion: run.conclusion ?? "failure",
					summary: `Workflow run #${run.run_number} (workflow ${run.workflow_id}) ended with ${run.conclusion} without starting any job`,
				}));
			return { kind: "failed", sha, failures };
		}
		if (verdict === "none" && now() - shaSeenAt >= opts.graceMs) return { kind: "no_run", sha };
		if (now() - opts.waitStartedAt >= opts.limitMs) return { kind: "timeout", sha };
		await sleep(opts.pollMs, signal);
	}
}
