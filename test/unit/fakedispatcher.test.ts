import { describe, expect, test } from "bun:test";
import { RunDetached, type RunHandle, type RunHooks, type RunRequest, type RunUi } from "../../src/orchestrator/dispatch/dispatcher";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import type { RunUsage } from "../../src/shared/transcript";

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
	owner: { kind: "job", jobId: "j1" },
	kind: "plan",
	profile: "plan",
	prompt: "p",
	thinking: "high",
	limits: { minutes: 1, costUsd: 1 },
	session: "issue-1-plan",
	resume: false,
	...over,
});

function hooks() {
	const usage: RunUsage[] = [];
	const handles: RunHandle[] = [];
	const h: RunHooks = { ui: {} as RunUi, register: handle => void handles.push(handle), onUsage: u => void usage.push(u) };
	return { h, usage, handles };
}

describe("createFakeDispatcher", () => {
	test("yields a canned output per kind", async () => {
		const d = createFakeDispatcher();
		expect((await d.runAgent(req(), hooks().h)).output).toMatchObject({ complexity: "small" });
		expect((await d.runAgent(req({ owner: { kind: "plan", threadId: "t" } }), hooks().h)).output).toHaveProperty("title");
		expect((await d.runAgent(req({ owner: { kind: "chat", threadId: "t" }, kind: "chat", profile: "chat" }), hooks().h)).output).toHaveProperty("answer");
		expect((await d.runAgent(req({ owner: { kind: "draft", draftId: "d" }, kind: "draft", profile: "draft" }), hooks().h)).output).toHaveProperty("body");
	});

	test("detaching rejects with RunDetached, the run goes on, and the next caller gets the result and the usage once", async () => {
		const d = createFakeDispatcher();
		d.script({ kind: "plan" }, { hold: true });
		const first = hooks();
		const controller = new AbortController();
		const p1 = d.runAgent(req(), first.h, controller.signal);
		controller.abort();
		expect(p1).rejects.toBeInstanceOf(RunDetached);
		await p1.catch(() => {});
		expect(d.hasUnfinishedRun({ kind: "job", jobId: "j1" })).toBe(true);
		d.run({ kind: "job", jobId: "j1" })!.finish();
		expect(d.hasUnfinishedRun({ kind: "job", jobId: "j1" })).toBe(false);

		const second = hooks();
		const result = await d.runAgent(req(), second.h);
		expect(result.output).toMatchObject({ complexity: "small" });
		expect(first.usage).toEqual([]);
		expect(second.usage).toHaveLength(1);
		expect(d.runs).toHaveLength(1);
		expect(d.run({ kind: "job", jobId: "j1" })).toBeUndefined();
	});

	test("abort is one-shot: the first reason wins", async () => {
		const d = createFakeDispatcher();
		d.script({ kind: "plan" }, { hold: true });
		const { h, handles } = hooks();
		const running = d.runAgent(req(), h);
		await handles[0]!.abort("time");
		await handles[0]!.abort("user");
		expect((await running).aborted).toBe("time");
		expect(await handles[0]!.steer("x", "a")).toBe("ended");
	});

	test("counts pending runs while they wait for a worker", async () => {
		const d = createFakeDispatcher();
		const gate = Promise.withResolvers<void>();
		d.once({ kind: "plan" }, { pending: gate.promise });
		const waiting: string[] = [];
		const running = d.runAgent(req(), { ...hooks().h, onWaitingForWorker: () => void waiting.push("w") });
		expect(d.counts()).toMatchObject({ pending: 1, running: 0 });
		expect(d.counts().oldestPendingMs).not.toBeNull();
		expect(waiting).toEqual(["w"]);
		gate.resolve();
		await running;
		expect(d.counts()).toEqual({ pending: 0, running: 0, oldestPendingMs: null });
	});
});
