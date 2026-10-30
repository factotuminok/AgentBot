import type { ExtensionAskDialogSubmitResult, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import type { Loadout, TodoItem } from "../../shared/agent";
import { errorMessage, setLogSink } from "../../shared/log";
import type { ChildMessage, DialogData, HostResult, HostRuntime, ParentMessage, StartOptions, UiMethod } from "../../shared/protocol";
import { type RunUsage, type TranscriptEvent, truncateEvent } from "../../shared/transcript";
import { abortError, createPauseClock, type HeadlessUI, headlessUIBase } from "../../shared/ui";
import type { SessionRuntime } from "./session";

/**
 * The agent host's side of the protocol (`src/shared/protocol.ts`), without the SDK: `host.ts` is the real entry and
 * passes the SDK-backed session, tests pass a scripted one (`test/fixtures/agent-host.ts`). A process serves exactly one
 * run: it receives one `start` message, runs the session with callbacks that post messages back, and exits after
 * reporting `done` or `failed`. Everything else (Discord, GitHub, storage) is the orchestrator's, reached through the
 * worker supervisor.
 */

export type AbortReason = NonNullable<HostResult["aborted"]>;

/** A run that must yield ended without doing so after one nudge (AGT-12); crosses the protocol as `failed` by `name`. */
export class NoStructuredOutput extends Error {
	override name = "NoStructuredOutput";
	constructor() {
		super("finished without calling yield");
	}
}

/** What the session registers once it accepts `steer` and `abort`. */
export interface SessionHandle {
	steer(text: string): Promise<void>;
	abort(reason: AbortReason): Promise<void>;
}

/** A UI context that also reports the time spent waiting on a human, which the wall-clock limit excludes (AGT-14). */
export type SessionUI = HeadlessUI & { pausedMs(): number };

/** A fresh access token for one sign-in, from the orchestrator (CRED-03). */
export interface FreshCredential {
	accessToken: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

/** Sends `credential_request` and resolves with the reply; rejects with the refusal (CRED-05) or when `signal` aborts. */
export type CredentialRequester = (
	request: { provider: string; credentialId: string; accessToken?: string },
	signal?: AbortSignal,
) => Promise<FreshCredential>;

/** The start options plus the callbacks that post messages to the supervisor. */
export type SessionOptions = Omit<StartOptions, "createIssueRepo" | "wantLoadout"> & {
	ui: SessionUI;
	onProgress(p: { tool?: string; intent?: string; usage: RunUsage; elapsedMs: number }): void;
	onTranscript(event: TranscriptEvent): void;
	onTodos(todos: TodoItem[]): void;
	/** Called once when the run ends, also when it throws, with what this run consumed. */
	onUsage(usage: RunUsage): void;
	/** Present when the supervisor wants the loadout (AGT-27). */
	onLoadout?(loadout: Loadout): void;
	/** Resolves when the orchestrator stored the session file; the prompt is only sent after that (JOB-10). */
	onSessionFile(path: string): Promise<void>;
	register(handle: SessionHandle): void;
	/** The `create_issue` tool (AGT-10); `file` is executed by the orchestrator. */
	createIssue?: { repo: string; file(title: string, body: string): Promise<{ number: number; url: string }> };
};

/** What the host runs. */
export interface HostDeps {
	openRuntime(runtime: HostRuntime, requestCredential: CredentialRequester): Promise<SessionRuntime>;
	run(runtime: SessionRuntime, opts: SessionOptions): Promise<HostResult>;
}

/** After the parent is gone, how long the session gets to wind down before the process exits (AGT-04). */
const ORPHAN_EXIT_MS = 5_000;
/** After the final message is queued, how long to wait for it to flush before exiting regardless. */
const FLUSH_EXIT_MS = 2_000;

type StartMessage = Extract<ParentMessage, { t: "start" }>;

/** The serializable members of omp's dialog options (the signal travels as `ui_cancel`, callbacks are not forwarded). */
function dialogData(options: ExtensionUIDialogOptions | undefined): DialogData {
	if (!options) return {};
	const { timeout, initialIndex, outline, helpText, selectionMarker, checkedIndices, markableCount, acceptImages } = options;
	return { timeout, initialIndex, outline, helpText, selectionMarker, checkedIndices, markableCount, acceptImages };
}

export function serveAgentHost(deps: HostDeps): void {
	const channel = process.send?.bind(process);
	if (!channel) throw new Error("The agent host must be started by the worker supervisor with an IPC channel");
	let nextId = 0;
	const pending = new Map<number, { resolve(value: unknown): void; reject(err: unknown): void }>();
	let handle: SessionHandle | undefined;
	let abortRequested: AbortReason | undefined;
	let started = false;
	let parentGone = false;

	function send(message: ChildMessage, flushed?: () => void): void {
		try {
			if (flushed) channel?.(message, flushed);
			else channel?.(message);
		} catch {
			// The parent is gone; `disconnect` winds the run down.
			flushed?.();
		}
	}
	// stdout is inherited; the supervisor also relays these lines to the orchestrator log (RUN-16).
	setLogSink(line => send({ t: "log", line }));

	/** Sends a request and waits for the parent's `reply`. */
	function rpc(build: (id: number) => ChildMessage): { id: number; promise: Promise<unknown> } {
		const id = ++nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		pending.set(id, { resolve, reject });
		send(build(id));
		return { id, promise };
	}

	function createProxyUI(): SessionUI {
		const clock = createPauseClock();
		function ask(method: Exclude<UiMethod, "notify">, args: unknown[], options: ExtensionUIDialogOptions | undefined): Promise<unknown> {
			const signal = options?.signal;
			if (signal?.aborted) return Promise.reject(abortError());
			// Time spent waiting on a person does not count against the wall-clock limit.
			return clock.during(async () => {
				const { id, promise } = rpc(id => ({ t: "ui", id, method, args, dialog: dialogData(options) }));
				const onAbort = () => {
					const waiting = pending.get(id);
					pending.delete(id);
					send({ t: "ui_cancel", id });
					waiting?.reject(abortError());
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					return await promise;
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			});
		}
		return {
			...headlessUIBase(),
			pausedMs: clock.pausedMs,
			askDialog: (questions, options) => ask("askDialog", [questions], options) as Promise<ExtensionAskDialogSubmitResult>,
			select: (title, options, dialogOptions) => ask("select", [title, options], dialogOptions) as Promise<string | undefined>,
			input: (title, placeholder, dialogOptions) => ask("input", [title, placeholder], dialogOptions) as Promise<string | undefined>,
			editor: (title, prefill, dialogOptions) => ask("editor", [title, prefill], dialogOptions) as Promise<string | undefined>,
			confirm: (title, message, dialogOptions) => ask("confirm", [title, message], dialogOptions) as Promise<boolean>,
			notify: (message, type) => send({ t: "ui", id: ++nextId, method: "notify", args: [message, type] }),
		};
	}

	const requestCredential: CredentialRequester = async (request, signal) => {
		if (signal?.aborted) throw abortError();
		const { id, promise } = rpc(id => ({ t: "credential_request", id, ...request }));
		const onAbort = () => {
			const waiting = pending.get(id);
			pending.delete(id);
			waiting?.reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const value = (await promise) as Partial<FreshCredential> | undefined;
			if (typeof value?.accessToken !== "string" || typeof value.expiresAt !== "number") {
				throw new Error(`Malformed credential reply for ${request.provider}`);
			}
			return { accessToken: value.accessToken, expiresAt: value.expiresAt };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	function answer(id: number, request: Promise<unknown>): void {
		request.then(
			() => send({ t: "reply", id, ok: true }),
			err => send({ t: "reply", id, ok: false, error: errorMessage(err) }),
		);
	}

	function finish(message: ChildMessage): void {
		if (parentGone) process.exit(1);
		// Exit once the result is flushed; process.exit right after send could drop it.
		const exit = () => process.exit(0);
		setTimeout(exit, FLUSH_EXIT_MS);
		send(message, exit);
	}

	async function start(message: StartMessage): Promise<void> {
		try {
			const runtime = await deps.openRuntime(message.runtime, requestCredential);
			const { createIssueRepo, wantLoadout, ...rest }: StartOptions = message.opts;
			const result = await deps.run(runtime, {
				...rest,
				ui: createProxyUI(),
				onProgress: p => send({ t: "progress", ...p }),
				// Field limits applied here, before the IPC hop (RUN-16).
				onTranscript: event => send({ t: "transcript", event: truncateEvent(event) }),
				onTodos: todos => send({ t: "todos", todos }),
				onUsage: usage => send({ t: "usage", usage }),
				onLoadout: wantLoadout ? loadout => send({ t: "loadout", loadout }) : undefined,
				onSessionFile: async path => {
					await rpc(id => ({ t: "session_file", id, path })).promise;
				},
				register: sessionHandle => {
					handle = sessionHandle;
					send({ t: "registered" });
					// A cancel that arrived before the session was ready (AGT-07).
					if (abortRequested) sessionHandle.abort(abortRequested).catch(() => {});
				},
				createIssue: createIssueRepo
					? {
							repo: createIssueRepo,
							file: async (title, body) =>
								(await rpc(id => ({ t: "tool_call", id, name: "create_issue", params: { title, body } })).promise) as { number: number; url: string },
						}
					: undefined,
			});
			finish({ t: "done", result });
		} catch (err) {
			finish({ t: "failed", message: errorMessage(err), name: err instanceof Error ? err.name : "Error" });
		}
	}

	process.on("message", raw => {
		const message = raw as ParentMessage;
		switch (message.t) {
			case "start":
				if (started) return;
				started = true;
				void start(message);
				break;
			case "steer":
				// AGT-15: refused until the session registered.
				answer(message.id, handle ? handle.steer(message.text) : Promise.reject(new Error("Agent session is not ready")));
				break;
			case "abort":
				// Before the session registered, the abort is applied as soon as it does; the first reason wins (AGT-07).
				abortRequested ??= message.reason;
				answer(message.id, handle ? handle.abort(message.reason) : Promise.resolve());
				break;
			case "reply": {
				const waiting = pending.get(message.id);
				pending.delete(message.id);
				if (message.ok) waiting?.resolve(message.value);
				else waiting?.reject(message.aborted ? abortError() : new Error(message.error));
				break;
			}
		}
	});

	// The supervisor died (crash, kill -9, container stop): wind the session down, then leave (AGT-04).
	process.on("disconnect", () => {
		parentGone = true;
		abortRequested ??= "user";
		if (!handle) process.exit(1);
		handle.abort(abortRequested).catch(() => {});
		setTimeout(() => process.exit(1), ORPHAN_EXIT_MS).unref();
	});
}
