import { describe, expect, test } from "bun:test";
import { collectCiFailures, pushCiWorkflows, pushTriggersBranch } from "../../src/orchestrator/github/ci";
import type { GhCheckRun } from "../../src/orchestrator/github/types";

const BRANCH = "agentbot/issue-1-add-thing";

describe("pushTriggersBranch", () => {
	test("string, array and map forms of `on: push`", () => {
		expect(pushTriggersBranch("on: push\njobs: {}", BRANCH)).toBe(true);
		expect(pushTriggersBranch("on: [pull_request, push]\njobs: {}", BRANCH)).toBe(true);
		expect(pushTriggersBranch("on:\n  push:\n  pull_request:\njobs: {}", BRANCH)).toBe(true);
	});

	test("pull_request-only and other triggers do not run on a bare push", () => {
		expect(pushTriggersBranch("on: pull_request", BRANCH)).toBe(false);
		expect(pushTriggersBranch("on: [pull_request, workflow_dispatch]", BRANCH)).toBe(false);
		expect(pushTriggersBranch("on:\n  pull_request:\n    branches: [main]\n  schedule:\n    - cron: '0 0 * * *'", BRANCH)).toBe(false);
	});

	test("branch filters", () => {
		expect(pushTriggersBranch("on:\n  push:\n    branches: [main]", BRANCH)).toBe(false);
		expect(pushTriggersBranch('on:\n  push:\n    branches: ["**"]', BRANCH)).toBe(true);
		expect(pushTriggersBranch("on:\n  push:\n    branches: agentbot/**", BRANCH)).toBe(true);
		expect(pushTriggersBranch("on:\n  push:\n    branches: [main, 'release/*']", BRANCH)).toBe(false);
		expect(pushTriggersBranch("on:\n  push:\n    branches: [main, 'agentbot/*']", BRANCH)).toBe(true);
	});

	test("negated branch patterns apply in order", () => {
		expect(pushTriggersBranch('on:\n  push:\n    branches: ["**", "!agentbot/**"]', BRANCH)).toBe(false);
		expect(pushTriggersBranch('on:\n  push:\n    branches: ["!agentbot/**", "**"]', BRANCH)).toBe(true);
	});

	test("branches-ignore", () => {
		expect(pushTriggersBranch("on:\n  push:\n    branches-ignore: ['agentbot/**']", BRANCH)).toBe(false);
		expect(pushTriggersBranch("on:\n  push:\n    branches-ignore: [main]", BRANCH)).toBe(true);
	});

	test("tag-only push triggers never start on a branch push", () => {
		expect(pushTriggersBranch("on:\n  push:\n    tags: ['v*']", BRANCH)).toBe(false);
		expect(pushTriggersBranch("on:\n  push:\n    tags-ignore: ['v*']", BRANCH)).toBe(false);
		expect(pushTriggersBranch("on:\n  push:\n    tags: ['v*']\n    branches: ['**']", BRANCH)).toBe(true);
	});

	test("paths filters are not evaluated", () => {
		expect(pushTriggersBranch("on:\n  push:\n    paths-ignore: ['**.md']", BRANCH)).toBe(true);
	});

	test("unparsable or oddly shaped workflow files count as triggering", () => {
		expect(pushTriggersBranch("on: [unclosed\n  : :", BRANCH)).toBe(true);
		expect(pushTriggersBranch("jobs: {}", BRANCH)).toBe(true);
		expect(pushTriggersBranch("on:\n  push: 5", BRANCH)).toBe(true);
	});
});

describe("pushCiWorkflows", () => {
	test("keeps push-triggered workflows with a readable file", () => {
		const workflows = [
			{ name: "CI", path: ".github/workflows/ci.yml", source: "on: push" },
			{ name: "CD", path: ".github/workflows/cd.yml", source: "on:\n  push:\n    branches: [main]" },
			{ name: "PR", path: ".github/workflows/pr.yml", source: "on: pull_request" },
			{ name: "Gone", path: ".github/workflows/gone.yml", source: null },
		];
		expect(pushCiWorkflows(workflows, BRANCH).map(w => w.name)).toEqual(["CI"]);
	});
});

describe("collectCiFailures", () => {
	const check = (over: Partial<GhCheckRun>): GhCheckRun => ({
		id: 1,
		name: "build",
		status: "completed",
		conclusion: "failure",
		app: { slug: "github-actions" },
		check_suite: null,
		output: { summary: "boom" },
		...over,
	});

	test("attaches log tails for GitHub Actions runs only and survives unavailable logs", async () => {
		const github = {
			getActionsJobLogTail: async (_repo: string, id: number) => {
				if (id === 3) throw new Error("expired");
				return `log ${id}`;
			},
		};
		const failures = await collectCiFailures(github, "o/r", [
			check({ id: 1 }),
			check({ id: 2, app: { slug: "circleci" } }),
			check({ id: 3, conclusion: "timed_out" }),
		]);
		expect(failures).toEqual([
			{ checkRunId: 1, name: "build", conclusion: "failure", summary: "boom", logTail: "log 1" },
			{ checkRunId: 2, name: "build", conclusion: "failure", summary: "boom" },
			{ checkRunId: 3, name: "build", conclusion: "timed_out", summary: "boom", logTail: "(log unavailable: expired)" },
		]);
	});
});
