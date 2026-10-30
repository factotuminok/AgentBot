import { z } from "zod";
import { errorMessage } from "../../shared/log";
import type { CiFailure } from "./feedback";
import type { GhCheckRun, GitHub, RepoWorkflow } from "./types";

export type { RepoWorkflow };

const PatternList = z.union([z.string().transform(p => [p]), z.array(z.string())]);

const PushFilter = z.object({
	branches: PatternList.optional(),
	"branches-ignore": PatternList.optional(),
	tags: PatternList.optional(),
	"tags-ignore": PatternList.optional(),
});

/** The part of a workflow file that decides push triggering. `push: null` = bare `push:`. */
const WorkflowTriggers = z.object({
	on: z.union([z.string().transform(e => [e]), z.array(z.string()), z.object({ push: PushFilter.nullable().optional() })]),
});

function globMatches(pattern: string, name: string): boolean {
	try {
		return new Bun.Glob(pattern).match(name);
	} catch {
		return false;
	}
}

/** GitHub's branch filter: patterns in order, a matching `!pattern` turns the result off, a matching plain one turns it on. */
function branchFilterMatches(filter: string[], branch: string): boolean {
	let matched = false;
	for (const pattern of filter) {
		if (pattern.startsWith("!")) {
			if (globMatches(pattern.slice(1), branch)) matched = false;
		} else if (globMatches(pattern, branch)) matched = true;
	}
	return matched;
}

/**
 * Whether a workflow file's `on:` makes a push of `branch` start it. `paths`/`paths-ignore` are not evaluated
 * (the no-run grace period covers them). An unparsable or oddly shaped file counts as triggering: the grace
 * period bounds the wait, so over-detecting is the safe error.
 */
export function pushTriggersBranch(source: string, branch: string): boolean {
	let parsed: z.ZodSafeParseResult<z.infer<typeof WorkflowTriggers>>;
	try {
		parsed = WorkflowTriggers.safeParse(Bun.YAML.parse(source));
	} catch {
		return true;
	}
	if (!parsed.success) return true;
	const { on } = parsed.data;
	if (Array.isArray(on)) return on.includes("push");
	if (on.push === undefined) return false;
	// `push:` without config matches every branch and tag.
	const filter = on.push ?? {};
	if (filter.branches) return branchFilterMatches(filter.branches, branch);
	const ignore = filter["branches-ignore"];
	if (ignore) return !ignore.some(p => globMatches(p, branch));
	return filter.tags === undefined && filter["tags-ignore"] === undefined;
}

/** Workflows whose push trigger covers `branch`; a workflow whose file is missing at the ref does not count. */
export function pushCiWorkflows(workflows: RepoWorkflow[], branch: string): RepoWorkflow[] {
	return workflows.filter(w => w.source !== null && pushTriggersBranch(w.source, branch));
}

/** GH-21: failing check runs with the log tail of GitHub Actions jobs, for the fix prompt. */
export async function collectCiFailures(
	github: Pick<GitHub, "getActionsJobLogTail">,
	repo: string,
	runs: GhCheckRun[],
): Promise<CiFailure[]> {
	const failures: CiFailure[] = [];
	for (const run of runs) {
		const failure: CiFailure = {
			checkRunId: run.id,
			name: run.name,
			conclusion: run.conclusion ?? "failure",
			summary: run.output.summary,
		};
		if (run.app?.slug === "github-actions") {
			failure.logTail = await github.getActionsJobLogTail(repo, run.id).catch(err => `(log unavailable: ${errorMessage(err)})`);
		}
		failures.push(failure);
	}
	return failures;
}
