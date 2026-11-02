import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { parseSettings, type Settings, WORK_CHANNEL_MISSING } from "../../src/shared/config";
import { createFakeDiscord, type FakeDiscord } from "../fakes/discord";
import type { StoredAccount } from "../../src/shared/adminModels";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const PASSWORD = "correct horse battery";

interface Harness {
	stateDir: string;
	db: Db;
	vault: Vault;
	github: FakeGitHub;
	discords: FakeDiscord[];
	applied: number[];
	controller: Controller;
	settings(extra?: Record<string, unknown>, discordToken?: string): Settings;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(opts: { loginError?: string; initialize?: boolean; signinAccounts?: () => StoredAccount[] } = {}): Promise<Harness> {
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-controller-"));
	const db = openDb(":memory:");
	const vault = await openVault(db);
	if (opts.initialize !== false) await vault.initialize("admin", PASSWORD);
	const github = startFakeGitHub();
	const agentLog = await openAgentLog({ dir: join(stateDir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const discords: FakeDiscord[] = [];
	const applied: number[] = [];
	const controller = createController({
		stateDir,
		db,
		vault,
		agentLog,
		dispatcher: createFakeDispatcher(),
		applyLogCap: gib => applied.push(gib),
		connectDiscord: () => {
			const discord = createFakeDiscord({ loginError: opts.loginError, channels: opts.signinAccounts ? [{ id: "w", name: "work" }] : undefined });
			discords.push(discord);
			return discord;
		},
		signinAccounts: opts.signinAccounts,
		connectGitHub: gh => createGitHub({ ...gh, baseUrl: github.url }),
	});
	cleanups.push(async () => {
		await controller.stop();
		await github.stop();
		db.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
	return {
		stateDir,
		db,
		vault,
		github,
		discords,
		applied,
		controller,
		settings: (extra = {}, discordToken = "discord-token") =>
			parseSettings({
				config: { discord: { guildId: "g", allowedUserIds: ["u"], workChannelId: "w" }, github: { appId: github.appId }, ...extra },
				secrets: { discordToken, githubAppPrivateKey: github.privateKey },
			}),
	};
}

test("apply passes Settings → Logs to applyLogCap before the engine starts, even if the engine then fails", async () => {
	const h = await harness({ loginError: "An invalid token was provided." });
	h.vault.writeSettings(h.settings({ logs: { maxGiB: 1.5 } }));
	await h.controller.apply();
	expect(h.applied).toEqual([1.5]);
	expect(h.controller.status()).toMatchObject({ phase: "error", error: expect.stringContaining("An invalid token was provided.") });
	expect(h.controller.snapshot()).toBeUndefined();
	// A failed login leaves nothing connected.
	expect(h.discords[0]!.destroyed).toBe(true);
});

test("apply chooses setup, locked and unconfigured from the vault (ENG-02)", async () => {
	const fresh = await harness({ initialize: false });
	expect(fresh.controller.status().phase).toBe("setup");
	await fresh.controller.apply();
	expect(fresh.controller.status().phase).toBe("setup");

	const h = await harness();
	await h.controller.apply();
	expect(h.controller.status().phase).toBe("unconfigured");

	const locked = createController({
		stateDir: h.stateDir,
		db: h.db,
		vault: await openVault(h.db),
		agentLog: await openAgentLog({ dir: join(h.stateDir, "logs", "agent2"), maxBytes: 1024 ** 3 }),
		dispatcher: createFakeDispatcher(),
	});
	expect(locked.status().phase).toBe("locked");
	await locked.apply();
	expect(locked.status().phase).toBe("locked");
	await locked.stop();
});

test("settings without a work channel save, but the engine stays unconfigured until one is chosen (DSC-33, WEB-20)", async () => {
	const h = await harness();
	const settings = h.settings();
	delete settings.config.discord.workChannelId;
	h.vault.writeSettings(settings);
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "unconfigured", error: WORK_CHANNEL_MISSING });
	expect(h.discords).toHaveLength(0);

	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "running", error: undefined });
});

test("a running engine creates the state dirs, logs in to Discord and reports a snapshot", async () => {
	const h = await harness();
	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "running", error: undefined });
	for (const dir of ["sessions", "scratch", "omp-agent", "repos"]) expect(existsSync(join(h.stateDir, dir))).toBe(true);
	expect(h.discords).toHaveLength(1);
	expect(h.discords[0]!.loggedIn).toBe(true);
	expect(h.discords[0]!.token).toBe("discord-token");
	const snapshot = h.controller.snapshot()!;
	expect(snapshot.githubApp).toBe(`${h.github.slug}[bot]`);
	expect(snapshot.discord.ready).toBe(true);
	expect(snapshot.watches).toEqual([]);
	expect(snapshot.queuedJobs).toBe(0);
	expect(snapshot.discordQueue).toMatchObject({ length: 0 });
});

test("overlapping applies are serialised: each restart stops the previous engine first", async () => {
	const h = await harness();
	h.vault.writeSettings(h.settings());
	await Promise.all([h.controller.apply(), h.controller.apply(), h.controller.apply()]);
	expect(h.controller.status().phase).toBe("running");
	expect(h.discords).toHaveLength(3);
	expect(h.discords.map(d => d.destroyed)).toEqual([true, true, false]);
});

test("a sign-in near its re-login deadline is announced in the work channel after login, and a re-apply does not repeat it (SEC-17)", async () => {
	const accounts: StoredAccount[] = [
		{ credentialId: 1, provider: "anthropic", type: "oauth", email: "alice@example.com", reloginBy: new Date(Date.now() + 2 * 86_400_000).toISOString() },
	];
	const h = await harness({ signinAccounts: () => accounts });
	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	await h.discords[0]!.settled();
	expect(h.discords[0]!.messages("w").map(m => m.content)).toEqual([expect.stringContaining("alice@example.com")]);

	await h.controller.apply();
	await h.discords[1]!.settled();
	expect(h.discords).toHaveLength(2);
	expect(h.discords[1]!.messages("w")).toEqual([]);
});

test("a bad GitHub key ends the start in error without touching Discord", async () => {
	const h = await harness();
	const settings = h.settings();
	h.vault.writeSettings({ ...settings, secrets: { ...settings.secrets, githubAppPrivateKey: "not a pem" } });
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "error", error: expect.stringContaining("GitHub App private key") });
	expect(h.discords).toHaveLength(0);
});

test("stop stays in stopping and no later apply starts the engine again (ENG-04)", async () => {
	const h = await harness();
	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	await h.controller.stop();
	expect(h.controller.status().phase).toBe("stopping");
	expect(h.discords[0]!.destroyed).toBe(true);
	await h.controller.apply();
	expect(h.controller.status().phase).toBe("stopping");
	expect(h.discords).toHaveLength(1);
});
