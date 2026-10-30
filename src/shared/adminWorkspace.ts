/**
 * The config workspace (requirements WEB-25 to WEB-29, architecture §2.5) as the orchestrator serves it to the web
 * process under `/internal/admin/workspace*`. The orchestrator is the source of truth; the web process keeps a synced
 * copy on its home volume for code-server.
 *
 * Files and paths (workspace-relative, `/`-separated):
 * - `settings.json`: every setting of requirements §13; secrets only as `SECRET_SET` / `SECRET_NOT_SET`.
 * - `omp.json`: `{ settings, mcpServers }`; credential settings and MCP env/header values only as placeholders.
 * - `skills/<name>/<path…>`: a skill folder; `SKILL.md` at its top.
 * - `agents/<name>.md`.
 * `README.md` and `.vscode/` are the web process's own files and never reach the orchestrator.
 *
 * Revisions: a file's revision is the sha256 (hex) of its content as the orchestrator renders it, so a change made
 * anywhere (the web pages, a skills upload, another editor) changes it without bookkeeping.
 *
 * Endpoints (web token; `X-Agentbot-Admin` names the admin for WEB-29 logging on writes):
 * - `GET /workspace` → `WorkspaceManifest`. Supports `If-None-Match` with the manifest `etag` → 304.
 * - `GET /workspace/file?path=<p>` → the file's bytes; header `X-Revision`. 404 when absent.
 * - `PUT /workspace/file?path=<p>&base=<revision>` with the raw bytes as body. `base` is the revision the local copy
 *   was based on; empty for a new file. → 200 `WorkspaceSaveResult` | 400 `WorkspaceRejection` | 409 `WorkspaceConflict`.
 * - `DELETE /workspace/file?path=<p>&base=<revision>` deletes a skill file, a whole skill folder (`skills/<name>/`, base
 *   ignored) or an agent. → 200 `WorkspaceSaveResult` (revision "") | 400 | 409. `settings.json`/`omp.json` can't be deleted (400).
 * - `GET /workspace/schemas` → `WorkspaceSchemas`.
 * While the vault is locked, `settings.json` and `omp.json` are left out of the manifest (`locked: true`) and writes to
 * them answer 409 `WorkspaceLocked`; skills and agents keep working.
 */

/** Placeholder for a stored secret / credential value. */
export const SECRET_SET = "<set>";
/** Placeholder for a secret / credential with no stored value. */
export const SECRET_NOT_SET = "<not set>";

/** WEB-26: a real value where only a placeholder may stand. */
export const SECRETS_ON_SETTINGS_PAGE = "Set secrets on the Settings page";
export const CREDENTIALS_ON_OMP_PAGE = "Set credentials on the omp page";

export const WORKSPACE_SETTINGS = "settings.json";
export const WORKSPACE_OMP = "omp.json";

export interface WorkspaceFile {
	path: string;
	revision: string;
	size: number;
}

export interface WorkspaceManifest {
	/** Changes whenever any file's revision, the file set or `locked` changes. */
	etag: string;
	/** Settings are locked (orchestrator restarted, nobody logged in): settings.json and omp.json are left out. */
	locked: boolean;
	files: WorkspaceFile[];
}

/** One validation error. `jsonPath` locates it inside settings.json/omp.json; `line` (1-based) inside a Markdown file. */
export interface WorkspaceProblem {
	message: string;
	jsonPath?: (string | number)[];
	line?: number;
}

export interface WorkspaceSaveResult {
	ok: true;
	/** The file's new revision ("" after a delete). */
	revision: string;
	/**
	 * True when the orchestrator stores the file differently from what was sent (settings.json and omp.json are
	 * re-rendered with defaults and masked secrets): the web process then fetches it and replaces its copy.
	 */
	rewritten: boolean;
	/** settings.json only: the engine after the apply, and warnings, as the Settings page shows them (WEB-28). */
	phase?: string;
	error?: string;
	warnings?: string[];
}

export interface WorkspaceRejection {
	ok: false;
	reason: "invalid";
	problems: WorkspaceProblem[];
}

export interface WorkspaceConflict {
	ok: false;
	reason: "conflict";
	/** The orchestrator's current revision ("" when the file no longer exists there). */
	revision: string;
}

export interface WorkspaceLocked {
	ok: false;
	reason: "locked";
	message: string;
}

export interface WorkspaceSchemas {
	/** JSON Schema (draft 2020-12) of settings.json, generated from the orchestrator's zod schemas. */
	settings: unknown;
	/** JSON Schema of omp.json: known omp settings with their types, and MCP servers. */
	omp: unknown;
}
