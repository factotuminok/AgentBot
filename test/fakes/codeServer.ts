/**
 * Stands in for code-server in the VS Code proxy tests: run as the `bin` (through a shell wrapper), it records its
 * arguments, environment and pid in `$HOME/fake-code-server.json`, then serves on `--bind-addr`:
 * - `GET /healthz` → 200;
 * - any other HTTP path → JSON `{ method, path, headers, body }`, with hop-by-hop response headers the proxy must drop;
 * - WebSockets on any path: first a JSON hello `{ path, origin, forwardedHost }`, then `echo:<text>` per text frame and
 *   the same bytes back per binary frame.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_RECORD = "fake-code-server.json";

export interface FakeRecord {
	argv: string[];
	env: Record<string, string | undefined>;
	cwd: string;
	pid: number;
}

export interface EchoBody {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: string;
}

interface Hello {
	path: string;
	origin: string | null;
	forwardedHost: string | null;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const bind = argv[argv.indexOf("--bind-addr") + 1] ?? "";
	const [hostname, port] = bind.split(":");
	const record: FakeRecord = {
		argv,
		env: {
			HOME: process.env.HOME,
			AGENTBOT_HOME: process.env.AGENTBOT_HOME,
			SHELL: process.env.SHELL,
			EXTENSIONS_GALLERY: process.env.EXTENSIONS_GALLERY,
		},
		cwd: process.cwd(),
		pid: process.pid,
	};
	writeFileSync(join(process.env.HOME ?? ".", FAKE_RECORD), JSON.stringify(record));
	Bun.serve<Hello>({
		hostname,
		port: Number(port),
		async fetch(req, srv) {
			const url = new URL(req.url);
			if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const hello: Hello = { path: url.pathname + url.search, origin: req.headers.get("origin"), forwardedHost: req.headers.get("x-forwarded-host") };
				return srv.upgrade(req, { data: hello }) ? undefined : new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/healthz") return Response.json({ status: "alive" });
			const body: EchoBody = { method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.text() };
			// Like code-server: its own CSP (it frames its webviews) and caching.
			return Response.json(body, {
				headers: {
					"keep-alive": "timeout=5",
					"proxy-authenticate": "Basic",
					"x-upstream": "yes",
					"content-security-policy": "default-src 'self'; frame-src 'self'",
					"cache-control": "public, max-age=60",
					"referrer-policy": "unsafe-url",
				},
			});
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify(ws.data));
			},
			message(ws, message) {
				ws.send(typeof message === "string" ? `echo:${message}` : message);
			},
		},
	});
	console.log(`fake code-server listening on ${bind}`);
}
