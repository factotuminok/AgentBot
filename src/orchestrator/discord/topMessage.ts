import { errorMessage, log } from "../../shared/log";
import type { IssueState } from "../engine/state";
import type { DiscordSurface } from "./surface";

/** Icon on an issue thread's top message (in the watch or work channel) for each issue state. */
export const ISSUE_ICONS: Record<IssueState, string> = {
	queued: "📥",
	planning: "🛠️",
	awaiting_approval: "📋",
	implementing: "🛠️",
	in_review: "👀",
	done: "✅",
	failed: "❌",
	cancelled: "⏹️",
};

/** Icon on a chat thread's top message: while a run is answering, and how the last run ended (DSC-15). */
export const CHAT_ICONS = { working: "🛠️", done: "✅", failed: "❌", stopped: "⏹️", limit: "⚠️" } as const;

/**
 * Replaces the leading icon of the channel message a thread was started from, so the channel shows each thread's
 * status at a glance. Threads without such a message, or with one the bot cannot edit, are left alone: never throws.
 */
export async function setTopIcon(surface: DiscordSurface, threadId: string, icon: string): Promise<void> {
	try {
		const top = await surface.starterMessage(threadId);
		if (!top) return;
		const content = top.content.replace(/^\S+/, icon);
		if (content !== top.content) await surface.edit({ channelId: top.channelId, messageId: top.messageId }, { content }, "state");
	} catch (err) {
		log("debug", "top message icon not updated", { thread: threadId, error: errorMessage(err) });
	}
}
