import type { Config, LabelNames } from "../../shared/config";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { InteractionRouter } from "../discord/interactions";
import type { ThreadReplies } from "../discord/replies";
import type { DiscordSurface } from "../discord/surface";
import type { GitHub, GhIssue } from "../github/types";
import type { AgentLog } from "../store/agentlog";
import type { Db, IssueRow, JobRow } from "../store/db";
import type { JobKind } from "./state";

/**
 * Everything one engine instance works with (ENG-02: rebuilt on every settings apply). Ported from DevForge `EngineDeps`
 * (src/engine/jobs.ts) with: `client` → `discord` (the surface, no discord.js), `runtime`/`activeSessions` → `dispatcher`
 * (process-wide, outlives the engine), no `workspace` until phase 4, label names from settings.
 */
export interface EngineDeps {
	config: Config;
	/** Effective label names (GH-08, GH-22). */
	labels: LabelNames;
	db: Db;
	github: GitHub;
	discord: DiscordSurface;
	dispatcher: Dispatcher;
	/** Typed thread replies waiting to answer an agent's question (checked before steering, DSC-18). */
	replies: ThreadReplies;
	interactions: InteractionRouter;
	agentLog: AgentLog;
	/** `<state>/sessions` (ENG-05). */
	sessionDir: string;
	/** Aborted when this engine instance stops: in-flight work detaches from its runs and stops touching Discord/GitHub. */
	signal: AbortSignal;
}

/** Ported from DevForge `src/engine/scheduler.ts` (JOB-01 to JOB-09). Implemented by `createScheduler(deps)`. */
export interface Scheduler {
	enqueue(issueId: number, kind: JobKind, input?: object): JobRow;
	/** Starts queued jobs up to `maxConcurrentJobs`, oldest first, one per issue (JOB-02, JOB-03). */
	tick(): void;
	/** JOB-05. */
	cancelIssue(issueId: number, reason: string): Promise<void>;
	/** True when the issue has a queued or running job. */
	isBusy(issueId: number): boolean;
	/** Steers the issue's live run, if any (AGT-15, DSC-24). */
	steer(issueId: number, text: string, from: string): Promise<"delivered" | "queued" | "not-ready" | "ended" | "none">;
	/** Engine start (JOB-08): re-executes jobs left `running`; the dispatcher re-attaches to their runs or reports them lost. */
	recover(): void;
	/** Engine stop: stop claiming and detach from runs. Never aborts runs (RUN-09). */
	detach(): Promise<void>;
}

/** How an issue came to be tracked; decides where its thread opens (DSC-34). */
export type TrackSource = { via: "label" } | { via: "command"; actorId: string };

/**
 * GH-12 and `/work start`: post the 📥 top message in the repo's watch channel (or the work channel), start the thread,
 * record the issue `queued` with its thread, post "Queued for planning", enqueue `plan`. Implemented by `trackIssue` in
 * `engine/issues.ts`; used by the poller and the bot.
 */
export type TrackIssue = (repo: string, issue: GhIssue, source: TrackSource) => Promise<IssueRow>;
