import type { StatusReport, UsageWindow } from "../shared/adminApi";
import { type Cell, formatCount, formatDuration, formatTime, formatUsd, type LiveContext, liveView } from "./live";
import { esc, layout, nav, table } from "./views";

export const USAGE_WINDOWS: readonly UsageWindow[] = ["24h", "7d", "30d", "all"];
export const WINDOW_LABELS: Record<UsageWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", all: "All time" };
export const DEFAULT_WINDOW: UsageWindow = "7d";

type Usage = StatusReport["usage"];

const USAGE_HEADERS = ["Runs", "Cost", "Tokens in", "Tokens out", "Cache read", "Cache write"];

function totalsCells(totals: Usage["totals"]): Cell[] {
	return [
		formatCount(totals.runs),
		formatUsd(totals.costUsd),
		formatCount(totals.tokensIn),
		formatCount(totals.tokensOut),
		formatCount(totals.cacheRead),
		formatCount(totals.cacheWrite),
	];
}

function outcomeCells(job: Usage["jobs"][number]): Cell[] {
	const finished = job.succeeded + job.failed + job.cancelled;
	return [
		job.kind,
		formatCount(job.succeeded),
		formatCount(job.failed),
		formatCount(job.cancelled),
		finished ? `${Math.round((job.succeeded / finished) * 100)}%` : "—",
		job.avgDurationMs === null ? "—" : formatDuration(job.avgDurationMs),
	];
}

function dailyChart(daily: Usage["daily"]): string {
	const max = Math.max(0, ...daily.map(d => d.costUsd));
	const bars = daily.map(d => {
		const pct = max > 0 ? (d.costUsd / max) * 100 : 0;
		return `<div class="day" title="${esc(`${d.day}: ${formatUsd(d.costUsd)}`)}"><span>${esc(d.costUsd > 0 ? formatUsd(d.costUsd) : "")}</span>
<div class="track"><div class="bar" style="height:${pct.toFixed(1)}%"></div></div><span>${esc(d.day.slice(5))}</span></div>`;
	});
	return `<div class="chart" role="img" aria-label="Daily cost for the last ${daily.length} days">${bars.join("\n")}</div>`;
}

function usageSection(usage: Usage): string {
	const windows = USAGE_WINDOWS.map(window =>
		window === usage.window
			? `<strong aria-current="page">${esc(WINDOW_LABELS[window])}</strong>`
			: `<a href="/status?window=${window}">${esc(WINDOW_LABELS[window])}</a>`,
	);
	return `<section id="usage"><h2>Usage</h2>
<p>Window: ${windows.join(" · ")}${usage.since ? ` <span class="hint">(since ${esc(formatTime(usage.since))})</span>` : ""}</p>
<h3>Totals</h3>
${table(USAGE_HEADERS, [totalsCells(usage.totals)], "")}
<h3>By kind</h3>
${table(["Kind", "Runs", "Cost"], usage.byKind.map(row => [row.kind, formatCount(row.runs), formatUsd(row.costUsd)]), "No runs in this window.")}
<h3>By repository</h3>
${table(["Repository", "Runs", "Cost"], usage.byRepo.map(row => [row.repo, formatCount(row.runs), formatUsd(row.costUsd)]), "No runs in this window.")}
<h3>Job outcomes</h3>
${table(["Kind", "Succeeded", "Failed", "Cancelled", "Success rate", "Avg duration"], usage.jobs.map(outcomeCells), "No finished jobs in this window.")}
<h3>Daily cost (last ${usage.daily.length} days)</h3>
${dailyChart(usage.daily)}
</section>`;
}

/** Replaces the rows of a `tbody` with text-only cells (links for `[text, href]`). */
const FILL_JS = `function fill(id, rows, empty) {
	const body = document.getElementById(id);
	const span = body.closest("table").tHead?.rows[0]?.cells.length || 1;
	body.replaceChildren(...(rows.length ? rows : [[empty]]).map(cells => {
		const tr = document.createElement("tr");
		for (const cell of cells) {
			const td = tr.insertCell();
			if (Array.isArray(cell)) {
				const a = document.createElement("a");
				a.href = cell[1];
				a.textContent = cell[0];
				td.append(a);
			} else td.textContent = cell;
		}
		if (!rows.length) tr.cells[0].colSpan = span;
		return tr;
	}));
}`;

/** Polls `/status.json` and re-renders the live sections with the same `liveView` the server uses. */
const STATUS_PAGE_SCRIPT = `<script>
${[formatUsd, formatCount, formatDuration, formatTime, liveView].map(fn => fn.toString()).join("\n")}
${FILL_JS}
const root = document.getElementById("status-root");
setInterval(async () => {
	try {
		const res = await fetch("/status.json" + location.search, { headers: { accept: "application/json" } });
		if (!res.ok) return;
		const data = await res.json();
		const view = liveView(data, { guildId: root.dataset.guild || undefined, now: Date.now() });
		fill("state-rows", view.state, "");
		fill("watch-rows", view.watches, "No watched repositories.");
		fill("limit-rows", view.limits, "Limits are shown once the settings are saved and unlocked.");
		fill("warning-rows", view.warnings, "No warnings.");
		fill("open-rows", view.open, "No open issues.");
	} catch {}
}, 5000);
</script>`;

export interface StatusPageOptions {
	report: StatusReport;
	context: LiveContext;
}

export function statusPage(opts: StatusPageOptions): string {
	const { report } = opts;
	const view = liveView(report, opts.context);
	const states = Object.keys(report.issues.counts);
	return layout(
		"Status",
		`${nav("status")}
<main id="status-root" data-guild="${esc(opts.context.guildId ?? "")}">
<h1>Status</h1>
<section id="current" class="status" aria-live="polite"><h2>Current state</h2>
${table([], view.state, "", "state-rows")}
</section>
<section id="watches"><h2>Watched repositories</h2>
${table(["Repository", "Channel", "State", "Last poll", "Last error"], view.watches, "No watched repositories.", "watch-rows")}
</section>
<section id="limits"><h2>Concurrency limits</h2>
${table([], view.limits, "Limits are shown once the settings are saved and unlocked.", "limit-rows")}
${table(["Warnings"], view.warnings, "No warnings.", "warning-rows")}
</section>
<section id="issues"><h2>Issues</h2>
${table(states, states.length ? [states.map(state => formatCount(report.issues.counts[state] ?? 0))] : [], "No issues.")}
<h3>Open issues</h3>
${table(["Issue", "Title", "State", "Job", "Thread"], view.open, "No open issues.", "open-rows")}
</section>
${usageSection(report.usage)}
</main>
${STATUS_PAGE_SCRIPT}`,
	);
}
