import { LOG_FILES_PATH, LOG_STREAM_PATH, LOG_STREAM_PING_MS, type LogEntry, LOGS_PAGE_ENTRIES, type LogsOverview, MAX_LOG_ROWS } from "../../shared/adminLogs";
import type { RollingFiles } from "../../shared/rollinglog";
import type { AgentLog, AgentLogEntry } from "../store/agentlog";
import { type AdminRoutes, fail } from "./http";

/** The `/logs` page's data (OBS-03, OBS-04): the agent log tail as an event stream, and both logs' files. */

export interface LogsRoutesOptions {
	agentLog: AgentLog;
	/** The orchestrator's own rolling process log (`processLog` in `main.ts`). */
	processLog: RollingFiles;
	/** Comment ping interval of the stream; default `LOG_STREAM_PING_MS` (tests shorten it). */
	pingMs?: number;
}

/** A sequence number cursor, or undefined for anything else. */
function cursor(value: string | null): number | undefined {
	return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

export function createLogsRoutes(opts: LogsRoutesOptions): AdminRoutes {
	const { agentLog, processLog } = opts;
	const pingMs = opts.pingMs ?? LOG_STREAM_PING_MS;

	function overview(url: URL): Response {
		const limit = cursor(url.searchParams.get("limit")) ?? LOGS_PAGE_ENTRIES;
		const body: LogsOverview = {
			entries: agentLog.recent(Math.min(limit, MAX_LOG_ROWS)) satisfies LogEntry[],
			agent: { segments: agentLog.segments(), maxBytes: agentLog.maxBytes },
			process: { segments: processLog.segments(), maxBytes: processLog.maxBytes },
		};
		return Response.json(body);
	}

	/**
	 * Entries after `Last-Event-ID` (a reconnect) or `?after=`, then every new entry, with a comment ping every
	 * `pingMs`. Without either cursor only new entries are sent. Ends when the client goes away.
	 */
	function stream(req: Request, url: URL): Response {
		const after = cursor(req.headers.get("last-event-id")) ?? cursor(url.searchParams.get("after"));
		const encoder = new TextEncoder();
		let cleanup = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (text: string) => {
					try {
						controller.enqueue(encoder.encode(text));
					} catch {
						cleanup();
					}
				};
				const sendEntry = (entry: AgentLogEntry) => send(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
				send(": connected\n\n");
				// Backlog and subscription happen in one synchronous turn, so no entry can fall between them.
				if (after !== undefined) for (const entry of agentLog.recent(MAX_LOG_ROWS, after)) sendEntry(entry);
				const unsubscribe = agentLog.subscribe(sendEntry);
				const ping = setInterval(() => send(": ping\n\n"), pingMs);
				cleanup = () => {
					unsubscribe();
					clearInterval(ping);
					req.signal.removeEventListener("abort", cleanup);
				};
				req.signal.addEventListener("abort", cleanup);
			},
			cancel() {
				cleanup();
			},
		});
		return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
	}

	/** One segment of either log; only names the logs themselves list are served. */
	async function file(path: string): Promise<Response> {
		let name: string;
		try {
			name = decodeURIComponent(path.slice(LOG_FILES_PATH.length));
		} catch {
			return fail(404, "not found");
		}
		const segment = agentLog.segmentPath(name) ?? processLog.segmentPath(name);
		const data = segment === undefined ? undefined : Bun.file(segment);
		if (!data || !(await data.exists())) return fail(404, "not found");
		return new Response(data, { headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="${name}"` } });
	}

	return {
		"/logs": { methods: ["GET"], handle: (_req, url) => overview(url) },
		[LOG_STREAM_PATH]: { methods: ["GET"], handle: stream },
		[LOG_FILES_PATH]: { methods: ["GET"], handle: (_req, _url, path) => file(path) },
	};
}
