import { errorMessage, log } from "../../shared/log";
import { type Progress, startProgress } from "../discord/progress";
import { createSilentUI } from "../discord/questions";
import { activityText, issueCreatedMessage } from "../discord/render";
import type { CommandEvent, InteractionResponder, OutMessage } from "../discord/surface";
import { RunDetached } from "../dispatch/dispatcher";
import type { AvailableRepo } from "../github/types";
import type { DraftRow } from "../store/db";
import { removeDraftSession } from "../store/sessions";
import { loadoutKey } from "../store/stats";
import type { EngineDeps, TrackIssue } from "./deps";
import { ISSUE_DRAFT_SCHEMA, type IssueDraftOutput, issueDraftPrompt, runPrompt } from "./prompts";
import { CAPACITY_REACHED } from "./chatSlots";
import { baseCheckout } from "./repoChat";

/**
 * `/work issue` (§7.2), ported from DevForge `src/engine/draft.ts` and the `createDraftedIssue` flow of its bot: a
 * read-only `draft` run on a worker drafts the issue from the request, the orchestrator files it with the trigger label
 * and starts tracking it at once. Every step is recorded in `drafts` (NFR-03): a draft whose run outlived the engine is
 * finished by the next one, which posts the result in the command's channel (the interaction may have expired), and an
 * issue already filed is never filed again.
 */

/** AGT-14; kept well inside the 15 minutes Discord allows for editing a slash command's reply. */
export const DRAFT_MINUTES = 10;
/** §7.2: the longest request accepted. */
export const MAX_REQUEST = 4000;
/** GitHub's limit on issue titles. */
const TITLE_MAX = 256;
const MAX_MESSAGE = 2000;

export interface IssueDrafter {
	/**
	 * `/work issue repo request`: access checked, repo resolved, interaction already deferred ephemerally. Refused up
	 * front when every chat slot is taken. Drafts with live progress in the command's reply, files the issue, starts
	 * tracking it and shows ✅ with the number, link and planning thread.
	 */
	command(e: CommandEvent, repo: AvailableRepo): Promise<void>;
	/** Engine start (NFR-03): finishes drafts left unfinished by the previous engine; never files twice. */
	start(): void;
	/** Engine stop: detaches from draft runs, which keep going (RUN-09). */
	stop(): Promise<void>;
}

/** Hidden marker in a drafted issue's body: finds an issue filed just before a restart recorded its number. */
export function draftMarker(draftId: string): string {
	return `<!-- agentbot:draft:${draftId} -->`;
}

/** The session of a draft run; deleted when the draft ends (ENG-05). */
export const draftSessionKey = (draftId: string): string => `draft-${draftId}`;

/** The filed issue's body: the draft, then the quoted request (§7.2, DSC-30). */
export function draftedIssueBody(agentName: string, draft: Pick<DraftRow, "id" | "body" | "author" | "request">): string {
	const quoted = draft.request.replaceAll("\n", "\n> ");
	return `${draft.body ?? ""}\n\n---\n_Drafted by ${agentName} from a Discord request by @${draft.author} via \`/work issue\`:_\n> ${quoted}\n\n${draftMarker(draft.id)}`;
}

export function createIssueDrafter(deps: EngineDeps, opts: { trackIssue: TrackIssue }): IssueDrafter {
	const { config, db, discord, dispatcher, github } = deps;
	const agentName = config.agent.name;
	const live = new Map<string, Promise<void>>();
	const detaching = new AbortController();
	const signal = AbortSignal.any([deps.signal, detaching.signal]);

	/** Stops a detached draft before its next Discord or GitHub write (ENG-02). */
	function assertAttached(): void {
		if (signal.aborted) throw new RunDetached();
	}

	function launch(draft: DraftRow, responder: InteractionResponder | undefined): Promise<void> {
		const done = run(draft.id, responder)
			.catch(err => log("error", "issue draft failed unexpectedly", { draft: draft.id, error: errorMessage(err) }))
			.finally(() => live.delete(draft.id));
		live.set(draft.id, done);
		void deps.chatSlots.track(`draft:${draft.id}`, done);
		return done;
	}

	/** Runs the draft agent and stores its output (`drafting` → `drafted`). Re-attaches to the run after a restart. */
	async function produce(draft: DraftRow, progress: Progress | undefined): Promise<DraftRow> {
		const session = draftSessionKey(draft.id);
		if (draft.session_file !== session) draft = db.updateDraft(draft.id, { session_file: session });
		progress?.phase("Reading the repository and drafting the issue…");
		const startedAt = new Date().toISOString();
		const logRun = { run: `draft-${draft.id}`, kind: "draft", repo: draft.repo };
		const result = await dispatcher.runAgent(
			{
				owner: { kind: "draft", draftId: draft.id },
				kind: "draft",
				profile: "draft",
				prompt: runPrompt(agentName, issueDraftPrompt(agentName, draft.request)),
				outputSchema: ISSUE_DRAFT_SCHEMA,
				model: config.models.chat,
				thinking: config.models.thinking,
				limits: { minutes: DRAFT_MINUTES, costUsd: config.limits.maxCostUsdPerJob },
				session,
				resume: false,
				checkout: baseCheckout(deps, draft.repo),
			},
			{
				// No thread to ask or steer from.
				ui: createSilentUI(`draft-${draft.id}`),
				register: () => {},
				onWaitingForWorker: () => progress?.phase("Waiting for a worker…"),
				onProgress: p => progress?.activity(activityText(p.tool, p.intent), p.usage.costUsd),
				onTodos: todos => progress?.todos(todos),
				onTranscript: event => deps.agentLog.append(logRun, event),
				onLoadout: loadout => db.kvSet(loadoutKey(loadout.profile), JSON.stringify(loadout)),
				onUsage: usage => db.recordRun({ kind: "draft", repo: draft.repo, startedAt, usage }),
			},
			signal,
		);
		if (result.aborted === "time") throw new Error(`Drafting the issue took longer than ${DRAFT_MINUTES} minutes`);
		if (result.aborted === "cost") throw new Error(`Drafting the issue reached the $${config.limits.maxCostUsdPerJob} cost limit`);
		if (result.aborted) throw new Error("Drafting the issue was stopped");
		const output = result.output as IssueDraftOutput;
		return db.updateDraft(draft.id, { state: "drafted", title: output.title.trim().slice(0, TITLE_MAX), body: output.body.trim() });
	}

	/** The issue an interrupted `filing` step created, found by its marker; undefined when none was created. */
	async function alreadyFiled(draft: DraftRow): Promise<{ number: number; url: string } | undefined> {
		const marker = draftMarker(draft.id);
		const found = (await github.listLabeledIssues(draft.repo, deps.labels.trigger, draft.created_at)).find(i => i.body?.includes(marker));
		return found ? { number: found.number, url: found.html_url } : undefined;
	}

	/** Files the issue with the trigger label (`drafted` → `filing` → `filed`). */
	async function file(draft: DraftRow, progress: Progress | undefined): Promise<DraftRow> {
		progress?.phase("Filing the issue on GitHub…");
		assertAttached();
		if (draft.state === "filing") {
			const existing = await alreadyFiled(draft);
			if (existing) {
				log("info", "drafted issue was already filed", { repo: draft.repo, draft: draft.id, issue: existing.number });
				return db.updateDraft(draft.id, { state: "filed", issue_number: existing.number, issue_url: existing.url });
			}
		} else {
			draft = db.updateDraft(draft.id, { state: "filing" });
		}
		assertAttached();
		const created = await github.createIssue(draft.repo, draft.title ?? draft.request.slice(0, TITLE_MAX), draftedIssueBody(agentName, draft), [deps.labels.trigger]);
		log("info", "issue drafted from discord", { repo: draft.repo, issue: created.number, user: draft.author_id, draft: draft.id });
		return db.updateDraft(draft.id, { state: "filed", issue_number: created.number, issue_url: created.url });
	}

	/** Starts tracking the filed issue at once; its thread, if any. A failure leaves it to the poller (trigger label). */
	async function track(draft: DraftRow, progress: Progress | undefined): Promise<string | undefined> {
		const number = draft.issue_number!;
		const tracked = db.findIssue(draft.repo, number);
		if (tracked) return tracked.thread_id ?? undefined;
		progress?.phase("Opening the issue's thread…");
		assertAttached();
		try {
			const gh = await github.getIssue(draft.repo, number);
			return (await opts.trackIssue(draft.repo, gh, { via: "command", actorId: draft.author_id })).thread_id ?? undefined;
		} catch (err) {
			log("warn", "drafted issue not tracked at once", { repo: draft.repo, issue: number, error: errorMessage(err) });
			return db.findIssue(draft.repo, number)?.thread_id ?? undefined;
		}
	}

	/** The command's reply when it can still be edited, else a message in the command's channel. */
	async function report(draft: DraftRow, responder: InteractionResponder | undefined, msg: OutMessage): Promise<void> {
		assertAttached();
		if (responder) {
			try {
				await responder.editReply(msg);
				return;
			} catch (err) {
				log("info", "draft reply not editable; posting in the channel", { draft: draft.id, error: errorMessage(err) });
			}
		}
		const content = `<@${draft.author_id}> ${msg.content}`.slice(0, MAX_MESSAGE);
		await discord.send(draft.channel_id, { ...msg, content, mentions: { users: [draft.author_id] } }, "high");
	}

	async function run(id: string, responder: InteractionResponder | undefined): Promise<void> {
		let draft = db.getDraft(id);
		if (!draft) return;
		let progress: Progress | undefined;
		try {
			if (responder) progress = await startProgress(discord, { responder }, `Drafting an issue for ${draft.repo}`, "Starting…");
			if (draft.state === "drafting") draft = await produce(draft, progress);
			if (draft.state === "drafted" || draft.state === "filing") draft = await file(draft, progress);
			const threadId = await track(draft, progress);
			await progress?.finish("done");
			await report(draft, responder, {
				content: issueCreatedMessage({
					agentName,
					repo: draft.repo,
					number: draft.issue_number!,
					url: draft.issue_url ?? "",
					title: draft.title ?? "",
					description: draft.body ?? "",
					label: deps.labels.trigger,
					createdBy: `@${draft.author}`,
					threadId,
				}),
			});
			draft = db.updateDraft(id, { state: "done" });
		} catch (err) {
			if (err instanceof RunDetached || signal.aborted) {
				// The run (or the filing) is finished by the next engine (NFR-03).
				progress?.stop();
				log("info", "issue draft detached", { draft: id, state: draft.state });
				return;
			}
			const reason = errorMessage(err);
			log("error", "issue draft failed", { repo: draft.repo, draft: id, error: reason });
			await progress?.finish("failed");
			draft = db.updateDraft(id, { state: "failed", error: reason.slice(0, 1500) });
			await report(draft, responder, {
				content: `❌ **Drafting the issue failed:** ${reason.slice(0, 1500)}\nRun \`/work issue\` again to retry.`,
			}).catch(e => log("warn", "draft failure not reported", { draft: id, error: errorMessage(e) }));
		}
		await removeDraftSession(deps, draft);
	}

	return {
		async command(e, repo) {
			const request = String(e.options.request ?? "").trim();
			if (!request) {
				await e.editReply({ content: "Describe the issue with the `request` option." });
				return;
			}
			if (request.length > MAX_REQUEST) {
				await e.editReply({ content: `The request is limited to ${MAX_REQUEST} characters.` });
				return;
			}
			if (deps.chatSlots.full()) {
				await e.editReply({ content: CAPACITY_REACHED });
				return;
			}
			const draft = db.insertDraft({
				id: crypto.randomUUID(),
				repo: repo.fullName,
				request,
				author: e.actor.username,
				authorId: e.actor.userId,
				channelId: e.where.channelId,
			});
			log("info", "issue draft started", { repo: repo.fullName, draft: draft.id, user: e.actor.userId });
			void launch(draft, e);
		},
		start() {
			for (const draft of db.draftsInState("drafting", "drafted", "filing", "filed")) {
				if (live.has(draft.id)) continue;
				log("info", "issue draft resumed after start", { repo: draft.repo, draft: draft.id, state: draft.state });
				void launch(draft, undefined);
			}
		},
		async stop() {
			detaching.abort();
			await Promise.allSettled([...live.values()]);
		},
	};
}
