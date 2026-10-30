import { type APIButtonComponentWithCustomId, ButtonStyle, ComponentType } from "discord-api-types/v10";
import type { TodoItem, TodoStatus } from "../../shared/agent";
import type { JobKind } from "../engine/state";
import type { Mention } from "./access";
import type { MessageRow, OutFile, OutMessage } from "./surface";

/**
 * Message texts and components (ported from DevForge `src/discord/render.ts`). Components are Discord API JSON so the
 * engine never needs discord.js. Text that names the system takes `agentName` (DSC-30).
 */
export type ComponentId =
	| { type: "plan"; issueId: number; rev: number; action: "approve" | "changes" | "reject" }
	| { type: "job"; jobId: string; action: "retry" }
	| { type: "issue"; repo: string; number: number; action: "handoff" }
	| { type: "ask"; rest: string }
	/** Buttons of a `/work plan` review message: the thread's plan at revision `rev`. */
	| { type: "preq"; threadId: string; rev: number; action: PlanRequestAction }
	/** Approve button of an omp update notice (UPD-02); `version` is the one to install. */
	| { type: "omp"; version: string; action: "approve" };

export type PlanRequestAction = "approve" | "execute" | "refine" | "reject";

/** Discord's hard limit on component custom_id length. */
const MAX_CUSTOM_ID = 100;
const MAX_MESSAGE = 2000;
const MAX_ERROR = 1500;

const PLAN_ACTIONS: Record<string, true> = { approve: true, changes: true, reject: true };
const PLAN_REQUEST_ACTIONS: Record<PlanRequestAction, true> = { approve: true, execute: true, refine: true, reject: true };
const INT = /^\d+$/;
const REPO = /^[^/\s:]+\/[^/\s:]+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function encodeId(id: ComponentId): string {
	let out: string;
	switch (id.type) {
		case "plan":
			out = `plan:${id.issueId}:${id.rev}:${id.action}`;
			break;
		case "job":
			out = `job:${id.jobId}:retry`;
			break;
		case "issue":
			out = `issue:${id.repo}:${id.number}:handoff`;
			break;
		case "ask":
			out = `ask:${id.rest}`;
			break;
		case "preq":
			out = `preq:${id.threadId}:${id.rev}:${id.action}`;
			break;
		case "omp":
			out = `omp:${id.version}:approve`;
			break;
	}
	if (out.length > MAX_CUSTOM_ID) throw new Error(`custom_id exceeds ${MAX_CUSTOM_ID} chars: ${out}`);
	return out;
}

export function parseId(customId: string): ComponentId | undefined {
	if (customId.length > MAX_CUSTOM_ID) return undefined;
	const parts = customId.split(":");
	switch (parts[0]) {
		case "plan": {
			const [, issueId, rev, action] = parts;
			if (parts.length !== 4 || !INT.test(issueId!) || !INT.test(rev!) || !Object.hasOwn(PLAN_ACTIONS, action!)) return undefined;
			return { type: "plan", issueId: Number(issueId), rev: Number(rev), action: action as "approve" | "changes" | "reject" };
		}
		case "job": {
			const [, jobId, action] = parts;
			if (parts.length !== 3 || !jobId || action !== "retry") return undefined;
			return { type: "job", jobId, action };
		}
		case "issue": {
			const [, repo, number, action] = parts;
			if (parts.length !== 4 || !REPO.test(repo!) || !INT.test(number!) || action !== "handoff") return undefined;
			return { type: "issue", repo: repo!, number: Number(number), action };
		}
		case "ask": {
			const rest = customId.slice("ask:".length);
			if (parts.length < 2 || !rest) return undefined;
			return { type: "ask", rest };
		}
		case "preq": {
			const [, threadId, rev, action] = parts;
			if (parts.length !== 4 || !INT.test(threadId!) || !INT.test(rev!) || !Object.hasOwn(PLAN_REQUEST_ACTIONS, action!)) return undefined;
			return { type: "preq", threadId: threadId!, rev: Number(rev), action: action as PlanRequestAction };
		}
		case "omp": {
			const [, version, action] = parts;
			if (parts.length !== 3 || !SEMVER.test(version!) || action !== "approve") return undefined;
			return { type: "omp", version: version!, action };
		}
		default:
			return undefined;
	}
}

type ButtonColour = ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger;

export function button(id: ComponentId | string, label: string, style: ButtonColour): APIButtonComponentWithCustomId {
	return { type: ComponentType.Button, custom_id: typeof id === "string" ? id : encodeId(id), label, style };
}

export function buttonRow(...buttons: APIButtonComponentWithCustomId[]): MessageRow {
	return { type: ComponentType.ActionRow, components: buttons };
}

function textFile(name: string, text: string): OutFile {
	return { name, data: new TextEncoder().encode(text) };
}

function mentionsOf(mention: Mention): OutMessage["mentions"] {
	return mention.users.length > 0 ? { users: mention.users } : undefined;
}

export function planMessage(p: {
	issueId: number;
	rev: number;
	summary: string;
	complexity: string;
	commentUrl: string;
	planMarkdown: string;
	/** The people who can approve, notified by the message (`allowedMentions`). */
	mention: Mention;
}): OutMessage {
	const header = `📋 ${p.mention.text}**Plan ready for your approval** · rev ${p.rev} · complexity: **${p.complexity}** · ${p.commentUrl}\n\n`;
	const footer = "\n\n_**Approve** to start implementing, **Request changes** to revise the plan, or **Reject** to stop. The full plan is attached._";
	const room = MAX_MESSAGE - header.length - footer.length;
	const content = header + (p.summary.length <= room ? p.summary : `${p.summary.slice(0, room - 1)}…`) + footer;
	const plan = (action: "approve" | "changes" | "reject"): ComponentId => ({ type: "plan", issueId: p.issueId, rev: p.rev, action });
	return {
		content,
		files: [textFile(`plan-rev${p.rev}.md`, p.planMarkdown)],
		components: [
			buttonRow(
				button(plan("approve"), "Approve", ButtonStyle.Success),
				button(plan("changes"), "Request changes", ButtonStyle.Secondary),
				button(plan("reject"), "Reject", ButtonStyle.Danger),
			),
		],
		mentions: mentionsOf(p.mention),
	};
}

/** A `/work plan` result for review: summary inline, the full plan attached, and the four decision buttons. */
export function requestPlanMessage(p: {
	threadId: string;
	rev: number;
	title: string;
	summary: string;
	complexity: string;
	planMarkdown: string;
	/** The people who can decide, notified by the message. */
	mention: Mention;
}): OutMessage {
	const header = `📋 ${p.mention.text}**Plan ready for your review** · rev ${p.rev} · complexity: **${p.complexity}**\n**${clipText(p.title, 200)}**\n\n`;
	const footer =
		"\n\n_**Approve** files the plan as a GitHub issue without starting it · **Execute** files it and implements it now (pull request) · **Refine** revises the plan with your feedback · **Reject** discards it. The full plan is attached._";
	const room = MAX_MESSAGE - header.length - footer.length;
	const content = header + (p.summary.length <= room ? p.summary : `${p.summary.slice(0, room - 1)}…`) + footer;
	const id = (action: PlanRequestAction): ComponentId => ({ type: "preq", threadId: p.threadId, rev: p.rev, action });
	return {
		content,
		files: [textFile(`plan-rev${p.rev}.md`, `# ${p.title}\n\n${p.planMarkdown}`)],
		components: [
			buttonRow(
				button(id("approve"), "Approve", ButtonStyle.Success),
				button(id("execute"), "Execute", ButtonStyle.Primary),
				button(id("refine"), "Refine", ButtonStyle.Secondary),
				button(id("reject"), "Reject", ButtonStyle.Danger),
			),
		],
		mentions: mentionsOf(p.mention),
	};
}

/**
 * Notice that a newer omp is available for workers (UPD-02), with the button that installs it. `current` is the omp new
 * workers use now; `failure` explains why an earlier attempt did not work (UPD-03, UPD-08).
 */
export function ompUpdateMessage(p: { current: string; latest: string; failure?: string }): OutMessage {
	const failure = p.failure ? `\n❌ ${clipText(p.failure, MAX_ERROR)}` : "";
	return {
		content: `⬆️ **omp ${p.latest}** is available (workers use ${p.current}). Approving installs it for new workers; workers already running keep their omp, and nothing restarts.${failure}\nhttps://www.npmjs.com/package/@oh-my-pi/pi-coding-agent/v/${p.latest}`,
		components: [buttonRow(button({ type: "omp", version: p.latest, action: "approve" }, "Approve update", ButtonStyle.Success))],
	};
}

export function failureMessage(p: { jobId: string; kind: JobKind; error: string }): OutMessage {
	return {
		content: `❌ ${p.kind} failed: ${p.error.slice(0, MAX_ERROR)}`,
		components: [buttonRow(button({ type: "job", jobId: p.jobId, action: "retry" }, "Retry", ButtonStyle.Primary))],
	};
}

export function handoffMessage(p: { agentName: string; repo: string; number: number; url: string }): OutMessage {
	return {
		content: `Created ${p.url}`,
		components: [
			buttonRow(button({ type: "issue", repo: p.repo, number: p.number, action: "handoff" }, clipText(`Hand to ${p.agentName}`, 80), ButtonStyle.Primary)),
		],
	};
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
}

export type ProgressState = "running" | "waiting" | "done" | "failed" | "cancelled";

const PROGRESS_STATES: Record<ProgressState, { icon: string; text: string }> = {
	running: { icon: "🛠️", text: "working" },
	waiting: { icon: "⏸️", text: "waiting for your answer below" },
	done: { icon: "✅", text: "finished" },
	failed: { icon: "❌", text: "failed" },
	cancelled: { icon: "⏹️", text: "cancelled" },
};

/** The live progress message of a job or chat run; while running, the second line shows what the agent is doing. */
export function progressLine(p: { title: string; state: ProgressState; elapsedMs: number; cost: number; activity: string }): string {
	const { icon, text } = PROGRESS_STATES[p.state];
	const line = `${icon} **${p.title}** · ${text} · ${formatElapsed(p.elapsedMs)} · $${p.cost.toFixed(2)}`;
	return p.state === "running" ? `${line}\n↳ ${p.activity}` : line;
}

/** What the agent is doing, from its latest tool call. */
export function activityText(tool: string | undefined, intent: string | undefined): string {
	if (!tool) return "Thinking…";
	return intent ? `${intent} (\`${tool}\`)` : `Running \`${tool}\``;
}

export function clipText(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export const TODO_ICONS: Record<TodoStatus, string> = { pending: "⬜", in_progress: "🔄", completed: "✅", failed: "❌" };
const MAX_TODO_TEXT = 200;

/** The agent's todo list: a count header and one icon line per step, cut with "… N more" to fit `max` characters. */
export function todoList(todos: TodoItem[], max = MAX_MESSAGE): string {
	const done = todos.filter(todo => todo.status === "completed").length;
	const failed = todos.filter(todo => todo.status === "failed").length;
	let text = `📝 **To-do** · ${done}/${todos.length} done${failed ? ` · ${failed} failed` : ""}`;
	for (const [i, todo] of todos.entries()) {
		const line = `\n${TODO_ICONS[todo.status]} ${clipText(todo.content.replace(/\s+/g, " "), MAX_TODO_TEXT)}`;
		const left = todos.length - i - 1;
		// Room for this line plus, if more follow, the "… N more" marker.
		if (text.length + line.length + (left > 0 ? `\n… ${left} more`.length : 0) > max) {
			return `${text}\n… ${todos.length - i} more`;
		}
		text += line;
	}
	return text;
}

/** First message in a new issue thread. */
export function queuedMessage(issueUrl: string, agentName: string): string {
	return `📥 **Queued for planning** — ${issueUrl}
${agentName} will post its progress here, ask any questions here (answer with the buttons or by replying in this thread), and post the plan for your approval.`;
}

/** Reply to `/work issue`: what was filed and where the agent is working on it. User text is clipped to fit one message. */
export function issueCreatedMessage(p: {
	agentName: string;
	repo: string;
	number: number;
	url: string;
	title: string;
	description: string;
	label: string;
	createdBy: string;
	threadId?: string;
}): string {
	const next = p.threadId
		? `${p.agentName} is planning it in <#${p.threadId}>; progress, questions and the plan will appear there.`
		: `${p.agentName} will open its thread on the next poll.`;
	// Headings don't render inside a Discord quote; show them as bold lines.
	const excerpt = clipText(p.description.replace(/^#{1,6}\s+(.+)$/gm, "**$1**"), 600);
	const description = excerpt ? `\n> ${excerpt.replaceAll("\n", "\n> ")}` : "";
	return `✅ **Issue created** — **#${p.number}** ${clipText(p.title, 200)}
${p.url}
Repository \`${p.repo}\` · label \`${p.label}\` · filed by ${p.createdBy}${description}
${next}`;
}

/** Shown on the PR, in follow-up comments and in Discord when the kernel OOM-killed processes during a run (AGT-17); empty for 0. */
export function oomWarning(kills: number, agentName: string): string {
	if (kills <= 0) return "";
	return `⚠️ **Local verification incomplete** — the kernel killed ${kills} process(es) in ${agentName}'s worker for lack of memory during this run (usually \`tsc\` or the test runner), so the checks reported below may not have finished. Rely on CI.`;
}

/** Posted after the implementation run opened its pull request; may exceed one message, send with `chunkText`. */
export function implementDoneMessage(p: {
	agentName: string;
	prNumber: number;
	prUrl: string;
	prTitle: string;
	prBody: string;
	testing: string;
	mentionKeyword: string;
	oomKills: number;
	/** CI outcome note (passed / no run / timed out), shown below the testing line. */
	ci?: string;
}): string {
	const warning = p.oomKills > 0 ? `${oomWarning(p.oomKills, p.agentName)}\n\n` : "";
	return `✅ **Implementation complete** — opened PR #${p.prNumber}: ${p.prUrl}

**${p.prTitle}**
${clipText(p.prBody, 1200)}

${warning}**Testing:** ${clipText(p.testing, 500)}${p.ci ? `\n\n**CI:** ${p.ci}` : ""}

_Next: review the pull request on GitHub. Reviews, inline comments, and comments containing \`${p.mentionKeyword}\` make ${p.agentName} revise it here; merging it completes this thread._`;
}

/** Posted after a review-feedback or CI-fix run (DSC-22). A fix_ci message carries its attempt out of `maxCiFixAttempts`. */
export function followUpMessage(
	p: { agentName: string; prNumber: number; pushed: boolean; summary: string; oomKills: number } & (
		| { kind: "revise" }
		| { kind: "fix_ci"; attempt: number; maxAttempts: number; checks?: string }
	),
): string {
	const summary = clipText(p.summary, 1500);
	const warning = p.oomKills > 0 ? `\n\n${oomWarning(p.oomKills, p.agentName)}` : "";
	if (p.kind === "revise") {
		const head = p.pushed ? `✅ **Review feedback addressed** — pushed changes to PR #${p.prNumber}.` : `✅ **Review feedback handled** — no code changes were needed on PR #${p.prNumber}.`;
		return `${head}${warning}\n\n${summary}\n\n_Waiting for more review or for the PR to be merged._`;
	}
	const attempt = `(attempt ${p.attempt}/${p.maxAttempts})`;
	if (p.pushed) return `✅ **CI fix pushed** to PR #${p.prNumber} ${attempt}.${warning}\n\n${summary}\n\n_Waiting for the checks to run again._`;
	return `⚠️ **Couldn't fix the failing checks** (${p.checks ?? "unknown"}) on PR #${p.prNumber} ${attempt} — this needs a human.${warning}\n\n${summary}`;
}

/** Posted after a CI fix was pushed while the pull request is still waiting for green CI. */
export function ciFixBeforePrMessage(p: { agentName: string; branch: string; attempt: number; maxAttempts: number; summary: string; oomKills: number }): string {
	const warning = p.oomKills > 0 ? `\n\n${oomWarning(p.oomKills, p.agentName)}` : "";
	return `✅ **CI fix pushed** to \`${p.branch}\` (attempt ${p.attempt}/${p.maxAttempts}).${warning}\n\n${clipText(p.summary, 1500)}\n\n_Waiting for CI again before opening the pull request._`;
}

/** Splits text into ≤max-char chunks on paragraph boundaries; oversize paragraphs are hard-split (DSC-14). */
export function chunkText(text: string, max = MAX_MESSAGE): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n{2,}/)) {
		if (!paragraph.trim()) continue;
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (candidate.length <= max) {
			current = candidate;
			continue;
		}
		if (current) chunks.push(current);
		current = "";
		let rest = paragraph;
		while (rest.length > max) {
			const nl = rest.lastIndexOf("\n", max);
			const cut = nl > 0 ? nl : max;
			chunks.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^\n/, "");
		}
		current = rest;
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Most files Discord accepts in one message. */
const MAX_FILES_PER_MESSAGE = 10;
const ANSWER_TRUNCATED = "\n\n_[Answer truncated: it exceeded the upload limit.]_";

/** A file a run produced, ready to upload. */
export interface UploadFile {
	name: string;
	size: number;
	data: Uint8Array;
}

function mibText(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

/** `name` made unique among `taken` (`a.csv`, `a-1.csv`, …) and recorded there. */
function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let candidate = name;
	for (let n = 1; taken.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
	taken.add(candidate);
	return candidate;
}

/** Upload messages for `files`: batches of at most 10 files under `limit` bytes, then a line naming the files over `limit` (not attached). */
function fileMessages(files: UploadFile[], limit: number, taken: Set<string>): { messages: OutMessage[]; tooLarge: string[]; attached: number } {
	const tooLarge: string[] = [];
	const batches: UploadFile[][] = [];
	let batch: UploadFile[] = [];
	let batchBytes = 0;
	for (const file of files) {
		if (file.size > limit) {
			tooLarge.push(file.name);
			continue;
		}
		if (batch.length === MAX_FILES_PER_MESSAGE || batchBytes + file.size > limit) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(file);
		batchBytes += file.size;
	}
	if (batch.length > 0) batches.push(batch);
	const messages: OutMessage[] = batches.map(b => ({
		content: `📎 ${b.map(f => `\`${f.name}\``).join(", ")}`.slice(0, MAX_MESSAGE),
		files: b.map(f => ({ name: uniqueName(f.name, taken), data: f.data })),
	}));
	if (tooLarge.length > 0) messages.push({ content: `⚠️ Too large to attach (over ${mibText(limit)}): ${tooLarge.join(", ")}`.slice(0, MAX_MESSAGE) });
	return { messages, tooLarge, attached: batches.reduce((n, b) => n + b.length, 0) };
}

/** Upload messages for files an ask-only run produced when it ended without an answer (stopped or over a limit). */
export function producedFilesMessages(files: UploadFile[], limit: number): { messages: OutMessage[]; tooLarge: string[] } {
	const { messages, tooLarge } = fileMessages(files, limit, new Set());
	return { messages, tooLarge };
}

/**
 * The messages that deliver an ask-only chat's result: the answer as an attached `answer.md` with a short pointer, the
 * files the agent produced in batches of at most 10 files under `limit` bytes, and a final line naming the files that
 * were over `limit` (those are not attached). Mentions stay off (OutMessage default).
 */
export function askAnswerMessages(answer: string, files: UploadFile[], limit: number): { messages: OutMessage[]; tooLarge: string[] } {
	const { messages: fileParts, tooLarge, attached } = fileMessages(files, limit, new Set(["answer.md"]));
	const encoder = new TextEncoder();
	let bytes = encoder.encode(answer);
	if (bytes.length > limit) {
		const note = encoder.encode(ANSWER_TRUNCATED);
		const out = new Uint8Array(limit);
		out.set(bytes.subarray(0, limit - note.length));
		out.set(note, limit - note.length);
		bytes = out;
	}
	const extra = attached > 0 ? ` and ${attached} generated file${attached === 1 ? "" : "s"} below` : "";
	const first: OutMessage = { content: `📄 **Answer attached:** \`answer.md\`${extra}`, files: [{ name: "answer.md", data: bytes }] };
	return { messages: [first, ...fileParts], tooLarge };
}
