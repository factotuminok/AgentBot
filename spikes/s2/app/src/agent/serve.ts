import type { ExtensionAskDialogSubmitResult, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent";
import { errorMessage, setLogSink } from "../log";
import type { ChildMessage, DialogData, ParentMessage, StartOptions, UiMethod } from "./protocol";
import type { RunAgentResult, SessionHandle } from "./runner";
import type { SessionOptions, SessionRuntime, SessionUI } from "./session";
import { abortError, createPauseClock, headlessUIBase } from "./ui";

/**
 * The agent process's side of the protocol (see `protocol.ts`), without the SDK: `host.ts` is the real entry and
 * passes the SDK-backed session, tests pass a scripted one. A process serves exactly one run: it receives one `start`
 * message, runs the session with callbacks that post messages back, and exits after reporting `done` or `failed`.
 * Nothing here touches the database, the vault, the agent log or Discord: those stay in the main process.
 */

/** What the host runs. */
export interface HostDeps {
	run(runtime: SessionRuntime, opts: SessionOptions): Promise<RunAgentResult>;
	openRuntime(agentDir: string, ompDir: string, providerKeys: Record<string, string>): Promise<SessionRuntime>;
}

/** After the parent is gone, how long the session gets to wind down before the process exits. */
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
	if (!channel) throw new Error("The agent host must be started with an IPC channel");
	let nextId = 0;
	const pending = new Map<number, { resolve(value: unknown): void; reject(err: unknown): void }>();
	let handle: SessionHandle | undefined;
	let abortRequested = false;
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
	// stdout is inherited (the container log shows these lines as before); the parent adds them to its log file.
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
			const { run, openRuntime } = deps;
			const { agentDir, ompDir, providerKeys } = message.runtime;
			const runtime = await openRuntime(agentDir, ompDir, providerKeys);
			const { createIssueRepo, wantLoadout, ...rest }: StartOptions = message.opts;
			const result = await run(runtime, {
				...rest,
				ui: createProxyUI(),
				onProgress: p => send({ t: "progress", ...p }),
				onTranscript: event => send({ t: "transcript", event }),
				onTodos: todos => send({ t: "todos", todos }),
				onUsage: usage => send({ t: "usage", usage }),
				onLoadout: wantLoadout ? loadout => send({ t: "loadout", loadout }) : undefined,
				// The main process stores the session file before replying, and the session prompts only after that (D-015).
				onSessionFile: async path => {
					await rpc(id => ({ t: "session_file", id, path })).promise;
				},
				register: sessionHandle => {
					handle = sessionHandle;
					send({ t: "registered" });
					if (abortRequested) sessionHandle.abort().catch(() => {});
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
				answer(message.id, handle ? handle.steer(message.text) : Promise.reject(new Error("Agent session is not ready")));
				break;
			case "abort":
				// Before the session registered, the abort is applied as soon as it does.
				abortRequested = true;
				answer(message.id, handle ? handle.abort() : Promise.resolve());
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

	// The main process died (crash, kill -9, container stop): wind the session down, then leave. Nothing can receive its result.
	process.on("disconnect", () => {
		parentGone = true;
		abortRequested = true;
		if (!handle) process.exit(1);
		handle.abort().catch(() => {});
		setTimeout(() => process.exit(1), ORPHAN_EXIT_MS).unref();
	});
}
