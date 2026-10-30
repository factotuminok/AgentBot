import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink } from "../../src/shared/log";
import { ArtifactClient, ArtifactError } from "../../src/worker/artifacts";

/** RUN-06: a worker's uploads that fail while the orchestrator is away go through once it is back. */

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function sessionFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agentbot-worker-artifacts-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "session.jsonl");
	await writeFile(path, '{"type":"session"}\n');
	return path;
}

/** A port nothing listens on right now (the orchestrator is away). */
function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const { port } = probe;
	probe.stop(true);
	return Number(port);
}

test("an upload started while the orchestrator is down is retried and lands after it comes back (RUN-06)", async () => {
	const path = await sessionFile();
	const port = freePort();
	const controller = new AbortController();
	cleanups.push(() => controller.abort());
	const client = new ArtifactClient({ orchestratorUrl: `http://127.0.0.1:${port}`, runId: "run-1", leaseToken: "lease", signal: controller.signal, retryMinMs: 20, retryMaxMs: 60 });

	const received: { path: string; auth: string | null; body: string }[] = [];
	let answers = [503];
	// Connection refused (the orchestrator is away) until two retries have been logged, then a 503, then accepted.
	const refused = Promise.withResolvers<void>();
	let retries = 0;
	setLogSink(line => {
		if (line.includes('"msg":"artifact request failed; retrying"') && ++retries === 2) refused.resolve();
	});
	cleanups.push(() => setLogSink(undefined));
	const upload = client.upload("session", path);
	await refused.promise;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch: async req => {
			received.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.text() });
			return new Response(null, { status: answers.shift() ?? 204 });
		},
	});
	cleanups.push(() => server.stop(true));
	await upload;
	expect(received).toHaveLength(2);
	expect(received.at(-1)).toEqual({ path: "/internal/runs/run-1/session", auth: "Bearer lease", body: '{"type":"session"}\n' });

	// A refusal (4xx) is final, not retried.
	answers = [409];
	await expect(client.upload("session", path)).rejects.toBeInstanceOf(ArtifactError);
	expect(received).toHaveLength(3);
});
