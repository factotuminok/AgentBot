import { LOG_FILES_PATH, LOG_STREAM_PATH, type LogEntry, type LogFiles, LOGS_PAGE_ENTRIES, type LogsOverview, MAX_LOG_ROWS } from "../shared/adminLogs";
import type { LogSegment } from "../shared/rollinglog";
import type { TranscriptEvent } from "../shared/transcript";
import type { AdminClient } from "./adminClient";
import { html, json, type PageRoutes, respond } from "./http";
import { formatCount, formatTime, formatUsd } from "./live";
import { type LogEntryView, logEntryView } from "./logview";
import { cellHtml, esc, layout, nav, notFoundPage, table } from "./views";

/**
 * `/logs` (OBS-03, OBS-04, §9.3): a live tail of the agent transcripts and the agent and orchestrator log files. The
 * event stream and the downloads are proxied from the orchestrator's admin API; web never reads log files itself.
 */

const ENTRY_TYPES: readonly TranscriptEvent["type"][] = ["prompt", "steer", "assistant", "tool_start", "tool_end", "run_end"];
const STREAM_PATH = "/logs/stream";
const FILES_PATH = "/logs/files/";

/** `1.2 GB` (binary units). */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

const LOGS_STYLE = `<style>
.toolbar { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; margin: .5rem 0; }
.toolbar label { display: inline; margin: 0; }
.log { max-height: 70vh; overflow: auto; border: 1px solid var(--border); border-radius: 4px; font-size: .9em; }
.entry { border-bottom: 1px solid var(--rule); padding: .3rem .5rem; }
.entry .meta { display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; color: var(--muted-strong); }
.entry pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: .25rem 0; font-size: .95em; }
.entry.error .badge { background: var(--error-bg); color: var(--error-fg); }
.conn { font-size: .9em; }
</style>`;

function entryHtml(view: LogEntryView): string {
	const blocks = view.blocks.map(block => {
		const pre = `<pre>${esc(block.text)}</pre>`;
		return block.label ? `<details${block.open ? " open" : ""}><summary>${esc(block.label)}</summary>${pre}</details>` : pre;
	});
	return `<article class="entry${view.error ? " error" : ""}" data-seq="${view.seq}" data-run="${esc(view.run)}" data-run-label="${esc(view.runLabel)}" data-type="${esc(view.type)}">
<div class="meta"><time>${esc(view.time)}</time> <span>${view.links.map(cellHtml).join(" · ")}</span> <span class="badge">${esc(view.type)}</span> <strong>${esc(view.head)}</strong></div>
${blocks.join("\n")}</article>`;
}

/** Builds the same markup as `entryHtml` with DOM APIs (text via `textContent` only). */
const ENTRY_ELEMENT_JS = `function entryElement(view) {
	const el = document.createElement("article");
	el.className = view.error ? "entry error" : "entry";
	Object.assign(el.dataset, { seq: String(view.seq), run: view.run, runLabel: view.runLabel, type: view.type });
	const meta = el.appendChild(document.createElement("div"));
	meta.className = "meta";
	meta.appendChild(document.createElement("time")).textContent = view.time;
	const links = meta.appendChild(document.createElement("span"));
	view.links.forEach((cell, i) => {
		if (i) links.append(" · ");
		if (Array.isArray(cell)) {
			const a = links.appendChild(document.createElement("a"));
			a.href = cell[1];
			a.textContent = cell[0];
		} else links.append(cell);
	});
	const badge = meta.appendChild(document.createElement("span"));
	badge.className = "badge";
	badge.textContent = view.type;
	meta.appendChild(document.createElement("strong")).textContent = view.head;
	for (const block of view.blocks) {
		const pre = document.createElement("pre");
		pre.textContent = block.text;
		if (!block.label) {
			el.appendChild(pre);
			continue;
		}
		const details = el.appendChild(document.createElement("details"));
		details.open = block.open;
		details.appendChild(document.createElement("summary")).textContent = block.label;
		details.appendChild(pre);
	}
	return el;
}`;

const LOGS_SCRIPT = `<script>
${[formatUsd, formatCount, formatTime, logEntryView].map(fn => fn.toString()).join("\n")}
${ENTRY_ELEMENT_JS}
(() => {
	const root = document.getElementById("logs-root");
	const guildId = root.dataset.guild || undefined;
	const list = document.getElementById("log-rows");
	const runSelect = document.getElementById("f-run");
	const textFilter = document.getElementById("f-text");
	const typeBoxes = [...document.querySelectorAll("input[name=type]")];
	const pauseButton = document.getElementById("pause");
	const follow = document.getElementById("follow");
	const conn = document.getElementById("conn");
	const runs = new Set();
	let lastSeq = Number(root.dataset.after) || 0;
	let paused = false;
	let pending = [];

	function addRun(run, label) {
		if (runs.has(run)) return;
		runs.add(run);
		const option = runSelect.appendChild(document.createElement("option"));
		option.value = run;
		option.textContent = label;
	}
	function matches(el) {
		const query = textFilter.value.trim().toLowerCase();
		if (runSelect.value && el.dataset.run !== runSelect.value) return false;
		if (!typeBoxes.some(box => box.checked && box.value === el.dataset.type)) return false;
		return !query || el.textContent.toLowerCase().includes(query);
	}
	function applyFilters() {
		for (const el of list.children) el.hidden = !matches(el);
	}
	function scrollToEnd() {
		if (follow.checked) list.scrollTop = list.scrollHeight;
	}
	function append(entries) {
		for (const entry of entries) {
			const el = entryElement(logEntryView(entry, guildId));
			addRun(el.dataset.run, el.dataset.runLabel);
			el.hidden = !matches(el);
			list.appendChild(el);
		}
		while (list.children.length > ${MAX_LOG_ROWS}) list.firstElementChild.remove();
		scrollToEnd();
	}
	function setStatus(text) {
		conn.textContent = text;
	}

	for (const el of list.children) addRun(el.dataset.run, el.dataset.runLabel);
	for (const control of [runSelect, textFilter, ...typeBoxes]) control.addEventListener("input", applyFilters);
	follow.addEventListener("change", scrollToEnd);
	pauseButton.addEventListener("click", () => {
		paused = !paused;
		if (!paused) {
			append(pending);
			pending = [];
		}
		pauseButton.textContent = paused ? "Resume" : "Pause";
	});
	scrollToEnd();

	const source = new EventSource(${JSON.stringify(STREAM_PATH)} + "?after=" + lastSeq);
	source.onopen = () => setStatus("● live");
	source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "○ disconnected (reload to retry)" : "◌ reconnecting…");
	source.onmessage = event => {
		const entry = JSON.parse(event.data);
		if (entry.seq <= lastSeq) return;
		lastSeq = entry.seq;
		if (!paused) return append([entry]);
		pending.push(entry);
		if (pending.length > ${MAX_LOG_ROWS}) pending.shift();
		pauseButton.textContent = "Resume (" + pending.length + " new)";
	};
})();
</script>`;

function segmentRows(segments: LogSegment[]) {
	return segments.map(segment => [
		[segment.name, `${FILES_PATH}${encodeURIComponent(segment.name)}`] as [string, string],
		formatBytes(segment.bytes),
		formatTime(segment.modifiedAt),
	]);
}

function usageLine(files: LogFiles): string {
	const total = formatBytes(files.segments.reduce((sum, segment) => sum + segment.bytes, 0));
	return `${total}${files.maxBytes === undefined ? "" : ` of ${formatBytes(files.maxBytes)}`} used; the oldest files are deleted automatically.`;
}

export interface LogsPageOptions {
	entries: LogEntry[];
	agent: LogFiles;
	process: LogFiles;
	guildId?: string;
	vscode: boolean;
}

export function logsPage(opts: LogsPageOptions): string {
	const after = opts.entries.at(-1)?.seq ?? 0;
	const typeBoxes = ENTRY_TYPES.map(type => `<label><input type="checkbox" name="type" value="${type}" checked> ${type}</label>`);
	return layout(
		"Logs",
		`${LOGS_STYLE}
${nav("logs", opts.vscode)}
<main id="logs-root" data-guild="${esc(opts.guildId ?? "")}" data-after="${after}">
<h1>Agent log</h1>
<div class="toolbar">
<label>Run <select id="f-run"><option value="">All runs</option></select></label>
<label>Search <input type="search" id="f-text" placeholder="filter text"></label>
<button type="button" id="pause">Pause</button>
<label><input type="checkbox" id="follow" checked> Follow</label>
<span id="conn" class="conn" role="status">○ connecting…</span>
</div>
<div class="toolbar">${typeBoxes.join(" ")}</div>
<div id="log-rows" class="log">
${opts.entries.map(entry => entryHtml(logEntryView(entry, opts.guildId))).join("\n")}
</div>
<section id="log-files"><h2>Agent log files</h2>
<p>${esc(usageLine(opts.agent))}</p>
${table(["File", "Size", "Modified"], segmentRows(opts.agent.segments), "No log files yet.")}
</section>
<section id="process-log-files"><h2>Orchestrator log files</h2>
<p>${esc(usageLine(opts.process))}</p>
${table(["File", "Size", "Modified"], segmentRows(opts.process.segments), "No log files yet.")}
</section>
</main>
${LOGS_SCRIPT}`,
	);
}

/** Discord guild for thread links; best effort (locked settings read as none). */
async function guildId(admin: AdminClient): Promise<string | undefined> {
	try {
		return (await admin.settings()).config?.discord.guildId;
	} catch {
		return undefined;
	}
}

export const logsPages: PageRoutes = {
	"GET /logs": {
		async handle(_req, _url, { admin, vscode }) {
			const [overview, guild] = await Promise.all([admin.call<LogsOverview>("GET", `/logs?limit=${LOGS_PAGE_ENTRIES}`), guildId(admin)]);
			return html(logsPage({ ...overview, guildId: guild, vscode }));
		},
	},
	/** Proxies the orchestrator's event stream; it ends when the browser goes away (`req.signal`). */
	[`GET ${STREAM_PATH}`]: {
		json: true,
		async handle(req, url, { admin }) {
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			const lastEventId = req.headers.get("last-event-id");
			if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId;
			const after = url.searchParams.get("after");
			const query = after === null ? "" : `?after=${encodeURIComponent(after)}`;
			const upstream = await admin.fetch("GET", `${LOG_STREAM_PATH}${query}`, { headers, signal: req.signal });
			if (!upstream.ok || !upstream.body) {
				await upstream.body?.cancel();
				return json({ error: `log stream unavailable (HTTP ${upstream.status})` }, 502);
			}
			return respond(upstream.body, 200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
		},
	},
	/** Proxies one log segment download; the orchestrator serves only the names its logs list. */
	[`GET ${FILES_PATH}`]: {
		async handle(req, url, { admin }) {
			const name = url.pathname.slice(FILES_PATH.length);
			if (!name || name.includes("/")) return html(notFoundPage(), 404);
			const upstream = await admin.fetch("GET", `${LOG_FILES_PATH}${name}`, { signal: req.signal });
			if (!upstream.ok || !upstream.body) {
				await upstream.body?.cancel();
				return html(notFoundPage(), 404);
			}
			return respond(upstream.body, 200, {
				"Content-Type": upstream.headers.get("content-type") ?? "application/x-ndjson",
				"Content-Disposition": upstream.headers.get("content-disposition") ?? "attachment",
			});
		},
	},
};
