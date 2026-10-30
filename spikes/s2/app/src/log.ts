export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
	repo?: string;
	issue?: number;
	job?: string;
	[key: string]: unknown;
}

let sink: ((line: string) => void) | undefined;
/** True while the sink runs, so `log()` calls made from inside it (the file store's prune and write-failure paths) don't recurse. */
let inSink = false;

/** Also send every log line (JSON, no trailing newline) to `sink`, e.g. the rolling process log file; `undefined` removes it. */
export function setLogSink(next: ((line: string) => void) | undefined): void {
	sink = next;
}

/** One JSON line per call on stdout: `{ts, level, msg, ...fields}`, then the same line to the sink. */
export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
	const line: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		line[key] = value instanceof Error ? value.message : value;
	}
	const text = JSON.stringify(line);
	process.stdout.write(`${text}\n`);
	writeLogSink(text);
}

/** Sends an already-formatted log line (e.g. one an agent process printed to its own stdout) to the sink only. */
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
