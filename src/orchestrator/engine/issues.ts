import { errorMessage, log } from "../../shared/log";
import { queuedMessage } from "../discord/render";
import type { IssueRow } from "../store/db";
import type { EngineDeps, Scheduler, TrackIssue } from "./deps";
import { STATE_ICONS } from "./state";

/** Discord's thread name limit (GH-12 step 2). */
const THREAD_NAME_MAX = 100;
const MESSAGE_MAX = 2000;

/**
 * DSC-34: where an issue's thread opens — the repository's watch channel when it has one (watched or not) and Discord
 * still has it, otherwise the work channel.
 */
export async function watchChannelFor(deps: Pick<EngineDeps, "db" | "config" | "discord">, repo: string): Promise<string> {
	const watch = deps.db.watchByName(repo);
	if (watch && (await deps.discord.channel(watch.channel_id))) return watch.channel_id;
	return deps.config.discord.workChannelId;
}

/**
 * GH-12 (the poller) and `/work start` (the bot): post the 📥 top message, start the one-week thread from it, record
 * the issue `queued` with its thread, post "Queued for planning" (a failure is only logged), enqueue `plan`.
 * Throws when the issue is already tracked or the top message or thread cannot be created.
 */
export function createTrackIssue(deps: EngineDeps, scheduler: Scheduler): TrackIssue {
	return async (repo, gh, source) => {
		const { db, discord } = deps;
		if (db.findIssue(repo, gh.number)) throw new Error(`${repo}#${gh.number} is already tracked`);
		const channelId = await watchChannelFor(deps, repo);
		const top = await discord.send(channelId, { content: `${STATE_ICONS.queued} **#${gh.number} ${gh.title}** — <${gh.html_url}>`.slice(0, MESSAGE_MAX) });
		const threadId = await discord.startThread(top, { name: `#${gh.number} ${gh.title}`.slice(0, THREAD_NAME_MAX), autoArchiveMinutes: 10080 });
		const inserted = db.insertIssue(repo, gh.number, gh.title);
		const issue: IssueRow = db.updateIssue(inserted.id, { thread_id: threadId });
		await discord
			.send(threadId, { content: queuedMessage(gh.html_url, deps.config.agent.name) })
			.catch(err => log("warn", "queued message not posted", { repo, issue: gh.number, error: errorMessage(err) }));
		scheduler.enqueue(issue.id, "plan");
		log("info", "issue tracked", { repo, issue: gh.number, thread: threadId, channel: channelId, via: source.via, actor: source.via === "command" ? source.actorId : undefined });
		return issue;
	};
}
