import type { Loadout } from "../../shared/agent";
import type { StatusReport, UsageWindow } from "../../shared/adminApi";
import type { IssueState, JobKind, RunKind } from "../engine/state";
import type { Db } from "./db";

/** Usage accounting and issue overview for the status page (OBS-06), read from the database. Ported from DevForge `src/stats.ts`. */

export type UsageReport = StatusReport["usage"];
export type IssueOverview = StatusReport["issues"];

export const USAGE_WINDOWS: Readonly<Record<UsageWindow, number | undefined>> = Object.freeze({
	"24h": 24 * 3_600_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
	all: undefined,
});

export const DEFAULT_USAGE_WINDOW: UsageWindow = "7d";

/** `?window=` value; unknown or missing → the default window. */
export function parseUsageWindow(raw: string | null | undefined): UsageWindow {
	return raw && Object.hasOwn(USAGE_WINDOWS, raw) ? (raw as UsageWindow) : DEFAULT_USAGE_WINDOW;
}

const DAILY_DAYS = 14;

const TOTALS_SQL = `COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(tokens_in), 0) AS tokensIn,
	COALESCE(SUM(tokens_out), 0) AS tokensOut, COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite`;

/**
 * OBS-06: totals for the window, by kind and by repo (sorted by cost), job outcomes and mean duration per kind, and the
 * cost per UTC day for the last 14 days (oldest first, zero-filled, independent of the window).
 */
export function usageReport(db: Db, window: UsageWindow, now = new Date()): UsageReport {
	const span = USAGE_WINDOWS[window];
	// "" sorts before every ISO timestamp, so it selects all rows for the unbounded window.
	const since = span === undefined ? "" : new Date(now.getTime() - span).toISOString();
	const raw = db.raw;

	const totals = raw.query<UsageReport["totals"], [string]>(`SELECT ${TOTALS_SQL} FROM agent_runs WHERE finished_at >= ?`).get(since)!;
	const byKind = raw
		.query<{ kind: RunKind; runs: number; costUsd: number }, [string]>(
			`SELECT kind, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd FROM agent_runs WHERE finished_at >= ?
			GROUP BY kind ORDER BY costUsd DESC, kind`,
		)
		.all(since);
	const byRepo = raw
		.query<{ repo: string; runs: number; costUsd: number }, [string]>(
			`SELECT repo, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd FROM agent_runs WHERE finished_at >= ?
			GROUP BY repo ORDER BY costUsd DESC, repo`,
		)
		.all(since);
	const jobs = raw
		.query<{ kind: JobKind; succeeded: number; failed: number; cancelled: number; avgDurationMs: number | null }, [string]>(
			`SELECT kind,
				SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed, SUM(status = 'cancelled') AS cancelled,
				AVG(CASE WHEN started_at IS NOT NULL
					THEN (julianday(finished_at) - julianday(started_at)) * 86400000 END) AS avgDurationMs
			FROM jobs WHERE finished_at IS NOT NULL AND finished_at >= ? GROUP BY kind ORDER BY kind`,
		)
		.all(since);

	const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DAILY_DAYS - 1)));
	const perDay = new Map<string, number>();
	for (const row of raw
		.query<{ day: string; costUsd: number }, [string]>(
			`SELECT substr(finished_at, 1, 10) AS day, SUM(cost_usd) AS costUsd FROM agent_runs WHERE finished_at >= ? GROUP BY day`,
		)
		.all(firstDay.toISOString())) {
		perDay.set(row.day, row.costUsd);
	}
	const daily = Array.from({ length: DAILY_DAYS }, (_, i) => {
		const day = new Date(firstDay.getTime() + i * 86_400_000).toISOString().slice(0, 10);
		return { day, costUsd: perDay.get(day) ?? 0 };
	});

	return { window, ...(span === undefined ? {} : { since }), totals, byKind, byRepo, jobs, daily };
}

/** Issue counts for every state, and the open issues with their active job. */
export function issueOverview(db: Db): IssueOverview {
	const counts: Record<IssueState, number> = {
		queued: 0,
		planning: 0,
		awaiting_approval: 0,
		implementing: 0,
		in_review: 0,
		done: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const row of db.raw.query<{ state: IssueState; n: number }, []>("SELECT state, COUNT(*) AS n FROM issues GROUP BY state").all()) {
		counts[row.state] = row.n;
	}
	const open = db.openIssues().map(issue => {
		const job = db.activeJob(issue.id);
		return {
			repo: issue.repo,
			number: issue.number,
			title: issue.title,
			state: issue.state,
			threadId: issue.thread_id,
			...(job ? { job: job.kind } : {}),
		};
	});
	return { counts, open };
}

const LOADOUT_PROFILES = ["plan", "implement", "chat", "draft", "ask"] as const satisfies readonly Loadout["profile"][];

/** kv key holding the most recent loadout seen for a profile (survives restarts, AGT-27). */
export function loadoutKey(profile: Loadout["profile"]): string {
	return `loadout:${profile}`;
}

/** Most recent loadout per profile, in plan/implement/chat/draft/ask order; profiles never run are omitted. */
export function latestLoadouts(db: Db): Loadout[] {
	return LOADOUT_PROFILES.flatMap(profile => {
		const raw = db.kvGet(loadoutKey(profile));
		return raw ? [JSON.parse(raw) as Loadout] : [];
	});
}
