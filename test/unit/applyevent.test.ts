import { afterEach, expect, test } from "bun:test";
import { applyEvent } from "../../src/orchestrator/engine/jobs";
import { createEngineHarness, type EngineHarness } from "../fakes/engine";

let h: EngineHarness;
afterEach(async () => {
	await h?.stop();
});

test("transitions close together leave only the latest state label (GH-09)", async () => {
	h = await createEngineHarness();
	h.gh.addRepo("o/r");
	const fake = h.gh.addIssue("o/r", { title: "T", labels: ["agentbot", "agentbot:planning"] });
	h.db.insertIssue("o/r", fake.number, "T");
	const planning = h.db.setIssueState(h.db.findIssue("o/r", fake.number)!.id, "planning");

	// The plan_ready label add is slow; an Approve lands while it is still in flight. A real delay, not a gate: the buggy
	// interleaving needs the second transition's calls to run during this one, and a gate released by those calls would
	// deadlock the serialised (correct) code.
	const github = h.deps.github;
	const addLabels = github.addLabels.bind(github);
	github.addLabels = async (repo, n, labels) => {
		if (labels.includes("agentbot:awaiting-approval")) await Bun.sleep(50);
		return addLabels(repo, n, labels);
	};

	const published = applyEvent(h.deps, planning, "plan_ready");
	const approved = applyEvent(h.deps, h.db.getIssue(planning.id)!, "approved");
	await Promise.all([published, approved]);

	expect(h.gh.getIssue("o/r", fake.number).labels.sort()).toEqual(["agentbot", "agentbot:implementing"]);
	expect(h.db.getIssue(planning.id)?.state).toBe("implementing");
});
