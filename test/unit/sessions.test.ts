import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDeps } from "../../src/orchestrator/engine/deps";
import { terminalCleanup } from "../../src/orchestrator/engine/jobs";
import type { IssueState } from "../../src/orchestrator/engine/state";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { isSessionKey, removeSessions, sessionPath, sweepSessions } from "../../src/orchestrator/store/sessions";
import { setLogSink } from "../../src/shared/log";
import { createFakeDiscord } from "../fakes/discord";

const root = mkdtempSync(join(tmpdir(), "agentbot-sessions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let stateDir: string;
let sessionDir: string;
let logs: Record<string, unknown>[];
let counter = 0;

beforeEach(() => {
	stateDir = join(root, `state${counter++}`);
	sessionDir = join(stateDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	logs = [];
	setLogSink(line => logs.push(JSON.parse(line)));
});
afterAll(() => setLogSink(undefined));

/** An omp-shaped session: `<key>.jsonl` plus a `<key>/` artifacts dir with a nested subagent transcript. */
function makeSession(key: string, dir = sessionDir): string {
	writeFileSync(join(dir, `${key}.jsonl`), "x".repeat(100));
	mkdirSync(join(dir, key, "sub"), { recursive: true });
	writeFileSync(join(dir, key, "sub", "agent.jsonl"), "y".repeat(50));
	return key;
}

const fileOf = (key: string, dir = sessionDir) => join(dir, `${key}.jsonl`);

function seedIssue(db: Db, number: number, state: IssueState, keys: { plan?: string; impl?: string }) {
	const issue = db.insertIssue("o/r", number, `issue ${number}`);
	return db.updateIssue(issue.id, { state, plan_session: keys.plan ?? null, impl_session: keys.impl ?? null });
}

describe("session keys", () => {
	test("sessionPath puts a key's file in the sessions dir and refuses unsafe keys", () => {
		expect(sessionPath(sessionDir, "issue-1-plan")).toBe(join(sessionDir, "issue-1-plan.jsonl"));
		for (const bad of ["", "..", "../x", "a/b", "/abs", ".hidden", "a..b", "a\\b"]) {
			expect(isSessionKey(bad)).toBe(false);
			expect(() => sessionPath(sessionDir, bad)).toThrow("invalid session key");
		}
	});
});

describe("removeSessions", () => {
	test("removes the file and its artifacts dir and logs the bytes freed", async () => {
		const key = makeSession("a");
		const { kept } = await removeSessions(sessionDir, [key], { repo: "o/r" });
		expect(kept).toEqual([]);
		expect(existsSync(fileOf(key))).toBe(false);
		expect(existsSync(join(sessionDir, "a"))).toBe(false);
		expect(logs.find(l => l.msg === "sessions removed")).toMatchObject({ sessions: ["a"], bytes: 150, repo: "o/r" });
	});

	test("a missing session is not an error and does not stop the others", async () => {
		const real = makeSession("b");
		const { kept } = await removeSessions(sessionDir, ["gone", null, undefined, real], {});
		expect(kept).toEqual([]);
		expect(existsSync(fileOf(real))).toBe(false);
		expect(logs.filter(l => l.level === "warn")).toEqual([]);
	});

	test("never deletes outside the sessions dir (ENG-05)", async () => {
		makeSession("outside", stateDir);
		const evilDir = join(stateDir, "sessions-evil");
		mkdirSync(evilDir);
		makeSession("y", evilDir);
		const absolute = fileOf("outside", stateDir);

		const { kept } = await removeSessions(sessionDir, ["../outside", absolute, "../sessions-evil/y", "..", "."], {});
		expect(kept).toEqual([]);
		for (const path of [fileOf("outside", stateDir), join(stateDir, "outside"), fileOf("y", evilDir), join(evilDir, "y"), sessionDir]) {
			expect(existsSync(path)).toBe(true);
		}
		expect(logs.filter(l => l.msg === "session outside session dir skipped")).toHaveLength(5);
	});
});

/** Deps for `terminalCleanup`: the DB, the sessions dir and a fake Discord thread. */
async function cleanupDeps(db: Db) {
	const discord = createFakeDiscord();
	const channel = discord.addChannel({ name: "work" });
	const top = await discord.send(channel.id, { content: "📥 top" });
	const threadId = await discord.startThread(top, { name: "#1", autoArchiveMinutes: 10080 });
	const deps = { db, sessionDir, discord } as unknown as EngineDeps;
	return { deps, discord, threadId };
}

describe("terminalCleanup session deletion", () => {
	test.each(["done", "cancelled"] as const)("deletes both sessions of a %s issue, nulls the columns, posts and archives", async state => {
		const db = openDb(":memory:");
		const plan = makeSession("issue-1-plan");
		const impl = makeSession("issue-1-impl");
		const issue = seedIssue(db, 1, state, { plan, impl });
		const { deps, discord, threadId } = await cleanupDeps(db);
		db.updateIssue(issue.id, { thread_id: threadId });

		await terminalCleanup(deps, db.getIssue(issue.id)!, "bye");

		for (const path of [fileOf(plan), fileOf(impl), join(sessionDir, plan), join(sessionDir, impl)]) expect(existsSync(path)).toBe(false);
		expect(db.getIssue(issue.id)).toMatchObject({ plan_session: null, impl_session: null });
		expect(discord.lastMessage(threadId)?.content).toBe("bye");
		expect(discord.channels().find(c => c.id === threadId)?.archived).toBe(true);
	});

	test("a stored value that is not a session key is skipped, cleared from the DB, and does not stop archiving", async () => {
		const db = openDb(":memory:");
		makeSession("elsewhere", stateDir);
		const impl = makeSession("issue-1-impl");
		const issue = seedIssue(db, 1, "done", { plan: "../elsewhere", impl });
		const { deps, discord, threadId } = await cleanupDeps(db);
		db.updateIssue(issue.id, { thread_id: threadId });

		await terminalCleanup(deps, db.getIssue(issue.id)!, "bye");

		expect(existsSync(fileOf("elsewhere", stateDir))).toBe(true);
		expect(existsSync(fileOf(impl))).toBe(false);
		expect(db.getIssue(issue.id)).toMatchObject({ plan_session: null, impl_session: null });
		expect(discord.channels().find(c => c.id === threadId)?.archived).toBe(true);
	});

	test.each(["failed", "queued", "planning", "awaiting_approval", "implementing", "in_review"] as const)(
		"keeps the sessions of a %s issue",
		async state => {
			const db = openDb(":memory:");
			const plan = makeSession("issue-1-plan");
			const impl = makeSession("issue-1-impl");
			const issue = seedIssue(db, 1, state, { plan, impl });
			const { deps } = await cleanupDeps(db);

			await terminalCleanup(deps, db.getIssue(issue.id)!, "not terminal");

			expect(existsSync(fileOf(plan))).toBe(true);
			expect(existsSync(join(sessionDir, impl))).toBe(true);
			expect(db.getIssue(issue.id)).toMatchObject({ plan_session: plan, impl_session: impl });
		},
	);
});

describe("sweepSessions", () => {
	test("deletes sessions of closed issues and rejected plans only", async () => {
		const db = openDb(":memory:");
		const donePlan = makeSession("done-plan");
		const doneImpl = makeSession("done-impl");
		const review = makeSession("review");
		const failed = makeSession("failed");
		const rejected = makeSession("rejected");
		const awaiting = makeSession("awaiting");
		const chat = makeSession("chat-123");
		const done = seedIssue(db, 1, "done", { plan: donePlan, impl: doneImpl });
		const cancelled = seedIssue(db, 2, "cancelled", { impl: "missing" });
		const inReview = seedIssue(db, 3, "in_review", { impl: review });
		const failedIssue = seedIssue(db, 4, "failed", { impl: failed });
		db.insertPlan("p1", "o/r", "r", "alice");
		db.updatePlan("p1", { state: "rejected", session_file: rejected });
		db.insertPlan("p2", "o/r", "r", "alice");
		db.updatePlan("p2", { state: "awaiting", session_file: awaiting });

		await sweepSessions({ db, sessionDir });

		for (const path of [fileOf(donePlan), fileOf(doneImpl), fileOf(rejected), join(sessionDir, doneImpl), join(sessionDir, rejected)]) {
			expect(existsSync(path)).toBe(false);
		}
		expect(db.getIssue(done.id)).toMatchObject({ plan_session: null, impl_session: null });
		expect(db.getIssue(cancelled.id)?.impl_session).toBeNull();
		expect(db.getPlan("p1")?.session_file).toBeNull();
		for (const key of [review, failed, awaiting, chat]) expect(existsSync(fileOf(key))).toBe(true);
		expect(db.getIssue(inReview.id)?.impl_session).toBe(review);
		expect(db.getIssue(failedIssue.id)?.impl_session).toBe(failed);
		expect(db.getPlan("p2")?.session_file).toBe(awaiting);
	});
});
