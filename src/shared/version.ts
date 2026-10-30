import { readdirSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

/** What is running, for the home page and health responses. */
export interface VersionInfo {
	/** CI build version (`AGENTBOT_VERSION` build arg), else the `package.json` version. */
	agentbot: string;
	/** Git commit the image was built from (`AGENTBOT_COMMIT` build arg), or the checkout's HEAD when run from source. */
	commit: string;
	/** Image build time (`AGENTBOT_BUILD_DATE` build arg), when known. */
	builtAt?: string;
	runtime: { bun: string; os: string; arch: string; container: boolean };
	dependencies: Record<string, string>;
	startedAt: string;
}

/**
 * The app identity (architecture §7.1): the AgentBot version and a hash of the app sources and lockfile. A derived
 * worker image inherits `/app/IDENTITY` unchanged, so omp-runtime copies are matched by identity, not image id.
 */
export interface AppIdentity {
	version: string;
	/** Hex sha256 over the sorted files under `src/` plus `bun.lock` and `package.json`. */
	hash: string;
}

/** Repository (or image `/app`) root. */
export const APP_ROOT = join(import.meta.dir, "..", "..");
export const IDENTITY_FILE = "/app/IDENTITY";
const DEPENDENCIES = ["@oh-my-pi/pi-coding-agent", "discord.js", "octokit", "zod"] as const;
const startedAt = new Date().toISOString();

async function packageVersion(dir: string): Promise<string> {
	try {
		const pkg = (await Bun.file(join(dir, "package.json")).json()) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

function sourceCommit(): string {
	const fromBuild = process.env.AGENTBOT_COMMIT;
	if (fromBuild && fromBuild !== "unknown") return fromBuild;
	const git = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], { cwd: APP_ROOT, stdout: "pipe", stderr: "ignore" });
	return git.exitCode === 0 ? git.stdout.toString().trim() : "unknown";
}

let info: Promise<VersionInfo> | undefined;

/** Versions are read once per process. */
export function versionInfo(): Promise<VersionInfo> {
	info ??= (async () => {
		const dependencies: Record<string, string> = {};
		for (const name of DEPENDENCIES) dependencies[name] = await packageVersion(join(APP_ROOT, "node_modules", name));
		return {
			agentbot: process.env.AGENTBOT_VERSION || (await packageVersion(APP_ROOT)),
			commit: sourceCommit(),
			...(process.env.AGENTBOT_BUILD_DATE ? { builtAt: process.env.AGENTBOT_BUILD_DATE } : {}),
			runtime: { bun: Bun.version, os: `${platform()} ${release()}`, arch: arch(), container: (await Bun.file("/.dockerenv").exists()) || (await Bun.file("/run/.containerenv").exists()) },
			dependencies,
			startedAt,
		};
	})();
	return info;
}

/** Computes the identity from the sources under `root`: path and content of every file, in sorted path order. */
export async function computeAppIdentity(root: string = APP_ROOT): Promise<AppIdentity> {
	const sources = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
		.map(rel => `src/${rel.split("\\").join("/")}`)
		.filter(rel => statSync(join(root, rel)).isFile());
	const files = [...sources, "bun.lock", "package.json"].sort();
	const hasher = new Bun.CryptoHasher("sha256");
	for (const rel of files) {
		hasher.update(`${rel}\0`);
		hasher.update(await Bun.file(join(root, rel)).arrayBuffer());
		hasher.update("\0");
	}
	return { version: process.env.AGENTBOT_VERSION || (await packageVersion(root)), hash: hasher.digest("hex") };
}

/** Reads `identityFile` when present (the image), otherwise computes the identity from the sources under `root`. */
export async function readAppIdentity(identityFile: string = IDENTITY_FILE, root: string = APP_ROOT): Promise<AppIdentity> {
	const file = Bun.file(identityFile);
	if (await file.exists()) {
		const parsed = (await file.json()) as Partial<AppIdentity>;
		if (typeof parsed.version !== "string" || typeof parsed.hash !== "string") throw new Error(`Invalid app identity file ${identityFile}`);
		return { version: parsed.version, hash: parsed.hash };
	}
	return computeAppIdentity(root);
}

let identity: Promise<AppIdentity> | undefined;

/** This process's app identity, read once. */
export function appIdentity(): Promise<AppIdentity> {
	identity ??= readAppIdentity();
	return identity;
}

/** Computes the identity from the sources under `root` and writes it to `path` as JSON (image build step). */
export async function writeAppIdentity(path: string, root: string = APP_ROOT): Promise<AppIdentity> {
	const computed = await computeAppIdentity(root);
	await Bun.write(path, `${JSON.stringify(computed)}\n`);
	return computed;
}

// Image build: `bun src/shared/version.ts --write-identity /app/IDENTITY`
if (import.meta.main) {
	const [flag, path] = process.argv.slice(2);
	if (flag !== "--write-identity" || !path) {
		process.stderr.write("usage: bun src/shared/version.ts --write-identity <path>\n");
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify(await writeAppIdentity(path))}\n`);
}
