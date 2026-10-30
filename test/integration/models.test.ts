/**
 * `/admin/models` end to end (SEC-12, SEC-13): the web page over the orchestrator's `/models*` admin API, with the sign-in
 * flows running against a real sign-in store and a fake sign-in backend (no omp provider, no network).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { createModelsRoutes } from "../../src/orchestrator/api/models";
import { createAccounts, FEATURED_PROVIDERS, LOGIN_TIMEOUT_MS, type SigninBackend } from "../../src/orchestrator/store/accounts";
import { openSignins } from "../../src/orchestrator/store/signins";
import type { LoginState } from "../../src/shared/adminModels";
import { modelsPages } from "../../src/web/modelsPage";
import { eventually, type PageStack, startPageStack } from "../fakes/adminPages";

const sandbox = mkdtempSync(join(tmpdir(), "agentbot-models-"));
const signins = await openSignins(join(sandbox, "state"));
afterAll(() => {
	signins.close();
	rmSync(sandbox, { recursive: true, force: true });
});

/** Provider ids in a scrambled order: the page must put the featured ones first. */
const PROVIDERS = [
	{ id: "zz-other", name: "Zeta Other", storedAs: "zz-other" },
	{ id: "github-copilot", name: "GitHub Copilot", storedAs: "github-copilot" },
	{ id: "aa-other", name: "Alpha Other", storedAs: "aa-other" },
	{ id: "openai-codex-device", name: "ChatGPT (device code)", storedAs: "openai-codex" },
	{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", storedAs: "anthropic" },
	{ id: "google-antigravity", name: "Antigravity", storedAs: "google-antigravity" },
	{ id: "xai-oauth", name: "Grok", storedAs: "xai-oauth" },
	{ id: "openai-codex", name: "ChatGPT", storedAs: "openai-codex" },
	{ id: "google-gemini-cli", name: "Gemini CLI", storedAs: "google-gemini-cli" },
];

let approveDevice = Promise.withResolvers<void>();

/** Fake provider flows: Anthropic is a browser flow (pasted URL or code), Copilot a device flow; both store a real credential. */
const backend: SigninBackend = {
	providers: () => PROVIDERS,
	async login(providerId: string, ctrl: OAuthLoginCallbacks) {
		const storedAs = PROVIDERS.find(p => p.id === providerId)!.storedAs;
		let email: string;
		if (providerId === "anthropic") {
			ctrl.onAuth({ url: "https://claude.example.com/oauth/authorize?redirect_uri=http://localhost:54545/callback" });
			const pasted = await ctrl.onManualCodeInput!(ctrl.signal);
			const code = pasted.startsWith("http") ? new URL(pasted).searchParams.get("code") : pasted;
			if (code !== "good-code") throw new Error(`Token exchange failed for code ${code}`);
			email = "me@example.com";
		} else {
			ctrl.onAuth({ url: "https://github.example.com/login/device", instructions: "Enter code ABCD-1234" });
			ctrl.onProgress?.("Waiting for approval…");
			const aborted = Promise.withResolvers<never>();
			ctrl.signal?.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
			await Promise.race([approveDevice.promise, aborted.promise]);
			email = "dev@example.com";
		}
		await signins.authStorage.credentials.upsert(storedAs, {
			type: "oauth",
			access: `access-${providerId}`,
			refresh: `refresh-${providerId}`,
			expires: Date.now() + 3_600_000,
			email,
			authorizedAt: Date.now(),
		});
		return { email };
	},
	models: () => signins.authStorage.credentials.list().map(row => ({ provider: row.provider, id: `${row.provider}/fake-model`, name: `Fake ${row.provider}` })),
	changed() {},
};

interface Harness {
	stack: PageStack;
	/** Fires the pending unattended-sign-in aborts. */
	timeouts: { fn: () => void; ms: number }[];
}

async function start(): Promise<Harness> {
	const timeouts: Harness["timeouts"] = [];
	const accounts = createAccounts({
		signins,
		backend,
		schedule: (fn, ms) => {
			timeouts.push({ fn, ms });
			return () => {};
		},
	});
	return { stack: await startPageStack(createModelsRoutes(accounts), modelsPages), timeouts };
}

async function loginJson(stack: PageStack, id: string): Promise<LoginState> {
	const res = await stack.get(`/admin/models/login/${id}.json`);
	expect(res.status).toBe(200);
	return (await res.json()) as LoginState;
}

function until(stack: PageStack, id: string, status: LoginState["status"]): Promise<LoginState> {
	return eventually(async () => {
		const state = await loginJson(stack, id);
		return state.status === status ? state : undefined;
	}, `sign-in ${id} to reach ${status}`);
}

/** Starts a sign-in from the page and returns its id (from the redirect). */
async function startLogin(stack: PageStack, provider: string): Promise<string> {
	const res = await stack.post("/admin/models/login", { provider });
	expect(res.status).toBe(303);
	const location = res.headers.get("location")!;
	expect(location).toStartWith("/admin/models/login/");
	return location.slice("/admin/models/login/".length);
}

describe("/admin/models", () => {
	test("featured providers first, the rest by name, and the SEC-13 notice", async () => {
		const { stack } = await start();
		const res = await stack.get("/admin/models");
		expect(res.status).toBe(200);
		const page = await res.text();
		const featuredButtons = [...page.matchAll(/<button type="submit" name="provider" value="([^"]+)">/g)].map(m => m[1]);
		expect(featuredButtons).toEqual([...FEATURED_PROVIDERS]);
		const others = [...page.matchAll(/<option value="([^"]+)">/g)].map(m => m[1]).filter(id => PROVIDERS.some(p => p.id === id));
		expect(others).toEqual(["aa-other", "zz-other"]);
		expect(page).toContain("Unlike stored API keys, a run's copy of these tokens is readable by that run's agent shell");
		expect(page).toContain("No accounts signed in yet.");
		expect(page).toContain("No models available");

		const view = (await (await stack.api("GET", "/models")).json()) as { providers: { id: string; featured: boolean }[] };
		expect(view.providers.map(p => p.id)).toEqual([...FEATURED_PROVIDERS, "aa-other", "zz-other"]);
	});

	test("browser flow: the pasted redirect URL completes it, the account and its models appear, sign-out removes it", async () => {
		const { stack } = await start();
		const id = await startLogin(stack, "anthropic");
		const waiting = await until(stack, id, "needs_input");
		expect(waiting.input?.kind).toBe("redirect");
		const page = await (await stack.get(`/admin/models/login/${id}`)).text();
		expect(page).toContain('href="https://claude.example.com/oauth/authorize?redirect_uri=http://localhost:54545/callback"');
		expect(page).toContain(`action="/admin/models/login/${id}/input"`);
		expect(page).toContain(`/admin/models/login/${id}.json`); // polls while unfinished

		// A blank paste is refused with the page re-rendered.
		const blank = await stack.post(`/admin/models/login/${id}/input`, { text: "  " });
		expect(blank.status).toBe(400);
		expect(await blank.text()).toContain("Enter a value.");

		const pasted = await stack.post(`/admin/models/login/${id}/input`, { text: "http://localhost:54545/callback?code=good-code&state=s" });
		expect(pasted.status).toBe(303);
		expect(pasted.headers.get("location")).toBe(`/admin/models/login/${id}`);
		expect(await until(stack, id, "done")).toMatchObject({ account: { email: "me@example.com" } });
		const done = await (await stack.get(`/admin/models/login/${id}`)).text();
		expect(done).toContain("Signed in to Anthropic (Claude Pro/Max) as me@example.com");
		expect(done).not.toContain(`${id}.json`); // finished: no polling

		const models = await (await stack.get("/admin/models")).text();
		expect(models).toContain("me@example.com");
		expect(models).toContain("anthropic/fake-model");
		// Anthropic grants show their re-login deadline, 30 days after the sign-in.
		const reloginBy = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
		expect(models).toContain(reloginBy);
		// The next run's snapshot has it (SEC-13: no restart).
		expect((await signins.snapshotForRun()).some(c => c.provider === "anthropic")).toBe(true);

		const out = await stack.post("/admin/models/signout", { provider: "anthropic" });
		expect(out.status).toBe(303);
		const after = await (await stack.get("/admin/models")).text();
		expect(after).toContain("Signed out of anthropic.");
		expect(after).toContain("No accounts signed in yet.");
		expect(signins.authStorage.credentials.list("anthropic")).toEqual([]);
		const again = await stack.post("/admin/models/signout", { provider: "anthropic" });
		expect(again.status).toBe(303);
		expect(await (await stack.get("/admin/models")).text()).toContain("No sign-in for anthropic.");
	});

	test("browser flow accepts a bare pasted code; a wrong one fails the sign-in", async () => {
		const { stack } = await start();
		const bad = await startLogin(stack, "anthropic");
		await until(stack, bad, "needs_input");
		await stack.post(`/admin/models/login/${bad}/input`, { text: "wrong" });
		expect(await until(stack, bad, "failed")).toMatchObject({ error: "Token exchange failed for code wrong" });
		expect(await (await stack.get(`/admin/models/login/${bad}`)).text()).toContain("Token exchange failed for code wrong");
		const late = await stack.post(`/admin/models/login/${bad}/input`, { text: "good-code" });
		expect(late.status).toBe(400);
		expect(await late.text()).toContain("not waiting for input");

		const good = await startLogin(stack, "anthropic");
		await until(stack, good, "needs_input");
		await stack.post(`/admin/models/login/${good}/input`, { text: "good-code" });
		await until(stack, good, "done");
		await signins.signOut("anthropic");
	});

	test("device flow shows the code and finishes by polling", async () => {
		const { stack } = await start();
		approveDevice = Promise.withResolvers<void>();
		const id = await startLogin(stack, "github-copilot");
		const waiting = await until(stack, id, "waiting");
		expect(waiting).toMatchObject({ url: "https://github.example.com/login/device", instructions: "Enter code ABCD-1234" });
		const page = await (await stack.get(`/admin/models/login/${id}`)).text();
		expect(page).toContain("Enter code ABCD-1234");
		expect(page).toContain("Waiting for approval…");
		expect(page).not.toContain("/input");
		expect(page).toContain(`/admin/models/login/${id}.json`);

		approveDevice.resolve();
		expect(await until(stack, id, "done")).toMatchObject({ account: { email: "dev@example.com" } });
		expect(await (await stack.get("/admin/models")).text()).toContain("dev@example.com");
		await signins.signOut("github-copilot");
	});

	test("a sign-in left unattended is aborted after 15 minutes; cancel ends one", async () => {
		const { stack, timeouts } = await start();
		const id = await startLogin(stack, "anthropic");
		await until(stack, id, "needs_input");
		expect(timeouts.map(t => t.ms)).toEqual([LOGIN_TIMEOUT_MS]);
		expect(LOGIN_TIMEOUT_MS).toBe(15 * 60_000);
		timeouts[0]!.fn();
		expect((await until(stack, id, "failed")).error).toContain("left unattended for 15 minutes");

		const cancelled = await startLogin(stack, "anthropic");
		await until(stack, cancelled, "needs_input");
		expect((await stack.post(`/admin/models/login/${cancelled}/cancel`, {})).status).toBe(303);
		await until(stack, cancelled, "cancelled");
		expect(await (await stack.get(`/admin/models/login/${cancelled}`)).text()).toContain("Sign-in was cancelled.");
		expect(signins.authStorage.credentials.list("anthropic")).toEqual([]);
	});

	test("unknown providers and sign-ins", async () => {
		const { stack } = await start();
		const unknown = await stack.post("/admin/models/login", { provider: "nope" });
		expect(unknown.headers.get("location")).toBe("/admin/models");
		expect(await (await stack.get("/admin/models")).text()).toContain("Unknown sign-in provider");
		expect((await stack.get("/admin/models/login/missing")).status).toBe(404);
		expect((await stack.get("/admin/models/login/missing.json")).status).toBe(404);
		expect((await stack.post("/admin/models/login/missing/input", { text: "x" })).status).toBe(404);
	});
});
