export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
	repo?: string;
	issue?: number;
	job?: string;
	run?: string;
	[key: string]: unknown;
}

/** The role this process runs as (OBS-02); set once by `cli.ts` before anything logs. */
let component = "agentbot";
let sink: ((line: string) => void) | undefined;
/** True while the sink runs, so `log()` calls made from inside it (the file store's prune and write-failure paths) don't recurse. */
let inSink = false;

export function setLogComponent(name: string): void {
	component = name;
}

/** Also send every log line (JSON, no trailing newline) to `sink`, e.g. the rolling process log file; `undefined` removes it. */
export function setLogSink(next: ((line: string) => void) | undefined): void {
	sink = next;
}

/** One JSON line per call on stdout: `{ts, level, msg, component, ...fields}`, then the same line to the sink. Never throws. */
export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
	const line: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, component };
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		line[key] = value instanceof Error ? value.message : value;
	}
	let text: string;
	try {
		text = JSON.stringify(line);
	} catch {
		text = JSON.stringify({ ts: line.ts, level, msg, component, logError: "fields not serialisable" });
	}
	try {
		process.stdout.write(`${text}\n`);
	} catch {
		// Logging never throws.
	}
	writeLogSink(text);
}

/** Sends an already-formatted log line to the sink only. */
export function writeLogSink(line: string): void {
	if (!sink || inSink) return;
	inSink = true;
	try {
		sink(line);
	} catch {
		// Logging never throws.
	} finally {
		inSink = false;
	}
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
