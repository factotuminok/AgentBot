import { ComponentType, TextInputStyle } from "discord-api-types/v10";
import { errorMessage, log } from "../../shared/log";
import type { AskChat } from "../engine/chat";
import { applyEvent, terminalCleanup } from "../engine/jobs";
import type { EngineDeps, Scheduler, TrackIssue } from "../engine/deps";
import { type IssueState, TERMINAL_STATES } from "../engine/state";
import { unwatchRepo, WatchRefused, watchRepo } from "../engine/watches";
import type { Poller } from "../github/poller";
import type { AvailableRepo } from "../github/types";
import type { IssueRow } from "../store/db";
import { commandAccess, memberAllowed, refusalMessage } from "./access";
import { commandDefinitions } from "./commands";
import { acknowledgeSteer } from "./questions";
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

export const STALE_PLAN = "This plan is no longer current.";
export const NOT_AUTHORIZED = "Not authorized.";
const FEEDBACK_FIELD = "feedback";
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
export function attachBot({ deps, connection, scheduler, trackIssue, poller, askChat }: BotOptions): BotHandle {
	const { config, db, github } = deps;
	const agentName = config.agent.name;
	const guildId = config.discord.guildId;
	let nicknameWarning: string | undefined;
	/** Issues whose plan decision is being applied: a second click while the first runs is stale (NFR-05). */
	const deciding = new Set<number>();

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

	/** Commands whose runs need workers (phases 3 and 5): refused clearly instead of faking success. */
	async function notYet(e: CommandEvent, what: string): Promise<void> {
		await answer(e, `${what} needs agent workers, which this version of ${agentName} does not have yet.`);
	}

	async function onWork(e: CommandEvent): Promise<void> {
		const sub = e.subcommand ?? "";
		if (REPO_SUBCOMMANDS[sub] && sub !== "unwatch") {
			await deferEphemeral(e);
			const repo = await resolveRepo(e);
			switch (sub) {
				case "start":
					return answer(e, await startIssue(e, repo, Number(e.options.issue)));
				case "watch":
					return answer(e, await watch(e, repo));
				default:
					return notYet(e, `\`/work ${sub}\``);
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

	/** `/work start`: tracks the issue at once, without waiting for a poll (§7.2). */
	async function startIssue(e: CommandEvent, repo: AvailableRepo, number: number): Promise<string> {
		const tracked = db.findIssue(repo.fullName, number);
		if (tracked) {
			const where = tracked.thread_id ? ` in <#${tracked.thread_id}>` : "";
			return TERMINAL_STATES[tracked.state] ? `#${number} was already handled (${tracked.state})${where}.` : `#${number} is already tracked (${tracked.state})${where}.`;
		}
		const gh = await github.getIssue(repo.fullName, number);
		if (gh.isPullRequest) return `#${number} is a pull request, not an issue.`;
		if (gh.state === "closed") return `#${number} is closed; reopen it first.`;
		await github.addLabels(repo.fullName, number, [deps.labels.trigger]);
		const issue = await trackIssue(repo.fullName, gh, { via: "command", actorId: e.actor.userId });
		log("info", "issue started from discord", { repo: repo.fullName, issue: number, user: e.actor.userId });
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
		const text = lines.join("\n") || "Nothing active.";
		return text.length > 2000 ? `${text.slice(0, 1990)}\n…` : text;
	}

	async function cancel(e: CommandEvent): Promise<void> {
		const issue = e.where.isThread ? db.issueByThread(e.where.channelId) : null;
		if (!issue) {
			await e.reply({ content: "Use inside an issue or plan thread", ephemeral: true });
			return;
		}
		if (TERMINAL_STATES[issue.state]) {
			await e.reply({ content: `#${issue.number} is already ${issue.state}.`, ephemeral: true });
			return;
		}
		await e.reply({ content: `Cancelling #${issue.number}…` });
		await scheduler.cancelIssue(issue.id, `cancelled by @${e.actor.username}`);
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

	/** Components nobody handles any more: questions that ended, and Retry until failed jobs exist (DSC-21). */
	function unhandledComponent(id: ComponentId | undefined): string {
		if (id?.type === "ask") return "This question is no longer waiting for an answer.";
		if (id?.type === "job") return "This job can no longer be retried.";
		return "This button no longer does anything.";
	}

	async function onModal(e: ModalEvent): Promise<void> {
		if (deps.interactions.dispatch(e)) return;
		if (!memberAllowed(config, e.actor)) {
			await e.reply({ content: NOT_AUTHORIZED, ephemeral: true });
			return;
		}
		const id = parseId(e.customId);
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
