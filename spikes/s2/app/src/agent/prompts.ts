import type { GhIssue } from "../github/app";
import type { CiFailure, FeedbackItem } from "../github/feedback";

export interface PlanOutput {
	summary: string;
	planMarkdown: string;
	complexity: "small" | "medium" | "large";
}

/** `/forge plan`: the plan plus a title for the GitHub issue it becomes on Approve or Execute. */
export interface RequestPlanOutput extends PlanOutput {
	title: string;
}

export interface ImplementOutput {
	prTitle: string;
	prBody: string;
	testing: string;
}

export interface ReviseOutput {
	summary: string;
}

export interface ChatOutput {
	answer: string;
}

export interface IssueDraftOutput {
	title: string;
	body: string;
}

export const PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["summary", "planMarkdown", "complexity"],
	properties: {
		summary: { type: "string" },
		planMarkdown: { type: "string" },
		complexity: { enum: ["small", "medium", "large"] },
	},
};

export const REQUEST_PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["title", "summary", "planMarkdown", "complexity"],
	properties: { title: { type: "string" }, ...PLAN_SCHEMA.properties },
};

export const IMPLEMENT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["prTitle", "prBody", "testing"],
	properties: {
		prTitle: { type: "string" },
		prBody: { type: "string" },
		testing: { type: "string" },
	},
};

/** Used for both revise and fix_ci jobs. */
export const REVISE_SCHEMA = {
	type: "object",
	required: ["summary"],
	properties: { summary: { type: "string" } },
};

export const CHAT_SCHEMA = {
	type: "object",
	required: ["answer"],
	properties: { answer: { type: "string" } },
	additionalProperties: false,
};

export const ISSUE_DRAFT_SCHEMA = {
	type: "object",
	required: ["title", "body"],
	properties: { title: { type: "string" }, body: { type: "string" } },
	additionalProperties: false,
};

export const RESTART_NOTE =
	"DevForge restarted while you were working. Inspect the worktree (git status, git log) and continue the same task from where it stopped.";

const COMMENT_MAX_CHARS = 4000;
const LOG_TAIL_MAX_LINES = 300;

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

function issueBlock(issue: GhIssue): string {
	return [`## Issue #${issue.number}: ${issue.title}`, `URL: ${issue.html_url}`, "", issue.body.trim() || "(no description)"].join("\n");
}

const GIT_RULES =
	"Never push, never change git remotes, never touch credentials or authentication configuration. DevForge pushes for you.";

/** The machine can be too small for `tsc` or the test runner; a killed command must not be retried (D-053). */
const MEMORY_RULE =
	"If a command exits with code 137 or prints `Killed`, the machine ran out of memory: do not run it again, and say in your final output that it did not complete.";

/** Planning-only rules shared by issue plans and `/forge plan`; `subject` names what is being planned. */
function planRules(subject: string, yieldFields: string): string[] {
	return [
		`You are planning only. Produce an implementation plan for ${subject}; a human will review it before any code is written.`,
		"- Do not modify, create, or delete any files.",
		"- Use bash only to read the repository or to run existing tests/builds. No commands with side effects.",
		`- ${MEMORY_RULE}`,
		"- If something is genuinely ambiguous and the answer changes the plan, use the `ask` tool. Do not ask about things you can find out yourself.",
		`- Finish by calling \`yield\` with ${yieldFields}.`,
	];
}

const PLAN_YIELD = "`summary` (a few sentences), `planMarkdown` (the full plan), and `complexity` (small, medium, or large)";

function revisionBlock(revision: { feedback: string; previousPlan: string }): string[] {
	return [
		"",
		"## Revision requested",
		"A human reviewed your previous plan and asked for changes. Revise the plan to address the feedback.",
		"",
		"### Feedback",
		revision.feedback,
		"",
		"### Previous plan",
		revision.previousPlan,
	];
}

export function planPrompt(
	issue: GhIssue,
	comments: { author: string; body: string }[],
	revision?: { feedback: string; previousPlan: string },
): string {
	const parts = [...planRules("the GitHub issue below", PLAN_YIELD), "", issueBlock(issue)];
	if (comments.length > 0) {
		parts.push("", "## Comments");
		for (const comment of comments) {
			parts.push("", `### @${comment.author}`, truncate(comment.body, COMMENT_MAX_CHARS));
		}
	}
	if (revision) parts.push(...revisionBlock(revision));
	return parts.join("\n");
}

/** `/forge plan`: plan a free-text request from Discord. The plan may become a GitHub issue, hence the title. */
export function requestPlanPrompt(request: string, revision?: { feedback: string; previousPlan: string }): string {
	const parts = [
		...planRules(
			"the request below",
			`\`title\` (a GitHub issue title for this work: imperative, under 80 characters, no prefix such as \`feat:\`), ${PLAN_YIELD}`,
		),
		"",
		"## Request",
		request,
	];
	if (revision) parts.push(...revisionBlock(revision));
	return parts.join("\n");
}

export function implementPrompt(issue: GhIssue, planMarkdown: string): string {
	return [
		"Implement the approved plan below on the current branch.",
		"- Keep the changes scoped to the plan.",
		"- Run the project's tests and linters, and fix what you broke. If you cannot build or test the project here, say so in `testing`; DevForge waits for the repository's CI on the pushed branch before opening the pull request.",
		`- ${MEMORY_RULE}`,
		`- Commit your work with messages that reference #${issue.number}.`,
		`- ${GIT_RULES}`,
		"- Finish by calling `yield` with `prTitle`, `prBody` (Markdown, describing the change), and `testing` (what you ran and the results).",
		"",
		issueBlock(issue),
		"",
		"## Approved plan",
		planMarkdown,
	].join("\n");
}

function feedbackItemText(item: FeedbackItem): string {
	const location = item.path ? ` (${item.path}${item.line !== undefined ? `:${item.line}` : ""})` : "";
	const lines = [`[${item.kind}] @${item.author}${location}`];
	if (item.kind === "inline" && item.diffHunk) lines.push("```diff", item.diffHunk, "```");
	lines.push(item.body);
	return lines.join("\n");
}

export function revisePrompt(items: FeedbackItem[]): string {
	return [
		"Reviewers left feedback on the pull request for this branch. Address it.",
		"- Make the requested changes and commit them. Where you disagree with a comment, explain why in your summary instead of changing code.",
		"- Run the project's tests and linters.",
		`- ${MEMORY_RULE}`,
		`- ${GIT_RULES} Do not push.`,
		"- Finish by calling `yield` with `summary`: what you changed for each item, suitable to post as a PR comment.",
		"",
		"## Feedback",
		...items.flatMap(item => ["", feedbackItemText(item)]),
	].join("\n");
}

function failureText(failure: CiFailure): string {
	const lines = [`### ${failure.name} (${failure.conclusion})`];
	if (failure.summary) lines.push("", failure.summary);
	if (failure.logTail) {
		const tail = failure.logTail.split("\n").slice(-LOG_TAIL_MAX_LINES).join("\n");
		lines.push("", "Log tail:", "```", tail, "```");
	}
	return lines.join("\n");
}

export function fixCiPrompt(failures: CiFailure[], opts?: { beforePr?: boolean }): string {
	return [
		opts?.beforePr
			? "CI checks failed on this branch (DevForge opens the pull request once CI passes). Find the cause and fix it."
			: "CI checks failed on this branch's pull request. Find the cause and fix it.",
		"- Fix the root cause, not the symptom. Do not disable or skip checks.",
		"- Commit the fix.",
		`- ${MEMORY_RULE}`,
		`- ${GIT_RULES} Do not push.`,
		"- Finish by calling `yield` with `summary`: the cause and the fix, suitable to post as a PR comment.",
		"",
		"## Failed checks",
		...failures.flatMap(failure => ["", failureText(failure)]),
	].join("\n");
}

export function chatPrompt(question: string): string {
	return [
		"Answer questions about this repository. Do not modify any files; use bash only to read the repository or run read-only commands.",
		"If the user asks for work to be filed, call `create_issue` with a complete, self-contained issue (clear title, context, and acceptance criteria).",
		"Finish by calling `yield` with `answer`: your reply in Markdown.",
		"",
		"## Question",
		question,
	].join("\n");
}

/** `## Attached files` block lines: the paths (relative to the workspace) of files the user attached; none when there are no files. */
function attachedFilesBlock(files: readonly string[]): string[] {
	return files.length > 0 ? ["", "## Attached files", ...files.map(file => `- ${file}`)] : [];
}

/** `/ask` in an ask-only channel: a general assistant with no repository, working in a scratch workspace. */
export function askPrompt(question: string, files: readonly string[]): string {
	return [
		"You are a general-purpose assistant answering a question from a Discord user. There is no repository: you work in a private scratch workspace.",
		"- You can only reach files through `list_files`, `read_file` and `write_file`; paths are relative to the workspace. You have no shell and cannot run code. Use `web_search` for current information.",
		"- Files the user attached are in `inputs/`. `read_file` also converts PDF, DOCX, PPTX, XLSX and EPUB files to Markdown and shows PNG, JPEG, GIF and WebP images.",
		"- Write a file to `outputs/` only when the user asks for a file other than your answer (for example CSV, JSON, HTML, SVG or a script). Every file you create or change in `outputs/` is attached to the Discord thread. Only text formats can be written; if the user asks for a binary format such as PDF, say so and offer a text alternative.",
		"- Do not create a file for the answer itself: DevForge posts your `answer` as `answer.md`.",
		"- Finish by calling `yield` with `answer`: your reply in Markdown, mentioning any files you produced.",
		"",
		"## Question",
		question,
		...attachedFilesBlock(files),
	].join("\n");
}

/** A follow-up (or steering) message in an ask-only thread; `note` is DevForge's remark about the workspace, if any. */
export function askFollowUp(text: string, files: readonly string[], note?: string): string {
	return [...(note ? [`Note: ${note}`, ""] : []), text, ...attachedFilesBlock(files)].join("\n");
}

/** `/forge issue`: turn a one-line request into a grounded, self-contained issue (read-only run). */
export function issueDraftPrompt(request: string): string {
	return [
		"Turn the request below into a GitHub issue for this repository. DevForge will plan and implement it from the issue alone, so it must be complete and self-contained.",
		"- Read the repository first to ground the issue: find the files, modules and current behaviour involved. Do not modify any files; use bash only for read-only commands.",
		"- Stay within what the request asks for. Do not invent requirements; list genuine open questions in the issue instead of guessing.",
		"- `title`: one line, imperative mood, under 80 characters, no prefix such as `feat:`.",
		"- `body`: Markdown with `## Summary` (what and why), `## Context` (relevant code with file paths), `## Acceptance criteria` (a checklist of observable results), and `## Open questions` only if there are any.",
		"Finish by calling `yield` with `title` and `body`.",
		"",
		"## Request",
		request,
	].join("\n");
}
