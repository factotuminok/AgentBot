import { ComponentType, TextInputStyle } from "discord-api-types/v10";
import { errorMessage, log } from "../../shared/log";
import { allowedMentions, memberAllowed } from "../discord/access";
import { type Progress, startProgress } from "../discord/progress";
import { acknowledgeSteer, createDiscordUI } from "../discord/questions";
import { activityText, type ComponentId, encodeId, requestPlanMessage } from "../discord/render";
import type { CommandEvent, ComponentEvent, MessageEvent, ModalEvent, MsgRef } from "../discord/surface";
import { ISSUE_ICONS, setTopIcon } from "../discord/topMessage";
import { type CheckoutRequest, RunDetached, type RunHandle, RunLost, type RunOwner, type RunResult } from "../dispatch/dispatcher";
import { PLAN_THREAD_MARKER } from "../github/poller";
import type { AvailableRepo } from "../github/types";
import { type IssueRow, type PlanRow, parseJson } from "../store/db";
import { createRunUiStore } from "../store/runUi";
import { planThreadSessionKey, removePlanSession } from "../store/sessions";
import { loadoutKey } from "../store/stats";
import { CAPACITY_REACHED } from "./chatSlots";
import type { EngineDeps, Scheduler } from "./deps";
import { PLAN_COMMENT_MARKER, type PlanJobResult } from "./jobs";
import { REQUEST_PLAN_SCHEMA, type RequestPlanOutput, requestPlanPrompt, restartNote, runPrompt } from "./prompts";
import { stateLabel } from "./state";

/**
 * `/work plan` (DSC-25 to DSC-28), ported from DevForge `src/engine/plans.ts` onto the surface and the dispatcher: each
 * planning turn is a `plan` run on a worker with a private checkout of the base branch. Runs outlive the engine: stopping
 * it detaches (RUN-09), starting it re-attaches and keeps editing the same messages (RUN-14). Every externally visible
 * step of a decision is recorded in the plan row (`issue_number`, `review_message_id`, `executed_at`) so a restart at any
 * point neither loses nor repeats it (NFR-03).
 */

export const STALE_PLAN = "This plan is no longer current.";
/** Custom id of the text input in the plan feedback modals (Request changes, Refine). */
export const FEEDBACK_FIELD = "feedback";
/** GitHub's limit on issue titles. */
const TITLE_MAX = 256;
/** Below GitHub's 65,536-character limit on issue and comment bodies, leaving room for the surrounding text. */
const PLAN_TEXT_MAX = 60_000;
const MAX_MESSAGE = 2000;
const THREAD_NAME_MAX = 100;

export interface Planner {
	/** `/work plan repo prompt`: access checked, repo resolved and the interaction ALREADY deferred ephemerally — answer with `e.editReply` only. Refuses up front when `deps.chatSlots.full()` (decision 1). Otherwise posts the starter `📋 **Plan** — <request>` in `e.where.channelId`, starts a thread from it, records the plan, replies with the thread link, and runs planning (DSC-25). */
	command(e: CommandEvent, repo: AvailableRepo): Promise<void>;
	/** A `preq` button (DSC-26): Approve, Execute, Refine (opens a modal whose custom id is `encodeId` of the same preq id), Reject. Stale clicks get `This plan is no longer current.` Compare-and-set via `db.claimPlan`. */
	component(e: ComponentEvent, id: Extract<ComponentId, { type: "preq" }>): Promise<void>;
	/** The Refine modal submit. */
	modal(e: ModalEvent, id: Extract<ComponentId, { type: "preq" }>): Promise<void>;
	/** DSC-27: true when the message's thread is a plan thread that is NOT `executing` and the message was handled (steer while planning, point to the buttons/`/work start`/`/work plan`, re-plan with the reply as feedback when failed, or answer a waiting question via `deps.replies.deliver`). `executing` plan threads return false: the thread is the issue's thread now. */
	message(e: MessageEvent): Promise<boolean>;
	/** `/work cancel` in a plan thread: stops a planning run or rejects an awaiting plan; returns the reply text, or undefined when the thread is not a plan thread (or is executing). */
	cancel(threadId: string, by: string): Promise<string | undefined>;
	/** Engine start: DSC-28 recovery (approved/executing without an issue number → awaiting; a lost planning run → failed with the thread told) and re-attach to unfinished planning runs (RUN-14, track them in chatSlots). */
	start(): void;
	/** Engine stop: detach from live runs (they keep going, RUN-09). */
	stop(): Promise<void>;
	/** Plan threads with a live planning run, for `/work status`. */
	active(): string[];
}

/** A new planning turn; absent when re-attaching to a run after a restart (the prompt is not resent). */
interface Turn {
	prompt: string;
	resume: boolean;
}

function quote(text: string): string {
	return `> ${text.trim().replaceAll("\n", "\n> ")}`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n\n…[truncated]` : text;
}

/** Text for a title or thread name: whitespace runs (newlines too) become one space. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function createPlanner(deps: EngineDeps, opts: { scheduler: Scheduler }): Planner {
	const { config, db, discord, dispatcher, github } = deps;
	const agentName = config.agent.name;
	const runUi = createRunUiStore(db);
	/** threadId → settle promise of the live planning run. */
	const running = new Map<string, Promise<void>>();
	/** threadId → handle of the live run (from `register`). */
	const handles = new Map<string, RunHandle>();
	/** Decisions and recoveries in flight, awaited by `stop()`. */
	const pending = new Set<Promise<void>>();
	/** Aborted by `stop()`; every run's signal also follows the engine's. */
	const detaching = new AbortController();
	const signal = AbortSignal.any([deps.signal, detaching.signal]);
	let reservations = 0;

	const planOwner = (threadId: string): RunOwner => ({ kind: "plan", threadId });

	function keep(work: Promise<void>): void {
		pending.add(work);
		void work.finally(() => pending.delete(work));
	}

	/** Stops detached work before its next Discord or GitHub write (ENG-02); the next engine resumes it. */
	function assertAttached(): void {
		if (signal.aborted) throw new RunDetached();
	}

	/** A plain thread message (mentions off, DSC-07). Never throws. */
	async function notify(threadId: string, content: string): Promise<void> {
		await discord.send(threadId, { content: content.slice(0, MAX_MESSAGE) }, "high").catch(err => {
			log("warn", "plan message failed", { thread: threadId, error: errorMessage(err) });
		});
	}

	/** A reply to a thread message. Never throws. */
	async function answer(to: MsgRef, content: string): Promise<void> {
		await discord.reply(to, { content: content.slice(0, MAX_MESSAGE) }, "high").catch(err => {
			log("warn", "plan reply failed", { thread: to.channelId, error: errorMessage(err) });
		});
	}

	/** Appends `note` to a review message and removes its buttons. Never throws. */
	async function closeReview(ref: MsgRef, note: string): Promise<void> {
		try {
			const current = await discord.fetchMessage(ref);
			if (!current) return;
			await discord.edit(ref, { content: `${current.content}\n\n${note}`.slice(0, MAX_MESSAGE), components: [] }, "state");
		} catch (err) {
			log("warn", "plan review message not updated", { thread: ref.channelId, error: errorMessage(err) });
		}
	}

	function outputOf(plan: PlanRow): RequestPlanOutput {
		const output = parseJson<RequestPlanOutput>(plan.output);
		if (!output) throw new Error("This thread has no plan yet");
		return output;
	}

	function checkout(repo: string): CheckoutRequest {
		return {
			repo,
			defaultBranch: async () => (await github.repo(repo)).defaultBranch,
			identity: { name: github.identity.name, email: github.identity.email },
			gitToken: () => github.gitToken(repo),
		};
	}

	/** Runs a planning turn (or re-attaches to the live one) and tracks it until it settles, in the chat budget too. */
	function launch(threadId: string, turn: Turn | undefined): Promise<void> {
		const done = run(threadId, turn)
			.catch(err => log("error", "plan run failed", { thread: threadId, error: errorMessage(err) }))
			.finally(() => {
				running.delete(threadId);
				handles.delete(threadId);
			});
		running.set(threadId, done);
		return deps.chatSlots.track(`plan:${threadId}`, done);
	}

	async function failPlan(threadId: string, message: string, icon: string = ISSUE_ICONS.failed): Promise<void> {
		db.updatePlan(threadId, { state: "failed" });
		await setTopIcon(discord, threadId, icon);
		await notify(threadId, message);
	}

	/** Posts the review message of the plan's current revision and records it (DSC-26). Throws on a Discord failure. */
	async function announce(plan: PlanRow): Promise<void> {
		const output = outputOf(plan);
		const ref = await discord.send(
			plan.thread_id,
			requestPlanMessage({
				threadId: plan.thread_id,
				rev: plan.rev,
				title: output.title,
				summary: output.summary,
				complexity: output.complexity,
				planMarkdown: output.planMarkdown,
				mention: allowedMentions(config),
			}),
			"high",
		);
		db.updatePlan(plan.thread_id, { review_message_id: ref.messageId });
	}

	/** Records the run's plan as the next revision awaiting a decision, then posts it. */
	async function publish(threadId: string, result: RunResult, progress: Progress): Promise<void> {
		const plan = db.getPlan(threadId);
		if (!plan) throw new Error(`plan thread ${threadId} not found`);
		const raw = result.output as RequestPlanOutput;
		const output: RequestPlanOutput = { ...raw, title: oneLine(raw.title).slice(0, TITLE_MAX) || oneLine(plan.request).slice(0, TITLE_MAX) };
		progress.phase("Posting the plan…", result.usage.costUsd);
		// Awaiting before the post so the buttons work the moment they appear; a restart before the post reposts it.
		const awaiting = db.updatePlan(threadId, { state: "awaiting", rev: plan.rev + 1, output: JSON.stringify(output), review_message_id: null });
		try {
			await announce(awaiting);
		} catch (err) {
			// The plan stays awaiting: the next reply in the thread (or the next start) posts it again.
			log("warn", "plan review not posted", { thread: threadId, error: errorMessage(err) });
		}
		await progress.finish("done");
		await setTopIcon(discord, threadId, ISSUE_ICONS.awaiting_approval);
		log("info", "plan ready", { repo: plan.repo, thread: threadId, rev: awaiting.rev });
	}

	async function run(threadId: string, turn: Turn | undefined): Promise<void> {
		const plan = db.getPlan(threadId);
		if (!plan) return;
		const owner = planOwner(threadId);
		// Only a re-attach continues the stored messages; a new turn posts its own and overwrites the state.
		const restore = turn ? undefined : runUi.get(owner);
		const logRun = { run: `plan-${threadId}`, kind: "plan", repo: plan.repo, thread: threadId };
		const startedAt = new Date().toISOString();
		let progress: Progress | undefined;
		try {
			progress = await startProgress(discord, threadId, plan.rev > 0 ? "Refining the plan" : "Planning", "Starting…", {
				restore,
				persist: state => runUi.set(owner, state),
			});
			await setTopIcon(discord, threadId, ISSUE_ICONS.planning);
			if (!restore) progress.phase("Starting the agent…");
			const current = progress;
			const ui = createDiscordUI(discord, threadId, {
				jobId: `plan-${threadId}`,
				askTimeoutMs: config.limits.askTimeoutHours * 3_600_000,
				isAllowed: actor => memberAllowed(config, actor),
				replies: deps.replies,
				interactions: deps.interactions,
				mention: allowedMentions(config),
				onWaiting: on => current.waiting(on),
			});
			const result = await dispatcher.runAgent(
				{
					owner,
					kind: "plan",
					profile: "plan",
					prompt: runPrompt(agentName, turn?.prompt ?? ""),
					outputSchema: REQUEST_PLAN_SCHEMA,
					model: config.models.plan,
					thinking: config.models.thinking,
					limits: { minutes: config.limits.planMinutes, costUsd: config.limits.maxCostUsdPerJob },
					session: planThreadSessionKey(threadId),
					resume: turn?.resume ?? true,
					checkout: checkout(plan.repo),
					threadId,
				},
				{
					ui,
					register: handle => handles.set(threadId, handle),
					onWaitingForWorker: () => current.phase("Waiting for a worker…"),
					onProgress: p => current.activity(activityText(p.tool, p.intent), p.usage.costUsd),
					onTodos: todos => current.todos(todos),
					onTranscript: event => deps.agentLog.append(logRun, event),
					onLoadout: loadout => db.kvSet(loadoutKey(loadout.profile), JSON.stringify(loadout)),
					onUsage: usage => db.recordRun({ kind: "plan", repo: plan.repo, threadId, startedAt, usage }),
				},
				signal,
			);
			if (result.hasSession) db.updatePlan(threadId, { session_file: planThreadSessionKey(threadId) });
			if (result.aborted === "user") {
				await progress.finish("cancelled");
				await failPlan(threadId, "⏹️ **Planning stopped.** Reply in this thread to plan again.", ISSUE_ICONS.cancelled);
			} else if (result.aborted) {
				const limit =
					result.aborted === "time"
						? `${config.limits.planMinutes} minute time limit (limits.planMinutes)`
						: `$${config.limits.maxCostUsdPerJob} cost limit (limits.maxCostUsdPerJob)`;
				throw new Error(`Planning exceeded the ${limit}`);
			} else {
				await publish(threadId, result, progress);
			}
			runUi.clear(owner);
		} catch (err) {
			if (err instanceof RunDetached || signal.aborted) {
				// The run keeps going; the next engine re-attaches and keeps editing the same messages (RUN-14).
				progress?.stop();
				log("info", "plan run detached", { thread: threadId });
				return;
			}
			const reason = err instanceof RunLost ? err.message : errorMessage(err);
			log("error", "plan run failed", { repo: plan.repo, thread: threadId, error: reason });
			await progress?.finish("failed");
			await failPlan(threadId, `❌ **Planning failed:** ${reason.slice(0, 1500)}\nReply in this thread to try again.`);
			runUi.clear(owner);
		}
	}

	/** Issue body for an approved or executed plan. Execute keeps the full plan in the plan comment instead. */
	function issueBody(plan: PlanRow, output: RequestPlanOutput, verdict: string, execute: boolean): string {
		return [
			...(execute ? [PLAN_THREAD_MARKER] : []),
			"## Request",
			quote(plan.request),
			"",
			`_Requested by @${plan.author} via \`/work plan\` in Discord; plan rev ${plan.rev} ${verdict}._`,
			"",
			"## Summary",
			output.summary,
			...(execute ? [] : ["", "## Plan", clip(output.planMarkdown, PLAN_TEXT_MAX)]),
		].join("\n");
	}

	/** Puts a claimed plan whose issue could not be filed back up for decision (DSC-26). */
	async function filingFailed(e: ComponentEvent, plan: PlanRow, err: unknown): Promise<void> {
		db.updatePlan(plan.thread_id, { state: "awaiting" });
		log("warn", "plan issue not filed", { repo: plan.repo, thread: plan.thread_id, error: errorMessage(err) });
		await e
			.followUp({ content: `❌ Couldn't file the issue: ${errorMessage(err).slice(0, 1500)}\nThe plan is waiting for a decision again.`, ephemeral: true })
			.catch(() => {});
	}

	async function approve(e: ComponentEvent, plan: PlanRow, who: string): Promise<void> {
		const output = outputOf(plan);
		let filed: { number: number; url: string };
		try {
			filed = await github.createIssue(plan.repo, output.title, issueBody(plan, output, `approved by ${who}`, false));
		} catch (err) {
			await filingFailed(e, plan, err);
			return;
		}
		db.updatePlan(plan.thread_id, { issue_number: filed.number });
		log("info", "plan approved", { repo: plan.repo, thread: plan.thread_id, issue: filed.number, rev: plan.rev });
		await setTopIcon(discord, plan.thread_id, ISSUE_ICONS.done);
		await closeReview(
			e.message,
			`✅ Approved by ${who} — filed [#${filed.number}](<${filed.url}>). Nothing runs yet; run \`/work start repo:${plan.repo} issue:${filed.number}\` when ${agentName} should implement it.`,
		);
	}

	/**
	 * Execute after filing (DSC-26): binds the issue to this thread in `implementing` with the plan as a succeeded plan
	 * job, posts the plan comment, rewrites the starter message and enqueues `implement`. Idempotent: every step checks
	 * what is already done, so a restart resumes it (NFR-03). Throws `RunDetached` when the engine stops midway.
	 */
	async function completeExecute(threadId: string): Promise<IssueRow> {
		const plan = db.getPlan(threadId);
		if (!plan || plan.state !== "executing" || plan.issue_number === null) throw new Error(`plan thread ${threadId} has no filed issue`);
		const output = outputOf(plan);
		const n = plan.issue_number;
		let issue = db.findIssue(plan.repo, n) ?? bindIssue(plan, output, n);
		assertAttached();
		if (!issue.plan_comment_id) {
			try {
				const body = `${PLAN_COMMENT_MARKER}\n## ${agentName} plan (rev ${plan.rev})\n${output.summary}\n\n${clip(output.planMarkdown, PLAN_TEXT_MAX)}`;
				const comment = await github.commentIssue(plan.repo, n, body);
				issue = db.updateIssue(issue.id, { plan_comment_id: comment.id });
			} catch (err) {
				log("warn", "plan comment not posted", { repo: plan.repo, issue: n, error: errorMessage(err) });
			}
		}
		assertAttached();
		const top = await discord.starterMessage(threadId).catch(() => null);
		const content = `${ISSUE_ICONS[issue.state]} **#${n} ${issue.title}** — <https://github.com/${plan.repo}/issues/${n}>`.slice(0, MAX_MESSAGE);
		if (top && top.content !== content) {
			await discord.edit({ channelId: top.channelId, messageId: top.messageId }, { content }, "state").catch(err => {
				log("warn", "plan starter message not rewritten", { thread: threadId, error: errorMessage(err) });
			});
		}
		assertAttached();
		// Exactly once: the job row is the record, whatever became of it since.
		const implementJobs = db.activeJob(issue.id) ?? (["succeeded", "failed", "cancelled"] as const).find(status => db.latestJob(issue.id, "implement", status));
		if (issue.state === "implementing" && !implementJobs) opts.scheduler.enqueue(issue.id, "implement");
		db.updatePlan(threadId, { executed_at: new Date().toISOString() });
		log("info", "plan executed", { repo: plan.repo, thread: threadId, issue: n, rev: plan.rev });
		return issue;
	}

	/**
	 * The issue row, created directly in `implementing` with this thread and the plan as its succeeded plan job, in one
	 * transaction: no state transition fires and the implement job reads the plan from that job.
	 */
	function bindIssue(plan: PlanRow, output: RequestPlanOutput, n: number): IssueRow {
		return db.raw.transaction(() => {
			const inserted = db.insertIssue(plan.repo, n, output.title);
			db.updateIssue(inserted.id, { thread_id: plan.thread_id, plan_rev: plan.rev, ...(plan.session_file ? { plan_session: plan.session_file } : {}) });
			const job = db.insertJob(inserted.id, "plan");
			const result: PlanJobResult = { summary: output.summary, planMarkdown: output.planMarkdown, complexity: output.complexity, rev: plan.rev, announced: true };
			db.finishJob(job.id, { status: "succeeded", result });
			return db.setIssueState(inserted.id, "implementing");
		})();
	}

	async function execute(e: ComponentEvent, plan: PlanRow, who: string): Promise<void> {
		const output = outputOf(plan);
		const implementing = stateLabel("implementing", deps.labels);
		let filed: { number: number; url: string };
		try {
			// The implementing label comes with the issue: no planning or approval label is ever applied (DSC-26).
			filed = await github.createIssue(plan.repo, output.title, issueBody(plan, output, `approved for implementation by ${who}`, true), [
				deps.labels.trigger,
				...(implementing ? [implementing] : []),
			]);
		} catch (err) {
			await filingFailed(e, plan, err);
			return;
		}
		// Recorded at once: from here a restart completes this Execute instead of filing again (DSC-28).
		db.updatePlan(plan.thread_id, { issue_number: filed.number });
		await completeExecute(plan.thread_id);
		await closeReview(
			e.message,
			`🚀 Execute pressed by ${who} — filed [#${filed.number}](<${filed.url}>); implementation starts as soon as a slot is free, and progress, the pull request and reviews follow in this thread.`,
		);
	}

	async function reject(plan: PlanRow, who: string, review: MsgRef | undefined): Promise<string> {
		log("info", "plan rejected", { repo: plan.repo, thread: plan.thread_id, rev: plan.rev });
		// `plan` is the row `claimPlan` just moved to `rejected`; no run is active on it.
		await removePlanSession(deps, plan);
		await setTopIcon(discord, plan.thread_id, ISSUE_ICONS.cancelled);
		const note = `⏹️ Rejected by ${who}`;
		if (review) await closeReview(review, note);
		await notify(plan.thread_id, "⏹️ **Plan rejected.** Archiving this thread; start again with `/work plan`.");
		await discord.archiveThread(plan.thread_id).catch(err => log("warn", "plan thread not archived", { thread: plan.thread_id, error: errorMessage(err) }));
		return note;
	}

	/** The review message of the plan's current revision, when it was posted. */
	function reviewRef(plan: PlanRow): MsgRef | undefined {
		return plan.review_message_id ? { channelId: plan.thread_id, messageId: plan.review_message_id } : undefined;
	}

	/** Starts planning again after Refine or a reply to a failed plan, resuming the session when there is one. */
	function replan(plan: PlanRow, feedback: string): void {
		const output = parseJson<RequestPlanOutput>(plan.output);
		const prompt = output
			? requestPlanPrompt(plan.request, { feedback, previousPlan: output.planMarkdown })
			: requestPlanPrompt(`${plan.request}\n\nAdditional guidance:\n${feedback}`);
		void launch(plan.thread_id, { prompt, resume: plan.session_file !== null });
	}

	/** DSC-28 and RUN-14 at engine start. */
	async function recover(): Promise<void> {
		for (const plan of [...db.plansInState("approved"), ...db.plansInState("executing")]) {
			// Approve or Execute claimed the plan, but the issue was never filed: its buttons work again.
			if (plan.issue_number === null) {
				db.updatePlan(plan.thread_id, { state: "awaiting" });
				log("info", "plan decision reopened after restart", { thread: plan.thread_id, state: plan.state });
			}
		}
		for (const plan of db.plansInState("executing")) {
			if (plan.issue_number === null || plan.executed_at !== null) continue;
			log("info", "completing plan execute after restart", { thread: plan.thread_id, issue: plan.issue_number });
			await completeExecute(plan.thread_id).catch(err => {
				if (!(err instanceof RunDetached)) log("error", "plan execute not completed", { thread: plan.thread_id, error: errorMessage(err) });
			});
		}
		for (const plan of db.plansInState("planning")) {
			if (running.has(plan.thread_id)) continue;
			// A run still going, or one that ended while nobody was attached, is picked up where it is (RUN-14, DSC-28).
			if (dispatcher.hasRun(planOwner(plan.thread_id))) {
				log("info", "plan run re-attached after start", { thread: plan.thread_id });
				void launch(plan.thread_id, undefined);
				continue;
			}
			// No run at all: the turn was still waiting for admission (memory only) when the orchestrator stopped, so no
			// worker ever had it. Start it again; a run a worker lost is a finished run and is reported above (DSC-28).
			log("warn", "plan run never started before the restart; starting it again", { thread: plan.thread_id });
			runUi.clear(planOwner(plan.thread_id));
			const resume = plan.session_file !== null;
			void launch(plan.thread_id, { prompt: resume ? restartNote(deps.config.agent.name) : requestPlanPrompt(plan.request), resume });
		}
		for (const plan of db.plansInState("awaiting")) {
			if (plan.review_message_id !== null) continue;
			assertAttached();
			await announce(plan).catch(err => log("warn", "plan review not reposted", { thread: plan.thread_id, error: errorMessage(err) }));
		}
	}

	return {
		async command(e, repo) {
			const request = String(e.options.prompt ?? "").trim();
			if (!request) {
				await e.editReply({ content: "Describe what should be planned with the `prompt` option." });
				return;
			}
			if (deps.chatSlots.full()) {
				await e.editReply({ content: CAPACITY_REACHED });
				return;
			}
			// Holds the slot while the thread is created, so a concurrent request cannot take it meanwhile.
			const reserved = Promise.withResolvers<void>();
			void deps.chatSlots.track(`plan:starting:${++reservations}`, reserved.promise);
			try {
				const top = await discord.send(e.where.channelId, { content: `📋 **Plan** — ${request}`.slice(0, MAX_MESSAGE) }, "high");
				const threadId = await discord.startThread(top, { name: oneLine(request).slice(0, THREAD_NAME_MAX), autoArchiveMinutes: 10080 });
				db.insertPlan(threadId, repo.fullName, request, e.actor.username);
				log("info", "plan started", { repo: repo.fullName, thread: threadId, user: e.actor.userId });
				void launch(threadId, { prompt: requestPlanPrompt(request), resume: false });
				await e.editReply({ content: `Started <#${threadId}>. Progress, any questions and the plan will appear there.` });
			} finally {
				reserved.resolve();
			}
		},

		async component(e, id) {
			const who = `@${e.actor.username}`;
			if (id.action === "refine") {
				const plan = db.getPlan(id.threadId);
				if (plan?.state !== "awaiting" || plan.rev !== id.rev) {
					await e.reply({ content: STALE_PLAN, ephemeral: true });
					return;
				}
				await e.showModal({
					custom_id: encodeId(id),
					title: "Refine the plan",
					components: [
						{
							type: ComponentType.Label,
							label: "What should change?",
							component: { type: ComponentType.TextInput, custom_id: FEEDBACK_FIELD, style: TextInputStyle.Paragraph, required: true },
						},
					],
				});
				return;
			}
			const to = { approve: "approved", execute: "executing", reject: "rejected" } as const;
			// One decision per revision: whichever click wins this update owns the plan (NFR-05).
			const plan = db.claimPlan(id.threadId, id.rev, "awaiting", to[id.action]);
			if (!plan) {
				await e.reply({ content: STALE_PLAN, ephemeral: true });
				return;
			}
			const work = (async () => {
				// Approve and Execute make GitHub calls; acknowledge first.
				await e.deferUpdate();
				if (id.action === "approve") await approve(e, plan, who);
				else if (id.action === "execute") await execute(e, plan, who);
				else await reject(plan, who, e.message);
			})();
			keep(work.catch(() => {}));
			try {
				await work;
			} catch (err) {
				if (err instanceof RunDetached) {
					log("info", "plan decision detached; the next start completes it", { thread: id.threadId });
					return;
				}
				throw err;
			}
		},

		async modal(e, id) {
			const feedback = (e.fields[FEEDBACK_FIELD] ?? "").trim() || "(no feedback given)";
			if (deps.chatSlots.full()) {
				await e.reply({ content: CAPACITY_REACHED, ephemeral: true });
				return;
			}
			const plan = db.claimPlan(id.threadId, id.rev, "awaiting", "planning");
			if (!plan) {
				await e.reply({ content: STALE_PLAN, ephemeral: true });
				return;
			}
			log("info", "plan refine requested", { repo: plan.repo, thread: plan.thread_id, rev: plan.rev, user: e.actor.userId });
			replan(plan, feedback);
			const note = `✏️ Refine requested by @${e.actor.username} — revising the plan; progress will appear below.\n${quote(feedback)}`;
			if (e.message) {
				await e.deferUpdate();
				await closeReview(e.message, note);
			} else {
				await e.reply({ content: "Revising the plan.", ephemeral: true });
				const review = reviewRef(plan);
				if (review) await closeReview(review, note);
				else await notify(plan.thread_id, note);
			}
		},

		async message(e) {
			const threadId = e.where.channelId;
			const plan = db.getPlan(threadId);
			if (!plan || plan.state === "executing") return false;
			if (!memberAllowed(config, e.actor)) return true;
			// A question is waiting: the message is its answer, not steering (DSC-18).
			if (deps.replies.deliver(threadId, e.content)) return true;
			try {
				switch (plan.state) {
					case "planning": {
						const handle = handles.get(threadId);
						if (!handle) {
							await answer(e.ref, "Planning is still starting; send that again in a moment.");
							break;
						}
						// Delivery can wait for the worker (RUN-15); the message handler does not.
						void acknowledgeSteer(discord, e.ref, onQueued => handle.steer(e.content, e.actor.username, { onQueued })).catch(err =>
							log("warn", "plan steer failed", { thread: threadId, error: errorMessage(err) }),
						);
						break;
					}
					case "awaiting":
						if (plan.review_message_id === null) await announce(plan);
						else await answer(e.ref, "The plan above is waiting for your decision — use its **Approve**, **Execute**, **Refine** or **Reject** buttons.");
						break;
					case "approved":
						await answer(
							e.ref,
							`This plan was approved and filed as #${plan.issue_number}. Run \`/work start repo:${plan.repo} issue:${plan.issue_number}\` to have ${agentName} implement it.`,
						);
						break;
					case "rejected":
						await answer(e.ref, "This plan was rejected. Start a new one with `/work plan`.");
						break;
					case "failed": {
						const text = e.content.trim();
						if (!text) break;
						if (deps.chatSlots.full()) {
							await answer(e.ref, CAPACITY_REACHED);
							break;
						}
						// The reply restarts planning: as feedback on the last plan, or as extra guidance when there is none.
						const restarted = db.claimPlan(threadId, plan.rev, "failed", "planning");
						if (restarted) replan(restarted, text);
						break;
					}
				}
			} catch (err) {
				log("error", "plan thread message failed", { thread: threadId, error: errorMessage(err) });
			}
			return true;
		},

		async cancel(threadId, by) {
			const plan = db.getPlan(threadId);
			if (!plan || plan.state === "executing") return undefined;
			if (plan.state === "planning") {
				const handle = handles.get(threadId);
				if (!handle) return running.has(threadId) ? "Planning is still starting; try again in a moment." : "Nothing to cancel: no planning run is active.";
				await handle.abort("user");
				log("info", "plan run stopped", { thread: threadId, by });
				return `Stopping planning (requested by ${by})…`;
			}
			if (plan.state === "awaiting") {
				const claimed = db.claimPlan(threadId, plan.rev, "awaiting", "rejected");
				if (claimed) return reject(claimed, by, reviewRef(plan));
			}
			return `Nothing to cancel: this plan is ${db.getPlan(threadId)?.state ?? plan.state}.`;
		},

		start() {
			keep(
				recover().catch(err => {
					if (!(err instanceof RunDetached)) log("error", "plan recovery failed", { error: errorMessage(err) });
				}),
			);
		},

		async stop() {
			detaching.abort();
			await Promise.allSettled([...running.values(), ...pending]);
		},

		active: () => [...running.keys()],
	};
}
