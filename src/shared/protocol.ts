import type { ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import type { AgentProfile, Loadout, TodoItem } from "./agent";
import type { OmpConfig } from "./ompconfig";
import type { RunUsage, TranscriptEvent } from "./transcript";

/**
 * Messages between the worker supervisor and its agent host (`src/worker/host/host.ts`), one host process per run, over
 * Bun's JSON IPC channel (ported from DevForge `src/agent/protocol.ts`). The supervisor relays every message except
 * `start` and `credential_request` to the orchestrator unchanged (architecture §4.2): `ChildMessage`s go up as relay
 * messages, `ParentMessage`s from the orchestrator come down. Requests carry a numeric `id` that the matching `reply`
 * echoes; ids are allocated by whoever sends the request.
 */

/** Where the host finds what the worker downloaded, and the run's keys (architecture §2.3, S2). */
export interface HostRuntime {
	/** omp agent dir with the run-private auth store (`PI_CODING_AGENT_DIR`, CRED-02); run-local, mode 0700. */
	agentDir: string;
	/** The downloaded skills and agents: the session's only extension root (AGT-24). */
	ompDir: string;
	providerKeys: Record<string, string>;
}

export interface StartOptions {
	runId: string;
	/** Working directory: the checkout (phase 4), or the scratch copy for `/ask`, or an empty run dir. */
	cwd: string;
	/** Directory the session file is written in. */
	sessionDir: string;
	/** Session file to resume, when the run continues one (JOB-10). */
	resumeFile?: string;
	profile: AgentProfile;
	modelPattern?: string;
	thinking: string;
	/** Complete prompt, built by the orchestrator (to-do instruction included). */
	prompt: string;
	outputSchema?: object;
	limits: { minutes: number; costUsd: number };
	omp: OmpConfig;
	/** Repository the `create_issue` tool files into; present only when the run has that tool (AGT-10). */
	createIssueRepo?: string;
	wantLoadout: boolean;
	/** For the `ask` profile: the scratch root its file tools are confined to (AGT-28). */
	scratchRoot?: string;
}

export type UiMethod = "askDialog" | "select" | "input" | "editor" | "confirm" | "notify";

/** The data members of `ExtensionUIDialogOptions`; its signal is replaced by `ui_cancel` and its callbacks are not forwarded. */
export type DialogData = Pick<
	ExtensionUIDialogOptions,
	"timeout" | "initialIndex" | "outline" | "helpText" | "selectionMarker" | "checkedIndices" | "markableCount" | "acceptImages"
>;

export type Reply = { t: "reply"; id: number } & ({ ok: true; value?: unknown } | { ok: false; error: string; aborted?: boolean });

export interface HostResult {
	output?: unknown;
	/** Path of the session file inside the worker (uploaded by the supervisor, RUN-19). */
	sessionFile: string;
	usage: RunUsage;
	aborted?: "time" | "cost" | "user";
	oomKills: number;
}

export type ParentMessage =
	/** Built by the supervisor from the run spec; never relayed. */
	| { t: "start"; runtime: HostRuntime; opts: StartOptions }
	| { t: "steer"; id: number; text: string }
	| { t: "abort"; id: number; reason: "user" | "time" | "cost" }
	/** Answers `ui`, `tool_call`, `session_file` and `credential_request`. */
	| Reply;

export type ChildMessage =
	| { t: "progress"; tool?: string; intent?: string; usage: RunUsage; elapsedMs: number }
	| { t: "transcript"; event: TranscriptEvent }
	| { t: "todos"; todos: TodoItem[] }
	| { t: "loadout"; loadout: Loadout }
	| { t: "usage"; usage: RunUsage }
	/** Sent before the prompt; the session waits for the reply so a restart can always resume it (JOB-10, RUN-18). */
	| { t: "session_file"; id: number; path: string }
	/** The session accepts `steer` and `abort` from now on. */
	| { t: "registered" }
	| { t: "ui"; id: number; method: UiMethod; args: unknown[]; dialog?: DialogData }
	| { t: "ui_cancel"; id: number }
	| { t: "tool_call"; id: number; name: "create_issue"; params: { title: string; body: string } }
	/**
	 * omp's `refreshOAuthCredential` hook fired (S1, CRED-03). Handled by the supervisor as the `credential-request`
	 * control message; never relayed. The reply's value is `{ accessToken, expiresAt }`; a refusal is `ok: false`.
	 */
	| { t: "credential_request"; id: number; provider: string; credentialId: string; accessToken?: string }
	/** Answers `steer` and `abort`. */
	| Reply
	/** A log line, already cut to 8 KiB by the supervisor before relaying (RUN-16). */
	| { t: "log"; line: string }
	| { t: "done"; result: HostResult }
	| { t: "failed"; message: string; name: string };
