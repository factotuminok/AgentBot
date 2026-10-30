import { describe, expect, test } from "bun:test";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { issueOverview, latestLoadouts, loadoutKey, parseUsageWindow, usageReport } from "../../src/orchestrator/store/stats";
import type { Loadout } from "../../src/shared/agent";
import type { RunUsage } from "../../src/shared/transcript";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function usage(costUsd: number, input = 100, output = 10): RunUsage {
	return { costUsd, input, output, cacheRead: 5, cacheWrite: 1 };
}

/** Inserts a run whose `finished_at` is `hoursAgo` before NOW (recordRun stamps the real clock, so patch it). */
function run(db: Db, kind: "plan" | "implement" | "chat", repo: string, costUsd: number, hoursAgo: number, jobId?: string) {
	db.recordRun({ kind, repo, jobId, threadId: "t", startedAt: NOW.toISOString(), usage: usage(costUsd) });
	const at = new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
	db.raw.run("UPDATE agent_runs SET finished_at = ? WHERE id = (SELECT MAX(id) FROM agent_runs)", [at]);
}

describe("usageReport", () => {
	test("windows filter by finish time and totals split by kind and repo, sorted by cost", () => {
		const db = openDb(":memory:");
		run(db, "plan", "o/a", 1, 1);
		run(db, "implement", "o/a", 2, 30);
		run(db, "chat", "o/b", 0.5, 24 * 10);
		run(db, "plan", "o/b", 4, 24 * 40);

		const day = usageReport(db, "24h", NOW);
		expect(day.totals).toEqual({ runs: 1, costUsd: 1, tokensIn: 100, tokensOut: 10, cacheRead: 5, cacheWrite: 1 });
		expect(day.since).toBe("2026-10-14T12:00:00.000Z");

		const week = usageReport(db, "7d", NOW);
		expect(week.totals.runs).toBe(2);
		expect(week.byKind).toEqual([
			{ kind: "implement", runs: 1, costUsd: 2 },
			{ kind: "plan", runs: 1, costUsd: 1 },
		]);

		const all = usageReport(db, "all", NOW);
		expect(all.since).toBeUndefined();
		expect(all.totals.costUsd).toBe(7.5);
		expect(all.byRepo).toEqual([
			{ repo: "o/b", runs: 2, costUsd: 4.5 },
			{ repo: "o/a", runs: 2, costUsd: 3 },
		]);
	});

	test("daily series covers 14 UTC days oldest first, zero-filled", () => {
		const db = openDb(":memory:");
		run(db, "plan", "o/a", 1, 1);
		run(db, "plan", "o/a", 2, 2);
		run(db, "plan", "o/a", 3, 24 * 3);
		run(db, "plan", "o/a", 9, 24 * 20);
		const { daily } = usageReport(db, "7d", NOW);
		expect(daily).toHaveLength(14);
		expect(daily[0]!.day).toBe("2026-10-02");
		expect(daily.at(-1)).toEqual({ day: "2026-10-15", costUsd: 3 });
		expect(daily.find(d => d.day === "2026-10-12")).toEqual({ day: "2026-10-12", costUsd: 3 });
		expect(daily.reduce((sum, d) => sum + d.costUsd, 0)).toBe(6);
	});

	test("job outcomes count statuses per kind", () => {
		const db = openDb(":memory:");
		const issue = db.insertIssue("o/a", 1, "t");
		const ok = db.insertJob(issue.id, "plan");
		db.claimNextJob();
		db.finishJob(ok.id, { status: "succeeded" });
		const bad = db.insertJob(issue.id, "implement");
		db.claimNextJob();
		db.finishJob(bad.id, { status: "failed", error: "boom" });

		const { jobs } = usageReport(db, "all");
		expect(jobs.map(j => [j.kind, j.succeeded, j.failed, j.cancelled])).toEqual([
			["implement", 0, 1, 0],
			["plan", 1, 0, 0],
		]);
		expect(jobs[1]!.avgDurationMs).toBeGreaterThanOrEqual(0);
	});

	test("setup time: claim and agent start are recorded; per repository over the window, slowest average first (NFR-06)", () => {
		const db = openDb(":memory:");
		// Recording: the claim stamps claimed_at, `registered` (→ running) stamps started_at.
		const recorded = db.insertRun({ kind: "draft", draftId: "d0", repo: "o/a" });
		const claimed = db.claimRun("worker-1", 60_000)!;
		expect(claimed.id).toBe(recorded.id);
		expect(claimed.claimed_at).not.toBeNull();
		expect(claimed.started_at).toBeNull();
		const started = db.transitionRun(recorded.id, ["assigned"], "running")!;
		expect(Date.parse(started.started_at!)).toBeGreaterThanOrEqual(Date.parse(claimed.claimed_at!));

		const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
		const setupRun = (id: string, repo: string | undefined, setupMs: number, startedMsAgo: number) => {
			const row = db.insertRun({ kind: repo ? "draft" : "ask", draftId: id, ...(repo ? { repo } : {}) });
			db.raw.run("UPDATE runs SET claimed_at = ?, started_at = ? WHERE id = ?", [at(startedMsAgo + setupMs), at(startedMsAgo), row.id]);
		};
		db.raw.run("DELETE FROM runs");
		setupRun("d1", "o/fast", 10_000, 3_600_000);
		setupRun("d2", "o/slow", 300_000, 3_600_000);
		setupRun("d3", "o/slow", 100_000, 7_200_000);
		setupRun("d4", undefined, 4_000, 3_600_000);
		setupRun("d5", "o/fast", 900_000, 3 * 86_400_000); // outside 24h
		// Never started (still setting up): not counted.
		db.insertRun({ kind: "draft", draftId: "d6", repo: "o/fast" });

		expect(usageReport(db, "24h", NOW).setup).toEqual([
			{ repo: "o/slow", runs: 2, avgMs: 200_000, maxMs: 300_000 },
			{ repo: "o/fast", runs: 1, avgMs: 10_000, maxMs: 10_000 },
			{ repo: "ask", runs: 1, avgMs: 4_000, maxMs: 4_000 },
		]);
		expect(usageReport(db, "7d", NOW).setup[0]).toEqual({ repo: "o/fast", runs: 2, avgMs: 455_000, maxMs: 900_000 });
	});
});

test("parseUsageWindow falls back to 7d for unknown values", () => {
	expect(parseUsageWindow("24h")).toBe("24h");
	expect(parseUsageWindow("all")).toBe("all");
	expect(parseUsageWindow("toString")).toBe("7d");
	expect(parseUsageWindow(null)).toBe("7d");
});

test("issueOverview counts every state and lists open issues with their active job", () => {
	const db = openDb(":memory:");
	const a = db.insertIssue("o/a", 1, "one");
	db.insertJob(a.id, "plan");
	const b = db.insertIssue("o/a", 2, "two");
	db.updateIssue(b.id, { state: "done" });
	const overview = issueOverview(db);
	expect(overview.counts).toMatchObject({ queued: 1, done: 1, planning: 0 });
	expect(overview.open).toHaveLength(1);
	expect(overview.open[0]).toMatchObject({ number: 1, state: "queued", job: "plan", threadId: null });
});

test("latestLoadouts returns stored loadouts in profile order", () => {
	const db = openDb(":memory:");
	const loadout = (profile: Loadout["profile"]): Loadout => ({ capturedAt: NOW.toISOString(), profile, tools: [], skills: [], agents: [], mcp: [] });
	db.kvSet(loadoutKey("chat"), JSON.stringify(loadout("chat")));
	db.kvSet(loadoutKey("plan"), JSON.stringify(loadout("plan")));
	expect(latestLoadouts(db).map(l => l.profile)).toEqual(["plan", "chat"]);
});
