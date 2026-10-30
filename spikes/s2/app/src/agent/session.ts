import {
	AgentRegistry,
	type AgentSessionEvent,
	type AuthStorage,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	ensureTheme,
	ModelRegistry,
	SessionManager,
	type YieldDetails,
} from "@oh-my-pi/pi-coding-agent";
import { reset as resetDiscoveryCache } from "@oh-my-pi/pi-coding-agent/capability";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEvent } from "../agentlog";
import { errorMessage, log } from "../log";
import { connectMcp, emptyOmpConfig, enabledMcpServers, initRunSettings, type McpConnection } from "../ompconfig";
import { createUsageMeter } from "../usage";
import { captureLoadout } from "./loadout";
import { readOomKills } from "./oom";
import { NoStructuredOutput } from "./protocol";
import type { AgentProfile, RunAgentOptions, RunAgentResult } from "./runner";
import { createScratchTools } from "./scratchTools";
import { createTodoTool, TODO_INSTRUCTION, TODO_TOOL } from "./todos";
import { createIssueTool } from "./tools";
import type { HeadlessUI } from "./ui";

/**
 * One omp agent session, run inside an agent process (`host.ts`) so its synchronous work (session-file rewrites,
 * SQLite, JSON, tool post-processing) never shares an event loop with the web server. This is the only module that
 * creates sessions; the main process reaches it through `runner.ts`.
 */

/** SDK singletons of one agent process. */
export interface SessionRuntime {
	agentDir: string;
	/** The omp volume: the only extension root sessions load (D-039). */
	ompDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/**
 * Opens omp's credential store under `agentDir` (the same `agent.db` the main process uses for model accounts, D-029)
 * and installs the provider keys from DevForge settings as in-memory runtime overrides.
 */
export async function openSessionRuntime(agentDir: string, ompDir: string, providerKeys: Record<string, string>): Promise<SessionRuntime> {
	await mkdir(agentDir, { recursive: true });
	const authStorage = await discoverAuthStorage(agentDir);
	for (const [provider, key] of Object.entries(providerKeys)) authStorage.keys.setRuntime(provider, key);
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
	await modelRegistry.refresh();
	return { agentDir, ompDir, authStorage, modelRegistry };
}

/** A UI context that also reports the time spent waiting on a human, which the wall-clock limit excludes. */
export type SessionUI = HeadlessUI & { pausedMs(): number };

export type SessionOptions = Omit<RunAgentOptions, "ui" | "onSessionFile"> & {
	ui: SessionUI;
	/** Resolves when the session file is stored; the prompt is only sent after that. */
	onSessionFile?(path: string): void | Promise<void>;
};

function oomSteer(kills: number, tool: string): string {
	return `DevForge: the kernel killed ${kills} process(es) in this container for lack of memory (OOM) while your last \`${tool}\` call ran. A killed command exits with code 137 or prints \`Killed\`; typical culprits are \`tsc\` and test runners. This machine does not have enough memory for that command. Do not run it again: it will be killed again and stall the machine. Continue without it, and state in your final output which checks did not complete because of memory.`;
}

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

const THINKING_LEVELS: Record<ThinkingLevel, true> = {
	auto: true,
	inherit: true,
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

/**
 * Restricted tool sets; `undefined` = unrestricted defaults (`ask` comes from `interactivePrompts`).
 * `find` is omitted: in omp 18.12.1 it is still gated by the `find.enabled` setting (auto = native judge model) and was inactive.
 */
const PROFILE_TOOLS: Record<AgentProfile, string[] | undefined> = {
	plan: ["read", "grep", "glob", "bash", "web_search", "ask", "yield", TODO_TOOL],
	chat: ["read", "grep", "glob", "bash", "web_search", "yield", "create_issue", TODO_TOOL],
	// `/forge issue` drafting: read the repository, no questions (nobody to answer), no filing (DevForge files it).
	draft: ["read", "grep", "glob", "bash", "web_search", "yield", TODO_TOOL],
	// Ask-only Discord channels (anyone may use them): no omp file or shell tools, only DevForge's workspace-confined ones.
	ask: ["web_search", "yield", "list_files", "read_file", "write_file", TODO_TOOL],
	implement: undefined,
};

const WALL_CLOCK_CHECK_MS = 15_000;
/** Headless runs wait for MCP servers to finish starting (omp's interactive default is 250 ms). */
const MCP_STARTUP_WAIT_MS = 15_000;
const YIELD_NUDGE = "You have not called yield. Call yield now with data matching the required schema.";

export async function runSession(runtime: SessionRuntime, opts: SessionOptions): Promise<RunAgentResult> {
	if (!Object.hasOwn(THINKING_LEVELS, opts.thinking)) throw new Error(`Unknown thinking level "${opts.thinking}"`);
	const thinkingLevel = opts.thinking as ThinkingLevel;
	const toolNames = PROFILE_TOOLS[opts.profile];
	// The ask tool formats labels with the process-global TUI theme, which only the omp CLI initializes.
	await ensureTheme();
	const sessionManager = opts.resumeFile
		? await SessionManager.open(opts.resumeFile, opts.sessionDir, undefined, { initialCwd: opts.cwd })
		: SessionManager.create(opts.cwd, opts.sessionDir);

	const omp = opts.omp ?? emptyOmpConfig();
	// omp disables MCP for restricted tool sets, so only unrestricted (implement) runs connect servers.
	const mcpServers = toolNames ? {} : enabledMcpServers(omp);
	let mcp: McpConnection | undefined;
	let created: CreateAgentSessionResult;
	try {
		if (Object.keys(mcpServers).length > 0) {
			mcp = await connectMcp(opts.cwd, mcpServers, MCP_STARTUP_WAIT_MS);
			// The session only mounts tools present at creation (a supplied manager gets no change listener).
			const startup = await mcp.manager.waitForStartup(MCP_STARTUP_WAIT_MS);
			for (const { name, error } of startup.failed) log("warn", "MCP server failed to start", { job: opts.jobId, server: name, error });
			if (startup.pending.length > 0) log("warn", "MCP servers still starting; their tools are skipped", { job: opts.jobId, servers: startup.pending });
		}
		// omp caches directory listings and file reads per process; clear them so files uploaded since the last run load.
		resetDiscoveryCache();
		const settings = await initRunSettings(omp, runtime.agentDir);
		created = await createAgentSession({
			cwd: opts.cwd,
			agentDir: runtime.agentDir,
			authStorage: runtime.authStorage,
			modelRegistry: runtime.modelRegistry,
			sessionManager,
			// Admin overrides from the web UI, with DevForge's pinned headless values on top (D-025). Also the process-global
			// settings that web_search and bash read (D-064).
			settings,
			agentRegistry: new AgentRegistry(),
			hasUI: false,
			interactivePrompts: true,
			...(mcp ? { enableMCP: true, mcpManager: mcp.manager, mcpTools: mcp.manager.getTools() } : { enableMCP: false }),
			disableExtensionDiscovery: true,
			// The only extension root: the user's skills and agents in the omp volume (D-039).
			additionalExtensionPaths: [runtime.ompDir],
			modelPattern: opts.modelPattern,
			thinkingLevel,
			outputSchema: opts.outputSchema,
			outputSchemaMode: "strict",
			requireYieldTool: !!opts.outputSchema,
			// Every run keeps a todo list the Discord thread mirrors (D-040).
			customTools: [
				createTodoTool(todos => opts.onTodos?.(todos)),
				...(opts.createIssue ? [createIssueTool(opts.createIssue)] : []),
				...(opts.profile === "ask" ? createScratchTools(opts.cwd) : []),
			],
			allowRestrictedCustomTools: true,
			...(toolNames ? { toolNames, restrictToolNames: true } : {}),
		});
	} catch (err) {
		await mcp?.close().catch(() => {});
		throw err;
	}
	const { session, setToolUIContext } = created;

	const start = Date.now();
	let output: unknown;
	let aborted: RunAgentResult["aborted"];
	let lastTool: { tool?: string; intent?: string } = {};
	const meter = createUsageMeter(session);

	const abortWith = (reason: NonNullable<RunAgentResult["aborted"]>) => {
		if (aborted) return;
		aborted = reason;
		log("warn", "agent aborted", { job: opts.jobId, reason, cost: meter.total.costUsd });
		session.abort().catch(err => log("warn", "agent abort failed", { job: opts.jobId, error: errorMessage(err) }));
	};
	const elapsedMs = () => Date.now() - start - opts.ui.pausedMs();

	// Container-wide kernel OOM counter (D-053); `undefined` = no cgroup v2, detection off.
	let oomSeen = readOomKills();
	let oomKills = 0;
	const checkOom = (tool: string) => {
		if (oomSeen === undefined) return;
		const now = readOomKills();
		if (now === undefined || now <= oomSeen) return;
		const delta = now - oomSeen;
		oomSeen = now;
		oomKills += delta;
		log("warn", "process OOM-killed during agent run", { job: opts.jobId, tool, kills: delta, total: oomKills });
		// After a successful yield a steer would start a turn the post-yield contingency aborts at once.
		if (output !== undefined || aborted) return;
		const text = oomSteer(delta, tool);
		transcript({ type: "steer", text });
		session.steer(text).catch(err => log("warn", "oom steer failed", { job: opts.jobId, error: errorMessage(err) }));
	};

	const transcript = (event: TranscriptEvent) => {
		try {
			opts.onTranscript?.(event);
		} catch (err) {
			log("warn", "transcript sink failed", { job: opts.jobId, error: errorMessage(err) });
		}
	};

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "tool_execution_start":
				lastTool = { tool: event.toolName, intent: event.intent };
				opts.onProgress({ ...lastTool, usage: meter.total, elapsedMs: elapsedMs() });
				transcript({ type: "tool_start", tool: event.toolName, intent: event.intent, args: JSON.stringify(event.args ?? null) });
				break;
			case "tool_execution_end": {
				transcript({ type: "tool_end", tool: event.toolName, isError: !!event.isError, text: toolResultText(event.result) });
				checkOom(event.toolName);
				if (event.toolName !== "yield" || event.isError) break;
				const details = (event.result as { details?: YieldDetails } | undefined)?.details;
				if (details?.status !== "success") break;
				output = details.data;
				break;
			}
			case "turn_start":
				// Contingency: yield should end a top-level run. If the loop starts another turn after a
				// successful yield, stop it; the captured output is the result.
				if (output !== undefined && !aborted) {
					log("info", "agent continued after yield; aborting", { job: opts.jobId });
					session.abort().catch(err => log("warn", "agent abort failed", { job: opts.jobId, error: errorMessage(err) }));
				}
				break;
			case "message_end": {
				const message = event.message;
				if (!("role" in message) || message.role !== "assistant") break;
				const text = message.content
					.flatMap(block => (block.type === "text" ? [block.text] : []))
					.join("")
					.trim();
				if (text) transcript({ type: "assistant", text });
				break;
			}
			case "turn_end": {
				const usage = meter.update();
				opts.onProgress({ ...lastTool, usage, elapsedMs: elapsedMs() });
				if (usage.costUsd > opts.limits.costUsd) abortWith("cost");
				break;
			}
		}
	});
	const clock = setInterval(() => {
		if (elapsedMs() > opts.limits.minutes * 60_000) abortWith("time");
	}, WALL_CLOCK_CHECK_MS);

	let runError: string | undefined;
	try {
		setToolUIContext(opts.ui, true);
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Agent session has no session file");
		if (toolNames) {
			const active = session.getActiveToolNames();
			const missing = toolNames.filter(name => !active.includes(name));
			if (missing.length > 0) log("warn", "profile tools unavailable", { job: opts.jobId, profile: opts.profile, missing });
		}
		await opts.onSessionFile?.(sessionFile);
		if (opts.onLoadout) {
			const disabledAgents = omp.settings["task.disabledAgents"];
			await captureLoadout(session, {
				cwd: opts.cwd,
				ompDir: runtime.ompDir,
				profile: opts.profile,
				mcp,
				disabledAgents: Array.isArray(disabledAgents) ? disabledAgents.filter(a => typeof a === "string") : [],
			})
				.then(opts.onLoadout)
				.catch(err => log("warn", "loadout capture failed", { job: opts.jobId, error: errorMessage(err) }));
		}
		opts.register({
			steer: async text => {
				transcript({ type: "steer", text });
				await session.steer(text);
			},
			abort: async () => {
				abortWith("user");
				await session.abort();
			},
		});

		const run = async (text: string) => {
			transcript({ type: "prompt", text });
			try {
				await session.prompt(text);
				await session.waitForIdle();
			} catch (err) {
				// An abort (ours or the post-yield contingency) can surface as a rejected prompt.
				if (!aborted && output === undefined) throw err;
			}
		};
		await run(`${TODO_INSTRUCTION}\n\n${opts.prompt}`);
		if (opts.outputSchema && output === undefined && !aborted) {
			// The session is idle here, so the nudge must start a new turn: prompt, not a queued followUp.
			await run(YIELD_NUDGE);
		}
		checkOom("agent run");
		const usage = meter.update();
		if (opts.outputSchema && output === undefined && !aborted) throw new NoStructuredOutput(opts.jobId);
		return { output, sessionFile, usage: { ...usage }, oomKills, ...(aborted ? { aborted } : {}) };
	} catch (err) {
		runError = errorMessage(err);
		throw err;
	} finally {
		clearInterval(clock);
		unsubscribe();
		const usage = { ...meter.update() };
		opts.onUsage?.(usage);
		transcript({ type: "run_end", usage, ...(aborted ? { aborted } : {}), ...(runError ? { error: runError } : {}) });
		await session.dispose();
		await mcp?.close().catch(err => log("warn", "MCP disconnect failed", { job: opts.jobId, error: errorMessage(err) }));
	}
}

/** Text blocks of a tool result (images and structured details are left out of the log). */
function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	const texts: string[] = [];
	for (const block of result.content) {
		if (block && typeof block === "object" && "text" in block && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("\n");
}
