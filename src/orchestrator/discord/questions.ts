import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResultItem,
	ExtensionAskDialogSubmitResult,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
// The package root re-exports this module with `export type *` first, which hides its values from TS.
import { timedOutAskDialogResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type APIModalInteractionResponseCallbackData,
	ButtonStyle,
	ComponentType,
	TextInputStyle,
} from "discord-api-types/v10";
import { errorMessage, log } from "../../shared/log";
import { abortError, selectViaAskDialog } from "../../shared/ui";
import type { RunUi } from "../dispatch/dispatcher";
import type { Mention } from "./access";
import type { InteractionRouter } from "./interactions";
import { button, buttonRow } from "./render";
import type { ThreadReplies } from "./replies";
import type { Actor, ComponentEvent, DiscordSurface, MessageRow, ModalEvent, MsgRef, OutMessage } from "./surface";

/**
 * Agent questions in a Discord thread (DSC-16 to DSC-20), ported from DevForge `src/agent/discord-ui.ts` onto the
 * surface, the interaction router (instead of discord.js collectors) and typed thread replies.
 */

/**
 * UI for runs with nobody to ask (drafting an issue for `/work issue`): questions get no answer, so the agent
 * continues with its recommended options, and notices go to the log.
 */
export function createSilentUI(jobId: string): RunUi {
	return {
		askDialog: async questions => timedOutAskDialogResult(questions),
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		confirm: async () => false,
		notify: (message, type) => log(type === "error" ? "warn" : "info", "agent notice", { job: jobId, message }),
	};
}

const SELECT_MAX_OPTIONS = 25;
const COMPONENT_TEXT_MAX = 100;
const MESSAGE_MAX = 2000;
/** A dismissed modal never submits, so stop listening for it after this; the menu, buttons and typed replies keep working until the question's deadline. */
const MODAL_WAIT_MS = 15 * 60_000;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function answerText(result: ExtensionAskDialogResultItem): string {
	if (result.customInput !== undefined) return result.customInput;
	return result.selectedOptions.length > 0 ? result.selectedOptions.join(", ") : "(none)";
}

/**
 * Reads a typed thread reply as an answer: an option number ("2"), an option label, or for multi-select a comma-separated
 * list of those; anything else is a free-text answer (DSC-17).
 */
export function answerFromText(text: string, labels: string[], multi: boolean): { selectedOptions: string[]; customInput?: string } {
	const trimmed = text.trim();
	const picks = multi ? trimmed.split(/\s*,\s*/) : [trimmed];
	const chosen: string[] = [];
	for (const pick of picks) {
		const number = /^\d+$/.test(pick) ? Number(pick) : 0;
		const label = number >= 1 && number <= labels.length ? labels[number - 1] : labels.find(l => l.toLowerCase() === pick.toLowerCase());
		if (label === undefined) return { selectedOptions: [], customInput: trimmed };
		chosen.push(label);
	}
	return { selectedOptions: chosen };
}

type Answer = { component: ComponentEvent } | { text: string } | { submitted: ModalEvent };

export interface DiscordUIOptions {
	/** Prefix of the questions' custom ids and log field: the job, chat or plan the run belongs to. */
	jobId: string;
	askTimeoutMs: number;
	/** Who may answer with the menu and buttons (DSC-02); others get "Not authorized.". */
	isAllowed(actor: Actor): boolean;
	/** Typed thread replies, so a reply answers the waiting question instead of steering the run (DSC-18). */
	replies: ThreadReplies;
	interactions: InteractionRouter;
	/** Notified by every question (DSC-16), from `allowedMentions`. */
	mention: Mention;
	/** Called with true while a question waits for a human and false when it is answered or given up. */
	onWaiting?(waiting: boolean): void;
	/** Counts the waits as paused run time (DSC-20); nested waits count once. */
	pauseClock?: { during<T>(fn: () => Promise<T>): Promise<T> };
	/**
	 * A question was answered (menu, button, modal or typed reply). Delivery reactions (✅ once the run received it,
	 * ⏳ while queued, DSC-17) hook in here in phase 3.
	 */
	onAnswered?(question: MsgRef): void;
}

export function createDiscordUI(surface: DiscordSurface, threadId: string, opts: DiscordUIOptions): RunUi {
	const mentions: OutMessage["mentions"] = opts.mention.users.length > 0 ? { users: opts.mention.users } : undefined;
	const askHours = Math.round((opts.askTimeoutMs / 3_600_000) * 10) / 10;

	/** Time spent waiting on a human, reported to `onWaiting` and the pause clock (nested waits report once). */
	let waits = 0;
	async function waitingFor<T>(fn: () => Promise<T>): Promise<T> {
		if (waits++ === 0) opts.onWaiting?.(true);
		try {
			return await (opts.pauseClock ? opts.pauseClock.during(fn) : fn());
		} finally {
			if (--waits === 0) opts.onWaiting?.(false);
		}
	}

	/** Best-effort edit of a question message: a failed edit never changes the answer. */
	async function settle(ref: MsgRef, content: string): Promise<void> {
		await surface.edit(ref, { content: clip(content, MESSAGE_MAX), components: [] }, "state").catch(err => {
			log("debug", "question edit failed", { job: opts.jobId, error: errorMessage(err) });
		});
	}

	function post(content: string, components?: MessageRow[]): Promise<MsgRef> {
		return surface.send(threadId, { content: clip(content, MESSAGE_MAX), components, mentions }, "high");
	}

	function say(content: string): Promise<void> {
		return surface.send(threadId, { content: clip(content, MESSAGE_MAX) }, "high").then(
			() => {},
			err => log("warn", "discord message failed", { job: opts.jobId, error: errorMessage(err) }),
		);
	}

	/**
	 * The first answer to `message`: a component interaction from an allowed member, a typed reply in the thread, or the
	 * submit of an open modal; undefined on timeout. A modal that times out or is dismissed drops out of the race.
	 */
	async function nextAnswer(message: MsgRef, timeMs: number, signal: AbortSignal | undefined, modal?: Promise<ModalEvent | undefined>): Promise<Answer | undefined> {
		if (signal?.aborted) throw abortError();
		// Aborting `local` stops whichever wait lost the race.
		const local = new AbortController();
		const stop = () => local.abort();
		signal?.addEventListener("abort", stop, { once: true });
		try {
			const answer = await Promise.race([
				opts.interactions
					.nextComponent(message.messageId, {
						timeoutMs: timeMs,
						signal: local.signal,
						filter: async event => {
							if (opts.isAllowed(event.actor)) return true;
							await event.reply({ content: "Not authorized.", ephemeral: true }).catch(() => {});
							return false;
						},
					})
					.then(component => (component ? { component } : undefined)),
				opts.replies.next(threadId, timeMs, local.signal).then(text => (text === undefined ? undefined : { text })),
				...(modal ? [modal.then(submitted => (submitted ? { submitted } : Promise.withResolvers<never>().promise))] : []),
			]);
			if (answer) opts.onAnswered?.(message);
			return answer;
		} finally {
			signal?.removeEventListener("abort", stop);
			local.abort();
		}
	}

	function otherModal(customId: string, q: ExtensionAskDialogQuestion): APIModalInteractionResponseCallbackData {
		return {
			custom_id: customId,
			title: clip(q.header ?? "Your answer", 45),
			components: [
				{
					type: ComponentType.ActionRow,
					components: [{ type: ComponentType.TextInput, custom_id: "answer", label: clip(q.question, 45), style: TextInputStyle.Paragraph, required: true }],
				},
			],
		};
	}

	/** Waits for one question's answer until `deadline`; undefined on timeout. */
	async function askOne(q: ExtensionAskDialogQuestion, qIndex: number, deadline: number, signal: AbortSignal | undefined): Promise<ExtensionAskDialogResultItem | undefined> {
		const labels = q.options.map(o => o.label);
		const shown = q.options.slice(0, SELECT_MAX_OPTIONS);
		const prefix = `ask:${opts.jobId}:${qIndex}`;
		const rows: MessageRow[] = [];
		if (shown.length > 0) {
			// Opened empty: no option is pre-selected, not even the recommended one (DSC-16).
			rows.push({
				type: ComponentType.ActionRow,
				components: [
					{
						type: ComponentType.StringSelect,
						custom_id: `${prefix}:sel`,
						placeholder: "Choose…",
						min_values: q.multi ? 0 : 1,
						max_values: q.multi ? shown.length : 1,
						options: shown.map((option, index) => ({
							label: clip(option.label || `Option ${index + 1}`, COMPONENT_TEXT_MAX),
							value: String(index),
							...(option.description ? { description: clip(option.description, COMPONENT_TEXT_MAX) } : {}),
						})),
					},
				],
			});
		}
		rows.push(buttonRow(button(`${prefix}:other`, "Other…", ButtonStyle.Secondary)));
		const header = q.header ? `**${q.header}**\n${q.question}` : `**${q.question}**`;
		const numbered = q.options
			.map((o, i) => `${i + 1}. ${o.label}${q.recommended === i ? " (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`)
			.join("\n");
		const hint =
			labels.length > 0
				? "_Choose from the menu, reply in this thread with a number or your own answer, or press **Other…**._"
				: "_Reply in this thread, or press **Other…**._";
		const message = await post([`❓ ${opts.mention.text}${header}`, numbered, hint].filter(Boolean).join("\n"), rows);
		const base = { id: q.id, question: q.question, options: labels, multi: !!q.multi };
		const modalId = `${prefix}:modal`;

		/** The open "Other…" modal's submit, if any; undefined once it times out or is dismissed. Runs alongside the other ways to answer. */
		let pendingModal: Promise<ModalEvent | undefined> | undefined;
		while (true) {
			const remaining = deadline - Date.now();
			let answer: Answer | undefined;
			try {
				answer = remaining > 0 ? await nextAnswer(message, remaining, signal, pendingModal) : undefined;
			} catch (err) {
				await settle(message, "Cancelled");
				throw err;
			}
			if (!answer) {
				await settle(message, `${header}\n→ (no answer)`);
				return undefined;
			}
			if ("text" in answer) {
				const result = { ...base, ...answerFromText(answer.text, labels, !!q.multi) };
				await settle(message, `${header}\n→ ${answerText(result)}`);
				return result;
			}
			if ("submitted" in answer) {
				const { submitted } = answer;
				const result = { ...base, selectedOptions: [], customInput: submitted.fields.answer ?? "" };
				const content = clip(`${header}\n→ ${answerText(result)}`, MESSAGE_MAX);
				if (submitted.message) {
					await submitted.update({ content, components: [] }).catch(() => settle(message, content));
				} else {
					await submitted.reply({ content: "Answer recorded.", ephemeral: true }).catch(() => {});
					await settle(message, content);
				}
				return result;
			}
			const { component } = answer;

			if (component.customId === `${prefix}:sel`) {
				const result = { ...base, selectedOptions: component.values.map(v => labels[Number(v)]).filter(l => l !== undefined) };
				await component
					.update({ content: clip(`${header}\n→ ${answerText(result)}`, MESSAGE_MAX), components: [] })
					.catch(err => log("debug", "ask update failed", { job: opts.jobId, error: errorMessage(err) }));
				return result;
			}

			// "Other…": the modal opens, and the menu, typed replies and a later modal submit all keep racing (DSC-17).
			await component.showModal(otherModal(modalId, q)).catch(err => log("debug", "ask modal failed", { job: opts.jobId, error: errorMessage(err) }));
			pendingModal = opts.interactions
				.nextModal(modalId, { timeoutMs: Math.max(1, Math.min(MODAL_WAIT_MS, deadline - Date.now())), signal })
				.catch(() => undefined);
		}
	}

	async function askDialog(questions: ExtensionAskDialogQuestion[], dialogOptions?: ExtensionUIDialogOptions): Promise<ExtensionAskDialogSubmitResult> {
		return waitingFor(async () => {
			const signal = dialogOptions?.signal;
			const deadline = Date.now() + opts.askTimeoutMs;
			const results: ExtensionAskDialogResultItem[] = [];
			for (let index = 0; index < questions.length; index++) {
				// Questions are answered sequentially; the timeout covers the whole dialog.
				const result = await askOne(questions[index]!, index, deadline, signal);
				if (!result) {
					// DSC-19: a select continues with the recommended options.
					await say(`No answer in ${askHours}h; continuing with recommended options.`);
					results.push(...timedOutAskDialogResult(questions.slice(index)).results);
					break;
				}
				results.push(result);
			}
			return { kind: "submit", results };
		});
	}

	async function nextMessage(title: string, signal: AbortSignal | undefined): Promise<string | undefined> {
		return waitingFor(async () => {
			const question = await post(`❓ ${opts.mention.text}**${title}**\n_Reply in this thread._`);
			const text = await opts.replies.next(threadId, opts.askTimeoutMs, signal);
			// DSC-19: free text proceeds with no answer.
			if (text === undefined) await say(`No answer in ${askHours}h; continuing without one.`);
			else opts.onAnswered?.(question);
			return text;
		});
	}

	return {
		askDialog,
		select: (title, options, dialogOptions) => selectViaAskDialog(askDialog, title, options, dialogOptions),
		input: (title, _placeholder, dialogOptions) => nextMessage(title, dialogOptions?.signal),
		editor: (title, _prefill, dialogOptions) => nextMessage(title, dialogOptions?.signal),
		async confirm(title, message, dialogOptions) {
			return waitingFor(async () => {
				const prefix = `ask:${opts.jobId}:confirm`;
				const sent = await post(`❓ ${opts.mention.text}**${title}**\n${message}\n_Press a button or reply yes / no._`, [
					buttonRow(button(`${prefix}:yes`, "Yes", ButtonStyle.Success), button(`${prefix}:no`, "No", ButtonStyle.Danger)),
				]);
				let answer: Answer | undefined;
				try {
					answer = await nextAnswer(sent, opts.askTimeoutMs, dialogOptions?.signal);
				} catch (err) {
					await settle(sent, "Cancelled");
					throw err;
				}
				// `confirm` passes no modal, so an answer is a typed reply or a button click; no answer is No (DSC-19).
				const yes = answer
					? "text" in answer
						? /^\s*(y|yes)\s*$/i.test(answer.text)
						: "component" in answer && answer.component.customId === `${prefix}:yes`
					: false;
				const content = clip(`**${title}**\n${message}\n→ ${answer ? (yes ? "Yes" : "No") : "(no answer: No)"}`, MESSAGE_MAX);
				if (answer && "component" in answer) await answer.component.update({ content, components: [] }).catch(() => settle(sent, content));
				else await settle(sent, content);
				return yes;
			});
		},
		notify(message, type) {
			const icon = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
			void say(`${icon} ${message}`);
		},
	};
}
