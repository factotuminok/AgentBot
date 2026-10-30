import { SECRET_NOT_SET, SECRET_SET, WORKSPACE_OMP, WORKSPACE_SETTINGS, type WorkspaceSchemas } from "../../shared/adminWorkspace";
import { REMOTE_SUFFIX } from "../../shared/workspaceSync";

/**
 * The workspace files the web process owns (WEB-25, WEB-31 layer 3). They never reach the orchestrator, and a local
 * edit is reverted at once: `.vscode/settings.json` must not gain terminal profiles or task settings.
 */

export const README_FILE = "README.md";
export const VSCODE_SETTINGS_FILE = ".vscode/settings.json";
/** Deleted as soon as they appear, so nothing can run a task or a debugger from the workspace (WEB-31 layer 3). */
export const FORBIDDEN_FILES = [".vscode/tasks.json", ".vscode/launch.json"];

export const README = `# AgentBot configuration

This folder is a copy of AgentBot's configuration. The orchestrator holds the real one; every file you save here is
sent to it within a second, checked with the same rules as the web pages, and applied only if it is valid.

| File | What it holds |
|---|---|
| \`${WORKSPACE_SETTINGS}\` | Every setting of the Settings page. Saving it applies the settings like a save on the Settings page. |
| \`${WORKSPACE_OMP}\` | omp setting overrides and MCP servers, as on the omp page. Runs that start afterwards use them. |
| \`skills/<name>/SKILL.md\` | A skill, with any supporting files in its folder (at most 5 MiB per folder, no symlinks). |
| \`agents/<name>.md\` | A task agent. |

Creating, changing or deleting a skill or agent file creates, changes or deletes that skill or agent; deleting a skill
folder deletes the skill. Sessions that start afterwards use the change.

## Secrets

Secrets and credentials never appear here. A stored value shows as \`"${SECRET_SET}"\`, a missing one as
\`"${SECRET_NOT_SET}"\`. Leave the placeholder as it is to keep the stored value. A real value in its place is rejected:
set secrets on the Settings page and credentials on the omp page. The admin account and model sign-ins are not here
either; they stay on their pages.

## Status bar

The AgentBot item in the status bar shows the sync state:

- **synced**: every saved file has reached the orchestrator.
- **saving**: a save is on its way.
- **rejected**: the orchestrator refused a file. Its errors are in the Problems panel, at the line when it is known.
  Nothing was changed, and your file keeps the edit: fix it and save again.
- **conflict**: the file was also changed elsewhere (the web pages, or another editor) since your copy was synced.
  The orchestrator's version is written next to it as \`<file>${REMOTE_SUFFIX}\`, and nothing is applied until you
  either save a merged file (it then goes in over that version, and the \`${REMOTE_SUFFIX}\` file is removed) or run
  **AgentBot: Accept server version**.
- **unavailable**: the orchestrator can't be reached, or the settings are locked until an admin logs in to the web
  UI. Saves wait on disk and are sent, in order, once it is back.

Changes made elsewhere reach this folder within a few seconds. They replace a file only if you haven't changed it
since it was last synced; otherwise you get a conflict.

## Commands

- **AgentBot: Reload from server** replaces a file, or every file, with the orchestrator's version. Local edits are
  dropped.
- **AgentBot: Accept server version** does the same for a conflicting file and removes its \`${REMOTE_SUFFIX}\` file.

## Files managed by AgentBot

This README and \`.vscode/settings.json\` (which gives VS Code the JSON Schemas of \`${WORKSPACE_SETTINGS}\` and
\`${WORKSPACE_OMP}\`) are rewritten whenever they change. \`.vscode/tasks.json\` and \`.vscode/launch.json\` are
deleted: tasks, debugging and terminals are disabled in this editor.
`;

/** `.vscode/settings.json`: the orchestrator's JSON Schemas inline (undefined until they are fetched). */
export function vscodeSettings(schemas: WorkspaceSchemas | undefined): string {
	const settings = {
		"json.schemas": schemas
			? [
					{ fileMatch: [`/${WORKSPACE_SETTINGS}`], schema: schemas.settings },
					{ fileMatch: [`/${WORKSPACE_OMP}`], schema: schemas.omp },
				]
			: [],
		// `.remote` files and `.vscode` stay visible: nothing the admin needs is hidden.
		"files.exclude": {},
		// Every save is applied (a settings.json save restarts the engine), so only explicit saves count.
		"files.autoSave": "off",
	};
	return `${JSON.stringify(settings, null, "\t")}\n`;
}
