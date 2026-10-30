import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage, log } from "../../shared/log";
import { TERMINAL_STATES } from "../engine/state";
import type { Db, DraftRow, PlanRow } from "./db";

/**
 * omp session files the orchestrator keeps between runs (JOB-10, ENG-05), ported from DevForge `src/sessions.ts`.
 * A session is named by a file-name-safe **key** (`RunRequest.session`): its file is `<state>/sessions/<key>.jsonl`, and
 * omp keeps subagent transcripts and tool artifacts in the directory `<state>/sessions/<key>/`. The DB stores keys
 * (`issues.plan_session`, `issues.impl_session`, `plans.session_file`), never paths.
 */

interface SessionDeps {
	db: Db;
	/** `<state>/sessions` */
	sessionDir: string;
}

const SESSION_SUFFIX = ".jsonl";
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** The plan session of issue `issueId` (JOB-13 revisions resume it). */
export const issuePlanSessionKey = (issueId: number): string => `issue-${issueId}-plan`;
/** The implement session of issue `issueId`; revise and fix_ci resume it (JOB-10). */
export const issueImplSessionKey = (issueId: number): string => `issue-${issueId}-impl`;
/** A `/work ask` or `/ask` chat thread's session (kept, ENG-05). */
export const chatSessionKey = (threadId: string): string => `chat-${threadId}`;
/** A `/work plan` thread's session. */
export const planThreadSessionKey = (threadId: string): string => `plan-${threadId}`;

/** True when `key` names a session file directly inside the sessions directory. */
export function isSessionKey(key: string): boolean {
	return KEY_PATTERN.test(key) && !key.includes("..");
}

/** `<sessionDir>/<key>.jsonl`; throws for a key that is not file-name-safe. */
export function sessionPath(sessionDir: string, key: string): string {
	if (!isSessionKey(key)) throw new Error(`invalid session key: ${JSON.stringify(key)}`);
	return join(sessionDir, `${key}${SESSION_SUFFIX}`);
}

/** True when `path` lies strictly inside `dir`. */
function inside(dir: string, path: string): boolean {
	const rel = relative(resolve(dir), resolve(path));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		return (await lstat(path)).size;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** Bytes of the files under `dir`; 0 when it does not exist. */
async function dirBytes(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { recursive: true, withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return 0;
		throw err;
	}
	let total = 0;
	for (const entry of entries) {
		if (entry.isDirectory()) continue;
		total += (await sizeOf(join(entry.parentPath, entry.name))) ?? 0;
	}
	return total;
}

/**
 * Deletes the sessions named by `keys` (file and artifacts dir). Never throws. A value that is not a session key, or that
 * would resolve outside `sessionDir`, is skipped with a warning (ENG-05). Returns the keys that could not be deleted
 * (keep them stored so the start sweep retries).
 */
export async function removeSessions(
	sessionDir: string,
	keys: readonly (string | null | undefined)[],
	context: Record<string, unknown>,
): Promise<{ kept: string[] }> {
	const kept: string[] = [];
	const removed: string[] = [];
	let bytes = 0;
	for (const key of keys) {
		if (!key) continue;
		const file = isSessionKey(key) ? join(sessionDir, `${key}${SESSION_SUFFIX}`) : undefined;
		const dir = isSessionKey(key) ? join(sessionDir, key) : undefined;
		if (!file || !dir || !inside(sessionDir, file) || !inside(sessionDir, dir)) {
			log("warn", "session outside session dir skipped", { ...context, session: key });
			continue;
		}
		try {
			const fileBytes = await sizeOf(file);
			const dirSize = await dirBytes(dir);
			await rm(file, { force: true });
			await rm(dir, { recursive: true, force: true });
			if (fileBytes !== undefined || dirSize > 0) {
				removed.push(key);
				bytes += (fileBytes ?? 0) + dirSize;
			}
		} catch (err) {
			log("warn", "session removal failed", { ...context, session: key, error: errorMessage(err) });
			kept.push(key);
		}
	}
	if (removed.length > 0) log("info", "sessions removed", { ...context, sessions: removed, bytes });
	return { kept };
}

/** Deletes a `done`/`cancelled` issue's sessions and nulls the columns. No-op for any other state. Never throws. */
export async function removeIssueSessions(deps: SessionDeps, issueId: number): Promise<void> {
	try {
		// Re-read: a run may have recorded a session after the caller took its snapshot.
		const issue = deps.db.getIssue(issueId);
		if (!issue || !TERMINAL_STATES[issue.state]) return;
		const { plan_session: plan, impl_session: impl } = issue;
		if (!plan && !impl) return;
		const { kept } = await removeSessions(deps.sessionDir, [plan, impl], { repo: issue.repo, issue: issue.number });
		const next = {
			plan_session: plan && kept.includes(plan) ? plan : null,
			impl_session: impl && kept.includes(impl) ? impl : null,
		};
		if (next.plan_session !== plan || next.impl_session !== impl) deps.db.updateIssue(issue.id, next);
	} catch (err) {
		log("warn", "issue session removal failed", { issue_id: issueId, error: errorMessage(err) });
	}
}

/** Deletes a rejected `/work plan`'s session and clears `session_file`. No-op for any other state. Never throws. */
export async function removePlanSession(deps: SessionDeps, plan: PlanRow): Promise<void> {
	try {
		if (plan.state !== "rejected" || !plan.session_file) return;
		const { kept } = await removeSessions(deps.sessionDir, [plan.session_file], { repo: plan.repo, plan_thread: plan.thread_id });
		if (!kept.includes(plan.session_file)) deps.db.updatePlan(plan.thread_id, { session_file: null });
	} catch (err) {
		log("warn", "plan session removal failed", { thread: plan.thread_id, error: errorMessage(err) });
	}
}

/** Deletes an ended (`done`/`failed`) `/work issue` draft's session and clears `session_file`. No-op otherwise. Never throws. */
export async function removeDraftSession(deps: SessionDeps, draft: DraftRow): Promise<void> {
	try {
		if ((draft.state !== "done" && draft.state !== "failed") || !draft.session_file) return;
		const { kept } = await removeSessions(deps.sessionDir, [draft.session_file], { repo: draft.repo, draft: draft.id });
		if (kept.length === 0) deps.db.updateDraft(draft.id, { session_file: null });
	} catch (err) {
		log("warn", "draft session removal failed", { draft: draft.id, error: errorMessage(err) });
	}
}

/** Engine start (ENG-03 step 4, ENG-05): done/cancelled issues, rejected plans and ended drafts that still store a session. Never throws. */
export async function sweepSessions(deps: SessionDeps): Promise<void> {
	try {
		for (const issue of deps.db.closedIssuesWithSessions()) await removeIssueSessions(deps, issue.id);
		for (const plan of deps.db.plansInState("rejected")) if (plan.session_file) await removePlanSession(deps, plan);
		for (const draft of deps.db.draftsInState("done", "failed")) if (draft.session_file) await removeDraftSession(deps, draft);
	} catch (err) {
		log("warn", "session sweep failed", { error: errorMessage(err) });
	}
}
