/**
 * The workers' read-only git endpoint (RUN-17, WS-02): smart HTTP around `git upload-pack --stateless-rpc`, serving
 * only the repo's mirror (never the runs repo) to a worker holding a live lease for that repo. Port of spike S3's
 * handler (wiki/spikes/S3.md §Endpoint handler).
 */
import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import { gitEnv } from "../../shared/git";
import { errorMessage, log } from "../../shared/log";
import { GIT_PATH_PREFIX } from "../../shared/wire";
import { isRepoName, type Repos } from "./repos";

export interface GitEndpointOptions {
	repos: Pick<Repos, "mirrorPath">;
	/** The repo (`owner/name`) a live lease token may read; undefined → 401. Called before any filesystem access. */
	authorize(token: string): string | undefined;
}

const ROUTE = new RegExp(`^${GIT_PATH_PREFIX.replace(/[/.]/g, "\\$&")}([^/]+)/([^/]+)\\.git/(info/refs|git-upload-pack|git-receive-pack)$`);
const GIT_PROTOCOL = /^[A-Za-z0-9=:._-]{1,256}$/;
export const MAX_GIT_REQUEST_BYTES = 16 * 1024 * 1024;
/** Git requests one lease may have in flight; a worker's fetch makes one at a time (each starts a `git upload-pack`). */
export const MAX_GIT_REQUESTS_PER_LEASE = 2;
const UPLOAD_PACK_CONFIG = ["-c", "uploadpack.allowReachableSHA1InWant=true", "-c", "uploadpack.hideRefs=refs/agentbot"];

/** Bearer <token>, or Basic with the token as password (any user name). */
function requestToken(header: string | null): string | undefined {
	if (!header) return undefined;
	const [scheme, value] = header.split(/\s+/, 2);
	if (!scheme || !value) return undefined;
	if (scheme.toLowerCase() === "bearer") return value;
	if (scheme.toLowerCase() === "basic") {
		const decoded = Buffer.from(value, "base64").toString("utf8");
		const colon = decoded.indexOf(":");
		return colon >= 0 ? decoded.slice(colon + 1) : undefined;
	}
	return undefined;
}

function pktLine(s: string): string {
	return (s.length + 4).toString(16).padStart(4, "0") + s;
}

/**
 * The request body, gunzipped for `Content-Encoding: gzip`, as a stream; undefined in another encoding. Never buffered:
 * `pump` feeds it to upload-pack as it arrives.
 */
function requestBody(req: Request): ReadableStream<Uint8Array> | undefined {
	const body = req.body ?? new Blob([]).stream();
	const encoding = (req.headers.get("content-encoding") ?? "").toLowerCase();
	if (encoding === "gzip" || encoding === "x-gzip") return body.pipeThrough(new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>);
	return encoding === "" || encoding === "identity" ? body : undefined;
}

/** Streams `body` into upload-pack's stdin; kills it when the (gunzipped) body passes the cap or can't be read. */
async function pump(body: ReadableStream<Uint8Array>, proc: Subprocess<"pipe", "pipe", "pipe">, repo: string): Promise<void> {
	let total = 0;
	try {
		for await (const chunk of body) {
			total += chunk.byteLength;
			if (total > MAX_GIT_REQUEST_BYTES) throw new Error(`request body over ${MAX_GIT_REQUEST_BYTES} bytes`);
			proc.stdin.write(chunk);
			await proc.stdin.flush();
		}
		await proc.stdin.end();
	} catch (err) {
		log("warn", "git endpoint: request body not delivered; upload-pack stopped", { repo, bytes: total, error: errorMessage(err) });
		proc.kill();
	}
}

const text = (body: string, status: number, headers?: Record<string, string>) => new Response(body, { status, headers });

export function createGitEndpoint(opts: GitEndpointOptions): (req: Request) => Promise<Response> {
	/** Requests in flight per lease token, until their upload-pack exits (`MAX_GIT_REQUESTS_PER_LEASE`). */
	const inFlight = new Map<string, number>();
	const acquire = (token: string): boolean => {
		const n = inFlight.get(token) ?? 0;
		if (n >= MAX_GIT_REQUESTS_PER_LEASE) return false;
		inFlight.set(token, n + 1);
		return true;
	};
	const release = (token: string): void => {
		const n = (inFlight.get(token) ?? 1) - 1;
		if (n > 0) inFlight.set(token, n);
		else inFlight.delete(token);
	};

	return async (req) => {
		const url = new URL(req.url);
		const m = ROUTE.exec(url.pathname);
		if (!m) return text("not found\n", 404);
		const [, owner = "", name = "", action] = m;
		const repo = `${owner}/${name}`;
		if (!isRepoName(repo)) return text("not found\n", 404);

		const token = requestToken(req.headers.get("authorization"));
		const leaseRepo = token ? opts.authorize(token) : undefined;
		if (!token || !leaseRepo) return text("unauthorized\n", 401, { "WWW-Authenticate": 'Basic realm="agentbot"' });
		if (leaseRepo !== repo) return text("forbidden\n", 403);
		if (action === "git-receive-pack") return text("forbidden\n", 403);

		const dir = opts.repos.mirrorPath(repo);
		if (!existsSync(dir)) return text("not found\n", 404);

		const protoHeader = req.headers.get("git-protocol") ?? "";
		const protocol = GIT_PROTOCOL.test(protoHeader) ? protoHeader : "";
		const env: Record<string, string> = protocol ? { GIT_PROTOCOL: protocol } : {};
		const v2 = /(^|:)version=2(:|$)/.test(protocol);

		if (action === "info/refs") {
			if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
			if (url.searchParams.get("service") !== "git-upload-pack") return text("forbidden\n", 403);
			if (!acquire(token)) return text("too many git requests in flight for this lease\n", 429, { "Retry-After": "1" });
			try {
				const proc = Bun.spawn(["git", ...UPLOAD_PACK_CONFIG, "upload-pack", "--stateless-rpc", "--http-backend-info-refs", dir], {
					env: gitEnv(env),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
				if (exitCode !== 0) {
					log("warn", "git endpoint: info/refs upload-pack failed", { repo, exitCode, stderr: stderr.trim().slice(-2000) });
					return text("upload-pack failed\n", 500);
				}
				// v0/v1 prefix the advertisement with the service line; v2 does not (as git http-backend).
				const body = v2 ? stdout : `${pktLine("# service=git-upload-pack\n")}0000${stdout}`;
				return new Response(body, {
					headers: { "Content-Type": "application/x-git-upload-pack-advertisement", "Cache-Control": "no-cache" },
				});
			} finally {
				release(token);
			}
		}

		if (req.method !== "POST") return new Response(null, { status: 405 });
		if (req.headers.get("content-type") !== "application/x-git-upload-pack-request") return text("bad content type\n", 415);
		if (Number(req.headers.get("content-length") ?? "0") > MAX_GIT_REQUEST_BYTES) return text("request body too large\n", 413);
		const body = requestBody(req);
		if (!body) return text("bad request body\n", 400);
		if (!acquire(token)) return text("too many git requests in flight for this lease\n", 429, { "Retry-After": "1" });
		const proc = Bun.spawn(["git", ...UPLOAD_PACK_CONFIG, "upload-pack", "--stateless-rpc", dir], {
			env: gitEnv(env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		void pump(body, proc, repo);
		void Promise.all([new Response(proc.stderr).text(), proc.exited])
			.then(([stderr, exitCode]) => {
				if (exitCode !== 0) log("warn", "git endpoint: upload-pack failed", { repo, exitCode, stderr: stderr.trim().slice(-2000) });
			})
			.finally(() => release(token));
		return new Response(proc.stdout, {
			headers: { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" },
		});
	};
}
