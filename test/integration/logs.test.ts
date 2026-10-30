import { afterEach, describe, expect, test } from "bun:test";
import { createLogsRoutes } from "../../src/orchestrator/api/logs";
import type { AgentLog, AgentLogRun } from "../../src/orchestrator/store/agentlog";
import type { LogEntry, LogsOverview } from "../../src/shared/adminLogs";
import { logsPages } from "../../src/web/logsPage";
import { type AdminStack, startAdminStack } from "../fixtures/adminStack";

const RUN: AgentLogRun = { run: "job-1", kind: "implement", repo: "acme/app", issue: 7 };
const PING_MS = 50;

let stack: AdminStack | undefined;
afterEach(async () => {
	await stack?.close();
	stack = undefined;
});

/** The stack with the logs routes; `subscribers()` counts the stream's live subscriptions to the agent log, `unsubscribed()` waits for none. */
async function start(): Promise<{ s: AdminStack; subscribers(): number; unsubscribed(): Promise<void> }> {
	let count = 0;
	const waiters: (() => void)[] = [];
	stack = await startAdminStack({
		routes: ({ agentLog, processLog }) => {
			const counted: AgentLog = Object.create(agentLog);
			counted.subscribe = listener => {
				count++;
				const unsubscribe = agentLog.subscribe(listener);
				return () => {
					count--;
					if (count === 0) for (const wake of waiters.splice(0)) wake();
					return unsubscribe();
				};
			};
			return createLogsRoutes({ agentLog: counted, processLog, pingMs: PING_MS });
		},
		pages: logsPages,
	});
	return {
		s: stack,
		subscribers: () => count,
		unsubscribed() {
			if (count === 0) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			return promise;
		},
	};
}

/** Reads an event stream until `done(text)` holds; returns everything read. */
async function readUntil(res: Response, done: (text: string) => boolean, timeoutMs = 3_000): Promise<string> {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (!done(text)) {
		if (Date.now() > deadline) throw new Error(`stream timed out; got: ${text}`);
		const { value, done: ended } = await reader.read();
		if (ended) break;
		text += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	return text;
}

function events(text: string): LogEntry[] {
	return text
		.split("\n\n")
		.filter(block => block.includes("data: "))
		.map(block => JSON.parse(block.slice(block.indexOf("data: ") + 6)) as LogEntry);
}

describe("/logs", () => {
	test("the page shows the newest entries and both logs' files", async () => {
		const { s } = await start();
		s.agentLog.append(RUN, { type: "prompt", text: "Implement <the> feature" });
		s.agentLog.append(RUN, { type: "tool_end", tool: "bash", isError: true, text: "exit 1" });
		s.processLog.append(JSON.stringify({ msg: "hello" }));
		const res = await s.get("/logs");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Implement &lt;the&gt; feature");
		expect(html).toContain('data-after="2"');
		expect(html).toContain("implement acme/app#7");
		const [agentFile] = s.agentLog.segments();
		const [processFile] = s.processLog.segments();
		expect(html).toContain(`href="/logs/files/${agentFile!.name}"`);
		expect(html).toContain(`href="/logs/files/${processFile!.name}"`);
		expect(html).toContain('aria-current="page"');

		const overview = (await (await s.call("GET", "/logs?limit=1")).json()) as LogsOverview;
		expect(overview.entries.map(e => e.seq)).toEqual([2]);
		expect(overview.process.segments.map(seg => seg.name)).toEqual([processFile!.name]);
	});

	test("the stream sends the entries after ?after, then live ones, with pings; it ends when the browser leaves", async () => {
		const { s, subscribers, unsubscribed } = await start();
		for (let i = 1; i <= 3; i++) s.agentLog.append(RUN, { type: "assistant", text: `line ${i}` });
		const browser = new AbortController();
		const res = await s.get("/logs/stream?after=1", { accept: "text/event-stream" }, browser.signal);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		expect(res.headers.get("content-security-policy")).toBeTruthy();
		let text = await readUntil(res, t => events(t).length >= 2);
		expect(events(text).map(e => e.seq)).toEqual([2, 3]);
		expect(text).toContain("id: 2\n");

		s.agentLog.append(RUN, { type: "steer", text: "live one" });
		text += await readUntil(res, t => events(text + t).length >= 3);
		expect(events(text).map(e => [e.seq, e.type])).toEqual([
			[2, "assistant"],
			[3, "assistant"],
			[4, "steer"],
		]);
		text += await readUntil(res, t => t.includes(": ping"));

		expect(subscribers()).toBe(1);
		browser.abort();
		await unsubscribed();
	});

	test("a reconnect resumes after Last-Event-ID; without a cursor only new entries arrive", async () => {
		const { s } = await start();
		for (let i = 1; i <= 4; i++) s.agentLog.append(RUN, { type: "assistant", text: `line ${i}` });
		const browser = new AbortController();
		// Last-Event-ID wins over the ?after the page was first loaded with.
		const resumed = await s.get("/logs/stream?after=0", { "last-event-id": "3" }, browser.signal);
		expect(events(await readUntil(resumed, t => events(t).length >= 1)).map(e => e.seq)).toEqual([4]);

		const fresh = await s.get("/logs/stream", {}, browser.signal);
		const first = await readUntil(fresh, t => t.includes(": connected"));
		expect(events(first)).toEqual([]);
		s.agentLog.append(RUN, { type: "assistant", text: "new" });
		expect(events(await readUntil(fresh, t => events(t).length >= 1)).map(e => e.seq)).toEqual([5]);
		browser.abort();
	});

	test("downloads serve listed segments of either log, through web; any other name is 404", async () => {
		const { s } = await start();
		s.agentLog.append(RUN, { type: "assistant", text: "in the file" });
		s.processLog.append(JSON.stringify({ msg: "process line" }));
		const agentFile = s.agentLog.segments()[0]!.name;
		const processFile = s.processLog.segments()[0]!.name;

		const agent = await s.get(`/logs/files/${encodeURIComponent(agentFile)}`);
		expect(agent.status).toBe(200);
		expect(agent.headers.get("content-disposition")).toBe(`attachment; filename="${agentFile}"`);
		expect(agent.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await agent.text()).toContain("in the file");

		const process = await s.get(`/logs/files/${encodeURIComponent(processFile)}`);
		expect(process.status).toBe(200);
		expect(await process.text()).toContain("process line");

		for (const name of ["agent-unknown.jsonl", "agentbot.db", "..%2Fagentbot.db", "%2e%2e", "..%2F..%2Fomp%2Fagents"]) {
			const res = await s.get(`/logs/files/${name}`);
			expect(res.status).toBe(404);
			await res.body?.cancel();
		}
		expect((await s.call("GET", "/logs/files/agentbot.db")).status).toBe(404);
		expect((await s.call("GET", `/logs/files/${encodeURIComponent(agentFile)}`)).status).toBe(200);
	});

	test("the stream needs a login (401 JSON) and the admin API needs the web token", async () => {
		const { s } = await start();
		const anonymous = await fetch(`${s.web.url}/logs/stream`, { redirect: "manual" });
		expect(anonymous.status).toBe(401);
		expect(await anonymous.json()).toEqual({ error: "unauthorized" });
		const noToken = await fetch(`${s.api.url}/internal/admin/logs/stream`);
		expect(noToken.status).toBe(401);
	});
});
