import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWebSocket, Subprocess } from "bun";
import { errorMessage, log } from "../shared/log";
import { WORKSPACE_DIR } from "../shared/workspaceSync";
import { respond, SECURITY_HEADERS } from "./http";

/** Where the browser reaches code-server; the prefix is stripped before forwarding. */
export const VSCODE_PREFIX = "/admin/vscode";
/** Image layout (spike S4, architecture §7.1): code-server under /opt, the locked user files and the bundled extension root-owned. */
const CODE_SERVER_BIN = "/opt/code-server/bin/code-server";
const LOCKED_DIR = "/opt/agentbot/vscode";
const EXTENSIONS_DIR = "/opt/agentbot/vscode-extensions";
/** Loopback only (WEB-14); nothing but this proxy reaches it. */
const PORT = 13337;
const NOLOGIN = "/usr/sbin/nologin";
/** How long the first request waits for code-server to answer `/healthz` (WEB-14). */
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 200;
/** Lines of code-server output kept to explain a failed start. */
const OUTPUT_LINES = 20;
/** Headers that describe one connection and must not be forwarded (RFC 9110 §7.6.1), plus `host`. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"];
/** Bun's WebSocket constructor accepts request headers; the lib.dom type it is declared with here does not know that overload. */
const UpstreamSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

/** code-server in the web role. The image paths are the defaults; tests point them at a fake binary and a temp layout. */
export interface VsCodeConfig {
	/** `AGENTBOT_HOME`: code-server's `$HOME`, holding `.local/share/code-server` and the config workspace. */
	home: string;
	bin?: string;
	port?: number;
	/** Holds the locked `settings.json` and `tasks.json`. */
	lockedDir?: string;
	extensionsDir?: string;
	startTimeoutMs?: number;
}

/** Per-connection state of a proxied code-server WebSocket. */
export interface VsCodeSocketData {
	/** The login that opened it; the web server closes the socket when that login ends. */
	token: string;
	/** Path and query on code-server (prefix stripped). */
	target: string;
	/** Browser-facing host and origin, forwarded so code-server's own origin check passes. */
	host: string;
	origin: string;
	upstream?: WebSocket;
	/** Frames from the browser that arrived before code-server accepted the connection. */
	pending: (string | Uint8Array)[];
}

export interface VsCode {
	/** HTTP requests under `/admin/vscode`, after the web server checked the login; starts code-server on first use. */
	proxy(req: Request, url: URL): Promise<Response>;
	/** Data for upgrading a WebSocket under the prefix, or undefined while code-server is not running. */
	socketData(req: Request, url: URL, token: string): VsCodeSocketData | undefined;
	websocket: {
		open(ws: ServerWebSocket<VsCodeSocketData>): void;
		message(ws: ServerWebSocket<VsCodeSocketData>, message: string | Buffer): void;
		close(ws: ServerWebSocket<VsCodeSocketData>): void;
	};
	/** Kills code-server and waits for it to exit. */
	stop(): Promise<void>;
}

/** code-server could not be started; the message says why (missing binary, port in use, no answer in time, …). */
export class VsCodeStartError extends Error {
	override name = "VsCodeStartError";
}

/** True for `/admin/vscode` and everything below it. */
export function isVsCodePath(pathname: string): boolean {
	return pathname === VSCODE_PREFIX || pathname.startsWith(`${VSCODE_PREFIX}/`);
}

/** `cookie` header without the named cookie; undefined when nothing is left. */
function withoutCookie(header: string | null, name: string): string | undefined {
	if (!header) return undefined;
	const kept = header
		.split(";")
		.map(part => part.trim())
		.filter(part => part && part.slice(0, part.indexOf("=")).trim() !== name);
	return kept.length ? kept.join("; ") : undefined;
}

/** Drops the hop-by-hop headers, including any the `Connection` header names. */
function stripHopByHop(headers: Headers): void {
	for (const name of (headers.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
	for (const name of HOP_BY_HOP) headers.delete(name);
}

/** Path and query on code-server for a browser URL under the prefix (`/admin/vscode/x?y` → `/x?y`). */
function upstreamPath(url: URL): string {
	return `${url.pathname.slice(VSCODE_PREFIX.length) || "/"}${url.search}`;
}

/** Close codes a server may send: 1000, 1001, 1011 or 3000–4999; reserved ones (1005, 1006, …) become 1000/1011. */
function sendableCode(code: number): number {
	if (code === 1000 || code === 1001 || code === 1011 || (code >= 3000 && code <= 4999)) return code;
	return code === 1005 ? 1000 : 1011;
}

/** Replaces `path` with a symlink to `target` (`ln -sfn`). */
async function relink(target: string, path: string): Promise<void> {
	await rm(path, { force: true });
	await symlink(target, path);
}

/**
 * The S4 start sequence (WEB-14, WEB-31), run before every start: the locked user and machine settings and user tasks
 * become symlinks to the root-owned files again, and the stored workbench state is deleted, which re-enables a
 * lock-down extension the admin disabled (`--enable-remote-storage` keeps that state here, not in the browser).
 */
async function prepare(home: string, lockedDir: string): Promise<void> {
	const data = join(home, ".local", "share", "code-server");
	await mkdir(join(data, "User"), { recursive: true });
	await mkdir(join(data, "Machine"), { recursive: true });
	await mkdir(join(home, WORKSPACE_DIR), { recursive: true });
	// Application-scoped settings (automatic tasks, workspace trust, extensions.allowed) only take effect from User/.
	await relink(join(lockedDir, "settings.json"), join(data, "User", "settings.json"));
	await relink(join(lockedDir, "settings.json"), join(data, "Machine", "settings.json"));
	await relink(join(lockedDir, "tasks.json"), join(data, "User", "tasks.json"));
	// VS Code restores a missing database from its backup, so both go.
	await rm(join(data, "User", "globalStorage", "state.vscdb"), { force: true });
	await rm(join(data, "User", "globalStorage", "state.vscdb.backup"), { force: true });
}

/**
 * code-server (VS Code in the browser), started on first use as the `agentbot` user and reached only through the web
 * server: HTTP is forwarded with the prefix stripped, WebSockets are piped frame by frame. `X-Forwarded-Host` carries the
 * browser's host, which code-server compares with the `Origin` of its WebSockets.
 */
export function createVsCode(config: VsCodeConfig, sessionCookie: string): VsCode {
	const bin = config.bin ?? CODE_SERVER_BIN;
	const lockedDir = config.lockedDir ?? LOCKED_DIR;
	const startTimeoutMs = config.startTimeoutMs ?? START_TIMEOUT_MS;
	const base = `127.0.0.1:${config.port ?? PORT}`;
	const argv = [
		bin,
		"--bind-addr",
		base,
		"--auth",
		"none",
		"--extensions-dir",
		config.extensionsDir ?? EXTENSIONS_DIR,
		"--disable-telemetry",
		"--disable-update-check",
		"--disable-getting-started-override",
		"--disable-workspace-trust",
		"--disable-file-uploads",
		"--disable-proxy",
		"--ignore-last-opened",
		"--enable-remote-storage",
		join(config.home, WORKSPACE_DIR),
	];
	// `HOME` is the web home so code-server's data dir is the one prepared above; the empty gallery turns the
	// marketplace off (unset or empty falls back to open-vsx), and nologin keeps a terminal that opens anyway shell-less.
	const env: Record<string, string | undefined> = { ...process.env, HOME: config.home, AGENTBOT_HOME: config.home, EXTENSIONS_GALLERY: "{}", SHELL: NOLOGIN };
	delete env.XDG_DATA_HOME;
	let proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let ready = false;
	let starting: Promise<void> | undefined;
	let output: string[] = [];

	async function collect(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<void> {
		const decoder = new TextDecoder();
		let partial = "";
		const emit = (line: string) => {
			if (!line) return;
			log("info", "code-server output", { stream: name, line });
			output.push(line);
			if (output.length > OUTPUT_LINES) output = output.slice(-OUTPUT_LINES);
		};
		for await (const chunk of stream) {
			const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
			partial = lines.pop() ?? "";
			for (const line of lines) emit(line);
		}
		emit(partial + decoder.decode());
	}

	const recent = () => output.slice(-5).join(" | ") || "no output";

	async function start(): Promise<void> {
		output = [];
		await prepare(config.home, lockedDir);
		let child: Subprocess<"ignore", "pipe", "pipe">;
		try {
			child = Bun.spawn(argv, { env, cwd: config.home, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		} catch (err) {
			throw new Error(`${bin} could not be run: ${errorMessage(err)}`);
		}
		proc = child;
		log("info", "code-server starting", { pid: child.pid, bind: base });
		void collect(child.stdout, "stdout");
		void collect(child.stderr, "stderr");
		void child.exited.then(code => {
			log(code === 0 ? "info" : "warn", "code-server exited", { code, signal: child.signalCode ?? undefined });
			if (proc !== child) return;
			proc = undefined;
			ready = false;
		});
		const deadline = Date.now() + startTimeoutMs;
		while (Date.now() < deadline) {
			if (proc !== child) throw new Error(`code-server exited during start-up: ${recent()}`);
			const healthy = await fetch(`http://${base}/healthz`, { signal: AbortSignal.timeout(START_POLL_MS * 5) }).then(
				res => res.ok,
				() => false,
			);
			if (healthy) {
				ready = true;
				log("info", "code-server started", { pid: child.pid });
				return;
			}
			await Bun.sleep(START_POLL_MS);
		}
		proc = undefined;
		child.kill();
		throw new Error(`code-server did not answer within ${startTimeoutMs / 1000} s: ${recent()}`);
	}

	function ensureRunning(): Promise<void> {
		if (proc && ready) return Promise.resolve();
		starting ??= start().finally(() => {
			starting = undefined;
		});
		return starting;
	}

	return {
		async proxy(req, url) {
			// code-server's pages use relative URLs, so its root must end in a slash.
			if (url.pathname === VSCODE_PREFIX) return respond(null, 308, { Location: `${VSCODE_PREFIX}/${url.search}` });
			try {
				await ensureRunning();
			} catch (err) {
				log("error", "code-server failed to start", { error: errorMessage(err) });
				throw new VsCodeStartError(errorMessage(err));
			}
			const headers = new Headers(req.headers);
			stripHopByHop(headers);
			const cookie = withoutCookie(req.headers.get("cookie"), sessionCookie);
			if (cookie) headers.set("cookie", cookie);
			else headers.delete("cookie");
			headers.set("x-forwarded-host", url.host);
			headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
			// Bodies pass through unchanged; a compressed upstream body would be decoded by fetch but keep its header.
			headers.set("accept-encoding", "identity");
			const hasBody = req.method !== "GET" && req.method !== "HEAD";
			const upstream = await fetch(`http://${base}${upstreamPath(url)}`, {
				method: req.method,
				headers,
				body: hasBody ? req.body : undefined,
				redirect: "manual",
			});
			const out = new Headers(upstream.headers);
			stripHopByHop(out);
			out.delete("content-encoding");
			// WEB-06 exemption: code-server's own Content-Security-Policy and Cache-Control stay (its workbench frames its
			// webviews and caches its static files); the other security headers are set as on every web response.
			out.set("X-Content-Type-Options", SECURITY_HEADERS["X-Content-Type-Options"]!);
			out.set("Referrer-Policy", SECURITY_HEADERS["Referrer-Policy"]!);
			return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
		},
		socketData(req, url, token) {
			if (!proc || !ready) return undefined;
			return { token, target: upstreamPath(url), host: url.host, origin: req.headers.get("origin") ?? "", pending: [] };
		},
		websocket: {
			open(ws) {
				const d = ws.data;
				const upstream = new UpstreamSocket(`ws://${base}${d.target}`, { headers: { origin: d.origin, "x-forwarded-host": d.host } });
				upstream.binaryType = "arraybuffer";
				d.upstream = upstream;
				upstream.addEventListener("open", () => {
					for (const frame of d.pending) upstream.send(frame);
					d.pending = [];
				});
				upstream.addEventListener("message", event => {
					ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
				});
				upstream.addEventListener("close", event => ws.close(sendableCode(event.code), event.reason));
				upstream.addEventListener("error", () => ws.close(1011, "code-server connection failed"));
			},
			message(ws, message) {
				const frame = typeof message === "string" ? message : new Uint8Array(message);
				const upstream = ws.data.upstream;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
				else ws.data.pending.push(frame);
			},
			close(ws) {
				const upstream = ws.data.upstream;
				if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close();
			},
		},
		async stop() {
			const child = proc;
			proc = undefined;
			ready = false;
			if (!child) return;
			child.kill();
			await child.exited;
		},
	};
}
