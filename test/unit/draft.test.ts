import { afterEach, describe, expect, test } from "bun:test";
import type { Actor } from "../../src/orchestrator/discord/surface";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { createChatSlots } from "../../src/orchestrator/engine/chatSlots";
import type { EngineDeps, Scheduler, TrackIssue } from "../../src/orchestrator/engine/deps";
import { createIssueDrafter, draftMarker, type IssueDrafter } from "../../src/orchestrator/engine/draft";
import { createTrackIssue } from "../../src/orchestrator/engine/issues";
import type { DraftRow } from "../../src/orchestrator/store/db";
import type { FakeResponse } from "../fakes/discord";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

interface Drafts {
	h: EngineHarness;
	drafter: IssueDrafter;
	dispatcher: FakeDispatcher;
	alice: Actor;
	/** Every `trackIssue` call: repo, number, source. */
	tracked: { repo: string; number: number; actorId?: string }[];
	/** A new engine instance over the same database and dispatcher (fresh signal and chat slots), not yet started. */
	restart(): Promise<IssueDrafter>;
}

let current: Drafts | undefined;

afterEach(async () => {
	if (!current) return;
	await current.drafter.stop();
	await current.h.stop();
	current = undefined;
});

async function setup(opts: { limits?: Record<string, unknown> } = {}): Promise<Drafts> {
	const dispatcher = createFakeDispatcher();
	const h = await createEngineHarness({ dispatcher, config: opts.limits ? { limits: opts.limits } : {} });
	h.gh.addRepo("o/r");
	const tracked: Drafts["tracked"] = [];
	const make = (deps: EngineDeps) => {
		// Only `enqueue` is used by trackIssue; the plan job itself is not under test here.
		const scheduler = { enqueue: (issueId: number, kind: "plan") => h.db.insertJob(issueId, kind) } as unknown as Scheduler;
		const real = createTrackIssue(deps, scheduler);
		const trackIssue: TrackIssue = (repo, issue, source) => {
			tracked.push({ repo, number: issue.number, actorId: source.via === "command" ? source.actorId : undefined });
			return real(repo, issue, source);
		};
		return createIssueDrafter(deps, { trackIssue });
	};
	let drafter = make(h.deps);
	h.discord.onEvent(async event => {
		if (event.type === "command" && event.command === "work" && event.subcommand === "issue") {
			await event.defer({ ephemeral: true });
			await drafter.command(event, await h.deps.github.repo("o/r"));
		}
	});
	await h.discord.login("token");
	current = {
		h,
		drafter,
		dispatcher,
		alice: h.discord.actor(ALLOWED_USER, { username: "alice" }),
		tracked,
		async restart() {
			await drafter.stop();
			const controller = new AbortController();
			drafter = make({ ...h.deps, signal: controller.signal, chatSlots: createChatSlots(h.deps.config.limits.maxChatSessions) });
			if (current) current.drafter = drafter;
			return drafter;
		},
	};
	return current;
}

/** Waits for what the drafter reaches in the background (runs, GitHub calls and the Discord queue settle off the handler). */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

async function draftIssue(d: Drafts, request: string) {
	return d.h.discord.emitCommand({ command: "work", subcommand: "issue", options: { repo: "o/r", request }, actor: d.alice, channelId: d.h.workChannelId });
}

const lastReply = (responses: FakeResponse[]) => responses.filter(r => r.type === "editReply").at(-1)?.msg?.content ?? "";
const allDrafts = (d: Drafts): DraftRow[] => d.h.db.draftsInState("drafting", "drafted", "filing", "filed", "done", "failed");
const issueCount = (d: Drafts) => d.h.gh.getRepo("o/r").issues.size;
/** Channel messages that report a filed issue (posted when the command's reply can no longer be used). */
const channelReports = (d: Drafts) => d.h.discord.messages(d.h.workChannelId).filter(m => m.content.startsWith(`<@${ALLOWED_USER}> ✅ **Issue created**`));

describe("/work issue (§7.2)", () => {
	test("refuses at capacity before drafting anything", async () => {
		const d = await setup({ limits: { maxChatSessions: 1 } });
		const gate = Promise.withResolvers<void>();
		void d.h.deps.chatSlots.track("chat:t-1", gate.promise);
		const emitted = await draftIssue(d, "Add a dark mode");
		expect(lastReply(emitted.responses)).toBe("Chat capacity reached; try again shortly.");
		expect(allDrafts(d)).toEqual([]);
		expect(d.dispatcher.runs).toHaveLength(0);
		expect(issueCount(d)).toBe(0);
		gate.resolve();
	});

	test("drafts on the base checkout, files with the trigger label and the quoted request, tracks it, and shows ✅", async () => {
		const d = await setup();
		d.dispatcher.once({ kind: "draft" }, { output: { title: "  Dark mode  ", body: "## Summary\nAdd it.\n\n## Context\n`src/theme.ts`" } });
		const emitted = await draftIssue(d, "Add a dark mode\nwith a toggle");
		await until(() => lastReply(emitted.responses).startsWith("✅ **Issue created**") && allDrafts(d)[0]?.session_file === null, "the ✅ reply and the session removed");

		const [draft] = allDrafts(d);
		const run = d.dispatcher.runs[0]!;
		expect(run.req).toMatchObject({
			owner: { kind: "draft", draftId: draft!.id },
			kind: "draft",
			profile: "draft",
			resume: false,
			limits: { minutes: 10, costUsd: d.h.deps.config.limits.maxCostUsdPerJob },
			checkout: { repo: "o/r" },
		});
		expect(run.req.checkout?.issueBranch).toBeUndefined();
		expect(run.req.prompt).toContain("Add a dark mode\nwith a toggle");
		expect(emitted.responses.some(r => r.type === "editReply" && r.msg?.content.includes("**Drafting an issue for o/r**"))).toBe(true);

		const agent = d.h.deps.config.agent.name;
		const issue = d.h.gh.getIssue("o/r", 1);
		expect(issue.title).toBe("Dark mode");
		expect(issue.labels).toEqual([d.h.deps.labels.trigger]);
		expect(issue.body).toBe(
			`## Summary\nAdd it.\n\n## Context\n\`src/theme.ts\`\n\n---\n_Drafted by ${agent} from a Discord request by @alice via \`/work issue\`:_\n> Add a dark mode\n> with a toggle\n\n${draftMarker(draft!.id)}`,
		);

		expect(d.tracked).toEqual([{ repo: "o/r", number: 1, actorId: ALLOWED_USER }]);
		const row = d.h.db.findIssue("o/r", 1)!;
		expect(row.thread_id).toBeTruthy();
		const reply = lastReply(emitted.responses);
		expect(reply).toContain("**#1** Dark mode");
		expect(reply).toContain("https://github.com/o/r/issues/1");
		expect(reply).toContain(`<#${row.thread_id}>`);
		expect(d.h.db.getDraft(draft!.id)).toMatchObject({ state: "done", issue_number: 1, session_file: null });
		expect(channelReports(d)).toHaveLength(0);
	});

	test("a failed draft reports the error and files nothing", async () => {
		const d = await setup();
		d.dispatcher.once({ kind: "draft" }, { aborted: "time" });
		const emitted = await draftIssue(d, "Something big");
		await until(() => lastReply(emitted.responses).startsWith("❌") && allDrafts(d)[0]?.session_file === null, "the failure reply and the session removed (ENG-05)");
		expect(lastReply(emitted.responses)).toBe("❌ **Drafting the issue failed:** Drafting the issue took longer than 10 minutes\nRun `/work issue` again to retry.");
		expect(allDrafts(d)[0]).toMatchObject({ state: "failed", session_file: null });
		expect(issueCount(d)).toBe(0);
		expect(d.tracked).toEqual([]);
	});

	test("a lost draft run fails with the worker-lost message and is not retried (RUN-04)", async () => {
		const d = await setup();
		d.dispatcher.once({ kind: "draft" }, { lost: true });
		const emitted = await draftIssue(d, "Something big");
		await until(() => lastReply(emitted.responses).startsWith("❌"), "the failure reply");
		expect(lastReply(emitted.responses)).toBe(
			"❌ **Drafting the issue failed:** the worker running this was lost (pod evicted or crashed)\nRun `/work issue` again to retry.",
		);
		expect(allDrafts(d)[0]).toMatchObject({ state: "failed" });
		expect(d.dispatcher.calls).toHaveLength(1);
		expect(issueCount(d)).toBe(0);
	});

	test("rejects a request over 4000 characters", async () => {
		const d = await setup();
		const emitted = await draftIssue(d, "x".repeat(4001));
		expect(lastReply(emitted.responses)).toBe("The request is limited to 4000 characters.");
		expect(allDrafts(d)).toEqual([]);
	});
});

describe("restart (NFR-03)", () => {
	test("a run that finished while no engine was attached is filed once and reported in the channel", async () => {
		const d = await setup();
		d.dispatcher.once({ kind: "draft" }, { hold: true, output: { title: "Late issue", body: "Body" } });
		await draftIssue(d, "Do the thing");
		await until(() => d.dispatcher.runs[0]?.registered === true, "draft run");
		const id = allDrafts(d)[0]!.id;

		const restarted = await d.restart();
		d.dispatcher.runs[0]!.finish();
		restarted.start();
		await until(() => channelReports(d).length === 1, "the channel report");
		expect(channelReports(d)[0]!.content).toContain("**#1** Late issue");
		expect(channelReports(d)[0]!.mentions).toEqual({ users: [ALLOWED_USER] });
		expect(issueCount(d)).toBe(1);
		expect(d.tracked).toHaveLength(1);
		expect(d.h.db.getDraft(id)).toMatchObject({ state: "done", issue_number: 1 });
		expect(d.dispatcher.runs).toHaveLength(1);

		// Another restart finds nothing left to do.
		(await d.restart()).start();
		await d.h.discord.settled();
		expect(issueCount(d)).toBe(1);
		expect(channelReports(d)).toHaveLength(1);
		expect(d.dispatcher.calls).toHaveLength(2);
	});

	test("a run still going at the restart is re-attached and filed once", async () => {
		const d = await setup();
		d.dispatcher.once({ kind: "draft" }, { hold: true });
		await draftIssue(d, "Do another thing");
		await until(() => d.dispatcher.runs[0]?.registered === true, "draft run");
		const restarted = await d.restart();
		restarted.start();
		await until(() => d.dispatcher.calls.length === 2, "the re-attach");
		expect(d.dispatcher.calls[1]!.attached).toBe(true);
		d.dispatcher.runs[0]!.finish();
		await until(() => channelReports(d).length === 1, "the channel report");
		expect(issueCount(d)).toBe(1);
		expect(d.tracked).toHaveLength(1);
	});

	test("an issue filed just before the restart recorded it is found by its marker, not filed again", async () => {
		const d = await setup();
		const draft = d.h.db.insertDraft({ id: "d-1", repo: "o/r", request: "Fix it", author: "alice", authorId: ALLOWED_USER, channelId: d.h.workChannelId });
		d.h.db.updateDraft(draft.id, { state: "filing", title: "Fix it", body: "Body" });
		d.h.gh.addIssue("o/r", { title: "Fix it", body: `Body\n\n${draftMarker("d-1")}`, labels: [d.h.deps.labels.trigger] });

		const restarted = await d.restart();
		restarted.start();
		await until(() => channelReports(d).length === 1, "the channel report");
		expect(issueCount(d)).toBe(1);
		expect(d.dispatcher.runs).toHaveLength(0);
		expect(d.tracked).toEqual([{ repo: "o/r", number: 1, actorId: ALLOWED_USER }]);
		expect(d.h.db.getDraft("d-1")).toMatchObject({ state: "done", issue_number: 1 });
	});
});
