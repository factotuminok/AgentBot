/**
 * Packages the bundled VS Code extension (`vscode/extension`, plain JavaScript, no build step) into `dist/agentbot.vsix`,
 * which the image installs into its root-owned extensions directory (WEB-14). Usage: `bun run build:vsix`.
 * The packager comes from `scripts/vsix/` with its own lockfile, so image builds don't resolve npm's latest packages.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tools = join(import.meta.dir, "vsix");
const out = join(root, "dist", "agentbot.vsix");

const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], { cwd: tools, stdout: "inherit", stderr: "inherit" });
if ((await install.exited) !== 0) process.exit(1);
await mkdir(join(root, "dist"), { recursive: true });
// The manifest has no repository or license file and activates on `*` (it must run before anything else, WEB-31).
const proc = Bun.spawn(
	[join(tools, "node_modules", ".bin", "vsce"), "package", "--allow-missing-repository", "--skip-license", "--allow-star-activation", "--no-dependencies", "--out", out],
	{ cwd: join(root, "vscode", "extension"), stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
