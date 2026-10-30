import type { AgentProfile } from "./agent";
import type { OmpConfig } from "./ompconfig";
import type { ChildMessage, ParentMessage } from "./protocol";

/**
 * Worker ↔ orchestrator run protocol (architecture §4.2): one WebSocket per worker at `/internal/worker`, authenticated
 * with the worker token, carrying JSON messages of two kinds — control messages and relay messages (the host's IPC,
 * unchanged, wrapped with the run id and a per-run, per-direction sequence number). Bulk data goes over the HTTP
 * artifact endpoints below, authorised by the run's lease token (`Authorization: Bearer <lease>`, SEC-14).
 * Every message is at most 4 MiB (RUN-16).
 */

export const WORKER_WS_PATH = "/internal/worker";
export const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024;
export const HEARTBEAT_MS = 10_000;
export const LEASE_MS = 45_000;

/** One snapshot entry of an omp sign-in (CRED-02); refresh tokens replaced by `__remote__`. Opaque to the wire. */
export type CredentialSnapshot = Record<string, unknown>;

/** Everything the worker needs for one run; sent only over the connection, never written to disk (architecture §4.2). */
export interface RunSpec {
	runId: string;
	kind: "plan" | "implement" | "revise" | "fix_ci" | "chat" | "draft" | "ask";
	profile: AgentProfile;
	prompt: string;
	outputSchema?: object;
	model?: string;
	thinking: string;
	limits: { minutes: number; costUsd: number };
	/** A session file exists in the orchestrator and is downloaded and resumed (`GET …/session`). */
	resumeSession: boolean;
	omp: OmpConfig;
	/** Content hash of the skills and agents bundle (`GET …/skills`); workers may cache by it. */
	skillsHash: string;
	providerKeys: Record<string, string>;
	credentials: CredentialSnapshot[];
	/** The run has the `create_issue` tool for this repo (AGT-10). */
	createIssueRepo?: string;
	/** Ask runs (CHAT-07): scratch input names to download (`GET …/scratch/inputs/<name>`); outputs go back with PUT. */
	scratch?: { inputs: string[] };
	/** Phase 4: checkout (repo, start ref + sha, temp branch, writes code, restore), git identity, setupCommand. */
	checkout?: never;
}

/** What `mcp-test` connects to (AGT-21). */
export interface McpTestSpec {
	name: string;
	server: OmpConfig["mcpServers"][string];
	timeoutMs: number;
}

export type WorkerPhase = "claiming" | "checkout" | "running" | "uploading" | "cleanup";

/** Control: worker → orchestrator. */
export type WorkerControl =
	| { t: "hello"; workerId: string; identity: { version: string; hash: string }; ompVersion: string; lease?: { runId: string; token: string } }
	| { t: "claim" }
	| { t: "heartbeat"; runId: string; token: string; phase: WorkerPhase }
	| { t: "run-info"; runId: string; ompVersion: string }
	| { t: "setup-output"; runId: string; exitCode: number; tail: string }
	| { t: "checkpoint"; runId: string }
	| { t: "gone"; runId: string; exitCode: number | null; signal: string | null; oomKills: number }
	| { t: "credential-request"; runId: string; requestId: number; provider: string; credentialId: string; accessToken?: string }
	| { t: "mcp-test-result"; runId: string; ok: boolean; tools: string[]; error?: string };

/** Control: orchestrator → worker. */
export type OrchestratorControl =
	| { t: "assign"; runId: string; token: string; kind: "run"; spec: RunSpec }
	| { t: "assign"; runId: string; token: string; kind: "mcp-test"; mcp: McpTestSpec }
	/** No pending run to claim: the worker exits 0 (architecture §2.3). */
	| { t: "nothing" }
	/** The lease announced in `hello` is no longer valid: the worker stops its host and cleans up. */
	| { t: "lease-invalid"; runId: string }
	| { t: "credential-response"; runId: string; requestId: number; ok: true; accessToken: string; expiresAt: number }
	| { t: "credential-response"; runId: string; requestId: number; ok: false; error: string }
	| { t: "scratch-input"; runId: string; name: string };

/** Relay: the host's IPC, unchanged, sequenced per run and direction (RUN-06). */
export type RelayUp = { t: "relay"; runId: string; seq: number; msg: ChildMessage };
export type RelayDown = { t: "relay"; runId: string; seq: number; msg: Exclude<ParentMessage, { t: "start" }> };

/** Highest relay sequence number received and stored, per run and direction (RUN-06). */
export type Ack = { t: "ack"; runId: string; seq: number };

export type UpMessage = WorkerControl | RelayUp | Ack;
export type DownMessage = OrchestratorControl | RelayDown | Ack;

/** Run artifact endpoints (architecture §4.5), all under `/internal/runs/<runId>/`, lease-token authorised. */
export const ARTIFACTS = {
	/** GET: the session file to resume; PUT: the current session file (at `session_file`, checkpoints and the end, RUN-18/19). */
	session: "session",
	/** GET: tar of the skills and agents (`skills/<name>/…`, `agents/<name>.md`). */
	skills: "skills",
	/** GET `scratch/inputs/<name>`; PUT `scratch/outputs/<name>` (CHAT-07, CHAT-10). */
	scratchInput: (name: string) => `scratch/inputs/${encodeURIComponent(name)}`,
	scratchOutput: (name: string) => `scratch/outputs/${encodeURIComponent(name)}`,
} as const;

export function runArtifactPath(runId: string, artifact: string): string {
	return `/internal/runs/${encodeURIComponent(runId)}/${artifact}`;
}
