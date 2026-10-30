// The bundled AgentBot extension: the terminal/task/extension-install block (WEB-31 layer 1, spike S4) and the sync UI
// for the config workspace (WEB-28), driven by the status file the web process writes (src/shared/workspaceSync.ts).
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sync = require("./sync");

/** Workbench commands that open a terminal, run a task or debug, or install an extension; each is shadowed by a command of the same id. */
const SHADOWED = [
	"workbench.action.terminal.new",
	"workbench.action.terminal.newWithProfile",
	"workbench.action.terminal.newWithCwd",
	"workbench.action.terminal.newInActiveWorkspace",
	"workbench.action.terminal.newInNewWindow",
	"workbench.action.terminal.toggleTerminal",
	"workbench.action.terminal.focus",
	"workbench.action.terminal.split",
	"workbench.action.terminal.splitInActiveWorkspace",
	"workbench.action.terminal.createTerminalEditor",
	"workbench.action.terminal.createTerminalEditorSide",
	"workbench.action.terminal.createTerminalEditorSameGroup",
	"workbench.action.terminal.openNativeConsole",
	"workbench.action.terminal.selectDefaultShell",
	"workbench.action.terminal.runSelectedText",
	"workbench.action.terminal.runActiveFile",
	"workbench.action.terminal.sendSequence",
	"workbench.action.terminal.runRecentCommand",
	"workbench.action.createTerminalEditor",
	"workbench.action.tasks.runTask",
	"workbench.action.tasks.build",
	"workbench.action.tasks.test",
	"workbench.action.tasks.reRunTask",
	"workbench.action.tasks.rerunForActiveTerminal",
	"workbench.action.tasks.restartTask",
	"workbench.action.debug.start",
	"workbench.action.debug.run",
	"workbench.action.debug.selectandstart",
	"workbench.extensions.action.installVSIX",
	"workbench.extensions.command.installFromVSIX",
	"workbench.extensions.installExtension",
	"workbench.extensions.action.installExtensionFromLocation",
	"workbench.extensions.action.disableAll",
	"workbench.extensions.action.disableAllWorkspace",
	"workbench.action.reloadWindowWithExtensionsDisabled",
	"extension.bisect.start",
	"terminal.focus",
];
/** The workbench registers some commands late (the Extensions view's on first open); re-registering keeps the shadows on top (S4 finding 2). */
const SHADOW_INTERVAL_MS = 5000;
const STATUS_POLL_MS = 500;
const SEEN_NOTICES_FILE = "seen-notices.json";

let channel;

/** One JSON line per event in the extension's log (Output › AgentBot, and its file under code-server's logs dir). */
function record(event, fields) {
	channel?.info(JSON.stringify({ ts: new Date().toISOString(), component: "agentbot-vscode", event, ...fields }));
}

function blocked(what) {
	record("blocked", { what });
	void vscode.window.showWarningMessage(`AgentBot: ${what} is disabled in this editor.`);
}

/** Shadowed ids: the fixed list plus every terminal and task command the workbench has registered. */
async function shadowIds() {
	const all = await vscode.commands.getCommands(false);
	const dynamic = all.filter(id => /^workbench\.action\.(terminal|tasks)\./.test(id));
	return [...new Set([...SHADOWED, ...dynamic])];
}

/** The workbench runs a command's most recent registration, so the shadows are re-registered periodically to stay last. */
function startShadowing(context) {
	let current = [];
	let firstRound = true;
	const round = async () => {
		const ids = await shadowIds();
		for (const d of current) d.dispose();
		current = [];
		const failed = [];
		for (const id of ids) {
			try {
				current.push(vscode.commands.registerCommand(id, () => blocked(id)));
			} catch (err) {
				failed.push({ id, error: String(err?.message ?? err) });
			}
		}
		if (firstRound || failed.length) record("shadowed", { count: current.length, failed });
		firstRound = false;
	};
	void round();
	const timer = setInterval(() => void round(), SHADOW_INTERVAL_MS);
	context.subscriptions.push({
		dispose: () => {
			clearInterval(timer);
			for (const d of current) d.dispose();
		},
	});
}

function startLockdown(context) {
	startShadowing(context);
	context.subscriptions.push(vscode.commands.registerCommand("agentbot.terminalDisabled", () => blocked("terminal keybinding")));
	const closeTerminal = (terminal, when) => {
		record("terminal-closed", { when, name: terminal.name });
		terminal.dispose();
	};
	for (const terminal of vscode.window.terminals) closeTerminal(terminal, "at-activation");
	context.subscriptions.push(
		vscode.window.onDidOpenTerminal(t => closeTerminal(t, "on-open")),
		vscode.tasks.onDidStartTask(e => {
			record("task-terminated", { name: e.execution.task.name, source: e.execution.task.source });
			e.execution.terminate();
		}),
		vscode.tasks.onDidStartTaskProcess(e => record("task-process-started", { name: e.execution.task.name, pid: e.processId })),
		vscode.debug.onDidStartDebugSession(s => {
			record("debug-stopped", { name: s.name, type: s.type });
			void vscode.debug.stopDebugging(s);
		}),
	);
}

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** Status bar, Problems panel and one-off notices from `status.json` (WEB-28). */
function startStatus(context, paths) {
	const item = vscode.window.createStatusBarItem("agentbot.sync", vscode.StatusBarAlignment.Left, 100);
	item.name = "AgentBot sync";
	item.command = "workbench.actions.view.problems";
	item.show();
	const diagnostics = vscode.languages.createDiagnosticCollection("agentbot");
	context.subscriptions.push(item, diagnostics);

	// Seen notice ids survive window reloads and code-server restarts; only ids still in the status file are kept.
	const seenFile = path.join(context.globalStorageUri.fsPath, SEEN_NOTICES_FILE);
	let seen = new Set();
	try {
		seen = new Set(JSON.parse(readText(seenFile) ?? "[]"));
	} catch {}

	let last;
	const refresh = () => {
		const text = readText(paths.status);
		if (text === last) return;
		last = text;
		const status = sync.parseStatus(text);
		const view = sync.statusView(status);
		item.text = view.text;
		item.tooltip = view.tooltip;
		item.backgroundColor = view.tone ? new vscode.ThemeColor(`statusBarItem.${view.tone}Background`) : undefined;

		diagnostics.clear();
		for (const [file, entries] of sync.problemsByFile(status)) {
			diagnostics.set(
				vscode.Uri.file(path.join(paths.workspace, file)),
				entries.map(e => {
					const d = new vscode.Diagnostic(
						new vscode.Range(e.line, 0, e.line, Number.MAX_SAFE_INTEGER),
						e.message,
						e.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
					);
					d.source = "AgentBot";
					return d;
				}),
			);
		}

		const fresh = sync.unseenNotices(status, seen);
		if (!status || !fresh.length) return;
		for (const notice of fresh) {
			const show =
				notice.level === "error"
					? vscode.window.showErrorMessage
					: notice.level === "warning"
						? vscode.window.showWarningMessage
						: vscode.window.showInformationMessage;
			void show(`AgentBot: ${notice.text}`);
		}
		seen = new Set(status.notices.map(n => n.id));
		try {
			fs.mkdirSync(path.dirname(seenFile), { recursive: true });
			fs.writeFileSync(seenFile, JSON.stringify([...seen]));
		} catch (err) {
			record("seen-notices-write-failed", { error: String(err?.message ?? err) });
		}
	};
	refresh();
	// Polling, not fs.watch: the file may not exist yet and is replaced by rename on every write.
	const timer = setInterval(refresh, STATUS_POLL_MS);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
	return () => sync.parseStatus(readText(paths.status));
}

/** Hands a command to the web process, which consumes it within 1 s; written under a temp name so it never reads half a file. */
function sendCommand(paths, command, file) {
	const { name, body } = sync.commandFile(command, file);
	fs.mkdirSync(paths.commands, { recursive: true });
	const temp = path.join(paths.commands, `.${name}.tmp`);
	fs.writeFileSync(temp, body);
	fs.renameSync(temp, path.join(paths.commands, name));
	record("command", { command, path: file });
}

/** Workspace-relative path of the active editor's file (`.remote` mapped to its original), if it is in the workspace. */
function activeFile(paths) {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === "file" ? sync.workspacePath(paths.workspace, uri.fsPath) : undefined;
}

function registerCommands(context, paths, currentStatus) {
	const run = (command, file, done) => {
		try {
			sendCommand(paths, command, file);
			void vscode.window.showInformationMessage(`AgentBot: ${done}`);
		} catch (err) {
			void vscode.window.showErrorMessage(`AgentBot: the command could not be sent: ${err?.message ?? err}`);
		}
	};
	context.subscriptions.push(
		vscode.commands.registerCommand("agentbot.reloadFromServer", async () => {
			const file = activeFile(paths);
			const thisFile = file && `Reload ${file}`;
			const all = "Reload all files";
			const choice = await vscode.window.showWarningMessage(
				"Replace local files with the orchestrator's version? Local edits that were not applied are lost.",
				{ modal: true },
				...(thisFile ? [thisFile, all] : [all]),
			);
			if (choice === all) run("reload", undefined, "reloading every file from the server.");
			else if (choice && choice === thisFile) run("reload", file, `reloading ${file} from the server.`);
		}),
		vscode.commands.registerCommand("agentbot.acceptServerVersion", () => {
			const conflicts = currentStatus()?.conflicts ?? [];
			const file = activeFile(paths);
			if (file === undefined) {
				if (!conflicts.length) void vscode.window.showInformationMessage("AgentBot: there are no conflicts.");
				else run("accept", undefined, `accepting the server version of ${conflicts.join(", ")}.`);
				return;
			}
			if (!conflicts.includes(file)) {
				void vscode.window.showInformationMessage(`AgentBot: ${file} has no conflict.`);
				return;
			}
			run("accept", file, `accepting the server version of ${file}.`);
		}),
	);
}

function activate(context) {
	channel = vscode.window.createOutputChannel("AgentBot", { log: true });
	context.subscriptions.push(channel);
	record("activated", {});
	startLockdown(context);
	const paths = sync.syncPaths(process.env.AGENTBOT_HOME || os.homedir());
	registerCommands(context, paths, startStatus(context, paths));
}

function deactivate() {}

module.exports = { activate, deactivate };
