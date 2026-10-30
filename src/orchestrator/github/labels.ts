import type { LabelNames } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import type { EngineDeps } from "../engine/deps";
import { type IssueState, stateLabel, TERMINAL_STATES } from "../engine/state";
import type { GitHub } from "./types";

/** kv key holding the JSON `LabelNames` last applied to every tracked issue (GH-23). */
export const APPLIED_LABELS_KEY = "labels.applied";
/** kv key holding the JSON `LabelNames` a relabel is moving away from while it has not succeeded everywhere. */
const RELABEL_FROM_KEY = "labels.relabelFrom";

/** GH-09: swap the issue's state label. Nothing is sent when the label is unchanged; callers log failures. */
export async function syncLabels(github: GitHub, labels: LabelNames, repo: string, n: number, from: IssueState, to: IssueState): Promise<void> {
	const fromLabel = stateLabel(from, labels);
	const toLabel = stateLabel(to, labels);
	if (fromLabel === toLabel) return;
	if (fromLabel) await github.removeLabel(repo, n, fromLabel);
	if (toLabel) await github.addLabels(repo, n, [toLabel]);
}

function sameLabels(a: LabelNames, b: LabelNames): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function storedLabels(deps: Pick<EngineDeps, "db">, key: string): LabelNames | undefined {
	const raw = deps.db.kvGet(key);
	return raw ? (JSON.parse(raw) as LabelNames) : undefined;
}

/**
 * True while label names changed and the relabel (GH-23) has not finished: GH-13 must not judge issues by the new
 * trigger name until they carry it.
 */
export function relabelPending(deps: Pick<EngineDeps, "db" | "labels">): boolean {
	const applied = storedLabels(deps, APPLIED_LABELS_KEY);
	return applied !== undefined && !sameLabels(applied, deps.labels);
}

/**
 * GH-23, GH-24: when the effective label names differ from those last applied, move every non-terminal tracked issue
 * to the new trigger and state labels. Repo labels are never deleted or renamed. Any failure is logged and leaves the
 * relabel pending, so the next call (next poll cycle) retries; the new names are stored only when all issues succeeded.
 * The first run with no stored names just records them. Never throws; returns the issues that failed.
 */
export async function relabelTrackedIssues(deps: EngineDeps): Promise<{ failed: number }> {
	const applied = storedLabels(deps, APPLIED_LABELS_KEY);
	const next = deps.labels;
	if (!applied) {
		deps.db.kvSet(APPLIED_LABELS_KEY, JSON.stringify(next));
		return { failed: 0 };
	}
	if (sameLabels(applied, next)) return { failed: 0 };
	// A rename during a pending relabel keeps the oldest names as the ones to remove.
	const from = storedLabels(deps, RELABEL_FROM_KEY) ?? applied;
	deps.db.kvSet(RELABEL_FROM_KEY, JSON.stringify(from));
	let failed = 0;
	for (const issue of deps.db.openIssues()) {
		if (TERMINAL_STATES[issue.state]) continue;
		const add = [next.trigger, stateLabel(issue.state, next)].filter((l): l is string => !!l);
		const remove = [from.trigger, stateLabel(issue.state, from)].filter((l): l is string => !!l && !add.includes(l));
		try {
			await deps.github.addLabels(issue.repo, issue.number, add);
			for (const label of remove) await deps.github.removeLabel(issue.repo, issue.number, label);
		} catch (err) {
			failed++;
			log("warn", "relabel failed", { repo: issue.repo, issue: issue.number, error: errorMessage(err) });
		}
	}
	if (failed === 0) {
		deps.db.kvSet(APPLIED_LABELS_KEY, JSON.stringify(next));
		deps.db.kvSet(RELABEL_FROM_KEY, "");
		log("info", "relabelled tracked issues", { trigger: next.trigger });
	}
	return { failed };
}
