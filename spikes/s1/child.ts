/**
 * Spike S1 worker side. Receives a run spec with a redacted sign-in snapshot over IPC (never from disk), writes it to a
 * run-private omp auth store (mode 0700), and replaces omp's OAuth refresh step with a `credential-request` to the
 * parent. Then resolves API keys the way a session does and runs a real `createAgentSession` turn against the fake
 * model endpoint. Modes:
 * - `normal`: refresh hook installed.
 * - `control`: no hook (negative control: shows the token endpoint counter catches a direct refresh).
 * - `revoked`: hook installed; the parent refuses because the sign-in was removed (CRED-05).
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SnapshotEntry = { id: number; provider: string; credential: Record<string, unknown> & { type: string } };
type Spec = { type: "run-spec"; name: string; mode: "normal" | "control" | "revoked"; baseUrl: string; tokenUrl: string; snapshot: SnapshotEntry[] };
type Reply =
	| { type: "credential"; reqId: number; credential: { access: string; refresh: string; expires: number } }
	| { type: "credential-refused"; reqId: number; error: string };

const send = (msg: unknown) => process.send?.(msg);
const specReceived = Promise.withResolvers<Spec>();
process.once("message", msg => specReceived.resolve(msg as Spec));
const spec = await specReceived.promise;
const say = (msg: string, fields: Record<string, unknown> = {}) => send({ type: "log", name: spec.name, msg, ...fields });

// Record every outbound HTTP request this process makes.
const fetchLog: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		fetchLog.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url}`);
		return realFetch(input, init);
	},
	realFetch,
);

// CRED-02: run-private store on run-local storage, mode 0700. omp must resolve its agent dir here, so set it before
// the SDK is imported (pi-utils resolves PI_CODING_AGENT_DIR at module load).
const runDir = await mkdtemp(join(process.env.S1_RUN_ROOT ?? tmpdir(), `agentbot-run-${spec.name}-`));
const runDirMode = ((await stat(runDir)).mode & 0o777).toString(8);
process.env.PI_CODING_AGENT_DIR = runDir;
// Dynamic import on purpose: pi-utils resolves PI_CODING_AGENT_DIR at module load, so it must be set first.
const { ModelRegistry, SessionManager, createAgentSession, discoverAuthStorage } = await import("@oh-my-pi/pi-coding-agent");
const { PROVIDER, MODEL_ID, registerFakeProvider } = await import("./fake-provider");

// IPC callback: in production this is the worker's `credential-request` to the orchestrator.
let nextReq = 0;
const pending = new Map<number, (reply: Reply) => void>();
process.on("message", msg => {
	const reply = msg as Reply;
	pending.get(reply.reqId)?.(reply);
	pending.delete(reply.reqId);
});
let credentialRequests = 0;
const masterIdOf = new Map<number, number>();

const requestCredential = async (provider: string, credentialId: number, credential: { access: string }, _signal?: AbortSignal, reason?: string) => {
	credentialRequests++;
	const reqId = nextReq++;
	const masterId = masterIdOf.get(credentialId);
	say("refresh hook called", { provider, credentialId, masterId, reason });
	if (masterId === undefined) throw new Error(`s1: no orchestrator id for credential ${credentialId}`);
	const replied = Promise.withResolvers<Reply>();
	pending.set(reqId, replied.resolve);
	send({ type: "credential-request", reqId, name: spec.name, provider, credentialId: masterId, access: credential.access });
	const reply = await replied.promise;
	if (reply.type === "credential-refused") throw new Error(reply.error);
	return reply.credential;
};

// Same call DevForge's openSessionRuntime makes, plus the refresh override.
const authStorage = await discoverAuthStorage(runDir, {
	authStorageOptions: spec.mode === "control" ? {} : { refreshOAuthCredential: requestCredential },
});

// Seed from the snapshot; remember each local row's orchestrator id.
for (const [provider, entries] of Map.groupBy(spec.snapshot, e => e.provider)) {
	await authStorage.credentials.set(provider, entries.map(e => e.credential) as never);
	const rows = authStorage.credentials.list(provider);
	rows.forEach((row, i) => {
		const entry = entries[i];
		if (!entry || row.credential.type !== "oauth" || row.credential.access !== entry.credential.access) throw new Error("s1: seed order mismatch");
		masterIdOf.set(row.id, entry.id);
	});
}

const registry = new ModelRegistry(authStorage, join(runDir, "models.yml"), {
	fetch: () => Promise.reject(new Error("s1: model catalog fetch disabled")),
});
registerFakeProvider(registry, { baseUrl: spec.baseUrl, tokenUrl: spec.tokenUrl, role: `worker:${spec.name}`, headers: { "x-s1-run": spec.name } });
const model = registry.find(PROVIDER, MODEL_ID);
if (!model) throw new Error("s1: fake model not registered");

// (b1) Resolve the key the way a session does, three times concurrently.
const keys = await Promise.allSettled([registry.getApiKey(model), registry.getApiKey(model), registry.getApiKey(model)]);
say("getApiKey x3", { keys: keys.map(k => (k.status === "fulfilled" ? k.value : `rejected: ${String(k.reason)}`)), credentialRequests });

// (b2) A real agent session turn against the fake model endpoint.
let sessionReply: string | undefined;
let sessionError: string | undefined;
if (spec.mode === "normal") {
	const cwd = join(runDir, "work");
	await Bun.write(join(cwd, ".keep"), "");
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: runDir,
			authStorage,
			modelRegistry: registry,
			model,
			thinkingLevel: "off",
			sessionManager: SessionManager.inMemory(cwd),
			hasUI: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			toolNames: [],
			restrictToolNames: true,
		});
		await session.prompt("ping");
		const last = session.messages.at(-1) as { role?: string; content?: unknown; errorMessage?: string } | undefined;
		sessionReply = JSON.stringify({ role: last?.role, content: last?.content, error: last?.errorMessage });
		await session.dispose();
	} catch (err) {
		sessionError = String(err);
	}
}

const rows = authStorage.credentials.list(PROVIDER).map(r => ({ id: r.id, credential: r.credential, disabledCause: r.disabledCause }));
const disabled = await authStorage.credentials.listDisabled(PROVIDER);
authStorage.close();
await rm(runDir, { recursive: true, force: true });
const runDirRemoved = !(await stat(runDir).catch(() => undefined));

send({
	type: "result",
	name: spec.name,
	mode: spec.mode,
	runDirMode,
	runDirRemoved,
	credentialRequests,
	keys: keys.map(k => (k.status === "fulfilled" ? k.value : `rejected: ${String(k.reason)}`)),
	sessionReply,
	sessionError,
	storedAfter: rows,
	disabled,
	fetchLog,
});
process.exit(0);
