/**
 * The file contract between the web process's workspace sync and the bundled VS Code extension (WEB-28). Both run as
 * the `agentbot` user on the web home volume (`AGENTBOT_HOME`); the extension is plain JavaScript, so it mirrors these
 * shapes and must be kept in step with this file.
 *
 * Layout under `<home>/.agentbot/sync/` (`SYNC_DIR`):
 * - `status.json` (`SyncStatus`): written atomically (temp file + rename) by web on every change; the extension watches it.
 * - `commands/<id>.json` (`SyncCommand`): written by the extension; web consumes and deletes each one within 1 s.
 * - web's own files (sync state, queued saves) live next to these and are private to it.
 *
 * The workspace itself is `<home>/config-workspace` (`WORKSPACE_DIR`).
 */

export const WORKSPACE_DIR = "config-workspace";
export const SYNC_DIR = ".agentbot/sync";
export const SYNC_STATUS_FILE = "status.json";
export const SYNC_COMMANDS_DIR = "commands";
/** Suffix of the orchestrator's version written next to a conflicting file (WEB-27). */
export const REMOTE_SUFFIX = ".remote";

/** Status bar states (WEB-28). Precedence when several apply: unavailable > conflict > rejected > saving > synced. */
export type SyncState = "synced" | "saving" | "rejected" | "conflict" | "unavailable";

export interface SyncProblem {
	/** Workspace-relative path. */
	path: string;
	message: string;
	/** 1-based line when known. */
	line?: number;
}

export interface SyncNotice {
	/** Unique; the extension shows each notice once. */
	id: string;
	level: "info" | "warning" | "error";
	text: string;
}

export interface SyncStatus {
	state: SyncState;
	/** One-line detail for the status bar tooltip, e.g. why the orchestrator is unavailable. */
	message?: string;
	updatedAt: string;
	/** Every rejected file's errors (Problems panel); cleared for a file once it saves or is reloaded. */
	problems: SyncProblem[];
	/** Workspace-relative paths that have a `<path>.remote` waiting. */
	conflicts: string[];
	/** Recent one-off messages, newest last, at most 20: settings apply results, deleted `.vscode/tasks.json`, … */
	notices: SyncNotice[];
}

export interface SyncCommand {
	/** "reload": replace the local file (or every file, without `path`) with the orchestrator's version, dropping local edits. "accept": the same for a conflicting file, also deleting its `.remote`. */
	command: "reload" | "accept";
	/** Workspace-relative path; absent = every file (reload) or every conflict (accept). */
	path?: string;
}
