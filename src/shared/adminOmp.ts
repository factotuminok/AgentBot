/**
 * Admin API for the omp configuration (AGT-20 to AGT-23), under `/internal/admin`. The configuration lives in the
 * vault; credential settings and MCP env/header values are write-only and never leave the orchestrator.
 *
 * - `GET /omp` → {@link OmpView} (409 while the vault is locked)
 * - `PUT /omp` {@link OmpSaveRequest} → `{ ok: true }` (400 with omp's parser message; 409 while locked)
 * - `POST /omp/mcp-tests` {@link McpTestRequest} → {@link McpTestState}: tests the saved server on a worker (AGT-21)
 * - `GET /omp/mcp-tests/<id>` → {@link McpTestState} (404 once expired)
 * - `POST /omp/update-check` → {@link OmpUpdateView}: asks the npm registry now (UPD-02, the page's "Check now")
 */

export type McpTransport = "stdio" | "http" | "sse";
export const MCP_TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];

/** One registered omp setting, for the reference and the override editor. */
export interface OmpSettingInfo {
	id: string;
	type: "boolean" | "number" | "string" | "enum" | "array" | "record";
	default: unknown;
	enumValues?: readonly string[];
	label?: string;
	description?: string;
	/** Write-only: a stored value is never sent back. */
	credential: boolean;
	/** Set when AgentBot pins this setting: why. */
	locked?: string;
}

/** A setting AgentBot pins (AGT-20): shown, never editable. */
export interface PinnedSetting {
	id: string;
	value: unknown;
	reason: string;
}

/** One override. Credential values are never carried: `value` is "" and `credentialSet` says whether one is stored. */
export interface SettingRow {
	id: string;
	/** Form text: JSON for arrays and records, plain text otherwise. */
	value: string;
	credentialSet: boolean;
}

/** An env var or header; the value is write-only, so only whether one is stored. */
export interface SecretKeyRow {
	key: string;
	set: boolean;
}

/** One MCP server as the form shows it. */
export interface McpRow {
	name: string;
	/** Stored under this name: the name is read-only (rename = delete + add) and the server can be tested. */
	existing: boolean;
	type: McpTransport;
	enabled: boolean;
	instructions: boolean;
	timeout: string;
	command: string;
	/** One argument per line. */
	args: string;
	cwd: string;
	url: string;
	env: SecretKeyRow[];
	headers: SecretKeyRow[];
}

export interface OmpView {
	/** omp versions and in-place worker updates (UPD-02 to UPD-10). */
	update: OmpUpdateView;
	/** Every registered omp setting, in omp's display order. */
	reference: OmpSettingInfo[];
	pinned: PinnedSetting[];
	settings: SettingRow[];
	servers: McpRow[];
	/** The stored configuration no longer validates (e.g. omp dropped a setting); what is shown is what still parses. */
	storedError?: string;
}

/** A key/value row as submitted; a blank `value` keeps the stored one. */
export interface SecretKeyInput {
	key: string;
	value: string;
}

export interface McpServerInput {
	name: string;
	type: McpTransport;
	enabled: boolean;
	instructions: boolean;
	/** Milliseconds as typed; "" for omp's default. */
	timeout: string;
	command: string;
	args: string[];
	cwd: string;
	url: string;
	env: SecretKeyInput[];
	headers: SecretKeyInput[];
}

/** The whole configuration as submitted: replaces the stored one (blank write-only values keep what is stored). */
export interface OmpSaveRequest {
	/** Setting id → form text, parsed by omp's own parser. A blank credential setting keeps its stored value. */
	settings: { id: string; value: string }[];
	servers: McpServerInput[];
}

export interface McpTestRequest {
	/** A saved server. */
	name: string;
}

/** `waiting` until the dispatcher reports the test queued for a worker; then until a result arrives (AGT-21). */
export interface McpTestState {
	id: string;
	name: string;
	status: "starting" | "waiting" | "running" | "done";
	result?: { ok: boolean; tools: string[]; error?: string };
	startedAt: string;
}

/** One in-place update attempt (UPD-03, UPD-08): an approval and what came of it. */
export interface OmpAttempt {
	version: string;
	/** The omp workers used when it was approved. */
	from: string;
	/** Who approved it, e.g. `@alice`. */
	by: string;
	/** `failed` covers both a failed install and a copy that failed its canary run (UPD-08). */
	outcome: "installing" | "installed" | "failed";
	error?: string;
	/** Tail of the install output, or of the failed agent host's stderr. */
	log?: string;
	/** The runtime copy it made. */
	copy?: string;
	at: string;
	/** The outcome was posted in Discord. */
	reported?: boolean;
}

/** omp version and update status for the omp page (UPD-10). */
export interface OmpUpdateView {
	/** The image's omp: the orchestrator's, and the workers' when no copy is active. */
	image: string;
	/** The active runtime copy new workers use (UPD-07); absent when workers use the image's omp. */
	active?: { copy: string; version: string; size: number; createdAt: string; by: string };
	/** npm's latest, as of `checkedAt`. */
	latest?: string;
	checkedAt?: string;
	/** The last check failed with this (UPD-02). */
	checkError?: string;
	/** `latest` when it is newer than the omp new workers would use. */
	available?: string;
	/** False outside the container image (no `AGENTBOT_OMP_RUNTIME_DIR`): updates are refused (UPD-05). */
	supported: boolean;
	unsupportedReason?: string;
	installing?: { version: string; by: string; startedAt: string };
	lastAttempt?: OmpAttempt;
}
