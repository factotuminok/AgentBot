import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseConfig, resolveLabelNames } from "../../src/shared/config";
import type { EngineDeps, Scheduler, TrackIssue } from "../../src/orchestrator/engine/deps";
import { createGitHub } from "../../src/orchestrator/github/app";
import { APPLIED_LABELS_KEY } from "../../src/orchestrator/github/labels";
import { createPoller, type Poller } from "../../src/orchestrator/github/poller";
import { openDb, type Db } from "../../src/orchestrator/store/db";
import { createFakeDiscord, type FakeDiscord } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const baseConfig = {
	discord: { guildId: "g1", allowedUserIds: ["u1"], workChannelId: "work" },
	github: { appId: 1, pollIntervalSeconds: 60 },
};

interface Harness {
	deps: EngineDeps;
	db: Db;
	discord: FakeDiscord;
	cancels: { issueId: number; reason: string }[];
	/** `stopJobs` calls with the issue's state at the time (GH-14). */
	stops: { issueId: number; state: string }[];
	enqueued: { issueId: number; kind: string; input: Record<string, unknown> }[];
	tracked: { repo: string; number: number }[];
	/** What `scheduler.isBusy` answers. */
	busy: { value: boolean };
	poller: Poller;
}

let gh: FakeGitHub;
let controller: AbortController;

beforeEach(() => {
	gh = startFakeGitHub();
	controller = new AbortController();
});
afterEach(async () => {
	controller.abort();
	await gh.stop();
});

async function harness(opts: { db?: Db; trigger?: string } = {}): Promise<Harness> {
	const config = parseConfig({ ...baseConfig, labels: { trigger: opts.trigger ?? "agentbot" } });
	const labels = resolveLabelNames(config);
	const db = opts.db ?? openDb(":memory:");
	const github = await createGitHub({ appId: gh.appId, privateKey: gh.privateKey, baseUrl: gh.url, labels, throttle: false });
	const discord = createFakeDiscord();
	const cancels: Harness["cancels"] = [];
	const stops: Harness["stops"] = [];
	const enqueued: Harness["enqueued"] = [];
	const tracked: Harness["tracked"] = [];
	const busy = { value: false };
	const dispatcher = { releaseIssue: async () => {} };
	const deps = { config, labels, db, github, discord, dispatcher, sessionDir: "/nonexistent-sessions", signal: controller.signal } as unknown as EngineDeps;
	const scheduler = {
		async cancelIssue(issueId: number, reason: string) {
			cancels.push({ issueId, reason });
			db.setIssueState(issueId, "cancelled");
		},
		async stopJobs(issueId: number) {
			stops.push({ issueId, state: db.getIssue(issueId)!.state });
		},
		isBusy: () => busy.value,
		enqueue(issueId: number, kind: string, input: Record<string, unknown>) {
			enqueued.push({ issueId, kind, input });
			// Like the real scheduler: the queued job makes the issue busy.
			busy.value = true;
		},
	} as unknown as Scheduler;
	const trackIssue: TrackIssue = async (repo, issue) => {
		tracked.push({ repo, number: issue.number });
		return db.insertIssue(repo, issue.number, issue.title);
	};
	return { deps, db, discord, cancels, stops, enqueued, tracked, busy, poller: createPoller(deps, scheduler, trackIssue) };
}

function watch(db: Db, fullName: string, channelId = `ch-${fullName}`): void {
	db.watchRepo({ repoId: gh.getRepo(fullName).id, repo: fullName, channelId, createdBy: "u1" });
}

describe("poller", () => {
	test("tracks a new labelled issue in a watched repo once, and advances the cursor (GH-10 to GH-12)", async () => {
		gh.addRepo("acme/app");
		const issue = gh.addIssue("acme/app", { title: "Add thing", labels: ["agentbot"] });
		gh.addIssue("acme/app", { title: "Unlabelled" });
		gh.addIssue("acme/app", { title: "Plan", labels: ["agentbot"], body: "x <!-- agentbot:plan-thread -->" });
		const h = await harness();
		watch(h.db, "acme/app");
		await h.poller.cycle();
		await h.poller.cycle();
		expect(h.tracked).toEqual([{ repo: "acme/app", number: issue.number }]);
		const row = h.db.watchByName("acme/app")!;
		expect(row.cursor).not.toBeNull();
		expect(row.last_polled_at).not.toBeNull();
		expect(row.last_error).toBeNull();
	});

	test("ignores labelled issues in unwatched repos (GH-27)", async () => {
		gh.addRepo("acme/app");
		gh.addRepo("acme/other");
		gh.addIssue("acme/other", { title: "Nope", labels: ["agentbot"] });
		const h = await harness();
		watch(h.db, "acme/app");
		await h.poller.cycle();
		expect(h.tracked).toEqual([]);
		expect(gh.requests.some(r => r.path === "/repos/acme/other/issues")).toBe(false);
	});

	test("a tracked issue that is closed is cancelled, even in an unwatched repo (GH-13, GH-27)", async () => {
		gh.addRepo("acme/app");
		const issue = gh.addIssue("acme/app", { title: "Thing", labels: ["agentbot"] });
		const h = await harness();
		const row = h.db.insertIssue("acme/app", issue.number, issue.title);
		h.db.setIssueState(row.id, "planning");
		await h.poller.cycle();
		expect(h.cancels).toEqual([]);
		gh.updateIssue("acme/app", issue.number, { state: "closed" });
		await h.poller.cycle();
		expect(h.cancels).toEqual([{ issueId: row.id, reason: "issue closed" }]);
	});

	test("losing the trigger label cancels (GH-13)", async () => {
		gh.addRepo("acme/app");
		const issue = gh.addIssue("acme/app", { title: "Thing", labels: ["agentbot"] });
		const h = await harness();
		const row = h.db.insertIssue("acme/app", issue.number, issue.title);
		gh.updateIssue("acme/app", issue.number, { labels: [] });
		await h.poller.cycle();
		expect(h.cancels).toEqual([{ issueId: row.id, reason: "`agentbot` label removed" }]);
	});

	test("a label rename relabels tracked issues without cancelling them (GH-23, GH-24)", async () => {
		gh.addRepo("acme/app");
		const issue = gh.addIssue("acme/app", { title: "Thing", labels: ["agentbot", "agentbot:planning"] });
		const db = openDb(":memory:");
		const first = await harness({ db });
		const row = db.insertIssue("acme/app", issue.number, issue.title);
		db.setIssueState(row.id, "planning");
		await first.poller.cycle();
		expect(JSON.parse(db.kvGet(APPLIED_LABELS_KEY)!).trigger).toBe("agentbot");

		const renamed = await harness({ db, trigger: "bot" });
		// The first relabel attempt fails (400: octokit does not retry it): the issue must not be judged by the new trigger meanwhile.
		gh.failRoute(/^POST \/repos\/acme\/app\/issues\/\d+\/labels$/, 400);
		await renamed.poller.cycle();
		expect(renamed.cancels).toEqual([]);
		expect(JSON.parse(db.kvGet(APPLIED_LABELS_KEY)!).trigger).toBe("agentbot");

		gh.failRoute(/^POST \/repos\/acme\/app\/issues\/\d+\/labels$/, undefined);
		await renamed.poller.cycle();
		expect(renamed.cancels).toEqual([]);
		expect(gh.getIssue("acme/app", issue.number).labels.sort()).toEqual(["bot", "bot:planning"]);
		expect(JSON.parse(db.kvGet(APPLIED_LABELS_KEY)!).trigger).toBe("bot");
		// GH-24: old labels stay in the repo; new ones were created with role colours.
		const repoLabels = gh.getRepo("acme/app").labels;
		expect(repoLabels.get("bot")?.color).toBe("5319e7");
		expect(repoLabels.get("bot:planning")?.color).toBe("fbca04");
		expect(gh.requests.some(r => r.method === "DELETE" && r.path.includes("/labels/") && !r.path.includes("/issues/"))).toBe(false);
	});

	test("an error in one repo does not stop the others and is recorded on its watch (GH-06)", async () => {
		gh.addRepo("acme/bad");
		gh.addRepo("acme/good");
		const good = gh.addIssue("acme/good", { title: "Fine", labels: ["agentbot"] });
		const h = await harness();
		watch(h.db, "acme/bad");
		watch(h.db, "acme/good");
		gh.failRoute(/^GET \/repos\/acme\/bad\/issues$/, 400);
		await h.poller.cycle();
		expect(h.tracked).toEqual([{ repo: "acme/good", number: good.number }]);
		expect(h.db.watchByName("acme/bad")!.last_error).toContain("fake failure 400");
		expect(h.db.watchByName("acme/good")!.last_error).toBeNull();
		expect(h.poller.status().watches.find(w => w.repo === "acme/bad")?.lastError).toContain("400");
	});

	test("follows a rename by repo id and suspends/resumes on lost access (DSC-37)", async () => {
		gh.addRepo("acme/app");
		const h = await harness();
		watch(h.db, "acme/app");
		const id = gh.getRepo("acme/app").id;
		gh.renameRepo("acme/app", "acme/renamed");
		await h.poller.cycle();
		expect(h.db.getWatch(id)!.repo).toBe("acme/renamed");

		gh.revokeRepo("acme/renamed");
		// The repository listing is cached for 60 s; a fresh client sees the change.
		const later = await harness({ db: h.db });
		await later.poller.cycle();
		expect(h.db.getWatch(id)!.state).toBe("suspended");
		gh.restoreRepo("acme/renamed");
		const again = await harness({ db: h.db });
		await again.poller.cycle();
		expect(h.db.getWatch(id)!.state).toBe("watching");
	});

	test("a repository watched after the cached listing was made is not suspended (DSC-37)", async () => {
		gh.addRepo("acme/app");
		const h = await harness();
		watch(h.db, "acme/app");
		await h.poller.cycle();
		// Installed and watched (e.g. from the web Repositories page) while the engine's listing is still cached.
		gh.addRepo("acme/new");
		gh.addIssue("acme/new", { title: "First", labels: ["agentbot"] });
		watch(h.db, "acme/new");
		await h.poller.cycle();
		expect(h.db.watchByName("acme/new")!.state).toBe("watching");
		expect(h.tracked).toEqual([{ repo: "acme/new", number: 1 }]);
	});

	test("pollNow resolves immediately when stopped and after a fresh cycle when running (GH-07)", async () => {
		const h = await harness();
		await h.poller.pollNow("acme/app");
		h.poller.start();
		await h.poller.pollNow();
		h.poller.stop();
	});
});

/** An `in_review` issue of the unwatched `acme/app` with open PR (head `head-1`) and a thread (GH-27: no watch needed). */
async function inReview(h: Harness, issueState: Partial<{ ci_attempts: number; ci_last_sha: string }> = {}) {
	if (!gh.repos.size) gh.addRepo("acme/app");
	const ghIssue = gh.addIssue("acme/app", { title: "Thing", labels: ["agentbot"] });
	const pull = gh.addPull("acme/app", { head: "agentbot/issue-1-thing", headSha: "head-1" });
	const thread = h.discord.addChannel({ name: "thing", kind: "thread", parentId: "work" });
	const row = h.db.insertIssue("acme/app", ghIssue.number, ghIssue.title);
	h.db.setIssueState(row.id, "in_review");
	h.db.updateIssue(row.id, { pr_number: pull.number, thread_id: thread.id, ...issueState });
	return { issue: row, pull, threadId: thread.id };
}

describe("poller review of an issue with an open PR", () => {
	test("a merged PR stops the jobs first, then ends the issue done with 🎉 Complete (GH-14)", async () => {
		const h = await harness();
		const { issue, pull, threadId } = await inReview(h);
		pull.state = "closed";
		pull.pull!.merged = true;
		await h.poller.cycle();
		await h.discord.settled();
		expect(h.stops).toEqual([{ issueId: issue.id, state: "in_review" }]);
		expect(h.cancels).toEqual([]);
		expect(h.db.getIssue(issue.id)!.state).toBe("done");
		expect(h.discord.lastMessage(threadId)!.content).toBe(`🎉 **Complete** — PR #${pull.number} was merged. Archiving this thread.`);
		await h.poller.cycle();
		expect(h.stops).toHaveLength(1);
	});

	test("a PR closed without merging stops the jobs first, then cancels with ⏹️ Stopped (GH-14)", async () => {
		const h = await harness();
		const { issue, pull, threadId } = await inReview(h);
		pull.state = "closed";
		await h.poller.cycle();
		await h.discord.settled();
		expect(h.stops).toEqual([{ issueId: issue.id, state: "in_review" }]);
		expect(h.db.getIssue(issue.id)!.state).toBe("cancelled");
		expect(h.discord.lastMessage(threadId)!.content).toBe(`⏹️ **Stopped** — PR #${pull.number} was closed without merging. Archiving this thread.`);
	});

	test("feedback and CI are evaluated only for in_review issues (GH-15)", async () => {
		const h = await harness();
		const { issue, pull } = await inReview(h);
		gh.addReview("acme/app", pull.number, { body: "Please rename it", state: "CHANGES_REQUESTED" });
		gh.addCheckRun("acme/app", "head-1", { name: "test", conclusion: "failure" });
		h.db.setIssueState(issue.id, "implementing");
		await h.poller.cycle();
		expect(h.enqueued).toEqual([]);
		expect(gh.requests.some(r => r.path.includes("/pulls/") || r.path.includes("/check-runs"))).toBe(false);
	});

	test("feedback is not read while the issue has a queued or running job (GH-15)", async () => {
		const h = await harness();
		const { pull } = await inReview(h);
		gh.addReview("acme/app", pull.number, { body: "Please rename it", state: "CHANGES_REQUESTED" });
		gh.addCheckRun("acme/app", "head-1", { name: "test", conclusion: "failure" });
		h.busy.value = true;
		await h.poller.cycle();
		expect(h.enqueued).toEqual([]);
		expect(gh.requests.some(r => r.path.endsWith(`/pulls/${pull.number}/reviews`) || r.path.includes("/check-runs"))).toBe(false);
	});

	test("new feedback enqueues one revise, skips CI that cycle, and seen items never trigger again (GH-16, GH-17)", async () => {
		const h = await harness();
		const { issue, pull } = await inReview(h);
		gh.addReview("acme/app", pull.number, { body: "Please rename it", state: "CHANGES_REQUESTED" });
		gh.addIssueComment("acme/app", pull.number, { body: "/agentbot also add a test" });
		gh.addIssueComment("acme/app", pull.number, { body: "nice work" });
		gh.addCheckRun("acme/app", "head-1", { name: "test", conclusion: "failure" });
		await h.poller.cycle();
		expect(h.enqueued.map(e => e.kind)).toEqual(["revise"]);
		const items = h.enqueued[0]!.input.items as { id: string }[];
		expect(items.map(i => i.id.split(":")[0]).sort()).toEqual(["ic", "review"]);
		expect(gh.requests.some(r => r.path.includes("/check-runs"))).toBe(false);

		// The revise ran (the job marks its items seen) and the issue is idle again: nothing re-enqueues them.
		for (const item of items) h.db.markSeen("acme/app", pull.number, item.id);
		h.busy.value = false;
		h.enqueued.length = 0;
		h.db.updateIssue(issue.id, { ci_last_sha: "head-1" });
		await h.poller.cycle();
		await h.poller.cycle();
		expect(h.enqueued).toEqual([]);
	});

	test("CI on the head SHA: only complete runs on a new SHA enqueue fix_ci with logs and the SHA (GH-18, GH-20, GH-21, GH-27)", async () => {
		const h = await harness();
		const { issue } = await inReview(h);
		const failing = gh.addCheckRun("acme/app", "head-1", { name: "test", conclusion: "failure" });
		gh.addCheckRun("acme/app", "head-1", { name: "lint", status: "in_progress", conclusion: null });
		gh.getRepo("acme/app").jobLogs.set(failing, "boom: expected 1, got 2\n");
		await h.poller.cycle();
		expect(h.enqueued).toEqual([]);

		gh.getRepo("acme/app").checkRuns.get("head-1")!.at(-1)!.status = "completed";
		await h.poller.cycle();
		expect(h.enqueued).toHaveLength(1);
		expect(h.enqueued[0]).toMatchObject({ issueId: issue.id, kind: "fix_ci", input: { sha: "head-1" } });
		const failures = h.enqueued[0]!.input.failures as { name: string; logTail?: string }[];
		expect(failures.map(f => f.name)).toEqual(["test"]);
		expect(JSON.stringify(failures)).toContain("boom: expected 1, got 2");

		// fix_ci records the SHA it attempted; the same SHA never triggers again (no duplicate push).
		h.busy.value = false;
		h.enqueued.length = 0;
		h.db.updateIssue(issue.id, { ci_attempts: 1, ci_last_sha: "head-1" });
		await h.poller.cycle();
		expect(h.enqueued).toEqual([]);
	});

	test("attempts exhausted on a new failing SHA: the SHA is recorded and one 'needs a human' message is posted (GH-20)", async () => {
		const h = await harness();
		const { issue, pull, threadId } = await inReview(h, { ci_attempts: 3, ci_last_sha: "head-0" });
		gh.addCheckRun("acme/app", "head-1", { name: "test", conclusion: "timed_out" });
		await h.poller.cycle();
		await h.poller.cycle();
		await h.discord.settled();
		expect(h.enqueued).toEqual([]);
		expect(h.db.getIssue(issue.id)!.ci_last_sha).toBe("head-1");
		expect(h.discord.messages(threadId).map(m => m.content)).toEqual(["⚠️ **CI is still failing after 3 fix attempts** — this needs a human."]);
		expect(gh.requests.filter(r => r.method === "POST" && r.path.endsWith(`/issues/${pull.number}/comments`))).toEqual([]);
	});
});
