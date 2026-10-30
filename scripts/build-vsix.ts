/**
 * Packages the bundled VS Code extension (`vscode/extension`, plain JavaScript, no build step) into `dist/agentbot.vsix`,
 * which the image installs into its root-owned extensions directory (WEB-14). Usage: `bun run build:vsix`.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const VSCE = "@vscode/vsce@4.1.0";
const root = join(import.meta.dir, "..");
const out = join(root, "dist", "agentbot.vsix");

await mkdir(join(root, "dist"), { recursive: true });
// The manifest has no repository or license file and activates on `*` (it must run before anything else, WEB-31).
const proc = Bun.spawn(
	[process.execPath, "x", VSCE, "package", "--allow-missing-repository", "--skip-license", "--allow-star-activation", "--no-dependencies", "--out", out],
	{ cwd: join(root, "vscode", "extension"), stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
