// Spike S4: close every way to a shell that an extension can reach (WEB-31 layer 1).
"use strict";
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOG_FILE = path.join(os.homedir(), "agentbot-lockdown.log");

/** Workbench commands that open a terminal; each is shadowed by a command of the same id. */
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

let channel;

function record(event, fields) {
	const line = JSON.stringify({ ts: new Date().toISOString(), component: "agentbot-lockdown", event, ...fields });
	try {
		fs.appendFileSync(LOG_FILE, `${line}\n`);
	} catch {}
	channel?.info(line);
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

/**
 * The workbench resolves a command id to its most recent registration, so ours wins only if it comes after the
 * workbench's. Some workbench contributions register late (the Extensions view's actions on first open), so the
 * shadows are re-registered periodically to stay on top.
 */
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
				failed.push({ id, error: String(err && err.message ? err.message : err) });
			}
		}
		if (firstRound || failed.length) record("shadowed", { count: current.length, failed });
		firstRound = false;
	};
	void round();
	const timer = setInterval(() => void round(), 5000);
	context.subscriptions.push({ dispose: () => { clearInterval(timer); for (const d of current) d.dispose(); } });
}

function activate(context) {
	channel = vscode.window.createOutputChannel("AgentBot lock-down", { log: true });
	context.subscriptions.push(channel);
	record("activated", {});

	startShadowing(context);
	context.subscriptions.push(vscode.commands.registerCommand("agentbot.terminalDisabled", () => blocked("terminal keybinding")));

	const closeTerminal = (terminal, when) => {
		record("terminal-closed", { when, name: terminal.name, creationOptions: terminal.creationOptions });
		terminal.dispose();
	};
	for (const terminal of vscode.window.terminals) closeTerminal(terminal, "at-activation");
	context.subscriptions.push(vscode.window.onDidOpenTerminal(t => closeTerminal(t, "on-open")));

	context.subscriptions.push(
		vscode.tasks.onDidStartTask(e => {
			record("task-terminated", { name: e.execution.task.name, source: e.execution.task.source });
			e.execution.terminate();
		}),
		vscode.tasks.onDidStartTaskProcess(e => {
			record("task-process-started", { name: e.execution.task.name, pid: e.processId });
		}),
		vscode.debug.onDidStartDebugSession(s => {
			record("debug-stopped", { name: s.name, type: s.type });
			void vscode.debug.stopDebugging(s);
		}),
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
