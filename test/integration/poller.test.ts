import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseConfig, resolveLabelNames } from "../../src/shared/config";
import type { EngineDeps, Scheduler, TrackIssue } from "../../src/orchestrator/engine/deps";
import { createGitHub } from "../../src/orchestrator/github/app";
import { APPLIED_LABELS_KEY } from "../../src/orchestrator/github/labels";
import { createPoller, type Poller } from "../../src/orchestrator/github/poller";
import { openDb, type Db } from "../../src/orchestrator/store/db";
import { createFakeDiscord } from "../fakes/discord";
import { type FakeGitHub, startFakeGitHub } from "../fakes/github";

const baseConfig = {
	discord: { guildId: "g1", allowedUserIds: ["u1"], workChannelId: "work" },
	github: { appId: 1, pollIntervalSeconds: 60 },
};

interface Harness {
	deps: EngineDeps;
	db: Db;
	cancels: { issueId: number; reason: string }[];
	tracked: { repo: string; number: number }[];
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
	const cancels: Harness["cancels"] = [];
	const tracked: Harness["tracked"] = [];
	const deps = { config, labels, db, github, discord: createFakeDiscord(), signal: controller.signal } as unknown as EngineDeps;
	const scheduler = {
		async cancelIssue(issueId: number, reason: string) {
			cancels.push({ issueId, reason });
			db.setIssueState(issueId, "cancelled");
		},
		isBusy: () => false,
		enqueue: () => {
			throw new Error("not expected");
		},
	} as unknown as Scheduler;
	const trackIssue: TrackIssue = async (repo, issue) => {
		tracked.push({ repo, number: issue.number });
		return db.insertIssue(repo, issue.number, issue.title);
	};
	return { deps, db, cancels, tracked, poller: createPoller(deps, scheduler, trackIssue) };
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

	test("pollNow resolves immediately when stopped and after a fresh cycle when running (GH-07)", async () => {
		const h = await harness();
		await h.poller.pollNow("acme/app");
		h.poller.start();
		await h.poller.pollNow();
		h.poller.stop();
	});
});
