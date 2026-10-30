import { afterAll, expect, test } from "bun:test";
import { createGitHub } from "../../src/orchestrator/github/app";
import { startFakeGitHub } from "../fakes/github";

const gh = startFakeGitHub();
afterAll(() => gh.stop());

test("opening a pull request again for the same head returns the open one instead of a second (JOB-09, NFR-03)", async () => {
	const github = await createGitHub({ appId: gh.appId, privateKey: gh.privateKey, baseUrl: gh.url, throttle: false });
	gh.addRepo("acme/app");
	const p = { head: "agentbot/issue-1-x", base: "main", title: "T", body: "B" };
	const first = await github.createPull("acme/app", p);
	const again = await github.createPull("acme/app", p);
	expect(again).toEqual(first);
	// Another head, or the same head once its PR closed, opens a new one.
	const other = await github.createPull("acme/app", { ...p, head: "agentbot/issue-2-y" });
	expect(other.number).not.toBe(first.number);
	gh.updateIssue("acme/app", first.number, { state: "closed" });
	expect((await github.createPull("acme/app", p)).number).not.toBe(first.number);
});
