/**
 * Agent transcript events and their size limits (OBS-03). Workers apply the limits before sending `transcript`
 * and `log` messages (architecture RUN-16); the orchestrator's agent log applies them again on append.
 */

/** Tokens and cost consumed by one agent run (excluding the history of a resumed session, OBS-05). */
export interface RunUsage {
	costUsd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** What an agent run reports while it is in progress. */
export type TranscriptEvent =
	| { type: "prompt"; text: string }
	| { type: "steer"; text: string }
	| { type: "assistant"; text: string }
	| { type: "tool_start"; tool: string; intent?: string; args: string }
	| { type: "tool_end"; tool: string; isError: boolean; text: string }
	| { type: "run_end"; usage: RunUsage; aborted?: string; error?: string };

/** Field caps in characters: prompts embed whole issues; tool output can be megabytes. */
export const TRANSCRIPT_LIMITS: Readonly<Record<TranscriptEvent["type"], number>> = Object.freeze({
	prompt: 64 * 1024,
	steer: 16 * 1024,
	assistant: 64 * 1024,
	tool_start: 4 * 1024,
	tool_end: 8 * 1024,
	run_end: 4 * 1024,
});

/** Worker `log` lines are cut at this many characters before sending (RUN-16). */
export const LOG_LINE_LIMIT = 8 * 1024;

/** `text` cut to `limit` characters, ending with a marker giving the number of characters dropped. */
export function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}… [${text.length - limit} more chars truncated]`;
}

/** The event with its limited field (text, tool arguments or run error) truncated per `TRANSCRIPT_LIMITS`. */
export function truncateEvent(event: TranscriptEvent): TranscriptEvent {
	const limit = TRANSCRIPT_LIMITS[event.type];
	switch (event.type) {
		case "tool_start":
			return { ...event, args: truncate(event.args, limit) };
		case "run_end":
			return event.error ? { ...event, error: truncate(event.error, limit) } : event;
		default:
			return { ...event, text: truncate(event.text, limit) };
	}
}
