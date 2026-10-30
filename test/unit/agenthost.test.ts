import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthStorage, discoverAuthStorage, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-coding-agent";
import type { ChildMessage, HostRuntime, ParentMessage, StartOptions } from "../../src/shared/protocol";
import { TRANSCRIPT_LIMITS } from "../../src/shared/transcript";
import { credentialRefreshHook } from "../../src/worker/host/session";

/**
 * The agent host's protocol, driven through a tiny local spawner (not the worker supervisor): the fixture host runs the
 * real `serveAgentHost` with scripted sessions; `host.ts` itself is started for its entry checks.
 */

const FIXTURE = join(import.meta.dir, "..", "fixtures", "agent-host.ts");
const HOST = join(import.meta.dir, "..", "..", "src", "worker", "host", "host.ts");

const temps: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "agentbot-host-"));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Reply = Extract<ChildMessage, { t: "reply" }>;
type Answer = { ok: true; value?: unknown } | { ok: false; error: string; aborted?: boolean };

interface Host {
	messages: ChildMessage[];
	send(message: ParentMessage): void;
	/** Resolves with the first message (already received or future) that matches. */
	next<T extends ChildMessage["t"]>(t: T, match?: (m: Extract<ChildMessage, { t: T }>) => boolean): Promise<Extract<ChildMessage, { t: T }>>;
	/** Resolves with the final `done` or `failed`. */
	end(): Promise<Extract<ChildMessage, { t: "done" | "failed" }>>;
	exited: Promise<number | null>;
	proc: ReturnType<typeof Bun.spawn>;
}

/**
 * Spawns `entry` with an IPC channel. Requests are answered by `answers` (by message type) unless it returns
 * `undefined`; `session_file` is accepted by default.
 */
function spawnHost(entry: string, answers: Partial<Record<"ui" | "tool_call" | "session_file" | "credential_request", (m: never) => Answer | Promise<Answer> | undefined>> = {}, env: Record<string, string> = {}): Host {
	const messages: ChildMessage[] = [];
	const waiters: { test(m: ChildMessage): boolean; resolve(m: ChildMessage): void }[] = [];
	const proc = Bun.spawn([process.execPath, entry], {
		serialization: "json",
		stdio: ["ignore", "ignore", "inherit"],
		env: { ...process.env, ...env },
		ipc(raw) {
			const message = raw as ChildMessage;
			messages.push(message);
			for (const waiter of waiters.slice()) {
				if (waiter.test(message)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(message);
				}
			}
			if (message.t === "ui" || message.t === "tool_call" || message.t === "session_file" || message.t === "credential_request") {
				if (message.t === "ui" && message.method === "notify") return;
				const handler = answers[message.t] ?? (message.t === "session_file" ? () => ({ ok: true }) : undefined);
				const answer = handler?.(message as never);
				if (answer) void Promise.resolve(answer).then(a => proc.send({ t: "reply", id: message.id, ...a } satisfies ParentMessage));
			}
		},
	});
	const next = <T extends ChildMessage["t"]>(t: T, match: (m: Extract<ChildMessage, { t: T }>) => boolean = () => true) => {
		const test = (m: ChildMessage) => m.t === t && match(m as Extract<ChildMessage, { t: T }>);
		const seen = messages.find(test);
		if (seen) return Promise.resolve(seen as Extract<ChildMessage, { t: T }>);
		return new Promise<Extract<ChildMessage, { t: T }>>(resolve => waiters.push({ test, resolve: m => resolve(m as never) }));
	};
	return {
		messages,
		proc,
		send: message => proc.send(message),
		next,
		end: () => Promise.race([next("done"), next("failed")]),
		exited: proc.exited,
	};
}

const RUNTIME: HostRuntime = { agentDir: "/run/omp-agent", ompDir: "/run/omp", providerKeys: { openai: "sk-test" } };

function startOptions(prompt: string, overrides: Partial<StartOptions> = {}): StartOptions {
	return {
		runId: "run-1",
		cwd: "/run/work",
		sessionDir: join(tempDir(), "sessions"),
		profile: "plan",
		thinking: "low",
		prompt,
		limits: { minutes: 5, costUsd: 1 },
		omp: { settings: {}, mcpServers: {} },
		wantLoadout: false,
		...overrides,
	};
}

function start(host: Host, prompt: string, overrides: Partial<StartOptions> = {}): StartOptions {
	const opts = startOptions(prompt, overrides);
	host.send({ t: "start", runtime: RUNTIME, opts });
	return opts;
}

const replyTo = (host: Host, id: number) => host.next("reply", m => m.id === id) as Promise<Reply>;

describe("agent host protocol", () => {
	test("messages arrive in emission order, the session file waits for its reply, and the result round-trips", async () => {
		const host = spawnHost(FIXTURE);
		const opts = start(host, "happy", {
			omp: { settings: { "task.maxDepth": 2 }, mcpServers: {} },
			outputSchema: { type: "object" },
			resumeFile: "/run/sessions/old.jsonl",
			wantLoadout: true,
			createIssueRepo: "acme/widgets",
		});
		const end = await host.end();
		expect(await host.exited).toBe(0);
		expect(host.messages.filter(m => m.t !== "log").map(m => (m.t === "transcript" ? `transcript:${m.event.type}` : m.t))).toEqual([
			"session_file",
			"transcript:prompt",
			"loadout",
			"registered",
			"progress",
			"transcript:tool_start",
			"todos",
			"progress",
			"usage",
			"transcript:run_end",
			"done",
		]);
		const sessionFile = join(opts.sessionDir, "fixture.jsonl");
		expect(host.messages[0]).toEqual({ t: "session_file", id: 1, path: sessionFile });
		if (end.t !== "done") throw new Error(end.message);
		expect(end.result).toMatchObject({ sessionFile, usage: { costUsd: 0.5 }, oomKills: 2 });
		// What the session saw: the runtime and the serializable options (createIssueRepo/wantLoadout become callbacks).
		const output = end.result.output as { runtime: HostRuntime; data: Record<string, unknown>; hasLoadoutCallback: boolean };
		expect(output.runtime).toEqual(RUNTIME);
		expect(output.hasLoadoutCallback).toBe(true);
		const { createIssueRepo: _c, wantLoadout: _w, ...data } = opts;
		expect(output.data).toEqual(data);
	});

	test("without wantLoadout no loadout is sent", async () => {
		const host = spawnHost(FIXTURE);
		start(host, "happy");
		const end = await host.end();
		expect(end.t === "done" && (end.result.output as { hasLoadoutCallback: boolean }).hasLoadoutCallback).toBe(false);
		expect(host.messages.some(m => m.t === "loadout")).toBe(false);
	});

	test("an ask run writes its outputs into the scratch root", async () => {
		const scratchRoot = tempDir();
		const host = spawnHost(FIXTURE);
		start(host, "happy", { profile: "ask", scratchRoot });
		expect((await host.end()).t).toBe("done");
		expect(await Bun.file(join(scratchRoot, "outputs", "answer.md")).text()).toBe("fixture answer\n");
	});

	test("a refused session_file fails the run before it prompts", async () => {
		const host = spawnHost(FIXTURE, { session_file: () => ({ ok: false, error: "db is locked" }) });
		start(host, "sessionFileRejected");
		expect(await host.end()).toEqual({ t: "failed", message: "db is locked", name: "Error" });
	});

	test("questions go out with their dialog data, answers come back, and the wait is excluded from run time", async () => {
		const host = spawnHost(FIXTURE, {
			ui: async (m: Extract<ChildMessage, { t: "ui" }>) => {
				if (m.method === "askDialog") {
					await Bun.sleep(60);
					return { ok: true, value: { kind: "submit", results: [{ id: "q", question: "Which?", options: ["a", "b"], multi: false, selectedOptions: ["b"] }] } };
				}
				return { ok: true, value: m.args[0] === "Sure?" && m.args[1] === "really" };
			},
		});
		start(host, "ask");
		const end = await host.end();
		if (end.t !== "done") throw new Error(end.message);
		const output = end.result.output as { answer: { results: { selectedOptions: string[] }[] }; confirmed: boolean; pausedMs: number };
		expect(output.answer.results[0]!.selectedOptions).toEqual(["b"]);
		expect(output.confirmed).toBe(true);
		expect(output.pausedMs).toBeGreaterThanOrEqual(50);
		const asks = host.messages.filter(m => m.t === "ui");
		expect(asks[0]).toMatchObject({ method: "askDialog", dialog: { timeout: 1234, initialIndex: 1 } });
		expect(asks.at(-1)).toMatchObject({ method: "notify", args: ["heads up", "warning"] });
	});

	test("a question aborted in the session is cancelled with ui_cancel", async () => {
		const host = spawnHost(FIXTURE, { ui: () => undefined });
		start(host, "cancel");
		const end = await host.end();
		const asked = await host.next("ui");
		expect(await host.next("ui_cancel")).toEqual({ t: "ui_cancel", id: asked.id });
		expect(end.t === "done" && end.result.output).toEqual({ name: "AbortError" });
	});

	test("a failed answer surfaces as an error in the question call", async () => {
		const host = spawnHost(FIXTURE, { ui: () => ({ ok: false, error: "discord is down" }) });
		start(host, "ask");
		expect(await host.end()).toMatchObject({ t: "failed", message: "discord is down" });
	});

	test("create_issue is a tool_call; its result and its errors reach the session", async () => {
		const host = spawnHost(FIXTURE, {
			tool_call: (m: Extract<ChildMessage, { t: "tool_call" }>) =>
				m.params.title === "boom" ? { ok: false, error: "GitHub said no" } : { ok: true, value: { number: 7, url: "https://github.com/acme/widgets/issues/7" } },
		});
		start(host, "issue", { profile: "chat", createIssueRepo: "acme/widgets" });
		const end = await host.end();
		expect(end.t === "done" && end.result.output).toEqual({
			repo: "acme/widgets",
			filed: { number: 7, url: "https://github.com/acme/widgets/issues/7" },
			failure: "GitHub said no",
		});
		expect(host.messages.find(m => m.t === "tool_call")).toMatchObject({ name: "create_issue", params: { title: "Title", body: "Body" } });
	});

	test("credential_request carries the sign-in and resolves with the orchestrator's token", async () => {
		const host = spawnHost(FIXTURE, { credential_request: () => ({ ok: true, value: { accessToken: "new", expiresAt: 123 } }) });
		start(host, "credential");
		const end = await host.end();
		expect(host.messages.find(m => m.t === "credential_request")).toEqual({ t: "credential_request", id: 1, provider: "fixture", credentialId: "1", accessToken: "old" });
		expect(end.t === "done" && end.result.output).toEqual({ value: { accessToken: "new", expiresAt: 123 } });
	});

	test("a refused or malformed credential reply rejects the request", async () => {
		const refused = spawnHost(FIXTURE, { credential_request: () => ({ ok: false, error: "revoked: sign-in removed" }) });
		start(refused, "credential");
		const end = await refused.end();
		expect(end.t === "done" && end.result.output).toEqual({ error: "revoked: sign-in removed" });

		const malformed = spawnHost(FIXTURE, { credential_request: () => ({ ok: true, value: { token: "x" } }) });
		start(malformed, "credential");
		const end2 = await malformed.end();
		expect(end2.t === "done" && end2.result.output).toEqual({ error: "Malformed credential reply for fixture" });
	});

	test("steer and abort go through the registered handle; abort carries its reason", async () => {
		const host = spawnHost(FIXTURE);
		start(host, "steerable");
		await host.next("registered");
		host.send({ t: "steer", id: 1, text: "look at foo.ts" });
		host.send({ t: "steer", id: 2, text: "and bar.ts" });
		expect(await replyTo(host, 2)).toEqual({ t: "reply", id: 2, ok: true });
		host.send({ t: "abort", id: 3, reason: "cost" });
		const end = await host.end();
		expect(await replyTo(host, 3)).toEqual({ t: "reply", id: 3, ok: true });
		expect(end.t === "done" && end.result).toMatchObject({ output: ["look at foo.ts", "and bar.ts"], aborted: "cost" });
	});

	test("before the session registers, a steer is refused as not ready and an abort is deferred; the first reason wins", async () => {
		const host = spawnHost(FIXTURE);
		start(host, "lateRegister");
		host.send({ t: "steer", id: 1, text: "too early" });
		host.send({ t: "abort", id: 2, reason: "time" });
		host.send({ t: "abort", id: 3, reason: "user" });
		expect(await replyTo(host, 1)).toEqual({ t: "reply", id: 1, ok: false, error: "Agent session is not ready" });
		const end = await host.end();
		expect(end.t === "done" && end.result.aborted).toBe("time");
	});

	test("a missing yield fails as NoStructuredOutput; other failures keep their message; log lines are relayed", async () => {
		const noYield = spawnHost(FIXTURE);
		start(noYield, "noYield");
		expect(await noYield.end()).toEqual({ t: "failed", message: "finished without calling yield", name: "NoStructuredOutput" });
		expect(noYield.messages.filter(m => m.t === "log" && m.line.includes("fixture log line"))).toHaveLength(1);

		const failure = spawnHost(FIXTURE);
		start(failure, "failure");
		expect(await failure.end()).toEqual({ t: "failed", message: "model exploded", name: "Error" });
		const unknown = spawnHost(FIXTURE);
		start(unknown, "nope");
		expect(await unknown.end()).toMatchObject({ t: "failed", message: "no script nope" });
	});

	test("transcript events are cut to their limits before they leave the host", async () => {
		const host = spawnHost(FIXTURE);
		start(host, "bigTranscript");
		const event = (await host.next("transcript")).event;
		if (event.type !== "tool_end") throw new Error(event.type);
		expect(event.text.length).toBeLessThan(TRANSCRIPT_LIMITS.tool_end + 100);
		expect(event.text).toEndWith("more chars truncated]");
	});

	test("when the supervisor disconnects, the host aborts the session and exits", async () => {
		const running = spawnHost(FIXTURE);
		start(running, "steerable");
		await running.next("registered");
		running.proc.disconnect();
		expect(await running.exited).toBe(1);

		const idle = spawnHost(FIXTURE);
		await Bun.sleep(100);
		idle.proc.disconnect();
		expect(await idle.exited).toBe(1);
	});
});

describe("host.ts entry", () => {
	test("without an IPC channel it exits non-zero with a clear message", async () => {
		const proc = Bun.spawn([process.execPath, HOST], { stdio: ["ignore", "pipe", "pipe"] });
		expect(await proc.exited).not.toBe(0);
		expect(await new Response(proc.stderr).text()).toContain("no IPC channel");
	});

	test("a PI_CODING_AGENT_DIR that is not the run's agent dir fails the run", async () => {
		const agentDir = join(tempDir(), "omp-agent");
		const host = spawnHost(HOST, {}, { PI_CODING_AGENT_DIR: join(tempDir(), "elsewhere"), HOME: tempDir() });
		host.send({ t: "start", runtime: { ...RUNTIME, agentDir }, opts: startOptions("hi") });
		const end = await host.end();
		expect(end).toMatchObject({ t: "failed", name: "Error" });
		expect(end.t === "failed" && end.message).toContain("PI_CODING_AGENT_DIR");
		expect(await host.exited).toBe(0);
	}, 30_000);
});

describe("credential refresh hook (S1, CRED-03)", () => {
	async function seededStore(requests: unknown[], answer: () => Promise<{ accessToken: string; expiresAt: number }>): Promise<{ storage: AuthStorage; id: number }> {
		const storage = await discoverAuthStorage(tempDir(), {
			authStorageOptions: {
				refreshOAuthCredential: credentialRefreshHook(async request => {
					requests.push(request);
					return answer();
				}),
			},
		});
		await storage.credentials.set("anthropic", [{ type: "oauth", access: "access-v1", refresh: REMOTE_REFRESH_SENTINEL, expires: Date.now() - 60_000, email: "a@example.com" }]);
		const row = storage.credentials.list("anthropic")[0]!;
		return { storage, id: row.id };
	}

	test("a refresh is a credential request; the store keeps the new token and the __remote__ sentinel", async () => {
		const requests: unknown[] = [];
		const expiresAt = Date.now() + 3_600_000;
		const { storage, id } = await seededStore(requests, async () => ({ accessToken: "access-v2", expiresAt }));
		try {
			await storage.oauth.refresh(id);
			expect(requests).toEqual([{ provider: "anthropic", credentialId: String(id), accessToken: "access-v1" }]);
			const credential = storage.credentials.list("anthropic")[0]!.credential;
			expect(credential).toMatchObject({ type: "oauth", access: "access-v2", refresh: REMOTE_REFRESH_SENTINEL, expires: expiresAt, email: "a@example.com" });
		} finally {
			storage.close();
		}
	});

	test("a refusal containing 'revoked' disables the run's copy", async () => {
		const { storage, id } = await seededStore([], async () => {
			throw new Error("revoked: sign-in for anthropic was removed");
		});
		try {
			await storage.oauth.refresh(id).catch(() => {});
			expect(storage.credentials.list("anthropic")).toEqual([]);
		} finally {
			storage.close();
		}
	});
});
