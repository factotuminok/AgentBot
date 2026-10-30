// Pure parts of the WEB-28 sync UI, kept free of the `vscode` module so they can be unit-tested. The shapes mirror
// src/shared/workspaceSync.ts (the file contract with the web process); keep the two in step.
"use strict";
const path = require("node:path");

const WORKSPACE_DIR = "config-workspace";
const SYNC_DIR = path.join(".agentbot", "sync");
const SYNC_STATUS_FILE = "status.json";
const SYNC_COMMANDS_DIR = "commands";
const REMOTE_SUFFIX = ".remote";

/** Status bar text and codicon per state; `missing` is the extension's own: no status file yet. */
const STATE_TEXT = {
	synced: "$(check) AgentBot: synced",
	saving: "$(sync~spin) AgentBot: saving",
	rejected: "$(error) AgentBot: rejected",
	conflict: "$(warning) AgentBot: conflict",
	unavailable: "$(debug-disconnect) AgentBot: orchestrator unavailable",
	missing: "$(debug-disconnect) AgentBot: not syncing",
};

/** Workspace, status file and commands dir under the web home (`AGENTBOT_HOME`, else the user's home). */
function syncPaths(home) {
	const syncDir = path.join(home, SYNC_DIR);
	return {
		workspace: path.join(home, WORKSPACE_DIR),
		status: path.join(syncDir, SYNC_STATUS_FILE),
		commands: path.join(syncDir, SYNC_COMMANDS_DIR),
	};
}

/** The parsed status file, or undefined when it is missing or not a status (mid-write files never appear: web renames). */
function parseStatus(text) {
	if (text === undefined) return undefined;
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || !(value.state in STATE_TEXT) || value.state === "missing") return undefined;
	return {
		state: value.state,
		message: typeof value.message === "string" ? value.message : undefined,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		problems: Array.isArray(value.problems) ? value.problems.filter(p => p && typeof p.path === "string" && typeof p.message === "string") : [],
		conflicts: Array.isArray(value.conflicts) ? value.conflicts.filter(c => typeof c === "string") : [],
		notices: Array.isArray(value.notices) ? value.notices.filter(n => n && typeof n.id === "string" && typeof n.text === "string") : [],
	};
}

/** Status bar item: text, tooltip lines, and whether it shows as an error or a warning. */
function statusView(status) {
	if (!status) return { text: STATE_TEXT.missing, tooltip: "The web process has not written a sync status yet.", tone: "warning" };
	const lines = [];
	if (status.message) lines.push(status.message);
	if (status.problems.length) lines.push(`${status.problems.length} validation error${status.problems.length === 1 ? "" : "s"}; see the Problems panel.`);
	for (const file of status.conflicts) lines.push(`Conflict: ${file} (the orchestrator's version is in ${file}${REMOTE_SUFFIX}).`);
	if (status.updatedAt) lines.push(`Updated ${status.updatedAt}`);
	const tone = status.state === "rejected" || status.state === "unavailable" ? "error" : status.state === "conflict" ? "warning" : undefined;
	return { text: STATE_TEXT[status.state], tooltip: lines.join("\n"), tone };
}

/**
 * Problems panel entries per workspace-relative file: each validation error (0-based line, line 1 when unknown), and a
 * warning on each conflicting file pointing at its `.remote`.
 */
function problemsByFile(status) {
	const files = new Map();
	const add = (file, entry) => {
		const list = files.get(file) ?? [];
		list.push(entry);
		files.set(file, list);
	};
	if (!status) return files;
	for (const p of status.problems) {
		const line = Number.isInteger(p.line) && p.line > 0 ? p.line - 1 : 0;
		add(p.path, { line, message: p.message, severity: "error" });
	}
	for (const file of status.conflicts) {
		add(file, {
			line: 0,
			message: `The orchestrator changed this file too; its version is in ${path.basename(file)}${REMOTE_SUFFIX}. Save a merged file, or run "AgentBot: Accept server version".`,
			severity: "warning",
		});
	}
	return files;
}

/** Notices not shown yet, oldest first. */
function unseenNotices(status, seen) {
	return status ? status.notices.filter(n => !seen.has(n.id)) : [];
}

/**
 * The workspace-relative path for a file in the editor (`.remote` maps back to its original), or undefined when the file
 * is outside the workspace.
 */
function workspacePath(workspace, file) {
	const rel = path.relative(workspace, file);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	const posix = rel.split(path.sep).join("/");
	return posix.endsWith(REMOTE_SUFFIX) ? posix.slice(0, -REMOTE_SUFFIX.length) : posix;
}

/** File name and body of a command for the web process; the name is unique and sorts by time. */
function commandFile(command, file, now = Date.now(), nonce = Math.random().toString(36).slice(2, 10)) {
	const body = file === undefined ? { command } : { command, path: file };
	return { name: `${now}-${nonce}.json`, body: `${JSON.stringify(body)}\n` };
}

module.exports = { REMOTE_SUFFIX, syncPaths, parseStatus, statusView, problemsByFile, unseenNotices, workspacePath, commandFile };
