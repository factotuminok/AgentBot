/**
 * Model sign-in flows (SEC-12, SEC-13) against a real sign-in store. omp's own OAuth registry and login run unchanged;
 * the providers signed in to are fakes registered in omp's process-global registry, so nothing reaches a real provider.
 * HOME and PI_CODING_AGENT_DIR point into a temp dir so nothing touches `~/.omp`.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginState } from "../../src/shared/adminModels";
import type { Accounts } from "../../src/orchestrator/store/accounts";

const sandbox = mkdtempSync(join(tmpdir(), "agentbot-accounts-"));
const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = join(sandbox, "home");
process.env.PI_CODING_AGENT_DIR = join(sandbox, "home", "omp-agent");
// Dynamic on purpose: HOME and PI_CODING_AGENT_DIR must be set before omp resolves its dirs at module load.
const { registerOAuthProvider, unregisterOAuthProvider } = await import("@oh-my-pi/pi-ai/registry/oauth");
const { openSignins } = await import("../../src/orchestrator/store/signins");
const { createAccounts, FEATURED_PROVIDERS, LOGIN_TIMEOUT_MS, ompSigninBackend } = await import("../../src/orchestrator/store/accounts");

const stateDir = join(sandbox, "state");
const signins = await openSignins(stateDir);

afterAll(() => {
	for (const id of ["agentbot-test-browser", "agentbot-test-prompt", "agentbot-test-device"]) unregisterOAuthProvider(id);
	signins.close();
	process.env.HOME = saved.HOME;
	if (saved.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.PI_CODING_AGENT_DIR;
	rmSync(sandbox, { recursive: true, force: true });
});

// Browser flow like Anthropic's: show a URL, then wait for the pasted redirect URL. Stored as `anthropic`, so the
// grant's re-login deadline and Anthropic's models show up.
registerOAuthProvider({
	id: "agentbot-test-browser",
	name: "Test Browser Flow",
	storeCredentialsAs: "anthropic",
	async login(ctrl) {
		ctrl.onAuth({ url: "https://auth.example.com/authorize?redirect_uri=http://localhost:54545/callback", instructions: "Sign in" });
		const pasted = await ctrl.onManualCodeInput!(ctrl.signal);
		const code = pasted.startsWith("http") ? new URL(pasted).searchParams.get("code") : pasted;
		if (code !== "abc") throw new Error(`bad code ${code}`);
		return { access: "acc", refresh: "ref", expires: Date.now() + 3_600_000, email: "me@example.com" };
	},
});

// Prompt flow: asks a question, then returns credentials.
registerOAuthProvider({
	id: "agentbot-test-prompt",
	name: "Test Prompt Flow",
	async login(ctrl) {
		ctrl.onProgress?.("Starting");
		const answer = await ctrl.onPrompt({ message: "Enter your team" });
		return { access: "acc2", refresh: "ref2", expires: Date.now() + 3_600_000, email: `${answer}@example.com` };
	},
});

// Device flow: shows a code, then polls the provider until the admin approved it elsewhere.
let approveDevice = Promise.withResolvers<void>();
registerOAuthProvider({
	id: "agentbot-test-device",
	name: "Test Device Flow",
	async login(ctrl) {
		ctrl.onAuth({ url: "https://device.example.com/activate", instructions: "Enter code WXYZ-1234" });
		// The provider's polling, until the admin approves elsewhere (or the sign-in is aborted).
		const aborted = Promise.withResolvers<never>();
		ctrl.signal?.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
		await Promise.race([approveDevice.promise, aborted.promise]);
		return { access: "acc3", refresh: "ref3", expires: Date.now() + 3_600_000, email: "device@example.com" };
	},
});

/** Resolves once the sign-in reaches one of `statuses` (driven by the flow's own promise chain). */
async function until(accounts: Accounts, id: string, statuses: LoginState["status"][]): Promise<LoginState> {
	for (let i = 0; i < 1000; i++) {
		const state = accounts.login(id)!;
		if (statuses.includes(state.status)) return state;
		await new Promise(resolve => setImmediate(resolve));
	}
	throw new Error(`sign-in ${id} stuck in ${accounts.login(id)?.status}`);
}

function accounts(schedule?: (fn: () => void, ms: number) => () => void): Accounts {
	return createAccounts({ signins, backend: ompSigninBackend(signins, stateDir), schedule });
}

test("featured providers come first, in their fixed order; the rest by name", () => {
	const providers = accounts().view().providers;
	const featured = providers.filter(p => p.featured).map(p => p.id);
	expect(featured).toEqual([...FEATURED_PROVIDERS]);
	expect(providers.slice(0, featured.length).map(p => p.id)).toEqual(featured);
	const rest = providers.slice(featured.length).map(p => p.name);
	expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
	expect(providers.find(p => p.id === "openai-codex-device")?.storedAs).toBe("openai-codex");
});

test("browser flow: URL shown, pasted redirect completes, the account and its models appear, sign-out removes it", async () => {
	const manager = accounts();
	const started = manager.startLogin("agentbot-test-browser");
	const waiting = await until(manager, started.id, ["needs_input"]);
	expect(waiting.url).toStartWith("https://auth.example.com/authorize");
	expect(waiting.input?.kind).toBe("redirect");

	expect(manager.submitInput(started.id, "http://localhost:54545/callback?code=abc&state=x")).toBe(true);
	expect(await until(manager, started.id, ["done", "failed"])).toMatchObject({ status: "done", account: { email: "me@example.com" } });

	const view = manager.view();
	const stored = view.accounts.find(a => a.provider === "anthropic")!;
	expect(stored).toMatchObject({ type: "oauth", email: "me@example.com" });
	expect(stored.expiresAt).toBeTruthy();
	// Anthropic grants end 30 days after the sign-in.
	expect(Date.parse(stored.reloginBy!) - Date.parse(stored.authorizedAt!)).toBe(30 * 86_400_000);
	expect(view.models.length).toBeGreaterThan(0);
	expect(view.models.every(m => m.id === `${m.provider}/${m.id.slice(m.provider.length + 1)}`)).toBe(true);
	expect(view.models.some(m => m.id.startsWith("anthropic/"))).toBe(true);
	// The next run's snapshot carries the new sign-in without a restart (SEC-13).
	expect((await signins.snapshotForRun()).some(c => c.provider === "anthropic")).toBe(true);

	expect(await manager.signOut("anthropic")).toBe(true);
	expect(manager.view().accounts.some(a => a.provider === "anthropic")).toBe(false);
	expect(await manager.signOut("anthropic")).toBe(false);
});

test("a pasted bare code also completes a browser flow", async () => {
	const manager = accounts();
	const login = manager.startLogin("agentbot-test-browser");
	await until(manager, login.id, ["needs_input"]);
	manager.submitInput(login.id, "  abc  ");
	expect((await until(manager, login.id, ["done", "failed"])).status).toBe("done");
	await manager.signOut("anthropic");
});

test("device flow shows the code and finishes by polling", async () => {
	const manager = accounts();
	approveDevice = Promise.withResolvers<void>();
	const login = manager.startLogin("agentbot-test-device");
	const waiting = await until(manager, login.id, ["waiting"]);
	expect(waiting).toMatchObject({ url: "https://device.example.com/activate", instructions: "Enter code WXYZ-1234" });
	expect(waiting.input).toBeUndefined();
	expect(manager.submitInput(login.id, "anything")).toBe(false);

	approveDevice.resolve();
	expect(await until(manager, login.id, ["done", "failed"])).toMatchObject({ status: "done", account: { email: "device@example.com" } });
	expect(manager.view().accounts.some(a => a.provider === "agentbot-test-device" && a.email === "device@example.com")).toBe(true);
	await manager.signOut("agentbot-test-device");
});

test("prompt flow answers through submitInput; a bad paste fails the sign-in", async () => {
	const manager = accounts();
	const prompt = manager.startLogin("agentbot-test-prompt");
	expect((await until(manager, prompt.id, ["needs_input"])).input).toEqual({ kind: "prompt", message: "Enter your team", placeholder: undefined });
	expect(manager.submitInput(prompt.id, "   ")).toBe(false);
	manager.submitInput(prompt.id, "forge");
	expect(await until(manager, prompt.id, ["done"])).toMatchObject({ account: { email: "forge@example.com" }, progress: ["Starting"] });
	await manager.signOut("agentbot-test-prompt");

	const bad = manager.startLogin("agentbot-test-browser");
	await until(manager, bad.id, ["needs_input"]);
	manager.submitInput(bad.id, "http://localhost:54545/callback?code=wrong");
	expect(await until(manager, bad.id, ["failed"])).toMatchObject({ error: "bad code wrong" });
});

test("cancelling a waiting sign-in ends it as cancelled and stores nothing", async () => {
	const manager = accounts();
	const before = manager.view().accounts.length;
	const login = manager.startLogin("agentbot-test-browser");
	await until(manager, login.id, ["needs_input"]);
	manager.cancelLogin(login.id);
	expect((await until(manager, login.id, ["cancelled", "failed"])).status).toBe("cancelled");
	expect(manager.view().accounts.length).toBe(before);
	expect(() => manager.startLogin("no-such-provider")).toThrow('Unknown sign-in provider "no-such-provider"');
});

test("a sign-in left unattended is aborted after 15 minutes", async () => {
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const manager = accounts((fn, ms) => {
		const timer = { fn, ms, cancelled: false };
		timers.push(timer);
		return () => void (timer.cancelled = true);
	});
	const login = manager.startLogin("agentbot-test-browser");
	await until(manager, login.id, ["needs_input"]);
	expect(timers.map(t => t.ms)).toEqual([15 * 60_000]);
	expect(LOGIN_TIMEOUT_MS).toBe(15 * 60_000);

	timers[0]!.fn();
	const ended = await until(manager, login.id, ["failed", "cancelled"]);
	expect(ended.status).toBe("failed");
	expect(ended.error).toContain("timed out");
	expect(ended.input).toBeUndefined();
	expect(manager.submitInput(login.id, "http://localhost:54545/callback?code=abc")).toBe(false);

	// A finished sign-in cancels its timer.
	approveDevice = Promise.withResolvers<void>();
	approveDevice.resolve();
	const quick = manager.startLogin("agentbot-test-device");
	await until(manager, quick.id, ["done"]);
	expect(timers[1]!.cancelled).toBe(true);
	await manager.signOut("agentbot-test-device");
});
