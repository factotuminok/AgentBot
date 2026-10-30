import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { parseLogCapOverride } from "./rollinglog";

/**
 * Typed `AGENTBOT_*` environment (requirements §13). Defaults are the source-checkout ones; the image sets its
 * own (`AGENTBOT_HOME=/home/agentbot`, `AGENTBOT_STATE_DIR=/state`, `AGENTBOT_WEB_HOST=0.0.0.0`, …) with `ENV`.
 * Each component reads only the fields it uses; an invalid value throws with the variable's name.
 */

export const ROLES = ["orchestrator", "web", "worker", "launcher"] as const;
export type Role = (typeof ROLES)[number];

export interface AgentbotEnv {
	/** `AGENTBOT_ROLE`; the command argument takes precedence in `cli.ts`. */
	role?: Role;
	/** `AGENTBOT_HOME`: web home volume root (absolute). */
	home: string;
	/** `AGENTBOT_STATE_DIR`: state volume root `<state>` (absolute); orchestrator only. */
	stateDir: string;
	/** `AGENTBOT_OMP_DIR`: skills and agents root; defaults to `<state>/omp`. */
	ompDir: string;
	webHost: string;
	webPort: number;
	/** `AGENTBOT_WEB_TRUSTED_PROXIES`: addresses and CIDRs of reverse proxies in front of web (WEB-03 client address). */
	webTrustedProxies: string[];
	/** `AGENTBOT_MASTER_KEY_FILE`: mounted master key file; orchestrator only. */
	masterKeyFile?: string;
	internalHost: string;
	internalPort: number;
	/** Mounted internal tokens (SEC-14). */
	webApiTokenFile?: string;
	workerTokenFile?: string;
	scaleTokenFile?: string;
	/** `AGENTBOT_WEB_VSCODE` is not `off`. */
	webVscode: boolean;
	/** `AGENTBOT_AGENT_LOG_MAX_BYTES`: overrides `logs.maxGiB` (OBS-04). */
	agentLogMaxBytes?: number;
	/** `AGENTBOT_OMP_RUNTIME_DIR`: set only in the image; enables in-place omp updates. */
	ompRuntimeDir?: string;
	/** `AGENTBOT_ORCHESTRATOR_URL` without a trailing slash. */
	orchestratorUrl: string;
	/** `AGENTBOT_WORKER_CLAIM_TIMEOUT` in milliseconds. */
	workerClaimTimeoutMs: number;
	/** `AGENTBOT_WORKER_ADDRESS_BINDING` (default on): one claim per worker address, worker ids bound to their first address (architecture §6). */
	workerAddressBinding: boolean;
	/** `AGENTBOT_WORKER_RUN_DIR`: parent of the worker's run-local root (the image: `/run/agentbot`, a tmpfs or memory `emptyDir`). */
	workerRunDir?: string;
	workerCapacity: number;
	/** `AGENTBOT_WORKER_IMAGE`: launcher only; undefined means the AgentBot image itself (`image`). */
	workerImage?: string;
	/** `AGENTBOT_IMAGE`: launcher only; the AgentBot image this stack runs (compose sets it to the services' image). */
	image?: string;
	/** `AGENTBOT_WORKER_NETWORK`: launcher only, required; the stack network workers join. */
	workerNetwork?: string;
	/** `AGENTBOT_WORKER_SECRET`: launcher only; the Podman secret holding the worker token. */
	workerSecret: string;
	/** `AGENTBOT_WORKER_MEMORY` in bytes. */
	workerMemoryBytes: number;
	/** `AGENTBOT_WORKER_CPUS`: launcher only; CPU quota per worker container, in CPUs (`podman run --cpus`). */
	workerCpus: number;
	/** `AGENTBOT_WORKER_DISK` in bytes. */
	workerDiskBytes: number;
	podmanSocket: string;
	launcherAllowRootful: boolean;
	version?: string;
	commit?: string;
	buildDate?: string;
}

type Env = Record<string, string | undefined>;

function fail(name: string, raw: string, expected: string): never {
	throw new Error(`${name} must be ${expected}, got "${raw}"`);
}

/** The variable's value, or undefined when unset or empty. */
function str(env: Env, name: string): string | undefined {
	const raw = env[name]?.trim();
	return raw ? raw : undefined;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
	const raw = str(env, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) fail(name, raw, `an integer from ${min} to ${max}`);
	return value;
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Parses a duration such as `15s`, `500ms`, `2m` or `1h` into milliseconds. */
export function parseDuration(name: string, raw: string): number {
	const match = /^(\d+)(ms|s|m|h)$/.exec(raw);
	const ms = match ? Number(match[1]) * DURATION_UNITS[match[2]!]! : 0;
	if (ms <= 0 || !Number.isSafeInteger(ms)) fail(name, raw, "a positive duration such as 15s, 500ms, 2m or 1h");
	return ms;
}

const SIZE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** Parses a Podman-style size such as `4g` or `512m` (binary units) into bytes. */
export function parseSize(name: string, raw: string): number {
	const match = /^(\d+)([bkmgt]?)$/i.exec(raw);
	const bytes = match ? Number(match[1]) * SIZE_UNITS[match[2]!.toLowerCase()]! : 0;
	if (bytes <= 0 || !Number.isSafeInteger(bytes)) fail(name, raw, "a positive size such as 4g or 512m");
	return bytes;
}

/** A CPU count such as `2` or `1.5` (`podman run --cpus`): at least 0.01 (a 1 ms quota per 100 ms), at most 1024. */
function cpus(env: Env, name: string, fallback: number): number {
	const raw = str(env, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!/^\d+(\.\d+)?$/.test(raw) || value < 0.01 || value > 1024) fail(name, raw, "a number of CPUs from 0.01 to 1024, such as 2 or 1.5");
	return value;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
	const raw = str(env, name);
	if (raw === undefined) return fallback;
	const value = raw.toLowerCase();
	if (["1", "true", "on", "yes"].includes(value)) return true;
	if (["0", "false", "off", "no"].includes(value)) return false;
	fail(name, raw, "on or off");
}

function url(env: Env, name: string, fallback: string): string {
	const raw = str(env, name) ?? fallback;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		fail(name, raw, "an http(s) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(name, raw, "an http(s) URL");
	return raw.replace(/\/+$/, "");
}

/** An image reference such as `ghcr.io/owner/agentbot:1.2.3`; undefined when unset. */
function image(env: Env, name: string): string | undefined {
	const raw = str(env, name);
	if (raw !== undefined && !/^[a-z0-9][^\s]*$/i.test(raw)) fail(name, raw, "an image reference");
	return raw;
}

/** A Podman network or secret name; undefined when unset. */
function podmanName(env: Env, name: string): string | undefined {
	const raw = str(env, name);
	if (raw !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(raw)) fail(name, raw, "a Podman name (letters, digits, '_', '.', '-')");
	return raw;
}

/** Comma-separated IP addresses and CIDRs (`10.0.0.0/8`, `fd00::/8`); empty when unset. */
function addressList(env: Env, name: string): string[] {
	const entries = (str(env, name) ?? "").split(",").map(entry => entry.trim()).filter(entry => entry !== "");
	for (const entry of entries) {
		const [address = "", prefix, extra] = entry.split("/");
		const version = isIP(address);
		const bits = version === 6 ? 128 : 32;
		const validPrefix = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits);
		if (version === 0 || !validPrefix || extra !== undefined) fail(name, entry, "comma-separated IP addresses or CIDRs");
	}
	return entries;
}

/** Reads and validates every `AGENTBOT_*` variable; throws on the first invalid one. */
export function loadEnv(env: Env = process.env): Readonly<AgentbotEnv> {
	const role = str(env, "AGENTBOT_ROLE");
	if (role !== undefined && !ROLES.includes(role as Role)) fail("AGENTBOT_ROLE", role, ROLES.join(", "));
	const vscode = str(env, "AGENTBOT_WEB_VSCODE") ?? "on";
	if (vscode !== "on" && vscode !== "off") fail("AGENTBOT_WEB_VSCODE", vscode, "on or off");
	const stateDir = resolve(str(env, "AGENTBOT_STATE_DIR") ?? "./state");
	const claimTimeout = str(env, "AGENTBOT_WORKER_CLAIM_TIMEOUT") ?? "15s";
	const workerMemory = str(env, "AGENTBOT_WORKER_MEMORY") ?? "4g";
	const workerDisk = str(env, "AGENTBOT_WORKER_DISK") ?? "20g";
	const optionalPath = (name: string) => {
		const raw = str(env, name);
		return raw === undefined ? undefined : resolve(raw);
	};
	return Object.freeze({
		role: role as Role | undefined,
		home: resolve(str(env, "AGENTBOT_HOME") ?? "./web-home"),
		stateDir,
		ompDir: resolve(str(env, "AGENTBOT_OMP_DIR") ?? join(stateDir, "omp")),
		webHost: str(env, "AGENTBOT_WEB_HOST") ?? "127.0.0.1",
		webPort: int(env, "AGENTBOT_WEB_PORT", 8080, 1, 65535),
		webTrustedProxies: addressList(env, "AGENTBOT_WEB_TRUSTED_PROXIES"),
		masterKeyFile: optionalPath("AGENTBOT_MASTER_KEY_FILE"),
		internalHost: str(env, "AGENTBOT_INTERNAL_HOST") ?? "0.0.0.0",
		internalPort: int(env, "AGENTBOT_INTERNAL_PORT", 8081, 1, 65535),
		webApiTokenFile: optionalPath("AGENTBOT_WEB_API_TOKEN_FILE"),
		workerTokenFile: optionalPath("AGENTBOT_WORKER_TOKEN_FILE"),
		scaleTokenFile: optionalPath("AGENTBOT_SCALE_TOKEN_FILE"),
		webVscode: vscode === "on",
		agentLogMaxBytes: parseLogCapOverride(str(env, "AGENTBOT_AGENT_LOG_MAX_BYTES")),
		ompRuntimeDir: optionalPath("AGENTBOT_OMP_RUNTIME_DIR"),
		orchestratorUrl: url(env, "AGENTBOT_ORCHESTRATOR_URL", "http://orchestrator:8081"),
		workerClaimTimeoutMs: parseDuration("AGENTBOT_WORKER_CLAIM_TIMEOUT", claimTimeout),
		workerAddressBinding: flag(env, "AGENTBOT_WORKER_ADDRESS_BINDING", true),
		workerRunDir: optionalPath("AGENTBOT_WORKER_RUN_DIR"),
		workerCapacity: int(env, "AGENTBOT_WORKER_CAPACITY", 4, 1, 1000),
		workerImage: image(env, "AGENTBOT_WORKER_IMAGE"),
		image: image(env, "AGENTBOT_IMAGE"),
		workerNetwork: podmanName(env, "AGENTBOT_WORKER_NETWORK"),
		workerSecret: podmanName(env, "AGENTBOT_WORKER_SECRET") ?? "agentbot_worker_token",
		workerMemoryBytes: parseSize("AGENTBOT_WORKER_MEMORY", workerMemory),
		workerCpus: cpus(env, "AGENTBOT_WORKER_CPUS", 2),
		workerDiskBytes: parseSize("AGENTBOT_WORKER_DISK", workerDisk),
		podmanSocket: str(env, "AGENTBOT_PODMAN_SOCKET") ?? "/run/podman/podman.sock",
		launcherAllowRootful: flag(env, "AGENTBOT_LAUNCHER_ALLOW_ROOTFUL", false),
		version: str(env, "AGENTBOT_VERSION"),
		commit: str(env, "AGENTBOT_COMMIT"),
		buildDate: str(env, "AGENTBOT_BUILD_DATE"),
	});
}
