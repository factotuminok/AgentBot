import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseCandidate, installLatest, verify } from "../../scripts/omp-latest";
import { installedOmpVersion, OMP_PACKAGE, type RunCommand } from "../../src/shared/ompPins";
import { setLogSink } from "../../src/shared/log";

const PIN = "18.12.1";
const dirs: string[] = [];
const logs: string[] = [];

function tempApp(): string {
	const appDir = mkdtempSync(join(tmpdir(), "agentbot-omp-latest-"));
	dirs.push(appDir);
	writeFileSync(join(appDir, "package.json"), JSON.stringify({ dependencies: { [OMP_PACKAGE]: PIN, "@oh-my-pi/pi-utils": PIN } }));
	writeFileSync(join(appDir, "bun.lock"), "pinned lock");
	return appDir;
}

/** A fake `bun`: `install` "installs" the omp `package.json` asks for; `-e` is the smoke import. */
function fakeBun(opts: { failInstall?: string[]; failSmoke?: string[] } = {}): { run: RunCommand; calls: string[][] } {
	const calls: string[][] = [];
	const run: RunCommand = async (cmd, { cwd }) => {
		calls.push(cmd.slice(1));
		if (cmd[1] === "install") {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> };
			const version = pkg.dependencies[OMP_PACKAGE]!;
			if (opts.failInstall?.includes(version)) return { exitCode: 1, output: `error: No version matching "${version}"` };
			mkdirSync(join(cwd, "node_modules", OMP_PACKAGE), { recursive: true });
			writeFileSync(join(cwd, "node_modules", OMP_PACKAGE, "package.json"), JSON.stringify({ version }));
			return { exitCode: 0, output: "" };
		}
		const broken = opts.failSmoke?.includes(installedOmpVersion(cwd));
		return broken ? { exitCode: 1, output: "SyntaxError: Export named 'Settings' not found" } : { exitCode: 0, output: "" };
	};
	return { run, calls };
}

function chosen(): Record<string, unknown> {
	const line = logs.map(l => JSON.parse(l) as Record<string, unknown>).find(l => l.msg === "omp version chosen");
	if (!line) throw new Error("no 'omp version chosen' line");
	return line;
}

afterEach(() => {
	setLogSink(undefined);
	logs.length = 0;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function captureLogs(): void {
	setLogSink(line => logs.push(line));
}

describe("omp-latest (UPD-01)", () => {
	test("chooses npm's latest only when it is newer than the pin; AGENTBOT_OMP forces the pin or a version", () => {
		expect(chooseCandidate("latest", PIN, "18.13.0")).toEqual({ candidate: "18.13.0" });
		expect(chooseCandidate("latest", PIN, PIN)).toEqual({ reason: `npm latest ${PIN} is not newer than the pin` });
		expect(chooseCandidate("latest", PIN, undefined)).toEqual({ reason: "the npm registry document has no usable version" });
		expect(chooseCandidate("pin", PIN, "18.13.0")).toEqual({ reason: "AGENTBOT_OMP=pin" });
		expect(chooseCandidate("99.0.0", PIN, undefined)).toEqual({ candidate: "99.0.0" });
		expect(() => chooseCandidate("newest", PIN, undefined)).toThrow("AGENTBOT_OMP must be latest, pin or an exact version");
	});

	test("installs and keeps the latest when it loads the app", async () => {
		captureLogs();
		const appDir = tempApp();
		const { run } = fakeBun();
		await installLatest({ appDir, latestDoc: JSON.stringify({ version: "18.13.0" }), want: "latest", run });
		const summary = await verify({ appDir, run });
		expect(summary).toMatchObject({ installed: "18.13.0", pin: PIN, latest: "18.13.0", reason: "npm latest 18.13.0" });
		expect(chosen()).toMatchObject({ installed: "18.13.0", reason: "npm latest 18.13.0" });
		expect(existsSync(join(appDir, ".omp-pinned"))).toBe(false);
	});

	test("falls back to the pin when the latest does not install", async () => {
		captureLogs();
		const appDir = tempApp();
		const { run, calls } = fakeBun({ failInstall: ["99.0.0"] });
		await installLatest({ appDir, latestDoc: "{}", want: "99.0.0", run });
		// The pin comes back from the saved lockfile, installed frozen.
		expect(calls.at(-1)).toEqual(["install", "--frozen-lockfile", "--production"]);
		expect(readFileSync(join(appDir, "bun.lock"), "utf8")).toBe("pinned lock");
		const summary = await verify({ appDir, run });
		expect(summary.installed).toBe(PIN);
		expect(summary.reason).toBe("AGENTBOT_OMP 99.0.0 failed to install (exit 1); fell back to the pin");
		expect(chosen()).toMatchObject({ installed: PIN, candidate: "99.0.0" });
	});

	test("falls back to the pin when the latest does not load the app's entry modules", async () => {
		captureLogs();
		const appDir = tempApp();
		const { run } = fakeBun({ failSmoke: ["18.13.0"] });
		await installLatest({ appDir, latestDoc: JSON.stringify({ version: "18.13.0" }), want: "latest", run });
		const summary = await verify({ appDir, run });
		expect(summary.reason).toBe("npm latest 18.13.0 does not load the app (smoke import failed (exit 1): SyntaxError: Export named 'Settings' not found); fell back to the pin");
		expect(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).dependencies[OMP_PACKAGE]).toBe(PIN);
	});

	test("AGENTBOT_OMP=pin installs the pin without trying the latest; a pin that does not load fails the build", async () => {
		captureLogs();
		const appDir = tempApp();
		const { run, calls } = fakeBun({ failSmoke: [PIN] });
		await installLatest({ appDir, latestDoc: JSON.stringify({ version: "18.13.0" }), want: "pin", run });
		expect(calls).toEqual([["install", "--frozen-lockfile", "--production"]]);
		await expect(verify({ appDir, run })).rejects.toThrow(`the pinned omp ${PIN} does not load the app`);
	});
});
