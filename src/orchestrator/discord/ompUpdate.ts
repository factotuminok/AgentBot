import { errorMessage, log } from "../../shared/log";
import type { EngineDeps } from "../engine/deps";
import type { OmpNotice, OmpUpdater } from "../omp/updates";
import { type ComponentId, ompUpdateMessage } from "./render";
import type { ComponentEvent, MsgRef } from "./surface";

/**
 * The omp update notice in the work channel (UPD-02, UPD-03; ported from DevForge `discord/ompUpdate.ts`): posts
 * "omp X is available" with an **Approve update** button, supersedes an older notice, installs on approval, and posts
 * failures (a failed install, or a copy that failed its canary run, UPD-08) with a fresh Approve button. One per engine.
 */

const MAX_MESSAGE = 2000;
const MAX_ERROR = 300;
const MAX_LOG = 700;
export const STALE_UPDATE = "This omp update is no longer current.";

/** Error plus the end of the install or host output, short enough to sit in a notice. */
function failureText(error: string, output: string | undefined): string {
	const head = error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR - 1)}…` : error;
	const tail = output?.trim().slice(-MAX_LOG).replaceAll("```", "'''");
	return tail ? `${head}\n\`\`\`\n${tail}\n\`\`\`` : head;
}

export interface OmpNotices {
	/** Syncs now and after every updater change. */
	start(): void;
	stop(): void;
	/** An Approve button click; the bot has checked that the member is allowed (DSC-02). */
	approve(e: ComponentEvent, id: Extract<ComponentId, { type: "omp" }>): Promise<void>;
}

export function createOmpNotices(deps: Pick<EngineDeps, "config" | "discord">, updater: OmpUpdater): OmpNotices {
	const { discord } = deps;
	const channelId = deps.config.discord.workChannelId;
	let unsubscribe: (() => void) | undefined;

	async function closeNotice(ref: MsgRef, note: string): Promise<void> {
		try {
			const message = await discord.fetchMessage(ref);
			if (!message) return;
			await discord.edit(ref, { content: `${message.content}\n\n${note}`.slice(0, MAX_MESSAGE), components: [] }, "state");
		} catch (err) {
			log("warn", "could not close the omp update notice", { error: errorMessage(err) });
		}
	}

	/** Posts a notice with the Approve button and remembers it. */
	async function postNotice(latest: string, failure?: string): Promise<void> {
		const ref = await discord.send(channelId, ompUpdateMessage({ current: updater.status().active?.version ?? updater.status().image, latest, failure }), "high");
		updater.setNotice({ version: latest, channelId: ref.channelId, messageId: ref.messageId, buttons: true });
	}

	async function syncOnce(): Promise<void> {
		const status = updater.status();
		// Outside the image there is nothing to approve (UPD-05); during an install the approval handler reports.
		if (!status.supported || status.installing) return;
		const attempt = status.lastAttempt;
		const failure = attempt?.outcome === "failed" && !attempt.reported ? failureText(`Updating omp to ${attempt.version} failed: ${attempt.error ?? "unknown error"}`, attempt.log) : undefined;
		const available = updater.updateAvailable();
		const stored: OmpNotice | undefined = updater.notice();
		if (available && (failure || stored?.version !== available)) {
			if (stored?.buttons) await closeNotice(stored, stored.version === available ? "See the newer notice below." : `Superseded by omp ${available}.`);
			await postNotice(available, failure);
		} else if (failure) {
			await discord.send(channelId, { content: `❌ ${failure}`.slice(0, MAX_MESSAGE) }, "high");
		}
		if (failure) updater.markReported();
	}

	/** Serialized, so two notifications cannot post the same notice twice. */
	let chain: Promise<void> = Promise.resolve();
	const sync = (): void => {
		chain = chain.then(syncOnce).catch(err => log("warn", "omp update notice failed", { error: errorMessage(err) }));
	};

	async function approve(e: ComponentEvent, id: Extract<ComponentId, { type: "omp" }>): Promise<void> {
		const status = updater.status();
		const refusal = !status.supported
			? (status.unsupportedReason ?? "omp updates are not supported here.")
			: status.installing
				? `omp ${status.installing.version} is already being installed (approved by ${status.installing.by}).`
				: id.version !== updater.updateAvailable()
					? STALE_UPDATE
					: undefined;
		if (refusal) {
			log("info", "omp update approval refused", { version: id.version, user: e.actor.userId, reason: refusal });
			await e.reply({ content: refusal, ephemeral: true });
			return;
		}
		const who = `@${e.actor.username}`;
		// Claims the install before anything is awaited, so a second click is refused above (UPD-03).
		const installing = updater.install(id.version, who);
		log("info", "omp update approved", { version: id.version, user: e.actor.userId });
		await e.deferUpdate();
		const stored = updater.notice();
		if (stored?.messageId === e.message.messageId) updater.setNotice({ ...stored, buttons: false });
		await closeNotice(e.message, `⬆️ Approved by ${who}: installing omp ${id.version} for workers…`);
		const result = await installing;
		if (result.ok) {
			await discord.send(
				channelId,
				{ content: `✅ omp ${id.version} is installed for workers (approved by ${who}). New workers use it; workers already running keep their omp.` },
				"high",
			);
			return;
		}
		if (result.refused) {
			await e.followUp({ content: result.error, ephemeral: true });
			return;
		}
		await postNotice(id.version, failureText(`Updating omp to ${id.version} failed: ${result.error}`, result.log));
	}

	return {
		start() {
			unsubscribe ??= updater.subscribe(sync);
			sync();
		},
		stop() {
			unsubscribe?.();
			unsubscribe = undefined;
		},
		approve,
	};
}
