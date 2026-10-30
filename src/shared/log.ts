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
/**
 * Known secret values as they appear inside JSON strings (security review F9): masked in every log line, relayed worker
 * line and agent-log entry. Seeded by the components that hold them: internal tokens, live lease tokens, the settings'
 * Discord token, GitHub App key and provider keys, and current OAuth access tokens.
 */
const secrets = new Set<string>();
/** Shorter values are not masked: they would hit ordinary text. */
const MIN_SECRET_CHARS = 8;
export const REDACTED = "[redacted]";

/**
 * The forms of `value` to mask: the whole value and, for multi-line values (PEM keys), each long line, JSON-escaped.
 * PEM armor lines (`-----BEGIN …-----`) are public text that error messages quote, so they are not masked.
 */
function secretForms(value: string): string[] {
	const lines = value.includes("\n") ? value.split(/\r?\n/).map(line => line.trim()).filter(line => !line.startsWith("-----")) : [];
	return [value, ...lines].filter(form => form.length >= MIN_SECRET_CHARS).map(form => JSON.stringify(form).slice(1, -1));
}

/** Masks `value` in every log line and agent-log entry from now on (F9). Empty and short values are ignored. */
export function addLogSecret(value: string | undefined): void {
	if (value) for (const form of secretForms(value)) secrets.add(form);
}

/** Stops masking `value` (a lease token whose run ended). */
export function removeLogSecret(value: string | undefined): void {
	if (value) for (const form of secretForms(value)) secrets.delete(form);
}

/** `text` (a JSON line) with every known secret replaced by `REDACTED`. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const secret of secrets) if (out.includes(secret)) out = out.replaceAll(secret, REDACTED);
	return out;
}

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
	text = redactSecrets(text);
	try {
		process.stdout.write(`${text}\n`);
	} catch {
		// Logging never throws.
	}
	writeLogSink(text);
}

/**
 * A log line a worker relayed (F9): kept only if it is one JSON object on one line; its `component` (and `run`, when
 * given) are forced, it is re-serialised and redacted, then sent to the sink. False when it was dropped.
 */
export function writeRelayedLogLine(raw: string, forced: { component: string; run?: string }): boolean {
	if (/[\r\n]/.test(raw)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
	writeLogSink(redactSecrets(JSON.stringify({ ...parsed, ...forced })));
	return true;
}

/** Sends an already-formatted log line to the sink only. */
function writeLogSink(line: string): void {
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
