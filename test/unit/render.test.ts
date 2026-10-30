import { describe, expect, test } from "bun:test";
import {
	askAnswerMessages,
	chunkText,
	type ComponentId,
	encodeId,
	failureMessage,
	followUpMessage,
	implementDoneMessage,
	issueCreatedMessage,
	parseId,
	planMessage,
	producedFilesMessages,
	progressLine,
	queuedMessage,
	todoList,
} from "../../src/orchestrator/discord/render";
import type { OutMessage } from "../../src/orchestrator/discord/surface";

const agentName = "Robo";
const text = (data: Uint8Array | string) => (typeof data === "string" ? data : new TextDecoder().decode(data));

describe("custom_id codec", () => {
	const ids: ComponentId[] = [
		{ type: "plan", issueId: 12, rev: 3, action: "approve" },
		{ type: "plan", issueId: 12, rev: 3, action: "changes" },
		{ type: "plan", issueId: 12, rev: 3, action: "reject" },
		{ type: "job", jobId: "3f1c2a4e-1b2c-4d5e-8f90-123456789abc", action: "retry" },
		{ type: "issue", repo: "my-org/my.repo", number: 42, action: "handoff" },
		{ type: "ask", rest: "job-1:0:opt" },
		{ type: "preq", threadId: "1561025712456990741", rev: 2, action: "approve" },
		{ type: "preq", threadId: "1561025712456990741", rev: 2, action: "execute" },
		{ type: "preq", threadId: "1561025712456990741", rev: 2, action: "refine" },
		{ type: "preq", threadId: "1561025712456990741", rev: 2, action: "reject" },
		{ type: "omp", version: "18.12.0", action: "approve" },
		{ type: "omp", version: "19.0.0-beta.1", action: "approve" },
	];
	for (const id of ids) {
		test(`round-trips ${encodeId(id)}`, () => expect(parseId(encodeId(id))).toEqual(id));
	}

	test("encodes the documented formats", () => {
		expect(encodeId({ type: "issue", repo: "a/b", number: 7, action: "handoff" })).toBe("issue:a/b:7:handoff");
		expect(encodeId({ type: "plan", issueId: 1, rev: 2, action: "reject" })).toBe("plan:1:2:reject");
	});

	for (const bad of ["", "plan:1:2", "plan:x:2:approve", "plan:1:2:merge", "job::retry", "job:1:run", "issue:noslash:1:handoff", "issue:a/b:1", "issue:a/b:x:handoff", "ask:", "other:1", `ask:${"x".repeat(100)}`, "preq:1:2:changes", "preq:t1:2:approve", "preq:1:2", "preq:1:2:toString", "omp:1.2:approve", "omp:../x:approve", "omp:18.12.0:install", "omp:18.12.0", "omp:v18.12.0:approve", "omp:18.12.0:approve:x", "plan:1:2:toString"]) {
		test(`rejects ${JSON.stringify(bad.slice(0, 30))}`, () => expect(parseId(bad)).toBeUndefined());
	}

	test("throws when encoding exceeds 100 chars", () => {
		expect(() => encodeId({ type: "issue", repo: `${"o".repeat(50)}/${"r".repeat(50)}`, number: 1, action: "handoff" })).toThrow();
	});
});

test("progress line shows the current activity only while running", () => {
	const base = { title: "Planning #12", elapsedMs: 192_000, cost: 1.5, activity: "Reading config (`read`)" };
	const running = progressLine({ ...base, state: "running" });
	expect(running.split("\n")).toEqual([expect.stringContaining("3m 12s · $1.50"), "↳ Reading config (`read`)"]);
	for (const state of ["waiting", "done", "failed", "cancelled"] as const) {
		const line = progressLine({ ...base, state });
		expect(line).not.toContain("\n");
		expect(line).toContain("**Planning #12**");
	}
});

describe("todo list", () => {
	test("one icon line per step and a done count", () => {
		const text = todoList([
			{ content: "Read the config loader", status: "completed" },
			{ content: "Add the\n  retry option", status: "in_progress" },
			{ content: "Write tests", status: "pending" },
		]);
		expect(text.split("\n")).toEqual(["📝 **To-do** · 1/3 done", "✅ Read the config loader", "🔄 Add the retry option", "⬜ Write tests"]);
	});

	test("a list longer than the limit ends with how many steps were left out", () => {
		const todos = Array.from({ length: 50 }, (_, i) => ({ content: `${i} ${"x".repeat(150)}`, status: "pending" as const }));
		const text = todoList(todos);
		expect(text.length).toBeLessThanOrEqual(2000);
		const shown = text.split("\n").filter(line => line.startsWith("⬜")).length;
		expect(text).toEndWith(`\n… ${50 - shown} more`);
		expect(shown).toBeGreaterThan(5);
		expect(todoList(todos, 300).length).toBeLessThanOrEqual(300);
	});

	test("a list that exactly fits is not cut", () => {
		const todos = [{ content: "a".repeat(50), status: "pending" as const }, { content: "b".repeat(50), status: "completed" as const }];
		const full = todoList(todos);
		expect(todoList(todos, full.length)).toBe(full);
		expect(todoList(todos, full.length - 1)).toEndWith("\n… 1 more");
	});
});

test("plan message stays within Discord's limit and keeps the approval buttons and mention", () => {
	const message = planMessage({ issueId: 1, rev: 2, summary: "s".repeat(5000), complexity: "large", commentUrl: "https://x/1", planMarkdown: "plan", mention: { text: "<@42> ", users: ["42"] } });
	expect(message.content.length).toBeLessThanOrEqual(2000);
	expect(message.content).toStartWith("📋 <@42> ");
	expect(message.content).toContain("Approve");
	expect(message.components).toHaveLength(1);
	expect(message.components![0]!.components.map(c => ("custom_id" in c ? c.custom_id : ""))).toEqual(["plan:1:2:approve", "plan:1:2:changes", "plan:1:2:reject"]);
	expect(message.mentions).toEqual({ users: ["42"] });
	expect(message.files!.map(f => f.name)).toEqual(["plan-rev2.md"]);
	expect(text(message.files![0]!.data)).toBe("plan");
});

test("implementation summary splits into sendable chunks and keeps the PR link first", () => {
	const text = implementDoneMessage({ agentName, prNumber: 7, prUrl: "https://github.com/a/b/pull/7", prTitle: "T", prBody: "b".repeat(5000), testing: "t".repeat(3000), mentionKeyword: "/agentbot", oomKills: 0 });
	const chunks = chunkText(text);
	for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
	expect(chunks[0]).toContain("https://github.com/a/b/pull/7");
	expect(chunks.at(-1)).toContain("`/agentbot`");
	expect(chunks.at(-1)).toContain("make Robo revise it");
});

test("OOM warning appears before Testing and in follow-ups only when processes were killed", () => {
	const done = (oomKills: number) =>
		implementDoneMessage({ agentName, prNumber: 7, prUrl: "u", prTitle: "T", prBody: "body", testing: "tests", mentionKeyword: "/agentbot", oomKills });
	expect(done(2)).toContain("Local verification incomplete");
	expect(done(2)).toContain("killed 2 process(es)");
	expect(done(2).indexOf("Local verification incomplete")).toBeLessThan(done(2).indexOf("**Testing:**"));
	expect(done(0)).not.toContain("Local verification incomplete");

	const followUp = (kind: "revise" | "fix_ci", pushed: boolean, oomKills: number) =>
		followUpMessage(
			kind === "revise"
				? { agentName, kind, prNumber: 7, pushed, summary: "sum", oomKills }
				: { agentName, kind, prNumber: 7, pushed, summary: "sum", checks: "ci", attempt: 2, maxAttempts: 3, oomKills },
		);
	for (const [kind, pushed] of [["revise", true], ["revise", false], ["fix_ci", true], ["fix_ci", false]] as const) {
		const warned = followUp(kind, pushed, 1);
		expect(warned).toContain("Local verification incomplete");
		expect(warned.indexOf("Local verification incomplete")).toBeLessThan(warned.indexOf("sum"));
		expect(followUp(kind, pushed, 0)).not.toContain("Local verification incomplete");
	}
});

describe("chunkText", () => {
	test("keeps paragraphs together", () => {
		const a = "a".repeat(1200);
		const b = "b".repeat(1200);
		expect(chunkText(`${a}\n\n${b}`)).toEqual([a, b]);
		expect(chunkText("x\n\ny")).toEqual(["x\n\ny"]);
	});

	test("hard-splits oversize paragraphs", () => {
		const chunks = chunkText("z".repeat(4500));
		expect(chunks.map(c => c.length)).toEqual([2000, 2000, 500]);
	});
});

describe("askAnswerMessages", () => {
	const attachments = (message: OutMessage) => message.files ?? [];
	const file = (name: string, size = 10) => ({ name, size, data: new Uint8Array(size) });

	test("the answer is an attached answer.md with a short pointer, not inline text", () => {
		const { messages, tooLarge } = askAnswerMessages("# Result\n\nIt is 42.", [], 1000);
		expect(tooLarge).toEqual([]);
		expect(messages).toHaveLength(1);
		const [answer] = attachments(messages[0]!);
		expect(answer!.name).toBe("answer.md");
		expect(text(answer!.data)).toBe("# Result\n\nIt is 42.");
		expect(messages[0]!.content).toBe("📄 **Answer attached:** `answer.md`");
		expect(messages[0]!.mentions).toBeUndefined();
	});

	test("generated files follow in messages of at most 10 files", () => {
		const files = Array.from({ length: 12 }, (_, i) => file(`f${i}.csv`));
		const { messages } = askAnswerMessages("answer", files, 1000);
		expect(messages.map(m => attachments(m).length)).toEqual([1, 10, 2]);
		expect(messages[0]!.content).toContain("and 12 generated files below");
		expect(attachments(messages[2]!).map(a => a.name)).toEqual(["f10.csv", "f11.csv"]);
		for (const m of messages) expect(m.mentions).toBeUndefined();
	});

	test("a batch stays under the byte limit", () => {
		const { messages } = askAnswerMessages("a", [file("a.bin", 600), file("b.bin", 600), file("c.bin", 300)], 1000);
		expect(messages.slice(1).map(m => attachments(m).map(a => a.name))).toEqual([["a.bin"], ["b.bin", "c.bin"]]);
	});

	test("an oversize file is named in a final line and not attached", () => {
		const { messages, tooLarge } = askAnswerMessages("a", [file("ok.csv"), file("big.json", 5000)], 1000);
		expect(tooLarge).toEqual(["big.json"]);
		const all = messages.flatMap(attachments).map(a => a.name);
		expect(all).toEqual(["answer.md", "ok.csv"]);
		const last = messages.at(-1)!;
		expect(last.files).toBeUndefined();
		expect(last.content).toBe("⚠️ Too large to attach (over 0 MiB): big.json");
	});

	test("an oversize answer is truncated to the limit with a note", () => {
		const { messages } = askAnswerMessages("x".repeat(5000), [], 1000);
		const bytes = attachments(messages[0]!)[0]!.data as Uint8Array;
		expect(bytes.length).toBeLessThanOrEqual(1000);
		expect(text(bytes)).toContain("Answer truncated");
	});

	test("a generated file called answer.md does not clash with the answer", () => {
		const { messages } = askAnswerMessages("a", [file("answer.md")], 1000);
		expect(messages.flatMap(attachments).map(a => a.name)).toEqual(["answer.md", "answer-1.md"]);
	});

	test("files of a run that ended without an answer are still delivered", () => {
		const { messages } = producedFilesMessages([file("partial.csv")], 1000);
		expect(messages).toHaveLength(1);
		expect(attachments(messages[0]!).map(a => a.name)).toEqual(["partial.csv"]);
	});
});

test("created-issue summary fits one message with any title and description, and links the thread when open", () => {
	const base = { repo: "o/r", number: 12, url: "https://github.com/o/r/issues/12", label: "agentbot", createdBy: "@mike", agentName };
	const long = issueCreatedMessage({ ...base, title: "t".repeat(256), description: "line\n".repeat(1000) });
	expect(long.length).toBeLessThanOrEqual(2000);
	expect(long).toContain("#12");
	expect(long).toContain("https://github.com/o/r/issues/12");
	expect(long).not.toContain("<#");
	expect(issueCreatedMessage({ ...base, title: "x", description: "", threadId: "999" })).toContain("<#999>");
	expect(issueCreatedMessage({ ...base, title: "x", description: "## Summary\nAdd it." })).toContain("> **Summary**\n> Add it.");
});

test("text that names the system uses the configured agent name (DSC-30)", () => {
	expect(queuedMessage("https://github.com/o/r/issues/1", agentName)).toContain("Robo will post its progress here");
	expect(issueCreatedMessage({ agentName, repo: "o/r", number: 1, url: "u", title: "t", description: "", label: "l", createdBy: "@m", threadId: "9" })).toContain("Robo is planning it in <#9>");
	expect(followUpMessage({ agentName, kind: "revise", prNumber: 1, pushed: true, summary: "s", oomKills: 1 })).toContain("in Robo's worker");
});

test("failure message carries the Retry button for its job", () => {
	const message = failureMessage({ jobId: "job-1", kind: "plan", error: "boom" });
	expect(message.content).toBe("❌ plan failed: boom");
	expect(message.components![0]!.components[0]).toMatchObject({ custom_id: "job:job-1:retry", label: "Retry" });
});
