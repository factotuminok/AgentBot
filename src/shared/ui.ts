import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogSubmitResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent";

/**
 * UI contexts live in the main process (Discord, console) and, as a proxy over IPC, in the agent process. This module
 * holds what both sides share and has no Discord dependency, so the agent process never loads discord.js.
 */
export type HeadlessUI = ExtensionUIContext;

type HeadlessBase = Omit<ExtensionUIContext, "askDialog" | "select" | "input" | "editor" | "confirm" | "notify">;

/** No-op members shared by every headless UI context (Discord, console and the agent process's proxy). */
export function headlessUIBase(): HeadlessBase {
	return {
		timeoutStartsOnPresentation: true,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.reject(new Error("custom UI unsupported")),
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: undefined as never,
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "headless" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

/**
 * Tracks time spent waiting on a human. Nested waits (select → askDialog) count once,
 * and an in-progress wait is included so wall-clock checks during a wait exclude it.
 * Lives in the agent process, which owns the run's wall clock.
 */
export function createPauseClock(): { pausedMs(): number; during<T>(fn: () => Promise<T>): Promise<T> } {
	let total = 0;
	let depth = 0;
	let startedAt = 0;
	return {
		pausedMs: () => total + (depth > 0 ? Date.now() - startedAt : 0),
		async during(fn) {
			if (depth++ === 0) startedAt = Date.now();
			try {
				return await fn();
			} finally {
				if (--depth === 0) total += Date.now() - startedAt;
			}
		},
	};
}

export function abortError(): DOMException {
	return new DOMException("aborted", "AbortError");
}

/** `select` as a single-question ask dialog; resolves with the chosen label (or the custom answer). */
export async function selectViaAskDialog(
	askDialog: (questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions) => Promise<ExtensionAskDialogSubmitResult>,
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	const result = await askDialog(
		[
			{
				id: "select",
				question: title,
				options: options.map(option =>
					typeof option === "string" ? { label: option } : { label: option.label, description: option.description },
				),
			},
		],
		dialogOptions,
	);
	const answer = result.results[0];
	return answer?.selectedOptions[0] ?? answer?.customInput;
}
