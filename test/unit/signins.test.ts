/**
 * Spike S1 as a unit test: the orchestrator's sign-in store answers workers' refresh requests, workers' run-private
 * stores refresh only through the `refreshOAuthCredential` hook, and only the orchestrator ever exchanges a refresh
 * token. A fake OAuth provider and a fake (rotating) token endpoint stand in for real ones; HOME and
 * PI_CODING_AGENT_DIR point into a temp dir so nothing touches `~/.omp`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthStorage, ModelRegistry as ModelRegistryType } from "@oh-my-pi/pi-coding-agent";
import type { CredentialSnapshot } from "../../src/shared/wire";

const sandbox = mkdtempSync(join(tmpdir(), "agentbot-signins-"));
const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = join(sandbox, "home");
process.env.PI_CODING_AGENT_DIR = join(sandbox, "home", "omp-agent");
// Dynamic on purpose: HOME and PI_CODING_AGENT_DIR must be set before omp resolves its dirs at module load.
const { ModelRegistry, REMOTE_REFRESH_SENTINEL, discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
const { openSignins, signinsDir } = await import("../../src/orchestrator/store/signins");
type Signins = Awaited<ReturnType<typeof openSignins>>;

const PROVIDER = "agentbot-fake-oauth";
const MODEL_ID = "agentbot-fake-model";

// ── Fake token endpoint: rotates refresh tokens like Anthropic, so a reused one gets invalid_grant ──
let generation = 1;
let validRefresh = "refresh-v1";
let tokenHits: { refreshToken: string; status: number }[] = [];
let hold: Promise<void> | undefined;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = (await req.json()) as { refresh_token: string };
		await hold;
		if (body.refresh_token !== validRefresh) {
			tokenHits.push({ refreshToken: body.refresh_token, status: 400 });
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		generation++;
		validRefresh = `refresh-v${generation}`;
		tokenHits.push({ refreshToken: body.refresh_token, status: 200 });
		return Response.json({ access: `access-v${generation}`, refresh: validRefresh, expires: Date.now() + 3_600_000 });
	},
});
const tokenUrl = `http://127.0.0.1:${server.port}/token`;

/** Registers the fake provider (omp keeps OAuth providers in a process-global registry). */
function registerFakeProvider(registry: ModelRegistryType): void {
	registry.registerProvider(PROVIDER, {
		baseUrl: "http://127.0.0.1:9/v1",
		api: "openai-completions",
		oauth: {
			name: "Fake OAuth",
			login: () => Promise.reject(new Error("no login in tests")),
			refreshToken: async credentials => {
				const res = await fetch(tokenUrl, { method: "POST", body: JSON.stringify({ refresh_token: credentials.refresh }) });
				if (!res.ok) throw new Error(`token endpoint: ${res.status} ${await res.text()}`);
				return { ...credentials, ...((await res.json()) as object) };
			},
		},
		models: [{ id: MODEL_ID, name: "Fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_000 }],
	});
}

const noFetch = { fetch: () => Promise.reject(new Error("model catalog fetch disabled")) };

interface Worker {
	registry: ModelRegistryType;
	store: AuthStorage;
	requests: number;
	keys(): Promise<(string | undefined)[]>;
	close(): Promise<void>;
}

/** A worker's run-private store seeded from the snapshot, with the S1 hook (or none, for the negative control). */
async function openWorker(signins: Signins, snapshot: CredentialSnapshot[], hook = true): Promise<Worker> {
	const runDir = await mkdtemp(join(sandbox, "run-"));
	const orchestratorId = new Map<number, number>();
	const worker = { requests: 0 } as Worker;
	const store = await discoverAuthStorage(runDir, {
		cwd: runDir,
		authStorageOptions: hook
			? {
					refreshOAuthCredential: async (provider, credentialId, credential) => {
						worker.requests++;
						const answer = await signins.handleCredentialRequest({ provider, credentialId: String(orchestratorId.get(credentialId)), accessToken: credential.access });
						if (!answer.ok) throw new Error(answer.error);
						return { ...credential, access: answer.accessToken, refresh: REMOTE_REFRESH_SENTINEL, expires: answer.expiresAt };
					},
				}
			: {},
	});
	const entries = snapshot as unknown as { id: number; provider: string; credential: { type: "oauth"; access: string; refresh: string; expires: number } }[];
	for (const [provider, group] of Map.groupBy(entries, e => e.provider)) {
		await store.credentials.set(provider, group.map(e => e.credential));
		store.credentials.list(provider).forEach((row, i) => orchestratorId.set(row.id, group[i]!.id));
	}
	const registry = new ModelRegistry(store, join(runDir, "models.yml"), noFetch);
	registerFakeProvider(registry);
	const model = registry.find(PROVIDER, MODEL_ID)!;
	return Object.assign(worker, {
		registry,
		store,
		keys: () => Promise.all([registry.getApiKey(model), registry.getApiKey(model), registry.getApiKey(model)]),
		async close() {
			store.close();
			await rm(runDir, { recursive: true, force: true });
		},
	});
}

/** The snapshot as a run would hold it once its copy has expired (a run outliving the token). */
function expired(snapshot: CredentialSnapshot[]): CredentialSnapshot[] {
	return snapshot.map(e => ({ ...e, credential: { ...(e.credential as object), expires: Date.now() - 1_000 } }));
}

let stateDir: string;
let signins: Signins;
let workers: Worker[];

async function signIn(expires: number): Promise<void> {
	await signins.authStorage.credentials.set(PROVIDER, { type: "oauth", access: "access-v1", refresh: "refresh-v1", expires, email: "a@example.invalid", accountId: "acct" });
}

beforeEach(async () => {
	generation = 1;
	validRefresh = "refresh-v1";
	tokenHits = [];
	hold = undefined;
	workers = [];
	stateDir = await mkdtemp(join(sandbox, "state-"));
	signins = await openSignins(stateDir, { answerWithinMs: 500 });
	registerFakeProvider(new ModelRegistry(signins.authStorage, join(signinsDir(stateDir), "models.yml"), noFetch));
});

afterEach(async () => {
	for (const w of workers) await w.close();
	signins.close();
	await rm(stateDir, { recursive: true, force: true });
});

afterAll(() => {
	server.stop(true);
	rmSync(sandbox, { recursive: true, force: true });
	process.env.HOME = saved.HOME;
	if (saved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.PI_CODING_AGENT_DIR;
});

describe("sign-in store (CRED-01)", () => {
	test("lives in omp's SQLite store at <state>/omp-agent/agent.db, mode 0700", async () => {
		await signIn(Date.now() + 3_600_000);
		expect(signinsDir(stateDir)).toBe(join(stateDir, "omp-agent"));
		expect(statSync(join(stateDir, "omp-agent")).mode & 0o777).toBe(0o700);
		expect(statSync(join(stateDir, "omp-agent", "agent.db")).isFile()).toBe(true);
	});
});

describe("snapshotForRun (CRED-02)", () => {
	test("refreshes a sign-in expiring within 10 minutes first, and never carries a refresh token", async () => {
		await signIn(Date.now() + 5 * 60_000);
		const snapshot = await signins.snapshotForRun();
		expect(tokenHits).toEqual([{ refreshToken: "refresh-v1", status: 200 }]);
		expect(snapshot).toEqual([{ id: expect.any(Number), provider: PROVIDER, credential: expect.objectContaining({ type: "oauth", access: "access-v2", refresh: REMOTE_REFRESH_SENTINEL }), identityKey: expect.any(String) }]);
		expect(JSON.stringify(snapshot)).not.toContain("refresh-v");
	});

	test("leaves a sign-in with more than 10 minutes left alone", async () => {
		await signIn(Date.now() + 11 * 60_000);
		const snapshot = await signins.snapshotForRun();
		expect(tokenHits).toEqual([]);
		expect(snapshot[0]!.credential).toMatchObject({ access: "access-v1" });
	});

	test("a sign-in the provider rejects (invalid_grant) is dropped by omp; dispatch still gets a snapshot", async () => {
		await signIn(Date.now() + 60_000);
		validRefresh = "something-else";
		expect(await signins.snapshotForRun()).toEqual([]);
		expect(tokenHits).toEqual([{ refreshToken: "refresh-v1", status: 400 }]);
	});
});

describe("credential requests (CRED-03, spike S1)", () => {
	test("two runs refreshing at once share one orchestrator refresh; workers never reach the token endpoint", async () => {
		await signIn(Date.now() + 3_600_000);
		const snapshot = expired(await signins.snapshotForRun());
		workers = [await openWorker(signins, snapshot), await openWorker(signins, snapshot)];
		const [a, b] = await Promise.all(workers.map(w => w.keys()));
		expect([...a!, ...b!]).toEqual(Array(6).fill("access-v2"));
		expect(workers.map(w => w.requests)).toEqual([1, 1]);
		expect(tokenHits).toEqual([{ refreshToken: "refresh-v1", status: 200 }]);
		for (const w of workers) {
			expect(w.store.credentials.list(PROVIDER)[0]!.credential).toMatchObject({ access: "access-v2", refresh: REMOTE_REFRESH_SENTINEL });
		}
		expect(signins.authStorage.credentials.list(PROVIDER)[0]!.credential).toMatchObject({ access: "access-v2", refresh: "refresh-v2" });
	});

	test("a worker with an older token gets the stored fresh one without a refresh", async () => {
		await signIn(Date.now() + 3_600_000);
		const [entry] = await signins.snapshotForRun();
		const answer = await signins.handleCredentialRequest({ provider: PROVIDER, credentialId: String(entry!.id), accessToken: "access-stale" });
		expect(answer).toEqual({ ok: true, accessToken: "access-v1", expiresAt: expect.any(Number) });
		expect(tokenHits).toEqual([]);
	});

	test("a worker whose current token was rejected (401 recovery) gets a newly minted one", async () => {
		await signIn(Date.now() + 3_600_000);
		const [entry] = await signins.snapshotForRun();
		const answer = await signins.handleCredentialRequest({ provider: PROVIDER, credentialId: entry!.id as number, accessToken: "access-v1" });
		expect(answer).toMatchObject({ ok: true, accessToken: "access-v2" });
		expect(tokenHits).toEqual([{ refreshToken: "refresh-v1", status: 200 }]);
		const again = await signins.handleCredentialRequest({ provider: PROVIDER, credentialId: entry!.id as number, accessToken: "access-v1" });
		expect(again).toMatchObject({ ok: true, accessToken: "access-v2" });
		expect(tokenHits).toHaveLength(1);
	});

	test("negative control: without the hook a worker hits the token endpoint with only the placeholder, and the chain survives", async () => {
		await signIn(Date.now() + 3_600_000);
		const snapshot = expired(await signins.snapshotForRun());
		workers = [await openWorker(signins, snapshot, false)];
		expect(await workers[0]!.keys()).toEqual([undefined, undefined, undefined]);
		expect(tokenHits).toEqual([{ refreshToken: REMOTE_REFRESH_SENTINEL, status: 400 }]);
		workers.push(await openWorker(signins, snapshot));
		expect(await workers[1]!.keys()).toEqual(["access-v2", "access-v2", "access-v2"]);
	});

	test("answers within the deadline when the provider hangs, and the late result is reused", async () => {
		await signIn(Date.now() + 3_600_000);
		const [entry] = await signins.snapshotForRun();
		const release = Promise.withResolvers<void>();
		hold = release.promise;
		const answer = await signins.handleCredentialRequest({ provider: PROVIDER, credentialId: entry!.id as number, accessToken: "access-v1" });
		expect(answer.ok).toBe(false);
		release.resolve();
		const retry = await signins.handleCredentialRequest({ provider: PROVIDER, credentialId: entry!.id as number, accessToken: "access-v1" });
		expect(retry).toMatchObject({ ok: true, accessToken: "access-v2" });
		expect(tokenHits).toEqual([{ refreshToken: "refresh-v1", status: 200 }]);
	});
});

describe("sign-out (CRED-05)", () => {
	test("later requests for the sign-in are refused, and the worker's copy is disabled without a token request", async () => {
		await signIn(Date.now() + 3_600_000);
		const snapshot = expired(await signins.snapshotForRun());
		expect(await signins.signOut(PROVIDER)).toBe(true);
		expect(await signins.signOut(PROVIDER)).toBe(false);
		expect(await signins.snapshotForRun()).toEqual([]);
		expect(await signins.handleCredentialRequest({ provider: PROVIDER, credentialId: snapshot[0]!.id as number, accessToken: "access-v1" })).toEqual({
			ok: false,
			error: `revoked: sign-in for ${PROVIDER} was removed`,
		});
		workers = [await openWorker(signins, snapshot)];
		expect(await workers[0]!.keys()).toEqual([undefined, undefined, undefined]);
		expect(workers[0]!.requests).toBe(1);
		expect(tokenHits).toEqual([]);
	});
});
