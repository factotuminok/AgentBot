/**
 * Image build step (UPD-01), ported from DevForge: installs npm's latest omp instead of the one in `package.json` and
 * `bun.lock`, and falls back to that pin when the latest does not install (10 min) or does not load the app's entry
 * modules (2 min). The build log gets one `omp version chosen` line saying which version the image has and why.
 *
 *   bun scripts/omp-latest.ts install <npm-latest.json>   before `src/` is copied: dependency install
 *   bun scripts/omp-latest.ts verify                      after `src/` is copied: smoke import, summary line
 *
 * `AGENTBOT_OMP` (build arg, read from the environment) picks the candidate: `latest` (default, npm's `latest` document),
 * `pin` (the version `package.json` pins, which is what CI tests; no candidate), or an exact version to try instead.
 * `install` needs only `package.json`, `bun.lock`, this file, `src/shared/log.ts` and `src/shared/ompPins.ts` (no
 * imports beyond `node:`) in the app dir.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, log } from "../src/shared/log";
import {
	APP_SMOKE_SCRIPT,
	INSTALL_TIMEOUT_MS,
	installedOmpVersion,
	OMP_PACKAGE,
	outputTail as tail,
	pinOmp,
	type RunCommand,
	runCommand,
	SEMVER,
	SMOKE_TIMEOUT_MS,
} from "../src/shared/ompPins";

/** Pinned `package.json` and `bun.lock`, plus the build state, kept from `install` to `verify` so either can fall back. */
const SAVED_DIR = ".omp-pinned";
const SAVED_FILES = ["package.json", "bun.lock"] as const;

export interface BuildState {
	/** The version `package.json` pins (what CI tested). */
	pin: string;
	/** npm's `latest`; undefined when the registry document was unusable or not asked for. */
	latest?: string;
	/** The version tried instead of the pin; undefined when the pin was installed directly. */
	candidate?: string;
	/** Why the image has the version it has. */
	reason: string;
}

interface Params {
	appDir: string;
	run?: RunCommand;
}

function readPin(appDir: string): string {
	const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
	const pin = pkg.dependencies?.[OMP_PACKAGE];
	if (!pin || !SEMVER.test(pin)) throw new Error(`package.json must pin ${OMP_PACKAGE} to an exact version, found ${pin}`);
	return pin;
}

/** Resolves the version in an npm `…/latest` document; undefined when it is not usable. */
export function latestVersion(latestDoc: string): string | undefined {
	try {
		const doc: unknown = JSON.parse(latestDoc);
		if (typeof doc !== "object" || doc === null || !("version" in doc)) return undefined;
		return typeof doc.version === "string" && SEMVER.test(doc.version) ? doc.version : undefined;
	} catch {
		return undefined;
	}
}

/** The candidate for `AGENTBOT_OMP` (see the header), or the reason the pin is installed directly. */
export function chooseCandidate(want: string, pin: string, latest: string | undefined): { candidate: string } | { reason: string } {
	if (want === "pin") return { reason: "AGENTBOT_OMP=pin" };
	if (want !== "latest") {
		if (!SEMVER.test(want)) throw new Error(`AGENTBOT_OMP must be latest, pin or an exact version, got "${want}"`);
		return want === pin ? { reason: `AGENTBOT_OMP=${want} is the pin` } : { candidate: want };
	}
	if (!latest) return { reason: "the npm registry document has no usable version" };
	if (Bun.semver.order(latest, pin) <= 0) return { reason: `npm latest ${latest} is not newer than the pin` };
	return { candidate: latest };
}

/** Puts the saved pinned files back and installs exactly the lockfile. */
async function installPinned(appDir: string, run: RunCommand): Promise<void> {
	for (const name of SAVED_FILES) cpSync(join(appDir, SAVED_DIR, name), join(appDir, name));
	rmSync(join(appDir, "node_modules"), { recursive: true, force: true });
	const result = await run([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: appDir, timeoutMs: INSTALL_TIMEOUT_MS });
	if (result.exitCode !== 0) throw new Error(`bun install of the pinned omp failed (exit ${result.exitCode}):\n${tail(result.output)}`);
}

function saveState(appDir: string, state: BuildState): BuildState {
	writeFileSync(join(appDir, SAVED_DIR, "state.json"), JSON.stringify(state));
	return state;
}

/** Installs the candidate omp, or the pin when there is none or it does not install. */
export async function installLatest(params: Params & { latestDoc: string; want: string }): Promise<BuildState> {
	const { appDir } = params;
	const run = params.run ?? runCommand;
	const pin = readPin(appDir);
	const latest = params.want === "latest" ? latestVersion(params.latestDoc) : undefined;
	const choice = chooseCandidate(params.want, pin, latest);

	mkdirSync(join(appDir, SAVED_DIR), { recursive: true });
	for (const name of SAVED_FILES) cpSync(join(appDir, name), join(appDir, SAVED_DIR, name));

	if ("reason" in choice) {
		await installPinned(appDir, run);
		return saveState(appDir, { pin, latest, reason: choice.reason });
	}
	const { candidate } = choice;
	const source = params.want === "latest" ? "npm latest" : "AGENTBOT_OMP";
	pinOmp(join(appDir, "package.json"), candidate);
	// Not `--production`: in Bun 1.4 it implies --frozen-lockfile, which refuses the changed pins.
	const result = await run([process.execPath, "install", "--omit=dev"], { cwd: appDir, timeoutMs: INSTALL_TIMEOUT_MS });
	if (result.exitCode === 0) return saveState(appDir, { pin, latest, candidate, reason: `${source} ${candidate}` });
	const reason = `${source} ${candidate} failed to install (exit ${result.exitCode}); fell back to the pin`;
	log("warn", "omp candidate did not install", { candidate, pin, exitCode: result.exitCode, output: tail(result.output) });
	await installPinned(appDir, run);
	return saveState(appDir, { pin, latest, candidate, reason });
}

/** Checks that the installed omp loads the app's entry modules and is the expected one, else reinstalls the pin. */
export async function verify(params: Params): Promise<BuildState & { installed: string }> {
	const { appDir } = params;
	const run = params.run ?? runCommand;
	const state = JSON.parse(readFileSync(join(appDir, SAVED_DIR, "state.json"), "utf8")) as BuildState;
	/** One line for the reason, plus the output tail for the log. */
	const smoke = async (): Promise<{ failure: string; output: string } | undefined> => {
		const result = await run([process.execPath, "-e", APP_SMOKE_SCRIPT], { cwd: appDir, timeoutMs: SMOKE_TIMEOUT_MS });
		if (result.exitCode === 0) return undefined;
		return { failure: `smoke import failed (exit ${result.exitCode}): ${result.output.trim().split("\n").at(-1) ?? ""}`, output: tail(result.output) };
	};

	let broken = await smoke();
	const installed = installedOmpVersion(appDir);
	if (installed !== state.pin) {
		if (!broken && installed !== state.candidate) broken = { failure: `installed ${OMP_PACKAGE} is ${installed}, expected ${state.candidate}`, output: "" };
		if (broken) {
			log("warn", "omp candidate does not load the app; falling back to the pin", { candidate: state.candidate, pin: state.pin, ...broken });
			state.reason = `${state.reason} does not load the app (${broken.failure}); fell back to the pin`;
			await installPinned(appDir, run);
			broken = await smoke();
		}
	}
	if (broken) throw new Error(`the pinned omp ${state.pin} does not load the app: ${broken.failure}\n${broken.output}`);

	const summary = { ...state, installed: installedOmpVersion(appDir) };
	log("info", "omp version chosen", { ...summary });
	rmSync(join(appDir, SAVED_DIR), { recursive: true, force: true });
	return summary;
}

if (import.meta.main) {
	const [command, doc] = process.argv.slice(2);
	const appDir = process.cwd();
	try {
		if (command === "install" && doc && existsSync(doc))
			await installLatest({ appDir, latestDoc: readFileSync(doc, "utf8"), want: process.env.AGENTBOT_OMP?.trim() || "latest" });
		else if (command === "verify") await verify({ appDir });
		else throw new Error("usage: bun scripts/omp-latest.ts install <npm-latest.json> | verify");
	} catch (err) {
		log("error", "omp install step failed", { error: errorMessage(err) });
		process.exit(1);
	}
}
