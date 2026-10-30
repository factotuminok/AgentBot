/**
 * Spike S2 driver: stands in for DevForge's `runner.ts` (the IPC parent). Spawns the unchanged DevForge agent host
 * (`src/agent/host.ts`) as a child process with a JSON IPC channel, sends one `start` message by hand for a
 * plan-profile run, answers the host's requests and prints what comes back. Paths come from the environment so the
 * same driver runs with any run-local layout.
 */
import { join } from "node:path";
import type { ChildMessage, ParentMessage } from "./src/agent/protocol";

const env = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const runDir = env("S2_RUN_DIR");
const start: ParentMessage = {
	t: "start",
	runtime: {
		// Run-local auth store: a copy of agent.db holding one OAuth credential.
		agentDir: join(runDir, "omp-agent"),
		// Downloaded skills at a non-default path, as the only extension root.
		ompDir: env("S2_SKILLS_DIR"),
		providerKeys: {},
	},
	opts: {
		jobId: "s2-spike",
		cwd: join(runDir, "repo"),
		sessionDir: join(runDir, "sessions"),
		profile: "plan",
		modelPattern: env("S2_MODEL"),
		thinking: "low",
		prompt: [
			"This is a smoke test; be brief and do not plan more than two todo steps.",
			"1. Call web_search exactly once with the query `Bun JavaScript runtime latest release`.",
			"2. Read README.md in the current directory.",
			"Then call yield with: readmeTitle = the first heading of README.md, searchFact = one fact from the search results with its source URL, skills = the names of the skills listed in your system prompt.",
		].join("\n"),
		outputSchema: {
			type: "object",
			properties: {
				readmeTitle: { type: "string" },
				searchFact: { type: "string" },
				skills: { type: "array", items: { type: "string" } },
			},
			required: ["readmeTitle", "searchFact", "skills"],
			additionalProperties: false,
		},
		limits: { minutes: 5, costUsd: 0.5 },
		wantLoadout: true,
	},
};

const out = (tag: string, value: unknown) => console.log(`[driver] ${tag} ${JSON.stringify(value)}`);
const clip = (text: string, max = 600) => (text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text);

const proc = Bun.spawn({
	cmd: [process.execPath, join(import.meta.dir, "src/agent/host.ts")],
	cwd: import.meta.dir,
	env: { ...process.env, DEVFORGE_AGENT_RUN: "s2-marker" },
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
	serialization: "json",
	detached: true,
	ipc: raw => handle(raw as ChildMessage),
});

const reply = (id: number, ok: boolean, error?: string) =>
	proc.send((ok ? { t: "reply", id, ok: true } : { t: "reply", id, ok: false, error: error ?? "unsupported" }) satisfies ParentMessage);

let exitCode = 1;
function handle(message: ChildMessage): void {
	switch (message.t) {
		case "log":
			break; // the child already printed it to the inherited stdout
		case "progress":
			out("progress", { tool: message.tool, usage: message.usage, elapsedMs: message.elapsedMs });
			break;
		case "transcript": {
			const event = message.event as Record<string, unknown>;
			out("transcript", Object.fromEntries(Object.entries(event).map(([k, v]) => [k, typeof v === "string" ? clip(v) : v])));
			break;
		}
		case "session_file":
			out("session_file", message.path);
			reply(message.id, true);
			break;
		case "ui":
			out("ui", { method: message.method, args: message.args });
			if (message.method !== "notify") reply(message.id, false, "no human in the S2 spike");
			break;
		case "tool_call":
			reply(message.id, false, "no create_issue in the S2 spike");
			break;
		case "done":
			out("done", message.result);
			exitCode = 0;
			break;
		case "failed":
			out("failed", message);
			break;
		default:
			out(message.t, message);
	}
}

proc.send(start);
const code = await proc.exited;
out("host exited", { code, signal: proc.signalCode });
process.exit(exitCode);
