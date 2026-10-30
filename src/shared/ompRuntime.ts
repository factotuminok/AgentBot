import { mkdir } from "node:fs/promises";

/**
 * Packing and unpacking an omp runtime copy (architecture UPD-06, UPD-07): a gzipped tar made with the system `tar`
 * (in the image), streamed to and from disk, because a copy's `node_modules` is far too large to hold in memory.
 */

/** What a copy's archive holds, relative to its app tree: enough to run the agent host with the copy's omp. */
export const RUNTIME_ENTRIES = ["src", "package.json", "bun.lock", "node_modules"] as const;

async function tar(args: string[]): Promise<void> {
	// COPYFILE_DISABLE: macOS's bsdtar would otherwise add `._*` metadata files (development hosts only).
	const proc = Bun.spawn(["tar", ...args], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`tar ${args[0]} failed (exit ${exitCode}): ${stderr.trim().slice(-1000)}`);
}

/** Hex sha256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** Packs `RUNTIME_ENTRIES` of `appDir` into the gzipped tar `archive`; returns its hash and size. */
export async function packRuntime(appDir: string, archive: string): Promise<{ sha256: string; size: number }> {
	await tar(["-czf", archive, "-C", appDir, ...RUNTIME_ENTRIES]);
	return { sha256: await sha256File(archive), size: Bun.file(archive).size };
}

/** Unpacks a runtime archive into `dir` (created). */
export async function unpackRuntime(archive: string, dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await tar(["-xzf", archive, "-C", dir]);
}
