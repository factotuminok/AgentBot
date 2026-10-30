import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { emptyOmpConfig, type OmpConfig, parseOmpConfig } from "../../shared/ompconfig";
import { type CheckoutSpec, type CredentialSnapshot, type OmpRuntimeSpec, type RunSpec, runBranch } from "../../shared/wire";
import { isRepoName } from "../git/repos";
import type { RunRow } from "../store/db";
import { isSessionKey, sessionPath } from "../store/sessions";
import { type RunRequest, writesCode } from "./dispatcher";

/**
 * Builds the run spec a worker gets with `assign` (architecture §4.2). It is assembled at claim time, so the credentials
 * snapshot and the omp configuration are as fresh as possible (CRED-02, AGT-23, AGT-26), and it is never written to disk.
 */

/** Where the spec's parts come from; all read at claim time. */
export interface SpecSources {
	stateDir: string;
	/** The omp configuration as stored in the vault (validated here); undefined when none was saved. */
	ompConfig(): unknown;
	/** Provider API keys from the settings. */
	providerKeys(): Record<string, string>;
	/** Snapshot of the model sign-ins, refreshed first when they expire within 10 minutes (CRED-02). */
	credentials(): Promise<CredentialSnapshot[]>;
	/** Content hash of the skills and agents bundle (AGT-24). */
	skillsHash(): Promise<string>;
}

/** `<state>/sessions`, where run sessions are kept between runs (JOB-10). */
export function sessionDir(stateDir: string): string {
	return join(stateDir, "sessions");
}

/** Why `req` cannot run on a worker, or undefined. Every kind but `ask` checks out its repository (architecture §4.2). */
export function unrunnableReason(req: RunRequest): string | undefined {
	if (!isSessionKey(req.session)) return `invalid session key ${JSON.stringify(req.session)}`;
	if (req.kind === "ask") return req.checkout ? "ask runs have no repository checkout" : undefined;
	if (!req.checkout) return `${req.kind} runs need a repository checkout`;
	if (!isRepoName(req.checkout.repo)) return `invalid repository name ${JSON.stringify(req.checkout.repo)}`;
	if (writesCode(req.kind) && !req.checkout.issueBranch) return `${req.kind} runs need the issue branch`;
	return undefined;
}

/** Regular files directly in `dir`, by name; none when it does not exist. */
async function regularFiles(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		const stat = await lstat(join(dir, name)).catch(() => undefined);
		if (stat?.isFile()) files.push(name);
	}
	return files;
}

/** The run's omp configuration: validated, MCP servers only for the implement profile (AGT-22). */
function runOmpConfig(raw: unknown, req: RunRequest): OmpConfig {
	const config = raw === undefined ? emptyOmpConfig() : parseOmpConfig(raw);
	return req.profile === "implement" ? config : { ...config, mcpServers: {} };
}

/** The worker's checkout of a prepared run (RUN-17); `restore` when the run continues one whose refs are kept. */
function checkoutSpec(row: RunRow, req: RunRequest, restore: boolean): CheckoutSpec | undefined {
	const checkout = req.checkout;
	if (!checkout) return undefined;
	if (!row.repo || !row.start_ref || !row.start_commit) throw new Error(`run ${row.id} has no prepared checkout`);
	const code = writesCode(req.kind);
	return {
		repo: row.repo,
		startRef: row.start_ref,
		startCommit: row.start_commit,
		branch: runBranch(row.id),
		writesCode: code,
		...(code && checkout.leftoverMessage ? { leftoverMessage: checkout.leftoverMessage } : {}),
		restore: code && restore,
		...(row.setup_command ? { setupCommand: row.setup_command } : {}),
		identity: checkout.identity,
	};
}

/** `ompRuntime`: the active omp runtime copy the run is given (UPD-07), if any. */
export async function buildRunSpec(row: RunRow, req: RunRequest, src: SpecSources, restore: boolean, ompRuntime?: OmpRuntimeSpec): Promise<RunSpec> {
	const reason = unrunnableReason(req);
	if (reason) throw new Error(reason);
	const omp = runOmpConfig(src.ompConfig(), req);
	const checkout = checkoutSpec(row, req, restore);
	const [credentials, skillsHash] = await Promise.all([src.credentials(), src.skillsHash()]);
	return {
		runId: row.id,
		kind: req.kind,
		profile: req.profile,
		prompt: req.prompt,
		...(req.outputSchema ? { outputSchema: req.outputSchema } : {}),
		...(req.model ? { model: req.model } : {}),
		thinking: req.thinking,
		limits: req.limits,
		resumeSession: req.resume && existsSync(sessionPath(sessionDir(src.stateDir), req.session)),
		omp,
		skillsHash,
		providerKeys: src.providerKeys(),
		credentials,
		...(req.createIssue ? { createIssueRepo: req.createIssue.repo } : {}),
		...(req.scratchDir ? { scratch: { inputs: await regularFiles(join(req.scratchDir, "inputs")) } } : {}),
		...(checkout ? { checkout } : {}),
		...(ompRuntime ? { ompRuntime } : {}),
	};
}
