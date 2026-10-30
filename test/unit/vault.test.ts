import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, type Settings } from "../../src/shared/config";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { loadMasterKey, openVault, VaultLocked } from "../../src/orchestrator/store/vault";

const KEY = Buffer.from("k".repeat(48));
const OTHER_KEY = Buffer.from("z".repeat(48));
const settings: Settings = parseSettings({
	config: {
		discord: { guildId: "g", allowedUserIds: ["u"], workChannelId: "work-channel" },
		github: { appId: 9 },
	},
	secrets: { discordToken: "discord-secret", githubAppPrivateKey: "pem-secret", providerKeys: { anthropic: "sk-secret" } },
});

async function initialized(db: Db, masterKey?: Uint8Array) {
	const vault = await openVault(db, masterKey);
	await vault.initialize("admin", "correct horse battery");
	vault.writeSettings(settings);
	return vault;
}

describe("vault", () => {
	test("settings and omp config are stored encrypted and round-trip", async () => {
		const db = openDb(":memory:");
		const vault = await initialized(db);
		vault.writeOmpConfig({ mcpServers: { search: { token: "mcp-secret" } } });
		expect(vault.readSettings()).toEqual(settings);
		expect(vault.readOmpConfig()).toEqual({ mcpServers: { search: { token: "mcp-secret" } } });
		const stored = db.kvGet("vault")!;
		for (const secret of ["discord-secret", "pem-secret", "sk-secret", "mcp-secret", "work-channel", "correct horse"]) {
			expect(stored).not.toContain(secret);
		}
	});

	test("each blob is bound to its own label, so swapping blobs fails authentication", async () => {
		const db = openDb(":memory:");
		const vault = await initialized(db, KEY);
		vault.writeOmpConfig({ settings: {} });
		const record = JSON.parse(db.kvGet("vault")!);
		db.kvSet("vault", JSON.stringify({ ...record, settings: record.omp }));
		await expect(openVault(db, KEY).then(v => v.readSettings())).rejects.toThrow("failed authentication");
	});

	test("without a key file a restart is locked until the right credentials are given", async () => {
		const db = openDb(":memory:");
		await initialized(db);
		const restarted = await openVault(db);
		expect(restarted.isInitialized()).toBe(true);
		expect(restarted.isUnlocked()).toBe(false);
		expect(() => restarted.readSettings()).toThrow(VaultLocked);
		expect(() => restarted.writeOmpConfig({})).toThrow(VaultLocked);
		expect(await restarted.login("admin", "wrong password!!")).toBe(false);
		expect(await restarted.login("someone", "correct horse battery")).toBe(false);
		expect(restarted.isUnlocked()).toBe(false);
		expect(await restarted.login("admin", "correct horse battery")).toBe(true);
		expect(restarted.readSettings()).toEqual(settings);
	});

	test("the password is NFC-normalised", async () => {
		const db = openDb(":memory:");
		const vault = await openVault(db);
		await vault.initialize("admin", "caf\u00e9 password");
		expect(await (await openVault(db)).login("admin", "cafe\u0301 password")).toBe(true);
	});

	test("the key file unlocks on restart; a different key file does not", async () => {
		const db = openDb(":memory:");
		await initialized(db, KEY);
		const withKey = await openVault(db, KEY);
		expect(withKey.unlockedByKeyFile()).toBe(true);
		expect(withKey.readSettings()).toEqual(settings);
		const wrongKey = await openVault(db, OTHER_KEY);
		expect(wrongKey.isUnlocked()).toBe(false);
	});

	test("a master key added later is enrolled by the next login", async () => {
		const db = openDb(":memory:");
		await initialized(db);
		expect((await openVault(db, KEY)).isUnlocked()).toBe(false);
		expect(await (await openVault(db, KEY)).login("admin", "correct horse battery")).toBe(true);
		expect((await openVault(db, KEY)).unlockedByKeyFile()).toBe(true);
	});

	test("a rotated master key is enrolled by the next login and replaces the old one", async () => {
		const db = openDb(":memory:");
		await initialized(db, KEY);
		const rotated = await openVault(db, OTHER_KEY);
		expect(await rotated.login("admin", "correct horse battery")).toBe(true);
		expect((await openVault(db, OTHER_KEY)).unlockedByKeyFile()).toBe(true);
		expect((await openVault(db, KEY)).isUnlocked()).toBe(false);
	});

	test("changing credentials requires the current password and keeps the key-file unlock", async () => {
		const db = openDb(":memory:");
		const vault = await initialized(db, KEY);
		expect(await vault.changeCredentials("not the password", "root", "new password 123")).toBe(false);
		expect(await vault.changeCredentials("correct horse battery", "root", "new password 123")).toBe(true);
		const restarted = await openVault(db);
		expect(await restarted.login("admin", "correct horse battery")).toBe(false);
		expect(await restarted.login("root", "new password 123")).toBe(true);
		expect((await openVault(db, KEY)).readSettings()).toEqual(settings);
	});

	test("tampered settings fail authentication instead of decrypting to garbage", async () => {
		const db = openDb(":memory:");
		await initialized(db, KEY);
		const record = JSON.parse(db.kvGet("vault")!);
		const data = Buffer.from(record.settings.data, "base64");
		data[0]! ^= 1;
		record.settings.data = data.toString("base64");
		db.kvSet("vault", JSON.stringify(record));
		await expect(openVault(db, KEY).then(v => v.readSettings())).rejects.toThrow("failed authentication");
	});

	test("initialize refuses to overwrite an existing admin", async () => {
		const db = openDb(":memory:");
		const vault = await initialized(db);
		await expect(vault.initialize("evil", "another password")).rejects.toThrow("already initialized");
		expect(vault.username()).toBe("admin");
	});
});

describe("loadMasterKey", () => {
	test("reads and trims the file, ignores an unset path or empty file, and rejects short keys", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agentbot-vault-"));
		try {
			const file = join(dir, "master.key");
			await writeFile(file, `${"m".repeat(40)}\n`);
			expect(Buffer.from((await loadMasterKey(file))!).toString()).toBe("m".repeat(40));
			expect(await loadMasterKey(undefined)).toBeUndefined();
			await writeFile(file, "\n");
			expect(await loadMasterKey(file)).toBeUndefined();
			await writeFile(file, "x".repeat(31));
			await expect(loadMasterKey(file)).rejects.toThrow("too short");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
