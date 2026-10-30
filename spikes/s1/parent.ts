/**
 * Spike S1 orchestrator side. Holds the "master" omp auth store with one fake OAuth sign-in whose access token is
 * already expired, serves a fake token endpoint and a fake OpenAI-compatible model endpoint (both instrumented), and
 * answers workers' `credential-request`s by refreshing in the master store. Launch through `run.ts` (sandboxed HOME).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, REMOTE_REFRESH_SENTINEL } from "@oh-my-pi/pi-coding-agent";
import { MODEL_ID, PROVIDER, registerFakeProvider } from "./fake-provider";

const sandbox = process.env.S1_SANDBOX;
if (!sandbox) throw new Error("run through spikes/s1/run.ts");
const TOKEN_LATENCY_MS = 300;

// ── Fake endpoints ───────────────────────────────────────────────────────────
const tokenHits: { role: string; refreshToken: string; status: number }[] = [];
const chatHits: { run: string; authorization: string }[] = [];
const otherHits: string[] = [];
let generation = 1;
let validRefresh = "refresh-v1";

const sse = (chunks: unknown[]) =>
	new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/token") {
			const body = (await req.json()) as { refresh_token: string };
			const role = req.headers.get("x-s1-role") ?? "unknown";
			await Bun.sleep(TOKEN_LATENCY_MS);
			if (body.refresh_token !== validRefresh) {
				tokenHits.push({ role, refreshToken: body.refresh_token, status: 400 });
				return Response.json({ error: "invalid_grant", error_description: "refresh token invalid" }, { status: 400 });
			}
			// Rotating refresh tokens, like Anthropic: the old one is dead after one use.
			generation++;
			validRefresh = `refresh-v${generation}`;
			tokenHits.push({ role, refreshToken: body.refresh_token, status: 200 });
			return Response.json({ access: `access-v${generation}`, refresh: validRefresh, expires: Date.now() + 3_600_000 });
		}
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
			chatHits.push({ run: req.headers.get("x-s1-run") ?? "?", authorization: req.headers.get("authorization") ?? "" });
			if (req.headers.get("authorization") !== `Bearer access-v${generation}`) {
				return Response.json({ error: { message: "invalid bearer", type: "authentication_error" } }, { status: 401 });
			}
			const base = { id: "s1", object: "chat.completion.chunk", created: 0, model: MODEL_ID };
			return sse([
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
			]);
		}
		otherHits.push(`${req.method} ${url.pathname}`);
		return new Response("not found", { status: 404 });
	},
});
const baseUrl = `http://127.0.0.1:${server.port}/v1`;
const tokenUrl = `http://127.0.0.1:${server.port}/token`;

// ── Master store (orchestrator, CRED-01) ─────────────────────────────────────
const masterDir = join(sandbox, "orchestrator", "omp-agent");
await mkdir(masterDir, { recursive: true, mode: 0o700 });
const master = await AuthStorage.create(join(masterDir, "agent.db"));
const masterRegistry = new ModelRegistry(master, join(masterDir, "models.yml"), {
	fetch: () => Promise.reject(new Error("s1: model catalog fetch disabled")),
});
registerFakeProvider(masterRegistry, { baseUrl, tokenUrl, role: "orchestrator" });
await master.credentials.set(PROVIDER, {
	type: "oauth",
	access: "access-v1",
	refresh: "refresh-v1",
	expires: Date.now() - 60_000,
	email: "s1@example.invalid",
	accountId: "s1-account",
});
const snapshot = master.credentials.snapshot().credentials;
console.log("snapshot sent in run spec:", JSON.stringify(snapshot));

// ── credential-request handler (prototype of the orchestrator side of CRED-03 / CRED-05) ──
const credentialRequests: { name: string; provider: string; credentialId: number; workerAccess: string; answer: string }[] = [];
async function answer(req: { provider: string; credentialId: number; access: string }) {
	const row = master.credentials.list(req.provider).find(r => r.id === req.credentialId);
	if (!row || row.credential.type !== "oauth") return { refused: `revoked: sign-in for ${req.provider} was removed` };
	const current = row.credential;
	// The worker's token is older than ours and ours is still good: hand it out without a new refresh.
	if (current.access !== req.access && current.expires > Date.now() + 5 * 60_000) {
		return { credential: { access: current.access, refresh: REMOTE_REFRESH_SENTINEL, expires: current.expires }, via: "cached" };
	}
	// Per-credential single-flight inside omp: concurrent requests share one token exchange.
	const entry = await master.oauth.refresh(row.id);
	if (entry.credential.type !== "oauth") throw new Error("s1: not oauth");
	return { credential: { access: entry.credential.access, refresh: entry.credential.refresh, expires: entry.credential.expires }, via: "refreshed" };
}

type ChildMsg =
	| { type: "log"; name: string; msg: string }
	| { type: "credential-request"; reqId: number; name: string; provider: string; credentialId: number; access: string }
	| ({ type: "result"; name: string } & Record<string, unknown>);

function runChild(name: string, mode: "normal" | "control" | "revoked", snap: typeof snapshot) {
	const done = Promise.withResolvers<Record<string, unknown>>();
	const child = Bun.spawn({
		cmd: [process.execPath, join(import.meta.dir, "child.ts")],
		env: { ...process.env, S1_RUN_ROOT: join(sandbox!, "worker-run-local") },
		stdout: "inherit",
		stderr: "inherit",
		ipc(raw) {
			const msg = raw as ChildMsg;
			if (msg.type === "log") console.log(`[${name}]`, JSON.stringify(msg));
			else if (msg.type === "result") done.resolve(msg);
			else if (msg.type === "credential-request") {
				answer(msg).then(
					res => {
						credentialRequests.push({ name, provider: msg.provider, credentialId: msg.credentialId, workerAccess: msg.access, answer: "refused" in res ? `refused: ${res.refused}` : `${res.via} ${res.credential.access}` });
						child.send("refused" in res ? { type: "credential-refused", reqId: msg.reqId, error: res.refused } : { type: "credential", reqId: msg.reqId, credential: res.credential });
					},
					err => child.send({ type: "credential-refused", reqId: msg.reqId, error: String(err) }),
				);
			}
		},
	});
	child.send({ type: "run-spec", name, mode, baseUrl, tokenUrl, snapshot: snap });
	void child.exited.then(code => done.resolve({ name, exitedWithoutResult: code }));
	return done.promise;
}

await mkdir(join(sandbox, "worker-run-local"), { recursive: true });
const phase = (title: string) => console.log(`\n=== ${title} ===`);

phase("1. two workers, expired snapshot, refresh hook installed (concurrently)");
const normal = await Promise.all([runChild("A", "normal", snapshot), runChild("B", "normal", snapshot)]);
for (const r of normal) console.log(JSON.stringify(r, null, 1));

phase("1b. worker whose access token looks fresh but the model endpoint rejects it (401 → omp auth-recovery)");
const staleSnapshot = snapshot.map(e => ({ ...e, credential: { ...e.credential, access: "access-stale", expires: Date.now() + 3_600_000 } }));
const stale = await runChild("E", "normal", staleSnapshot);
console.log(JSON.stringify(stale, null, 1));

phase("2. negative control: worker without the hook");
const control = await runChild("C", "control", snapshot);
console.log(JSON.stringify(control, null, 1));

phase("3. sign-out, then a worker holding the old snapshot asks for a refresh (CRED-05)");
const removed = await master.credentials.removeById(PROVIDER, snapshot[0]!.id);
console.log("removed from master:", removed);
const revoked = await runChild("D", "revoked", snapshot);
console.log(JSON.stringify(revoked, null, 1));

phase("summary");
console.log("token endpoint hits:", JSON.stringify(tokenHits));
console.log("credential-requests answered by orchestrator:", JSON.stringify(credentialRequests));
console.log("model endpoint hits:", JSON.stringify(chatHits));
console.log("other endpoint hits:", JSON.stringify(otherHits));

const workerTokenHits = (names: string[]) => tokenHits.filter(h => names.some(n => h.role === `worker:${n}`));
const ok = {
	a_childCalledHook: normal.every(r => r.credentialRequests === 1),
	b_keysUseRefreshedToken: normal.every(r => (r.keys as string[]).every(k => k === "access-v2")),
	b_sessionUsedRefreshedToken: ["A", "B"].every(n => chatHits.some(h => h.run === n && h.authorization === "Bearer access-v2")) && normal.every(r => String(r.sessionReply).includes("pong")),
	c_workersNeverHitTokenEndpoint: workerTokenHits(["A", "B", "D", "E"]).length === 0,
	c_onlyOneOrchestratorRefresh: tokenHits.filter(h => h.role === "orchestrator").length === 1,
	control_counterCatchesDirectRefresh: workerTokenHits(["C"]).length === 1,
	revoked_refused: revoked.credentialRequests === 1 && workerTokenHits(["D"]).length === 0 && (revoked.keys as string[]).every(k => k === undefined || k === null || String(k).startsWith("rejected")),
	authRecovery_hookOn401: stale.credentialRequests === 1 && chatHits.some(h => h.run === "E" && h.authorization === "Bearer access-stale") && chatHits.some(h => h.run === "E" && h.authorization === "Bearer access-v2") && String(stale.sessionReply).includes("pong"),
	runDirs0700AndRemoved: [...normal, stale, control, revoked].every(r => r.runDirMode === "700" && r.runDirRemoved === true),
};
console.log("checks:", JSON.stringify(ok, null, 1));
console.log(Object.values(ok).every(Boolean) ? "S1 RESULT: PASS" : "S1 RESULT: FAIL");
master.close();
server.stop(true);
process.exit(0);
