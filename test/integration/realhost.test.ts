import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildMessage } from "../../src/shared/protocol";
import type { TranscriptEvent } from "../../src/shared/transcript";
import {
	FAKE_PROVIDER,
	type HostDirs,
	type HostRun,
	type HostRunOptions,
	makeHostDirs,
	type ModelTurn,
	removeHostDirs,
	runRealHost,
	seedCredentials,
	startFakeModel,
	writeFakeModels,
} from "../fixtures/real-host";

/**
 * The real agent host (`src/worker/host/host.ts` with omp) against a fake OpenAI-compatible model server: the tools each
 * profile offers the model (AGT-08, AGT-09), the time and cost limits (JOB-07, AGT-14), usage of a resumed session
 * (OBS-05), OOM detection and its steer (AGT-17, AGT-18) and OAuth refresh through `credential_request` (CRED-03).
 */

// Every test starts its own host processes and servers, so the tests run concurrently (each host start is ~2 s of omp
// loading); everything is cleaned up once at the end.
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
	await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
}, 30_000);

async function setup(play: (n: number) => ModelTurn, models: { costPerMTok?: number; apiKey?: string | null } = {}, accept?: (auth: string | null) => boolean) {
	const model = startFakeModel(play, accept);
	cleanups.push(() => model.stop());
	const dirs = await makeHostDirs();
	cleanups.push(() => removeHostDirs(dirs));
	await writeFakeModels(dirs, model, { costPerMTok: models.costPerMTok, ...(models.apiKey === null ? {} : { apiKey: models.apiKey ?? "fake-key" }) });
	return { model, dirs };
}

async function host(o: HostRunOptions) {
	const run = runRealHost(o);
	cleanups.push(() => {
		run.proc.kill("SIGKILL");
	});
	const end = await run.end;
	return { run, end };
}

function transcriptOf(messages: ChildMessage[]): TranscriptEvent[] {
	return messages.flatMap(m => (m.t === "transcript" ? [m.event] : []));
}

const ANSWER_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const yieldAnswer = (answer: string): ModelTurn => ({ toolCalls: [{ name: "yield", args: { data: { answer } } }] });

/** omp's tools that reach outside a scratch directory: files anywhere, shell, code execution, subagents. */
const UNCONFINED = ["bash", "edit", "eval", "find", "glob", "grep", "read", "task", "write"];

describe("profiles (AGT-08, AGT-09)", () => {
	const restricted: [profile: "plan" | "chat" | "draft" | "ask", tools: string[], extra?: Partial<HostRunOptions["opts"]>][] = [
		["plan", ["ask", "bash", "glob", "grep", "read", "update_todos", "web_search", "yield"]],
		["chat", ["bash", "create_issue", "glob", "grep", "read", "update_todos", "web_search", "yield"], { createIssueRepo: "acme/app" }],
		["draft", ["bash", "glob", "grep", "read", "update_todos", "web_search", "yield"]],
		["ask", ["list_files", "read_file", "update_todos", "web_search", "write_file", "yield"]],
	];
	for (const [profile, tools, extra] of restricted) {
		test.concurrent(`${profile} offers the model exactly its tools`, async () => {
			const { model, dirs } = await setup(() => yieldAnswer("ok"));
			const { end } = await host({ dirs, opts: { profile, prompt: "hi", outputSchema: ANSWER_SCHEMA, ...extra } });
			expect(end).toMatchObject({ t: "done", result: { output: { answer: "ok" } } });
			expect(model.requests[0]!.tools).toEqual(tools);
		}, 30_000);
	}

	test.concurrent("ask has none of omp's unconfined file, shell or code tools", async () => {
		const { model, dirs } = await setup(() => yieldAnswer("ok"));
		await host({ dirs, opts: { profile: "ask", prompt: "hi", outputSchema: ANSWER_SCHEMA } });
		const offered = model.requests[0]!.tools;
		expect(offered.filter(t => UNCONFINED.includes(t))).toEqual([]);
		// A model that calls `read` anyway gets no file content: the tool does not exist in the session.
		const secret = join(dirs.root, "secret.txt");
		writeFileSync(secret, "worker-secret-content");
		const second = await setup(n => (n === 0 ? { toolCalls: [{ name: "read", args: { path: secret } }] } : yieldAnswer("done")));
		const { run } = await host({ dirs: second.dirs, opts: { profile: "ask", prompt: "read it", outputSchema: ANSWER_SCHEMA } });
		expect(JSON.stringify(second.model.requests.map(r => r.messages))).not.toContain("worker-secret-content");
		expect(transcriptOf(run.messages).some(e => e.type === "tool_end" && e.tool === "read" && !e.isError)).toBe(false);
	}, 30_000);

	test.concurrent("implement offers omp's defaults plus ask, update_todos and yield", async () => {
		const { model, dirs } = await setup(() => yieldAnswer("ok"));
		const { end } = await host({ dirs, opts: { profile: "implement", prompt: "hi", outputSchema: ANSWER_SCHEMA } });
		expect(end?.t).toBe("done");
		expect(model.requests[0]!.tools).toEqual(expect.arrayContaining(["ask", "bash", "edit", "glob", "grep", "read", "update_todos", "web_search", "write", "yield"]));
	}, 30_000);
});

describe("limits (JOB-07, AGT-14)", () => {
	test.concurrent("cost over the limit at the end of a turn aborts the run with `cost`; no further turn is started", async () => {
		// $1 per token: the first turn costs $10 against a $1 limit, and asks for another turn with a tool call.
		const { model, dirs } = await setup(() => ({ toolCalls: [{ name: "update_todos", args: { todos: [{ content: "go on", status: "in_progress" }] } }], usage: { input: 6, output: 4 } }), {
			costPerMTok: 1_000_000,
		});
		const { end } = await host({ dirs, opts: { profile: "plan", prompt: "spend", limits: { minutes: 10, costUsd: 1 } } });
		expect(end).toMatchObject({ t: "done", result: { aborted: "cost", usage: { costUsd: 10, input: 6, output: 4 } } });
		expect(model.requests).toHaveLength(1);
	}, 30_000);

	test.concurrent("a run under its cost limit is not aborted", async () => {
		const { dirs } = await setup(() => ({ text: "cheap", usage: { input: 6, output: 4 } }), { costPerMTok: 1_000 });
		const { end } = await host({ dirs, opts: { profile: "plan", prompt: "spend", limits: { minutes: 10, costUsd: 1 } } });
		expect(end).toMatchObject({ t: "done", result: { usage: { costUsd: 0.01 } } });
		expect(end?.t === "done" && end.result.aborted).toBeFalsy();
	}, 30_000);

	test.concurrent("the wall clock check aborts a busy run past its minutes with `time`", async () => {
		// The model keeps the agent working (a tool call every 100 ms) and would never stop on its own. The session's
		// 15 s check runs every 200 ms here (`fast-clock.ts` preload, which fails if the 15 s constant changes).
		const { model, dirs } = await setup(() => ({ toolCalls: [{ name: "update_todos", args: { todos: [{ content: "loop", status: "in_progress" }] } }], delayMs: 100 }));
		let registeredAt = 0;
		const { end } = await host({
			dirs,
			clockCheckMs: 200,
			opts: { profile: "plan", prompt: "loop", limits: { minutes: 0.01, costUsd: 100 } },
			onMessage: m => {
				if (m.t === "registered") registeredAt = Date.now();
			},
		});
		const took = Date.now() - registeredAt;
		expect(end).toMatchObject({ t: "done", result: { aborted: "time" } });
		// The 0.6 s limit is enforced at a check, not before it.
		expect(took).toBeGreaterThanOrEqual(600);
		expect(took).toBeLessThan(10_000);
		// The run was working (the model never lets it stop) when the limit hit; how many turns fit in 0.6 s depends on the host.
		expect(model.requests.length).toBeGreaterThanOrEqual(1);
	}, 40_000);
});

describe("usage (OBS-05)", () => {
	test.concurrent("a resumed session reports only the usage of the new run", async () => {
		const { model, dirs } = await setup(n => (n === 0 ? { text: "first", usage: { input: 100, output: 50 } } : { text: "second", usage: { input: 7, output: 3 } }), { costPerMTok: 1_000_000 });
		const first = await host({ dirs, opts: { profile: "plan", prompt: "one" } });
		expect(first.end).toMatchObject({ t: "done", result: { usage: { input: 100, output: 50, costUsd: 150 } } });
		const sessionFile = first.end?.t === "done" ? first.end.result.sessionFile : "";
		const second = await host({ dirs, opts: { profile: "plan", prompt: "two", resumeFile: sessionFile } });
		expect(second.end).toMatchObject({ t: "done", result: { usage: { input: 7, output: 3, costUsd: 10 } } });
		// The resumed run really carried the earlier history to the model.
		expect(JSON.stringify(model.requests[1]!.messages)).toContain("first");
		const reported = second.run.messages.filter(m => m.t === "usage");
		expect(reported.map(m => m.t === "usage" && m.usage.input)).toEqual([7]);
	}, 30_000);
});

describe("OOM detection (AGT-17, AGT-18)", () => {
	async function memoryEvents(dirs: HostDirs, kills: number): Promise<string> {
		const file = join(dirs.root, "memory.events");
		writeFileSync(file, `low 0\nhigh 0\nmax 0\noom 0\noom_kill ${kills}\noom_group_kill 0\n`);
		return file;
	}

	test.concurrent("a rise during a tool call steers the agent once, naming the tool; the result counts the kills", async () => {
		let events = "";
		const { model, dirs } = await setup(n => {
			// The tool's command is what the kernel kills: the counter rises while `bash` runs.
			if (n === 0) return { toolCalls: [{ name: "bash", args: { command: `printf 'oom 2\\noom_kill 2\\n' > ${events}` } }] };
			if (n === 1) return { toolCalls: [{ name: "bash", args: { command: "true" } }] };
			return yieldAnswer("finished");
		});
		events = await memoryEvents(dirs, 0);
		const { run, end } = await host({ dirs, memoryEvents: events, opts: { profile: "implement", prompt: "build it", outputSchema: ANSWER_SCHEMA } });
		expect(end).toMatchObject({ t: "done", result: { oomKills: 2, output: { answer: "finished" } } });
		const steers = transcriptOf(run.messages).filter(e => e.type === "steer");
		expect(steers).toHaveLength(1);
		const text = steers[0]!.type === "steer" ? steers[0]!.text : "";
		expect(text).toContain("killed 2 process(es)");
		expect(text).toContain("`bash`");
		expect(text).toContain("Do not run it again");
		expect(JSON.stringify(model.requests[1]!.messages.filter(m => m.role === "user"))).toContain("lack of memory (OOM)");
	}, 30_000);

	test.concurrent("no cgroup v2 file: detection is off, nothing is counted", async () => {
		const { dirs } = await setup(() => yieldAnswer("ok"));
		const { end } = await host({ dirs, memoryEvents: join(dirs.root, "absent"), opts: { profile: "implement", prompt: "x", outputSchema: ANSWER_SCHEMA } });
		expect(end).toMatchObject({ t: "done", result: { oomKills: 0 } });
	}, 30_000);

	test.concurrent("kills seen at a successful yield are counted but not steered", async () => {
		let events = "";
		const { model, dirs } = await setup(() => {
			writeFileSync(events, "oom_kill 1\n");
			return yieldAnswer("done");
		});
		events = await memoryEvents(dirs, 0);
		const { run, end } = await host({ dirs, memoryEvents: events, opts: { profile: "implement", prompt: "x", outputSchema: ANSWER_SCHEMA } });
		expect(end).toMatchObject({ t: "done", result: { oomKills: 1, output: { answer: "done" } } });
		expect(transcriptOf(run.messages).filter(e => e.type === "steer")).toEqual([]);
		expect(model.requests).toHaveLength(1);
	}, 30_000);

	test.concurrent("kills seen after an abort are counted but not steered", async () => {
		let events = "";
		let live: HostRun | undefined;
		const { dirs } = await setup(() => {
			// The kernel kills something while the model is answering, and the user cancels the run meanwhile.
			writeFileSync(events, "oom_kill 3\n");
			live?.send({ t: "abort", id: 1, reason: "user" });
			return { text: "slow", delayMs: 2_000 };
		});
		events = await memoryEvents(dirs, 0);
		const { run, end } = await host({
			dirs,
			memoryEvents: events,
			opts: { profile: "implement", prompt: "x" },
			onMessage: (m, r) => {
				if (m.t === "registered") live = r;
			},
		});
		expect(end).toMatchObject({ t: "done", result: { aborted: "user", oomKills: 3 } });
		expect(transcriptOf(run.messages).filter(e => e.type === "steer")).toEqual([]);
	}, 30_000);
});

describe("OAuth refresh (CRED-03, spike S1)", () => {
	test.concurrent("an expired sign-in is refreshed only through credential_request; the model gets the fresh token", async () => {
		const { model, dirs } = await setup(() => ({ text: "pong" }), { apiKey: null }, auth => auth === "Bearer access-v2");
		// The run spec's snapshot: the orchestrator's row 42, expired, with the refresh token replaced by `__remote__` (CRED-02).
		const ids = await seedCredentials(dirs, [
			{ id: 42, provider: FAKE_PROVIDER, credential: { type: "oauth", access: "access-v1", refresh: "__remote__", expires: Date.now() - 60_000, accountId: "acct" } },
		]);
		const local = [...ids.keys()][0]!;
		expect(ids.get(local)).toBe("42");
		const requests: Extract<ChildMessage, { t: "credential_request" }>[] = [];
		const { end } = await host({
			dirs,
			opts: { profile: "plan", prompt: "ping" },
			credential: req => {
				requests.push(req);
				return { accessToken: "access-v2", expiresAt: Date.now() + 3_600_000 };
			},
		});
		expect(end).toMatchObject({ t: "done" });
		expect(requests.map(r => ({ provider: r.provider, credentialId: r.credentialId, accessToken: r.accessToken }))).toEqual([
			{ provider: FAKE_PROVIDER, credentialId: local, accessToken: "access-v1" },
		]);
		expect(model.requests.map(r => r.authorization)).toEqual(["Bearer access-v2"]);
		expect(model.other).toEqual([]);
		// The run's store keeps the sentinel: no refresh token ever reached the worker.
		const db = new Database(join(dirs.auth, "agent.db"), { readonly: true });
		cleanups.push(() => db.close());
		const stored = JSON.stringify(db.query("SELECT * FROM auth_credentials").all());
		expect(stored).toContain("access-v2");
		expect(stored).toContain("__remote__");
	}, 30_000);

	test.concurrent("a refusal containing 'revoked' disables the run's copy; the model is never called", async () => {
		const { model, dirs } = await setup(() => ({ text: "pong" }), { apiKey: null });
		await seedCredentials(dirs, [{ id: 7, provider: FAKE_PROVIDER, credential: { type: "oauth", access: "access-v1", refresh: "__remote__", expires: Date.now() - 60_000 } }]);
		const { end } = await host({ dirs, opts: { profile: "plan", prompt: "ping" }, credential: () => ({ error: "revoked: sign-in was removed" }) });
		expect(end?.t).toBe("failed");
		expect(model.requests).toEqual([]);
	}, 30_000);
});
