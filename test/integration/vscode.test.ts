import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECURITY_HEADERS } from "../../src/web/http";
import type { VsCodeConfig } from "../../src/web/vscode";
import { type EchoBody, FAKE_RECORD, type FakeRecord } from "../fakes/codeServer";
import { type AdminStack, startAdminStack } from "../fixtures/adminStack";

const REPO = join(import.meta.dir, "..", "..");
const LOCKED_DIR = join(REPO, "vscode", "locked");
const FAKE = join(REPO, "test", "fakes", "codeServer.ts");

const temps: string[] = [];
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = Number(probe.url.port);
	probe.stop(true);
	return port;
}

/** An executable shell script standing in for the code-server binary. */
function script(dir: string, body: string): string {
	const path = join(dir, "code-server");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

function startStack(vscode?: VsCodeConfig): Promise<AdminStack> {
	return startAdminStack({ routes: () => ({}), pages: {}, vscode });
}

interface RawResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

function dechunk(body: string): string {
	let out = "";
	let rest = body;
	for (;;) {
		const eol = rest.indexOf("\r\n");
		const size = Number.parseInt(rest.slice(0, eol), 16);
		if (eol < 0 || !size) return out;
		out += rest.slice(eol + 2, eol + 2 + size);
		rest = rest.slice(eol + 2 + size + 2);
	}
}

/** One HTTP/1.1 request over a plain socket, so connection-level headers reach the server exactly as written. */
function rawRequest(origin: string, head: string[]): Promise<RawResponse> {
	const { hostname, port } = new URL(origin);
	const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
	const socket = connect(Number(port), hostname);
	let data = "";
	const finish = () => {
		const split = data.indexOf("\r\n\r\n");
		const [statusLine, ...lines] = data.slice(0, split).split("\r\n");
		const headers: Record<string, string> = {};
		for (const line of lines) headers[line.slice(0, line.indexOf(":")).toLowerCase()] = line.slice(line.indexOf(":") + 1).trim();
		const raw = data.slice(split + 4);
		socket.destroy();
		resolve({ status: Number(statusLine?.split(" ")[1]), headers, body: headers["transfer-encoding"] === "chunked" ? dechunk(raw) : raw });
	};
	socket.on("data", chunk => {
		data += chunk.toString();
		const split = data.indexOf("\r\n\r\n");
		if (split < 0) return;
		const length = /\r\ncontent-length:\s*(\d+)/i.exec(data.slice(0, split));
		if (length && data.length - split - 4 >= Number(length[1])) finish();
		else if (/\r\ntransfer-encoding:\s*chunked/i.test(data.slice(0, split)) && data.endsWith("0\r\n\r\n")) finish();
	});
	socket.on("end", finish);
	socket.on("error", reject);
	socket.write(`${head.join("\r\n")}\r\n\r\n`);
	return promise;
}

function upgradeHead(origin: string, path: string, extra: string[]): string[] {
	return [
		`GET ${path} HTTP/1.1`,
		`Host: ${new URL(origin).host}`,
		"Connection: Upgrade",
		"Upgrade: websocket",
		"Sec-WebSocket-Version: 13",
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
		...extra,
	];
}

/** Opens a WebSocket through the proxy and returns it with a queue of received frames. */
async function openSocket(stack: AdminStack, path: string): Promise<{ ws: WebSocket; next(): Promise<string | ArrayBuffer>; closed: Promise<CloseEvent> }> {
	const url = `${stack.web.url.replace(/^http/, "ws")}${path}`;
	const ws = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(url, {
		headers: { cookie: stack.cookie, origin: stack.web.url },
	});
	ws.binaryType = "arraybuffer";
	const frames: (string | ArrayBuffer)[] = [];
	const waiters: ((frame: string | ArrayBuffer) => void)[] = [];
	ws.addEventListener("message", event => {
		const waiter = waiters.shift();
		if (waiter) waiter(event.data);
		else frames.push(event.data);
	});
	const closed = Promise.withResolvers<CloseEvent>();
	ws.addEventListener("close", closed.resolve);
	const opened = Promise.withResolvers<void>();
	ws.addEventListener("open", () => opened.resolve());
	ws.addEventListener("error", () => opened.reject(new Error("WebSocket failed")));
	await opened.promise;
	return {
		ws,
		closed: closed.promise,
		next: () => {
			const frame = frames.shift();
			if (frame !== undefined) return Promise.resolve(frame);
			const { promise, resolve } = Promise.withResolvers<string | ArrayBuffer>();
			waiters.push(resolve);
			return promise;
		},
	};
}

describe("VS Code proxy (WEB-14)", () => {
	let stack: AdminStack;
	let home: string;
	let port: number;
	const data = () => join(home, ".local", "share", "code-server");

	beforeAll(async () => {
		home = tempDir("agentbot-vscode-home-");
		const bin = script(tempDir("agentbot-vscode-bin-"), `exec "${process.execPath}" "${FAKE}" "$@"`);
		// Left from a previous start: a plain settings file and the workbench state with a disabled extension.
		mkdirSync(join(data(), "User", "globalStorage"), { recursive: true });
		writeFileSync(join(data(), "User", "settings.json"), `{"terminal.integrated.profiles.linux":{"evil":{"path":"/bin/sh"}}}`);
		writeFileSync(join(data(), "User", "globalStorage", "state.vscdb"), "disabled: agentbot.agentbot");
		writeFileSync(join(data(), "User", "globalStorage", "state.vscdb.backup"), "disabled: agentbot.agentbot");
		port = freePort();
		stack = await startStack({ home, bin, port, lockedDir: LOCKED_DIR, extensionsDir: "/opt/test-extensions" });
	});
	afterAll(async () => {
		await stack?.close();
	});

	test("without a login, pages and WebSockets are refused", async () => {
		const page = await fetch(`${stack.web.url}/admin/vscode/`, { redirect: "manual" });
		expect(page.status).toBe(303);
		expect(page.headers.get("location")).toBe("/login");
		const socket = await rawRequest(stack.web.url, upgradeHead(stack.web.url, "/admin/vscode/", [`Origin: ${stack.web.url}`]));
		expect(socket.status).toBe(401);
	});

	test("the first request starts code-server with the S4 sequence and proxies to it", async () => {
		const root = await stack.get("/admin/vscode");
		expect(root.status).toBe(308);
		expect(root.headers.get("location")).toBe("/admin/vscode/");

		const res = await stack.get("/admin/vscode/echo?x=1", { cookie: `${stack.cookie}; vscode-tkn=abc` });
		expect(res.status).toBe(200);
		expect(res.headers.get("x-upstream")).toBe("yes");
		const echo: EchoBody = await res.json();
		expect(echo.path).toBe("/echo?x=1");
		// The admin's session cookie never reaches code-server; its own cookies do.
		expect(echo.headers.cookie).toBe("vscode-tkn=abc");
		expect(echo.headers["x-forwarded-host"]).toBe(new URL(stack.web.url).host);
		expect(echo.headers["x-forwarded-proto"]).toBe("http");

		const record: FakeRecord = JSON.parse(readFileSync(join(home, FAKE_RECORD), "utf8"));
		expect(record.argv).toEqual([
			"--bind-addr",
			`127.0.0.1:${port}`,
			"--auth",
			"none",
			"--extensions-dir",
			"/opt/test-extensions",
			"--disable-telemetry",
			"--disable-update-check",
			"--disable-getting-started-override",
			"--disable-workspace-trust",
			"--disable-file-uploads",
			"--disable-proxy",
			"--ignore-last-opened",
			"--enable-remote-storage",
			join(home, "config-workspace"),
		]);
		expect(record.env).toEqual({ HOME: home, AGENTBOT_HOME: home, SHELL: "/usr/sbin/nologin", EXTENSIONS_GALLERY: "{}" });
		expect(existsSync(join(home, "config-workspace"))).toBe(true);

		for (const [link, target] of [
			["User/settings.json", "settings.json"],
			["Machine/settings.json", "settings.json"],
			["User/tasks.json", "tasks.json"],
		] as const) {
			expect(lstatSync(join(data(), link)).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(data(), link))).toBe(join(LOCKED_DIR, target));
		}
		expect(existsSync(join(data(), "User", "globalStorage", "state.vscdb"))).toBe(false);
		expect(existsSync(join(data(), "User", "globalStorage", "state.vscdb.backup"))).toBe(false);
	});

	test("the redirect carries every security header; proxied responses add nosniff and same-origin, keeping code-server's CSP and caching (WEB-06)", async () => {
		const root = await stack.get("/admin/vscode");
		expect(root.status).toBe(308);
		expect(root.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
		expect(root.headers.get("x-content-type-options")).toBe("nosniff");
		expect(root.headers.get("referrer-policy")).toBe("same-origin");
		expect(root.headers.get("cache-control")).toBe("no-store");

		const res = await stack.get("/admin/vscode/echo");
		expect(res.status).toBe(200);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("same-origin");
		expect(res.headers.get("content-security-policy")).toBe("default-src 'self'; frame-src 'self'");
		expect(res.headers.get("cache-control")).toBe("public, max-age=60");
		await res.body?.cancel();
	});

	test("hop-by-hop headers are dropped both ways", async () => {
		await stack.get("/admin/vscode/echo");
		const res = await rawRequest(stack.web.url, [
			"GET /admin/vscode/echo HTTP/1.1",
			`Host: ${new URL(stack.web.url).host}`,
			`Cookie: ${stack.cookie}`,
			"Connection: close, x-hop",
			"X-Hop: 1",
			"Keep-Alive: timeout=9",
			"TE: trailers",
			"Proxy-Authorization: Basic Zm9vOmJhcg==",
			"X-Kept: 1",
		]);
		expect(res.status).toBe(200);
		const echo: EchoBody = JSON.parse(res.body);
		expect(echo.headers["x-kept"]).toBe("1");
		for (const name of ["x-hop", "keep-alive", "te", "proxy-authorization", "upgrade"]) expect(echo.headers[name]).toBeUndefined();
		expect(res.headers["x-upstream"]).toBe("yes");
		expect(res.headers["proxy-authenticate"]).toBeUndefined();
		expect(res.headers["keep-alive"]).toBeUndefined();
	});

	test("POST bodies pass through", async () => {
		const res = await fetch(`${stack.web.url}/admin/vscode/echo`, {
			method: "POST",
			headers: { cookie: stack.cookie, origin: stack.web.url, "content-type": "application/json" },
			body: `{"a":1}`,
		});
		const echo: EchoBody = await res.json();
		expect(echo.method).toBe("POST");
		expect(echo.body).toBe(`{"a":1}`);
	});

	test("WebSockets are piped both ways with the browser's origin and host", async () => {
		await stack.get("/admin/vscode/");
		const socket = await openSocket(stack, "/admin/vscode/stable-abc?reconnectionToken=1");
		const hello = JSON.parse(String(await socket.next()));
		expect(hello).toEqual({ path: "/stable-abc?reconnectionToken=1", origin: stack.web.url, forwardedHost: new URL(stack.web.url).host });
		socket.ws.send("ping");
		expect(await socket.next()).toBe("echo:ping");
		socket.ws.send(new Uint8Array([1, 2, 3]));
		expect([...new Uint8Array((await socket.next()) as ArrayBuffer)]).toEqual([1, 2, 3]);
		socket.ws.close();
	});

	test("a WebSocket from a foreign origin is rejected", async () => {
		await stack.get("/admin/vscode/");
		const res = await rawRequest(stack.web.url, upgradeHead(stack.web.url, "/admin/vscode/x", [`Cookie: ${stack.cookie}`, "Origin: https://evil.example"]));
		expect(res.status).toBe(403);
		const none = await rawRequest(stack.web.url, upgradeHead(stack.web.url, "/admin/vscode/x", [`Cookie: ${stack.cookie}`]));
		expect(none.status).toBe(403);
	});

	test("home and menu list VS Code when it is on", async () => {
		const page = await (await stack.get("/")).text();
		expect(page).toContain('<h3><a href="/admin/vscode/">VS Code</a></h3>');
		expect(page).toContain('<li><a href="/admin/vscode/">VS Code</a></li>');
		const settings = await (await stack.get("/admin")).text();
		expect(settings).toContain('<li><a href="/admin/vscode/">VS Code</a></li>');
	});
});

describe("VS Code lifecycle", () => {
	test("logging out closes the VS Code WebSockets of that login", async () => {
		const home = tempDir("agentbot-vscode-home-");
		const bin = script(tempDir("agentbot-vscode-bin-"), `exec "${process.execPath}" "${FAKE}" "$@"`);
		const stack = await startStack({ home, bin, port: freePort(), lockedDir: LOCKED_DIR });
		try {
			await stack.get("/admin/vscode/");
			const socket = await openSocket(stack, "/admin/vscode/ws");
			await socket.next();
			await stack.post("/logout", {});
			expect((await socket.closed).code).toBe(4001);
		} finally {
			await stack.close();
		}
	});

	test("stopping the web server stops code-server", async () => {
		const home = tempDir("agentbot-vscode-home-");
		const bin = script(tempDir("agentbot-vscode-bin-"), `exec "${process.execPath}" "${FAKE}" "$@"`);
		const stack = await startStack({ home, bin, port: freePort(), lockedDir: LOCKED_DIR });
		expect((await stack.get("/admin/vscode/echo")).status).toBe(200);
		const { pid }: FakeRecord = JSON.parse(readFileSync(join(home, FAKE_RECORD), "utf8"));
		await stack.close();
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("a code-server that never answers gets an error page after the start-up wait", async () => {
		const bin = script(tempDir("agentbot-vscode-bin-"), "exec sleep 30");
		const stack = await startStack({ home: tempDir("agentbot-vscode-home-"), bin, port: freePort(), lockedDir: LOCKED_DIR, startTimeoutMs: 600 });
		try {
			const res = await stack.get("/admin/vscode/");
			expect(res.status).toBe(502);
			expect(await res.text()).toContain("VS Code could not be started: code-server did not answer within 0.6 s");
		} finally {
			await stack.close();
		}
	});

	test("a code-server that exits during start-up gets its output on the error page", async () => {
		const bin = script(tempDir("agentbot-vscode-bin-"), "echo 'error: address already in use' >&2; exit 1");
		const stack = await startStack({ home: tempDir("agentbot-vscode-home-"), bin, port: freePort(), lockedDir: LOCKED_DIR });
		try {
			const res = await stack.get("/admin/vscode/");
			expect(res.status).toBe(502);
			const text = await res.text();
			expect(text).toContain("code-server exited during start-up");
			expect(text).toContain("address already in use");
		} finally {
			await stack.close();
		}
	});

	test("with VS Code off, the route says so and no page links to it", async () => {
		const stack = await startStack();
		try {
			const res = await stack.get("/admin/vscode/");
			expect(res.status).toBe(200);
			expect(await res.text()).toContain("AGENTBOT_WEB_VSCODE=off");
			expect((await stack.get("/admin/vscode/anything")).status).toBe(404);
			expect(await (await stack.get("/")).text()).not.toContain('href="/admin/vscode');
		} finally {
			await stack.close();
		}
	});
});
