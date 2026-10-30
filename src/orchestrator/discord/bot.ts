import { ComponentType, TextInputStyle } from "discord-api-types/v10";
import { errorMessage, log } from "../../shared/log";
import type { AskChat } from "../engine/chat";
import type { IssueDrafter } from "../engine/draft";
import { applyEvent, type JobInput, terminalCleanup } from "../engine/jobs";
import type { EngineDeps, Scheduler, TrackIssue } from "../engine/deps";
import { FEEDBACK_FIELD, type Planner, STALE_PLAN } from "../engine/plans";
import type { RepoChat } from "../engine/repoChat";
import { type IssueState, TERMINAL_STATES } from "../engine/state";
import { unwatchRepo, WatchRefused, watchRepo } from "../engine/watches";
import type { Poller } from "../github/poller";
import type { AvailableRepo } from "../github/types";
import { type IssueRow, parseJson } from "../store/db";
import { commandAccess, memberAllowed, refusalMessage } from "./access";
import { commandDefinitions } from "./commands";
import { acknowledgeSteer } from "./questions";
import type { OmpNotices } from "./ompUpdate";
import { type ComponentId, encodeId, parseId } from "./render";
import {
	type AutocompleteEvent,
	type CommandEvent,
	type ComponentEvent,
	type DiscordConnection,
	MissingPermission,
	type MessageEvent,
	type ModalEvent,
	type MsgRef,
} from "./surface";

export const NOT_AUTHORIZED = "Not authorized.";
export const NOT_RETRYABLE = "This job can no longer be retried.";
/** Discord shows at most 25 autocomplete suggestions (DSC-09). */
const MAX_CHOICES = 25;
/** `/work` subcommands that take a repository and are bound to the work channel or a watch channel (DSC-33). */
const REPO_SUBCOMMANDS: Record<string, true> = { start: true, issue: true, plan: true, ask: true, watch: true, unwatch: true };

export interface BotOptions {
	deps: EngineDeps;
	connection: DiscordConnection;
	scheduler: Scheduler;
	trackIssue: TrackIssue;
	poller: Poller;
	/** `/ask` and messages in ask threads (CHAT-03 to CHAT-11). */
	askChat: AskChat;
	/** `/work ask` and messages in repo-chat threads (CHAT-01 to CHAT-06). */
	repoChat: RepoChat;
	/** `/work plan`, its buttons and plan-thread messages (DSC-25 to DSC-28). */
	planner: Planner;
	/** `/work issue` (§7.2). */
	drafter: IssueDrafter;
	/** The omp update notice's Approve button (UPD-03); absent when the orchestrator has no updater (tests). */
	ompNotices?: OmpNotices;
}

export interface BotHandle {
	/** Stops handling events (engine stop). */
	detach(): void;
	/** DSC-29: why the nickname could not be set at the last ready event, for the status page; undefined when it was set. */
	nicknameWarning(): string | undefined;
}

/** What an issue thread is waiting on when nothing is running in it (DSC-23). */
export function idleIssueReply(agentName: string, state: IssueState, busy: boolean): string {
	if (busy) return "A job for this issue is queued and starts as soon as a slot is free; progress will appear here.";
	if (state === "awaiting_approval") return "The plan above is waiting for your decision — use its **Approve**, **Request changes** or **Reject** buttons.";
	if (state === "in_review") return `The pull request is in review. Review it on GitHub; reviews and comments there make ${agentName} revise it.`;
	if (state === "failed") return "The last job failed — press **Retry** on the failure message above, or use `/work cancel`.";
	return "Nothing is running in this thread right now. Use the buttons above or `/work`.";
}

/** Thrown inside a command handler to answer with an ephemeral refusal instead of `Error: …`. */
class Refusal extends Error {}

/**
 * Wires `/work`, `/ask`, buttons, modals and thread messages onto a Discord connection (requirements §7.1, §7.2).
 * Ported from DevForge `src/discord/bot.ts` onto the `DiscordConnection` events. Attach before `login`: commands and
 * the nickname are set at every ready event (DSC-01, DSC-29). Unhandled errors propagate to the connection, which logs
 * them and answers `Error: <message>` (DSC-08).
 */
export function attachBot({ deps, connection, scheduler, trackIssue, poller, askChat, repoChat, planner, drafter, ompNotices }: BotOptions): BotHandle {
	const { config, db, github } = deps;
	const agentName = config.agent.name;
	const guildId = config.discord.guildId;
	let nicknameWarning: string | undefined;
	/** Issues whose plan decision is being applied: a second click while the first runs is stale (NFR-05). */
	const deciding = new Set<number>();
	/** Jobs whose Retry is being applied: a second click while the first runs is stale (DSC-21). */
	const retrying = new Set<string>();

	async function onReady(): Promise<void> {
		// Replaces the guild's whole command list, so removed or renamed commands disappear at every start.
		await connection.registerCommands(guildId, commandDefinitions(agentName));
		try {
			await connection.setNickname(guildId, agentName);
			nicknameWarning = undefined;
		} catch (err) {
			if (!(err instanceof MissingPermission)) throw err;
			nicknameWarning = `Cannot set the bot's nickname to "${agentName}": the bot lacks the Change Nickname permission.`;
			log("warn", "nickname not set", { nickname: agentName, error: errorMessage(err) });
		}
		log("info", "discord ready", { user: connection.status().user });
	}

	// ---------------------------------------------------------------------------
	// Repositories (DSC-09, DSC-33)

	/** Available repositories, archived ones included (refused with a reason rather than "unknown"). */
	async function findRepo(name: string): Promise<AvailableRepo | undefined> {
		const lower = name.trim().toLowerCase();
		return (await github.listRepositories()).find(r => r.fullName.toLowerCase() === lower);
	}

	/** The `repo` option, or the watch channel's repository; validated against the available repositories. */
	async function resolveRepo(e: CommandEvent): Promise<AvailableRepo> {
		const typed = typeof e.options.repo === "string" ? e.options.repo.trim() : "";
		const name = typed || db.watchByChannel(e.where.channelId)?.repo;
		if (!name) throw new Refusal("Choose a repository with the `repo` option.");
		const repo = await findRepo(name);
		if (!repo) throw new Refusal(`\`${name}\` is not a repository the GitHub App can access. Install the App on it: ${github.installUrl}`);
		if (repo.archived) throw new Refusal(`\`${repo.fullName}\` is archived (read-only).`);
		return repo;
	}

	async function onAutocomplete(e: AutocompleteEvent): Promise<void> {
		if (e.focused.name !== "repo") return e.respond([]);
		const typed = e.focused.value.trim().toLowerCase();
		const watched = new Set(db.listWatches("watching").map(w => w.repo_id));
		let repos: AvailableRepo[];
		try {
			repos = await github.listRepositories();
		} catch (err) {
			log("warn", "repo autocomplete failed", { error: errorMessage(err) });
			return e.respond([]);
		}
		const choices = repos
			.filter(r => !r.archived && r.fullName.toLowerCase().includes(typed))
			.sort((a, b) => Number(watched.has(b.id)) - Number(watched.has(a.id)) || a.fullName.localeCompare(b.fullName))
			.slice(0, MAX_CHOICES)
			.map(r => ({ name: r.fullName, value: r.fullName }));
		await e.respond(choices);
	}

	// ---------------------------------------------------------------------------
	// Commands

	async function onCommand(e: CommandEvent): Promise<void> {
		const isWatchChannel = db.watchByChannel(e.where.channelId) !== null;
		const access = commandAccess(config, { command: e.command, subcommand: e.subcommand, actor: e.actor, where: e.where, isWatchChannel });
		if (!access.ok) {
			log("info", "command refused", {
				user: e.actor.userId,
				command: e.command,
				subcommand: e.subcommand ?? undefined,
				channel: e.where.channelId,
				parent: e.where.parentId ?? undefined,
				reason: access.reason,
			});
			await e.reply({ content: refusalMessage(config, access.reason, e.where), ephemeral: true });
			return;
		}
		try {
			if (e.command === "ask") await askChat.command(e);
			else await onWork(e);
		} catch (err) {
			if (!(err instanceof Refusal)) throw err;
			log("info", "command refused", { user: e.actor.userId, command: e.command, subcommand: e.subcommand ?? undefined, channel: e.where.channelId, reason: err.message });
			await answer(e, err.message);
		}
	}

	/** Ephemeral answer whether or not the command was deferred. */
	async function answer(e: CommandEvent, content: string): Promise<void> {
		if (deferred.has(e)) await e.editReply({ content });
		else await e.reply({ content, ephemeral: true });
	}
	const deferred = new WeakSet<CommandEvent>();
	async function deferEphemeral(e: CommandEvent): Promise<void> {
		await e.defer({ ephemeral: true });
		deferred.add(e);
	}

	async function onWork(e: CommandEvent): Promise<void> {
		const sub = e.subcommand ?? "";
		if (REPO_SUBCOMMANDS[sub] && sub !== "unwatch") {
			await deferEphemeral(e);
			const repo = await resolveRepo(e);
			switch (sub) {
				case "start":
					return answer(e, await startIssue(e.actor.userId, repo, Number(e.options.issue)));
				case "watch":
					return answer(e, await watch(e, repo));
				case "issue":
					return drafter.command(e, repo);
				case "plan":
					return planner.command(e, repo);
				case "ask":
					return repoChat.command(e, repo);
			}
		}
		switch (sub) {
			case "unwatch":
				await deferEphemeral(e);
				return answer(e, await unwatch(e));
			case "status":
				return answer(e, statusText());
			case "cancel":
				return cancel(e);
			default:
				throw new Error(`unknown subcommand /work ${sub}`);
		}
	}

	/** `/work start` and the hand-off button: tracks the issue at once, without waiting for a poll (§7.2, AGT-10). */
	async function startIssue(actorId: string, repo: AvailableRepo, number: number): Promise<string> {
		const tracked = db.findIssue(repo.fullName, number);
		if (tracked) {
			const where = tracked.thread_id ? ` in <#${tracked.thread_id}>` : "";
			return TERMINAL_STATES[tracked.state] ? `#${number} was already handled (${tracked.state})${where}.` : `#${number} is already tracked (${tracked.state})${where}.`;
		}
		const gh = await github.getIssue(repo.fullName, number);
		if (gh.isPullRequest) return `#${number} is a pull request, not an issue.`;
		if (gh.state === "closed") return `#${number} is closed; reopen it first.`;
		await github.addLabels(repo.fullName, number, [deps.labels.trigger]);
		const issue = await trackIssue(repo.fullName, gh, { via: "command", actorId });
		log("info", "issue started from discord", { repo: repo.fullName, issue: number, user: actorId });
		return issue.thread_id
			? `Started <#${issue.thread_id}> for #${number}. Progress, questions and the plan will appear there.`
			: `Tracking #${number} (${issue.state}).`;
	}

	async function watch(e: CommandEvent, repo: AvailableRepo): Promise<string> {
		try {
			const outcome = await watchRepo(deps, repo, e.actor.userId, connection.status().userId);
			// Look for labelled issues now rather than at the next cycle.
			if (!outcome.alreadyWatched) void poller.pollNow(repo.fullName).catch(err => log("warn", "poll after watch failed", { repo: repo.fullName, error: errorMessage(err) }));
			return outcome.message;
		} catch (err) {
			if (err instanceof WatchRefused) throw new Refusal(err.message);
			throw err;
		}
	}

	/** `/work unwatch [repo]`: a watched repository may have lost App access, so the watch itself is enough (DSC-36). */
	async function unwatch(e: CommandEvent): Promise<string> {
		const typed = typeof e.options.repo === "string" ? e.options.repo.trim() : "";
		const watchRow = typed ? db.watchByName(typed) : db.watchByChannel(e.where.channelId);
		if (!watchRow) {
			if (!typed) throw new Refusal("Choose a repository with the `repo` option.");
			if (!(await findRepo(typed))) throw new Refusal(`\`${typed}\` is not a repository the GitHub App can access.`);
			return `\`${typed}\` is not watched.`;
		}
		try {
			return (await unwatchRepo(deps, watchRow.repo, e.actor.userId)).message;
		} catch (err) {
			if (err instanceof WatchRefused) throw new Refusal(err.message);
			throw err;
		}
	}

	function statusText(): string {
		const watches = db.listWatches().filter(w => w.state !== "unwatched");
		const lines = watches.map(w => `👁️ ${w.repo} · <#${w.channel_id}>${w.state === "suspended" ? ` · suspended${w.last_error ? `: ${w.last_error}` : ""}` : ""}`);
		for (const issue of db.openIssues()) {
			const job = db.activeJob(issue.id);
			const jobText = job ? ` · ${job.kind}/${job.status}` : "";
			const thread = issue.thread_id ? ` · <#${issue.thread_id}>` : "";
			lines.push(`${issue.repo}#${issue.number} ${issue.state}${jobText}${thread}`);
		}
		for (const threadId of [...repoChat.active(), ...askChat.active.keys()]) lines.push(`💬 chat <#${threadId}>`);
		for (const threadId of planner.active()) lines.push(`📋 plan <#${threadId}>`);
		const text = lines.join("\n") || "Nothing active.";
		return text.length > 2000 ? `${text.slice(0, 1990)}\n…` : text;
	}

	/** `/work cancel`: the issue, the plan, or the live chat run of this thread (§7.2; chats per requirements §20 item 2). */
	async function cancel(e: CommandEvent): Promise<void> {
		const threadId = e.where.channelId;
		const issue = e.where.isThread ? db.issueByThread(threadId) : null;
		if (issue) {
			if (TERMINAL_STATES[issue.state]) {
				await e.reply({ content: `#${issue.number} is already ${issue.state}.`, ephemeral: true });
				return;
			}
			await e.reply({ content: `Cancelling #${issue.number}…` });
			await scheduler.cancelIssue(issue.id, `cancelled by @${e.actor.username}`);
			return;
		}
		if (e.where.isThread) {
			const by = `@${e.actor.username}`;
			const note = (await planner.cancel(threadId, by)) ?? (await repoChat.cancel(threadId, by)) ?? (await askChat.cancel(threadId, by));
			if (note !== undefined) {
				await e.reply({ content: note });
				return;
			}
		}
		await e.reply({ content: "Use inside an issue, plan or chat thread", ephemeral: true });
	}

	// ---------------------------------------------------------------------------
	// Buttons and modals

	/**
	 * Claims the issue for a plan decision when the buttons are still current (JOB-17): same rev, still awaiting approval,
	 * no other decision in flight. Synchronous, so two clicks cannot both pass (NFR-05). Release with `deciding.delete`.
	 */
	function claimPlan(id: Extract<ComponentId, { type: "plan" }>, hold: boolean): IssueRow | undefined {
		const issue = db.getIssue(id.issueId);
		if (!issue || issue.plan_rev !== id.rev || issue.state !== "awaiting_approval" || deciding.has(issue.id)) return undefined;
		if (hold) deciding.add(issue.id);
		return issue;
	}

	/** Appends `note` to the plan message and removes its buttons. */
	async function closeMessage(ref: MsgRef, note: string): Promise<void> {
		const current = await deps.discord.fetchMessage(ref);
		if (!current) return;
		const content = `${current.content}\n\n${note}`;
		await deps.discord.edit(ref, { content: content.length > 2000 ? content.slice(0, 2000) : content, components: [] }, "state");
	}

	async function onComponent(e: ComponentEvent): Promise<void> {
		if (deps.interactions.dispatch(e)) return;
		const id = parseId(e.customId);
		if (!memberAllowed(config, e.actor)) {
			await e.reply({ content: NOT_AUTHORIZED, ephemeral: true });
			return;
		}
		if (id?.type === "preq") return planner.component(e, id);
		if (id?.type === "job") return retry(e, id);
		if (id?.type === "issue") return handOff(e, id);
		if (id?.type === "omp" && ompNotices) return ompNotices.approve(e, id);
		if (id?.type !== "plan") {
			await e.reply({ content: unhandledComponent(id), ephemeral: true });
			return;
		}
		const who = `@${e.actor.username}`;
		if (id.action === "changes") {
			if (!claimPlan(id, false)) {
				await e.reply({ content: STALE_PLAN, ephemeral: true });
				return;
			}
			await e.showModal({
				custom_id: encodeId(id),
				title: "Request changes",
				components: [
					{
						type: ComponentType.Label,
						label: "Feedback",
						component: { type: ComponentType.TextInput, custom_id: FEEDBACK_FIELD, style: TextInputStyle.Paragraph, required: true },
					},
				],
			});
			return;
		}
		const issue = claimPlan(id, true);
		if (!issue) {
			await e.reply({ content: STALE_PLAN, ephemeral: true });
			return;
		}
		try {
			// Everything below makes GitHub calls; acknowledge first.
			await e.deferUpdate();
			if (id.action === "approve") {
				await applyEvent(deps, issue, "approved");
				scheduler.enqueue(issue.id, "implement");
				log("info", "plan approved", { repo: issue.repo, issue: issue.number, user: e.actor.userId, rev: id.rev });
				await closeMessage(e.message, `✅ Approved by ${who} — implementation starts as soon as a slot is free; progress will appear below.`);
			} else {
				const rejected = await applyEvent(deps, issue, "rejected");
				log("info", "plan rejected", { repo: issue.repo, issue: issue.number, user: e.actor.userId, rev: id.rev });
				await closeMessage(e.message, `⏹️ Rejected by ${who}`);
				await github.removeLabel(issue.repo, issue.number, deps.labels.trigger);
				await github.commentIssue(issue.repo, issue.number, `Plan rejected by ${e.actor.username} via Discord.`);
				await terminalCleanup(deps, rejected, `⏹️ **Plan rejected** by ${who}. Archiving this thread.`);
			}
		} finally {
			deciding.delete(issue.id);
		}
	}

	/**
	 * DSC-21: Retry requeues a failed job with `resume: true` when it is still the issue's failed work: status `failed`, no
	 * queued or running job, and the issue in `failed` (plan, implement) or `in_review` (revise, fix_ci). The resumed run
	 * continues the failed run's kept work (RUN-17).
	 */
	async function retry(e: ComponentEvent, id: Extract<ComponentId, { type: "job" }>): Promise<void> {
		const job = db.getJob(id.jobId);
		const issue = job ? db.getIssue(job.issue_id) : null;
		const expected = job?.kind === "plan" || job?.kind === "implement" ? "failed" : "in_review";
		if (
			!job ||
			!issue ||
			job.status !== "failed" ||
			issue.state !== expected ||
			db.newestJob(issue.id)?.id !== job.id ||
			scheduler.isBusy(issue.id) ||
			retrying.has(job.id)
		) {
			await e.reply({ content: NOT_RETRYABLE, ephemeral: true });
			return;
		}
		retrying.add(job.id);
		try {
			await e.deferUpdate();
			if (job.kind === "plan" || job.kind === "implement") await applyEvent(deps, issue, "retry", job.kind);
			// A fresh loss budget: the retried run may be requeued once again after a lost worker (RUN-04).
			const { lost: _lost, ...input } = parseJson<JobInput>(job.input) ?? {};
			scheduler.enqueue(issue.id, job.kind, { ...input, resume: true });
			log("info", "job retried", { repo: issue.repo, issue: issue.number, job: job.id, kind: job.kind, user: e.actor.userId });
			await closeMessage(e.message, `🔁 Retried by @${e.actor.username} — progress will appear below.`);
		} finally {
			retrying.delete(job.id);
		}
	}

	/** AGT-10: the hand-off button under an issue a chat filed starts the pipeline on it, as `/work start` does. */
	async function handOff(e: ComponentEvent, id: Extract<ComponentId, { type: "issue" }>): Promise<void> {
		await e.deferUpdate();
		const repo = await findRepo(id.repo);
		const outcome = !repo
			? `\`${id.repo}\` is not a repository the GitHub App can access.`
			: repo.archived
				? `\`${repo.fullName}\` is archived (read-only).`
				: await startIssue(e.actor.userId, repo, id.number);
		await closeMessage(e.message, `📥 Handed to ${agentName} by @${e.actor.username}: ${outcome}`);
	}

	/** Components nobody handles any more: questions that ended. */
	function unhandledComponent(id: ComponentId | undefined): string {
		if (id?.type === "ask") return "This question is no longer waiting for an answer.";
		return "This button no longer does anything.";
	}

	async function onModal(e: ModalEvent): Promise<void> {
		if (deps.interactions.dispatch(e)) return;
		if (!memberAllowed(config, e.actor)) {
			await e.reply({ content: NOT_AUTHORIZED, ephemeral: true });
			return;
		}
		const id = parseId(e.customId);
		if (id?.type === "preq") return planner.modal(e, id);
		if (id?.type !== "plan" || id.action !== "changes") {
			await e.reply({ content: unhandledComponent(id), ephemeral: true });
			return;
		}
		const feedback = (e.fields[FEEDBACK_FIELD] ?? "").trim();
		if (!feedback) {
			await e.reply({ content: "Feedback is required.", ephemeral: true });
			return;
		}
		const issue = claimPlan(id, true);
		if (!issue) {
			await e.reply({ content: STALE_PLAN, ephemeral: true });
			return;
		}
		try {
			await e.defer({ ephemeral: true });
			await applyEvent(deps, issue, "changes_requested");
			scheduler.enqueue(issue.id, "plan", { revision: { feedback } });
			log("info", "plan changes requested", { repo: issue.repo, issue: issue.number, user: e.actor.userId, rev: id.rev });
			const note = `✏️ Changes requested by @${e.actor.username} — revising the plan; progress will appear below.\n> ${feedback.replaceAll("\n", "\n> ")}`;
			if (e.message) await closeMessage(e.message, note);
			else if (issue.thread_id) await deps.discord.send(issue.thread_id, { content: note.slice(0, 2000) }, "high");
			await e.editReply({ content: "Changes requested; the plan is being revised." });
		} finally {
			deciding.delete(issue.id);
		}
	}

	// ---------------------------------------------------------------------------
	// Thread messages

	async function onMessage(e: MessageEvent): Promise<void> {
		// DSC-08: bot authors, DMs and channel messages are not for us.
		if (e.actor.isBot || !e.where.guildId || !e.where.isThread) return;
		// Ask threads check their own access (DSC-06).
		if (await askChat.message(e)) return;
		if (!memberAllowed(config, e.actor)) return;
		const threadId = e.where.channelId;
		try {
			// Plan threads (DSC-27) and repo chats (CHAT-03) handle their own questions, steering and follow-ups.
			if (await planner.message(e)) return;
			if (await repoChat.message(e)) return;
			// A question is waiting: the message is its answer, not steering (DSC-18). The question marks delivery (RUN-15).
			if (deps.replies.deliver(threadId, e.content)) return;
			const issue = db.issueByThread(threadId);
			if (!issue) return;
			// Delivery can wait for the worker (RUN-15); the handler does not.
			void acknowledgeSteer(deps.discord, e.ref, onQueued => scheduler.steer(issue.id, e.content, e.actor.username, { onQueued }))
				.then(async steered => {
					if (steered === "not-ready") {
						await deps.discord.reply(e.ref, { content: "Not ready: the agent's session is still starting. Send your message again in a moment." }, "high");
					} else if (steered === "none") {
						await deps.discord.reply(e.ref, { content: idleIssueReply(agentName, issue.state, scheduler.isBusy(issue.id)) }, "high");
					}
				})
				.catch(err => log("error", "thread message failed", { thread: threadId, error: errorMessage(err) }));
		} catch (err) {
			log("error", "thread message failed", { thread: threadId, error: errorMessage(err) });
		}
	}

	const offReady = connection.onReady(onReady);
	const offEvent = connection.onEvent(event => {
		if (deps.signal.aborted) return;
		switch (event.type) {
			case "command":
				return onCommand(event);
			case "autocomplete":
				return onAutocomplete(event);
			case "component":
				return onComponent(event);
			case "modal":
				return onModal(event);
			case "message":
				return onMessage(event);
		}
	});
	return {
		detach() {
			offReady();
			offEvent();
		},
		nicknameWarning: () => nicknameWarning,
	};
}
