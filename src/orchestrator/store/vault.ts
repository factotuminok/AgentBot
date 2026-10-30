import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt, type ScryptOptions } from "node:crypto";
import { parseSettings, type Settings } from "../../shared/config";
import { addLogSecret } from "../../shared/log";
import type { Db } from "./db";

/**
 * Encrypted settings store (SEC-03 to SEC-05).
 *
 * A random 256-bit data key seals each blob (settings with secrets, omp configuration) with AES-256-GCM under its
 * own additional-data label. The data key itself is stored only wrapped: once under a key derived from the admin
 * password (scrypt) and, when a master key file is present, once under a key derived from that file (HKDF). Either
 * unwraps it, so the orchestrator starts unattended when the key file is mounted and otherwise waits for an admin
 * login.
 */

const KV_KEY = "vault";
const SETTINGS_AAD = "agentbot:settings:v1";
const OMP_AAD = "agentbot:omp:v1";
const KEYFILE_INFO = "agentbot:keyfile:v1";
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const MIN_KEY_FILE_CHARS = 32;

/** F9: the settings' secrets are masked in every log line and agent-log entry once the vault has handled them. */
function maskSecrets(settings: Settings): Settings {
	addLogSecret(settings.secrets.discordToken);
	addLogSecret(settings.secrets.githubAppPrivateKey);
	for (const key of Object.values(settings.secrets.providerKeys)) addLogSecret(key);
	return settings;
}

interface Sealed {
	iv: string;
	data: string;
	tag: string;
}

interface VaultRecord {
	version: 1;
	username: string;
	password: { salt: string; N: number; r: number; p: number; wrapped: Sealed };
	keyFile?: { salt: string; wrapped: Sealed };
	settings?: Sealed;
	/** omp setting overrides and MCP servers, sealed separately so saving them does not restart the engine. */
	omp?: Sealed;
}

export interface Vault {
	/** An admin account exists. */
	isInitialized(): boolean;
	/** The data key is in memory, so settings can be read and written. */
	isUnlocked(): boolean;
	/** True when the vault holds a key-file wrap that the mounted key file opened at startup. */
	unlockedByKeyFile(): boolean;
	username(): string | undefined;
	/** First run: create the admin account and data key. Leaves the vault unlocked. Throws if already initialized. */
	initialize(username: string, password: string): Promise<void>;
	/** Checks the credentials (also when already unlocked) and unlocks. Enrols a new or rotated master key. */
	login(username: string, password: string): Promise<boolean>;
	/** Re-wraps the data key for new credentials after verifying the current password. */
	changeCredentials(currentPassword: string, username: string, password: string): Promise<boolean>;
	/** Decrypted settings, or undefined when none were saved yet. Throws if locked or if stored settings no longer validate. */
	readSettings(): Settings | undefined;
	writeSettings(settings: Settings): void;
	/** The stored omp configuration as saved (the caller validates it), or undefined when none was saved. Throws if locked. */
	readOmpConfig(): unknown;
	writeOmpConfig(config: unknown): void;
}

export class VaultLocked extends Error {
	override name = "VaultLocked";
	constructor() {
		super("Settings are locked; log in to unlock them");
	}
}

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64");

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Sealed {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad));
	const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return { iv: b64(iv), data: b64(data), tag: b64(cipher.getAuthTag()) };
}

/** Returns the plaintext, or undefined if the key is wrong or the data was tampered with. */
function open(key: Uint8Array, sealed: Sealed, aad: string): Buffer | undefined {
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, unb64(sealed.iv));
		decipher.setAAD(Buffer.from(aad));
		decipher.setAuthTag(unb64(sealed.tag));
		return Buffer.concat([decipher.update(unb64(sealed.data)), decipher.final()]);
	} catch {
		return undefined;
	}
}

function passwordKey(password: string, salt: Uint8Array, params: ScryptOptions): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	scrypt(password.normalize("NFC"), salt, 32, { ...params, maxmem: 128 * 1024 * 1024 }, (err, key) =>
		err ? reject(err) : resolve(key),
	);
	return promise;
}

function keyFileKey(material: Uint8Array, salt: Uint8Array): Buffer {
	return Buffer.from(hkdfSync("sha256", material, salt, KEYFILE_INFO, 32));
}

/** The password wrap is bound to the username so the stored name cannot be swapped without the password. */
const passwordAad = (username: string) => `agentbot:password:v1:${username}`;

/**
 * Reads the master key file at `path` (`AGENTBOT_MASTER_KEY_FILE`). Returns undefined when no path is given or the
 * file is empty; throws when it is shorter than 32 characters.
 */
export async function loadMasterKey(path: string | undefined): Promise<Uint8Array | undefined> {
	if (!path) return undefined;
	const text = (await Bun.file(path).text()).trim();
	if (!text) return undefined;
	if (text.length < MIN_KEY_FILE_CHARS) {
		throw new Error(`Master key file is too short (${text.length} chars; need at least ${MIN_KEY_FILE_CHARS})`);
	}
	return Buffer.from(text, "utf8");
}

export async function openVault(db: Db, masterKey?: Uint8Array): Promise<Vault> {
	const stored = db.kvGet(KV_KEY);
	let record: VaultRecord | undefined = stored ? (JSON.parse(stored) as VaultRecord) : undefined;
	let dataKey: Buffer | undefined;
	let viaKeyFile = false;

	if (record?.keyFile && masterKey) {
		dataKey = open(keyFileKey(masterKey, unb64(record.keyFile.salt)), record.keyFile.wrapped, KEYFILE_INFO);
		viaKeyFile = dataKey !== undefined;
	}

	function save(next: VaultRecord): void {
		db.kvSet(KV_KEY, JSON.stringify(next));
		record = next;
	}

	async function wrapForPassword(username: string, password: string, key: Buffer): Promise<VaultRecord["password"]> {
		const salt = randomBytes(16);
		const kek = await passwordKey(password, salt, SCRYPT_PARAMS);
		return { salt: b64(salt), ...SCRYPT_PARAMS, wrapped: seal(kek, key, passwordAad(username)) };
	}

	function wrapForKeyFile(key: Buffer): VaultRecord["keyFile"] {
		if (!masterKey) return undefined;
		const salt = randomBytes(16);
		return { salt: b64(salt), wrapped: seal(keyFileKey(masterKey, salt), key, KEYFILE_INFO) };
	}

	/** Unwraps the data key with the password; undefined on any mismatch. Always pays the scrypt cost. */
	async function unwrapWithPassword(username: string, password: string): Promise<Buffer | undefined> {
		if (!record) return undefined;
		const { salt, N, r, p, wrapped } = record.password;
		const kek = await passwordKey(password, unb64(salt), { N, r, p });
		// Compare after deriving so an unknown username costs the same as a wrong password.
		if (username !== record.username) return undefined;
		return open(kek, wrapped, passwordAad(username));
	}

	function readBlob(sealed: Sealed | undefined, aad: string, what: string): unknown {
		if (!dataKey) throw new VaultLocked();
		if (!sealed) return undefined;
		const plain = open(dataKey, sealed, aad);
		if (!plain) throw new Error(`Stored ${what} failed authentication; it was modified or the data key is wrong`);
		return JSON.parse(plain.toString("utf8"));
	}

	function sealBlob(value: unknown, aad: string): Sealed {
		if (!dataKey || !record) throw new VaultLocked();
		return seal(dataKey, Buffer.from(JSON.stringify(value), "utf8"), aad);
	}

	return {
		isInitialized: () => record !== undefined,
		isUnlocked: () => dataKey !== undefined,
		unlockedByKeyFile: () => viaKeyFile,
		username: () => record?.username,

		async initialize(username, password) {
			if (record) throw new Error("Vault is already initialized");
			const key = randomBytes(32);
			save({ version: 1, username, password: await wrapForPassword(username, password, key), keyFile: wrapForKeyFile(key) });
			dataKey = key;
		},

		async login(username, password) {
			const key = await unwrapWithPassword(username, password);
			if (!key) return false;
			dataKey = key;
			// A newly mounted (or rotated) key file is enrolled on the next successful login.
			const keyFileOpens =
				masterKey && record!.keyFile && open(keyFileKey(masterKey, unb64(record!.keyFile.salt)), record!.keyFile.wrapped, KEYFILE_INFO);
			if (masterKey && !keyFileOpens) save({ ...record!, keyFile: wrapForKeyFile(key) });
			return true;
		},

		async changeCredentials(currentPassword, username, password) {
			const key = await unwrapWithPassword(record?.username ?? "", currentPassword);
			if (!key) return false;
			save({ ...record!, username, password: await wrapForPassword(username, password, key) });
			dataKey = key;
			return true;
		},

		readSettings() {
			const raw = readBlob(record?.settings, SETTINGS_AAD, "settings") as { config: unknown; secrets: unknown } | undefined;
			return raw && maskSecrets(parseSettings(raw));
		},

		writeSettings(settings) {
			save({ ...record!, settings: sealBlob(maskSecrets(settings), SETTINGS_AAD) });
		},

		readOmpConfig: () => readBlob(record?.omp, OMP_AAD, "omp config"),

		writeOmpConfig(config) {
			save({ ...record!, omp: sealBlob(config, OMP_AAD) });
		},
	};
}
