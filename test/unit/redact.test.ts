import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { addLogSecret, log, REDACTED, removeLogSecret, setLogSink, writeRelayedLogLine } from "../../src/shared/log";

/** Security review F9: known secrets are masked in log lines and agent-log entries; relayed worker lines can't forge entries. */

const SECRET = "lease-token-0123456789abcdef";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
const lines: string[] = [];
const dirs: string[] = [];

afterEach(() => {
	setLogSink(undefined);
	removeLogSecret(SECRET);
	removeLogSecret(PEM);
	lines.length = 0;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("log redaction (F9)", () => {
	test("known secrets, and each line of a multi-line one, are masked until removed", () => {
		setLogSink(line => lines.push(line));
		addLogSecret(SECRET);
		addLogSecret(PEM);
		addLogSecret("short");
		log("info", "setup command finished", { tail: `cat token\n${SECRET}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7`, other: "short" });
		expect(lines[0]).not.toContain(SECRET);
		expect(lines[0]).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
		expect(lines[0]).toContain(REDACTED);
		expect(lines[0]).toContain('"other":"short"');
		removeLogSecret(SECRET);
		log("info", "after the run", { token: SECRET });
		expect(lines[1]).toContain(SECRET);
	});

	test("relayed lines must be one JSON object on one line; component and run are forced", () => {
		setLogSink(line => lines.push(line));
		addLogSecret(SECRET);
		const forced = { component: "agent-host", run: "r1" };
		expect(writeRelayedLogLine(JSON.stringify({ level: "info", msg: "hi", component: "orchestrator", run: "other", token: SECRET }), forced)).toBe(true);
		expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "hi", component: "agent-host", run: "r1", token: REDACTED });
		for (const bad of ['{"msg":"a"}\n{"msg":"forged","component":"orchestrator"}', "plain text", "[1,2]", "null", '{"msg":"cut…']) {
			expect(writeRelayedLogLine(bad, forced)).toBe(false);
		}
		expect(lines).toHaveLength(1);
	});

	test("agent-log entries are masked in the file and the tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agentbot-redact-"));
		dirs.push(dir);
		addLogSecret(SECRET);
		const agentLog = await openAgentLog({ dir, maxBytes: 1_000_000 });
		agentLog.append({ run: "job-1", kind: "implement", repo: "acme/widgets" }, { type: "tool_end", tool: "bash", text: `token=${SECRET}`, isError: false });
		expect(JSON.stringify(agentLog.recent(10))).not.toContain(SECRET);
		const file = await Bun.file(join(dir, readdirSync(dir)[0]!)).text();
		expect(file).not.toContain(SECRET);
		expect(file).toContain(REDACTED);
	});
});
