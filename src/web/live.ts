import type { StatusReport } from "../shared/adminApi";

/*
 * The functions in this module render on the server and are also shipped verbatim (`Function.prototype.toString`)
 * in the status page script, which re-renders the live sections from `/status.json`. They must therefore only
 * reference each other and browser/runtime globals.
 */

/** Table cell: plain text or `[text, href]`. */
export type Cell = string | [text: string, href: string];

export interface LiveContext {
	/** Discord guild for thread and channel links; undefined while the settings can't be read. */
	guildId?: string;
	now: number;
}

export interface LiveView {
	/** Label/value rows of the "Current state" table. */
	state: [string, Cell][];
	watches: Cell[][];
	/** Label/value rows of the limits table; empty while the settings are locked or not saved (RUN-12). */
	limits: [string, Cell][];
	warnings: string[][];
	open: Cell[][];
	/** Connected workers: id, address, run, phase, omp version, connected for (§9.3). */
	workers: Cell[][];
}

/** `$1.23`; four decimals for non-zero amounts under a cent. */
export function formatUsd(value: number): string {
	return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

export function formatCount(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/** `45s`, `3m 12s`, `1h 5m`, `2d 3h`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** ISO timestamp → `2026-10-15 12:34:56 UTC`. */
export function formatTime(iso: string): string {
	return `${iso.slice(0, 19).replace("T", " ")} UTC`;
}

export function liveView(report: StatusReport, ctx: LiveContext): LiveView {
	const discordLink = (text: string, id: string | null): Cell =>
		ctx.guildId && id ? [text, `https://discord.com/channels/${encodeURIComponent(ctx.guildId)}/${encodeURIComponent(id)}`] : text;
	const { state: admin, engine, runs } = report;
	const state: [string, Cell][] = [
		["Engine", admin.phase],
		["Since", formatTime(admin.since)],
	];
	if (admin.error) state.push(["Error", admin.error]);
	if (engine) {
		const { discord, discordQueue } = engine;
		const discordParts = [discord.ready ? "ready" : "not ready"];
		if (discord.user) discordParts.push(`as ${discord.user}`);
		if (discord.pingMs !== undefined && discord.pingMs >= 0) discordParts.push(`ping ${discord.pingMs} ms`);
		state.push(["Uptime", formatDuration(ctx.now - Date.parse(engine.startedAt))], ["Discord", discordParts.join(" · ")]);
		if (discord.nicknameWarning) state.push(["Nickname", discord.nicknameWarning]);
		state.push(
			["GitHub App", engine.githubApp],
			[
				"Discord write queue",
				`${formatCount(discordQueue.length)} queued${discordQueue.oldestAgeMs === null ? "" : ` · oldest ${formatDuration(discordQueue.oldestAgeMs)}`}`,
			],
			["Queued jobs", formatCount(engine.queuedJobs)],
		);
	}
	state.push([
		"Runs",
		`${formatCount(runs.pending)} pending${runs.oldestPendingMs === null ? "" : ` (oldest ${formatDuration(runs.oldestPendingMs)})`} · ${formatCount(runs.running)} running`,
	]);

	const watches: Cell[][] = (engine?.watches ?? []).map(watch => [
		[watch.repo, `https://github.com/${watch.repo}`],
		watch.channelId ? discordLink(`#${watch.channelId}`, watch.channelId) : "—",
		watch.state,
		watch.lastPollAt ? formatTime(watch.lastPollAt) : "never",
		watch.lastError ?? "",
	]);

	const limits: [string, Cell][] = report.limits
		? [
				["Max concurrent jobs", formatCount(report.limits.maxConcurrentJobs)],
				["Max chat sessions", formatCount(report.limits.maxChatSessions)],
				["Max concurrent runs", formatCount(report.limits.maxConcurrentRuns)],
				["Worker capacity", formatCount(report.limits.workerCapacity)],
				["Effective concurrency", formatCount(report.limits.effectiveConcurrency)],
			]
		: [];
	const warnings = report.warnings.map(warning => [warning]);

	const open: Cell[][] = report.issues.open.map(issue => [
		[`${issue.repo}#${issue.number}`, `https://github.com/${issue.repo}/issues/${issue.number}`],
		issue.title,
		issue.state,
		issue.job ?? "",
		issue.threadId ? discordLink("thread", issue.threadId) : "",
	]);
	const workers: Cell[][] = report.workers.map(worker => [
		worker.id,
		worker.address,
		worker.runId ?? "",
		worker.phase ?? "",
		worker.ompVersion,
		formatDuration(ctx.now - Date.parse(worker.connectedAt)),
	]);
	return { state, watches, limits, warnings, open, workers };
}
