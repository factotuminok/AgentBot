import { errorMessage, log } from "../../shared/log";
import type { EngineDeps, Scheduler, TrackIssue } from "../engine/deps";
import { applyEvent, terminalCleanup } from "../engine/jobs";
import { TERMINAL_STATES } from "../engine/state";
import { watchChannelName } from "../engine/watches";
import type { IssueRow, WatchRow } from "../store/db";
import { collectCiFailures } from "./ci";
import { detectFeedback, evaluateChecks } from "./feedback";
import { relabelPending, relabelTrackedIssues } from "./labels";
import type { AvailableRepo } from "./types";

/** GH-11: issues filed by `/work plan` Execute carry this marker and are tracked by that flow itself. */
export const PLAN_THREAD_MARKER = "<!-- agentbot:plan-thread -->";

export interface PollerStatus {
	watches: { repo: string; channelId: string | null; state: WatchRow["state"]; lastPollAt?: string; lastError?: string }[];
	/** GH-06: errors following tracked issues of repositories that are not watched. */
	issueErrors: { issueId: number; repo: string; number: number; error: string; at: string }[];
}

export interface Poller {
	/** GH-05: first cycle immediately, then every `github.pollIntervalSeconds`. */
	start(): void;
	stop(): void;
	/** GH-07: joins a running cycle; resolves when a cycle started after the call has finished; immediately when stopped. */
	pollNow(repo?: string): Promise<void>;
	/** One full cycle (exposed for tests). */
	cycle(): Promise<void>;
	status(): PollerStatus;
}

export function createPoller(deps: EngineDeps, scheduler: Scheduler, trackIssue: TrackIssue): Poller {
	const { config, db, github, discord } = deps;
	const intervalMs = config.github.pollIntervalSeconds * 1000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let rerun = false;
	let stopped = true;
	let waiters: (() => void)[] = [];
	const issueErrors = new Map<number, PollerStatus["issueErrors"][number]>();

	/** DSC-37: follow renames/transfers by repo id, suspend watches that lost access and resume them when it returns. */
	async function syncWatches(): Promise<void> {
		const watches = db.listWatches().filter(w => w.state !== "unwatched");
		if (watches.length === 0) return;
		let listed = await github.listRepositories();
		// The listing is cached (GH-25): a repository added to the installation and watched since (e.g. from the web
		// Repositories page, which lists with its own client) is missing from it. Look again before suspending anything.
		if (watches.some(w => w.state !== "suspended" && !listed.some(r => r.id === w.repo_id))) listed = await github.listRepositories({ refresh: true });
		const byId = new Map<number, AvailableRepo>(listed.map(r => [r.id, r]));
		for (const watch of watches) {
			const repo = byId.get(watch.repo_id);
			if (!repo) {
				if (watch.state === "suspended") continue;
				db.updateWatch(watch.repo_id, { state: "suspended", last_error: "the GitHub App can no longer access this repository" });
				log("warn", "watch suspended", { repo: watch.repo });
				await discord
					.send(watch.channel_id, {
						content: `⚠️ **Watch suspended** — the GitHub App can no longer access ${watch.repo}. Watching resumes when access returns: ${github.installUrl}`,
					})
					.catch(err => log("warn", "watch message failed", { repo: watch.repo, error: errorMessage(err) }));
				continue;
			}
			if (repo.fullName !== watch.repo) {
				log("info", "watched repo renamed", { from: watch.repo, to: repo.fullName });
				db.updateWatch(watch.repo_id, { repo: repo.fullName });
				await discord
					.setChannel(watch.channel_id, { name: watchChannelName(repo.fullName) })
					.catch(err => log("warn", "watch channel rename failed", { repo: repo.fullName, error: errorMessage(err) }));
			}
			if (watch.state === "suspended") {
				db.updateWatch(watch.repo_id, { state: "watching", last_error: null });
				log("info", "watch resumed", { repo: repo.fullName });
				await discord
					.send(watch.channel_id, { content: `✅ **Watch resumed** — the GitHub App can access ${repo.fullName} again.` })
					.catch(err => log("warn", "watch message failed", { repo: repo.fullName, error: errorMessage(err) }));
			}
		}
	}

	/** GH-10 to GH-12. */
	async function newWork(watch: WatchRow): Promise<void> {
		const since = watch.cursor ?? undefined;
		const issues = await github.listLabeledIssues(watch.repo, deps.labels.trigger, since);
		let cursor = since;
		for (const gh of issues) {
			if (!cursor || gh.updated_at > cursor) cursor = gh.updated_at;
			if (db.findIssue(watch.repo, gh.number)) continue;
			if (gh.body.includes(PLAN_THREAD_MARKER)) continue;
			await trackIssue(watch.repo, gh, { via: "label" });
			log("info", "issue tracked", { repo: watch.repo, issue: gh.number });
		}
		// A failure above throws before this, so the whole listing is retried next cycle.
		if (cursor && cursor !== since) db.updateWatch(watch.repo_id, { cursor });
	}

	/** GH-13. During a pending relabel (GH-23) only closing cancels. */
	async function cancellation(issue: IssueRow): Promise<void> {
		const gh = await github.getIssue(issue.repo, issue.number);
		if (gh.state === "closed") await scheduler.cancelIssue(issue.id, "issue closed");
		else if (!gh.labels.includes(deps.labels.trigger) && !relabelPending(deps)) {
			await scheduler.cancelIssue(issue.id, `\`${deps.labels.trigger}\` label removed`);
		}
	}

	/** GH-14 to GH-21. */
	async function review(issue: IssueRow): Promise<void> {
		const pr = issue.pr_number!;
		const pull = await github.getPull(issue.repo, pr);
		if (pull.state === "closed") {
			// GH-14: queued jobs and the live run stop first, so nothing acts on the issue once it is terminal.
			await scheduler.stopJobs(issue.id);
			const ended = await applyEvent(deps, db.getIssue(issue.id) ?? issue, pull.merged ? "pr_merged" : "pr_closed");
			await terminalCleanup(
				deps,
				ended,
				pull.merged ? `🎉 **Complete** — PR #${pr} was merged. Archiving this thread.` : `⏹️ **Stopped** — PR #${pr} was closed without merging. Archiving this thread.`,
			);
			return;
		}
		if (scheduler.isBusy(issue.id)) return;

		const [reviews, reviewComments, issueComments] = await Promise.all([
			github.listReviews(issue.repo, pr),
			github.listReviewComments(issue.repo, pr),
			github.listIssueComments(issue.repo, pr),
		]);
		const items = detectFeedback({
			reviews,
			reviewComments,
			issueComments,
			botLogin: github.identity.login,
			seen: db.seenIds(issue.repo, pr),
			mentionKeyword: config.github.mentionKeyword,
		});
		if (items.length) {
			scheduler.enqueue(issue.id, "revise", { items });
			return;
		}

		const runs = await github.listCheckRuns(issue.repo, pull.headSha);
		const { failures, exhausted } = evaluateChecks(runs, pull.headSha, issue, config.limits.maxCiFixAttempts);
		if (exhausted) {
			db.updateIssue(issue.id, { ci_last_sha: pull.headSha });
			if (issue.thread_id) {
				await discord.send(issue.thread_id, { content: `⚠️ **CI is still failing after ${issue.ci_attempts} fix attempts** — this needs a human.` });
			}
			return;
		}
		if (!failures.length) return;
		const withLogs = await collectCiFailures(github, issue.repo, failures);
		scheduler.enqueue(issue.id, "fix_ci", { failures: withLogs, sha: pull.headSha });
	}

	function recordIssueError(issue: IssueRow, err: unknown): void {
		const error = errorMessage(err);
		log("error", "poll failed", { repo: issue.repo, issue: issue.number, error });
		const watch = db.watchByName(issue.repo);
		if (watch?.state === "watching") db.updateWatch(watch.repo_id, { last_error: `${new Date().toISOString()}: ${error}` });
		else issueErrors.set(issue.id, { issueId: issue.id, repo: issue.repo, number: issue.number, error, at: new Date().toISOString() });
	}

	async function cycle(): Promise<void> {
		await relabelTrackedIssues(deps);
		try {
			await syncWatches();
		} catch (err) {
			log("error", "listing repositories failed", { error: errorMessage(err) });
		}
		// GH-06, GH-27: new work only in watched repositories, one after another.
		for (const watch of db.listWatches("watching")) {
			if (deps.signal.aborted) return;
			try {
				await newWork(watch);
				db.updateWatch(watch.repo_id, { last_polled_at: new Date().toISOString(), last_error: null });
			} catch (err) {
				log("error", "poll failed", { repo: watch.repo, error: errorMessage(err) });
				db.updateWatch(watch.repo_id, { last_error: `${new Date().toISOString()}: ${errorMessage(err)}` });
			}
		}
		// Then every tracked issue, whatever its repository.
		for (const open of db.openIssues()) {
			if (deps.signal.aborted) return;
			const issue = db.getIssue(open.id);
			if (!issue || TERMINAL_STATES[issue.state]) continue;
			try {
				if (issue.state === "in_review" && issue.pr_number) await review(issue);
				else if (!issue.pr_number) await cancellation(issue);
				issueErrors.delete(issue.id);
			} catch (err) {
				recordIssueError(issue, err);
			}
		}
	}

	function schedule(delayMs: number): void {
		clearTimeout(timer);
		if (stopped) return;
		timer = setTimeout(run, delayMs);
	}

	function run(): void {
		if (inFlight) {
			rerun = true;
			return;
		}
		// Only callers that asked before this cycle started are answered by it.
		const answered = waiters;
		waiters = [];
		inFlight = cycle()
			.catch(err => log("error", "poll cycle failed", { error: errorMessage(err) }))
			.finally(() => {
				inFlight = undefined;
				for (const resolve of answered) resolve();
				const again = rerun;
				rerun = false;
				schedule(again ? 0 : intervalMs);
			});
	}

	deps.signal.addEventListener("abort", () => stop(), { once: true });

	function stop(): void {
		stopped = true;
		clearTimeout(timer);
		for (const resolve of waiters.splice(0)) resolve();
	}

	return {
		cycle,
		stop,
		start() {
			stopped = false;
			schedule(0);
		},
		pollNow(repo) {
			log("debug", "poll requested", { repo });
			const { promise, resolve } = Promise.withResolvers<void>();
			if (stopped) {
				resolve();
				return promise;
			}
			waiters.push(resolve);
			if (inFlight) rerun = true;
			else schedule(0);
			return promise;
		},
		status() {
			return {
				watches: db.listWatches().map(w => ({
					repo: w.repo,
					channelId: w.channel_id,
					state: w.state,
					...(w.last_polled_at ? { lastPollAt: w.last_polled_at } : {}),
					...(w.last_error ? { lastError: w.last_error } : {}),
				})),
				issueErrors: [...issueErrors.values()],
			};
		},
	};
}
