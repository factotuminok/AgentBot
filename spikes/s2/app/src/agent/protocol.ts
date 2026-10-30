import type { ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import type { TranscriptEvent } from "../agentlog";
import type { RunUsage } from "../usage";
import type { Loadout } from "./loadout";
import type { AgentRuntime, RunAgentOptions, RunAgentResult } from "./runner";
import type { TodoItem } from "./todos";

/**
 * Messages between the main process (`runner.ts`) and an agent process (`host.ts`), one process per run, over Bun's
 * JSON IPC channel. Everything is plain JSON; messages arrive in the order they were sent, so the main process sees
 * the run's events in emission order. Requests carry a numeric `id` that the matching `reply` echoes; ids are
 * allocated by whoever sends the request.
 */

/** The `RunAgentOptions` that cross the boundary as data; the callbacks stay in the main process. */
export type StartOptions = Pick<
	RunAgentOptions,
	"jobId" | "cwd" | "sessionDir" | "resumeFile" | "profile" | "modelPattern" | "thinking" | "prompt" | "outputSchema" | "limits" | "omp"
> & {
	/** Repository the `create_issue` tool files into; present only when the run has that tool. */
	createIssueRepo?: string;
	/** Whether the main process wants the `loadout` message. */
	wantLoadout: boolean;
};

export type UiMethod = "askDialog" | "select" | "input" | "editor" | "confirm" | "notify";

/** The data members of `ExtensionUIDialogOptions`; its signal is replaced by `ui_cancel` and its callbacks are not forwarded. */
export type DialogData = Pick<
	ExtensionUIDialogOptions,
	"timeout" | "initialIndex" | "outline" | "helpText" | "selectionMarker" | "checkedIndices" | "markableCount" | "acceptImages"
>;

export type Reply = { t: "reply"; id: number } & ({ ok: true; value?: unknown } | { ok: false; error: string; aborted?: boolean });

export type ParentMessage =
	| { t: "start"; runtime: AgentRuntime; opts: StartOptions }
	| { t: "steer"; id: number; text: string }
	| { t: "abort"; id: number }
	/** Answers `ui`, `tool_call` and `session_file`. */
	| Reply;

export type ChildMessage =
	| { t: "progress"; tool?: string; intent?: string; usage: RunUsage; elapsedMs: number }
	| { t: "transcript"; event: TranscriptEvent }
	| { t: "todos"; todos: TodoItem[] }
	| { t: "loadout"; loadout: Loadout }
	| { t: "usage"; usage: RunUsage }
	/** Sent before the prompt; the session waits for the reply so a restart can always resume it (D-015). */
	| { t: "session_file"; id: number; path: string }
	/** The session accepts `steer` and `abort` from now on. */
	| { t: "registered" }
	| { t: "ui"; id: number; method: UiMethod; args: unknown[]; dialog?: DialogData }
	| { t: "ui_cancel"; id: number }
	| { t: "tool_call"; id: number; name: "create_issue"; params: { title: string; body: string } }
	/** Answers `steer` and `abort`. */
	| Reply
	/** A log line the agent process also printed to the shared stdout; the main process only adds it to its log sink. */
	| { t: "log"; line: string }
	| { t: "done"; result: RunAgentResult }
	| { t: "failed"; message: string; name: string };

/** Thrown when a run that must yield structured output ends without doing so; crosses the boundary by `name`. */
export class NoStructuredOutput extends Error {
	constructor(jobId: string) {
		super(`Agent finished without calling yield (job ${jobId})`);
		this.name = "NoStructuredOutput";
	}
}
