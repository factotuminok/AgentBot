import type { LogEntry } from "../shared/adminLogs";
import { type Cell, formatCount, formatTime, formatUsd } from "./live";

/*
 * Like `live.ts`: `logEntryView` renders on the server and is shipped verbatim (`Function.prototype.toString`)
 * to the log tail script, so it may only reference the `live.ts` formatters and runtime globals.
 */

/** A text block of a log entry; with a `label` it is collapsible (`<details>`), `open` deciding its initial state. */
export interface LogBlock {
	label?: string;
	text: string;
	open: boolean;
}

export interface LogEntryView {
	seq: number;
	time: string;
	/** Run id, for the run filter. */
	run: string;
	runLabel: string;
	/** Run label (linked to the GitHub issue when there is one), then the Discord thread link when known. */
	links: Cell[];
	type: string;
	head: string;
	error: boolean;
	blocks: LogBlock[];
}

export function logEntryView(entry: LogEntry, guildId: string | undefined): LogEntryView {
	// Prompts embed whole issues and tool output can be long: collapse past 1000 chars or 20 lines.
	const isLong = (text: string) => text.length > 1000 || text.split("\n").length > 20;
	const runLabel = entry.issue === undefined ? `${entry.kind} ${entry.repo}` : `${entry.kind} ${entry.repo}#${entry.issue}`;
	const links: Cell[] = [entry.issue === undefined ? runLabel : [runLabel, `https://github.com/${entry.repo}/issues/${entry.issue}`]];
	if (guildId && entry.thread) {
		links.push(["thread", `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(entry.thread)}`]);
	}
	let head = "";
	let error = false;
	const blocks: LogBlock[] = [];
	switch (entry.type) {
		case "prompt":
			blocks.push(
				isLong(entry.text)
					? { label: `prompt (${formatCount(entry.text.length)} chars)`, text: entry.text, open: false }
					: { text: entry.text, open: true },
			);
			break;
		case "steer":
		case "assistant":
			blocks.push({ text: entry.text, open: true });
			break;
		case "tool_start":
			head = entry.intent ? `${entry.tool} — ${entry.intent}` : entry.tool;
			blocks.push({ label: "arguments", text: entry.args, open: false });
			break;
		case "tool_end":
			head = entry.isError ? `${entry.tool} — error` : entry.tool;
			error = entry.isError;
			blocks.push({ label: `output (${formatCount(entry.text.length)} chars)`, text: entry.text, open: !isLong(entry.text) });
			break;
		case "run_end": {
			const { usage } = entry;
			const parts = [`cost ${formatUsd(usage.costUsd)}`, `tokens ${formatCount(usage.input)} in / ${formatCount(usage.output)} out`];
			if (entry.aborted) parts.push(`aborted: ${entry.aborted}`);
			if (entry.error) parts.push("failed");
			head = parts.join(" · ");
			error = Boolean(entry.error);
			if (entry.error) blocks.push({ text: entry.error, open: true });
			break;
		}
	}
	return { seq: entry.seq, time: formatTime(entry.ts), run: entry.run, runLabel, links, type: entry.type, head, error, blocks };
}
