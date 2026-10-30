import { describe, expect, test } from "bun:test";
import { detectFeedback } from "../../src/orchestrator/github/feedback";
import type { GhIssueComment, GhReview, GhReviewComment } from "../../src/orchestrator/github/types";

const BOT = "agentbot-app[bot]";
const human = { login: "alice", type: "User" };
const otherBot = { login: "dependabot[bot]", type: "Bot" };
const selfBot = { login: BOT, type: "Bot" };

function review(over: Partial<GhReview>): GhReview {
	return { id: 1, user: human, body: "Please rename this.", state: "COMMENTED", author_association: "MEMBER", ...over };
}

function reviewComment(over: Partial<GhReviewComment>): GhReviewComment {
	return {
		id: 10,
		user: human,
		body: "Off by one here.",
		path: "src/a.ts",
		line: 42,
		original_line: 40,
		diff_hunk: "@@ -1,3 +1,3 @@\n-a\n+b",
		author_association: "COLLABORATOR",
		...over,
	};
}

function issueComment(over: Partial<GhIssueComment>): GhIssueComment {
	return { id: 100, user: human, body: "/agentbot please add tests", author_association: "OWNER", created_at: "2026-01-01T00:00:00Z", ...over };
}

function detect(input: { reviews?: GhReview[]; reviewComments?: GhReviewComment[]; issueComments?: GhIssueComment[]; seen?: string[] }) {
	return detectFeedback({
		reviews: input.reviews ?? [],
		reviewComments: input.reviewComments ?? [],
		issueComments: input.issueComments ?? [],
		botLogin: BOT,
		seen: new Set(input.seen ?? []),
		mentionKeyword: "/agentbot",
	});
}

describe("detectFeedback", () => {
	test("includes trusted human feedback of every kind with prefixed ids", () => {
		const items = detect({ reviews: [review({})], reviewComments: [reviewComment({})], issueComments: [issueComment({})] });
		expect(items.map(i => [i.id, i.kind, i.author])).toEqual([
			["review:1", "review", "alice"],
			["rc:10", "inline", "alice"],
			["ic:100", "comment", "alice"],
		]);
	});

	test("ignores bot-authored reviews and comments (Bot type and own login)", () => {
		const items = detect({
			reviews: [review({ id: 1, user: otherBot }), review({ id: 2, user: selfBot }), review({ id: 3, user: { login: BOT, type: "User" } })],
			reviewComments: [reviewComment({ id: 10, user: otherBot }), reviewComment({ id: 11, user: selfBot })],
			issueComments: [issueComment({ id: 100, user: otherBot }), issueComment({ id: 101, user: selfBot })],
		});
		expect(items).toEqual([]);
	});

	test("ignores comments with no user", () => {
		expect(detect({ reviews: [review({ user: null })], issueComments: [issueComment({ user: null })] })).toEqual([]);
	});

	test("ignores APPROVED reviews with an empty body", () => {
		expect(detect({ reviews: [review({ state: "APPROVED", body: "" }), review({ id: 2, state: "APPROVED", body: null })] })).toEqual([]);
	});

	test("keeps APPROVED reviews that carry a body", () => {
		const items = detect({ reviews: [review({ state: "APPROVED", body: "LGTM but fix the typo" })] });
		expect(items.map(i => i.id)).toEqual(["review:1"]);
	});

	test("keeps CHANGES_REQUESTED reviews even with an empty body", () => {
		const items = detect({ reviews: [review({ state: "CHANGES_REQUESTED", body: "" })] });
		expect(items).toEqual([{ id: "review:1", kind: "review", author: "alice", body: "" }]);
	});

	test("ignores COMMENTED reviews with a blank body", () => {
		expect(detect({ reviews: [review({ state: "COMMENTED", body: "   " })] })).toEqual([]);
	});

	test("ignores conversation comments without the mention keyword", () => {
		expect(detect({ issueComments: [issueComment({ body: "Looks good to me" }), issueComment({ id: 101, body: null })] })).toEqual([]);
	});

	test("ignores untrusted author associations", () => {
		for (const author_association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
			const items = detect({
				reviews: [review({ author_association })],
				reviewComments: [reviewComment({ author_association })],
				issueComments: [issueComment({ author_association })],
			});
			expect(items).toEqual([]);
		}
	});

	test("accepts OWNER, MEMBER and COLLABORATOR", () => {
		const items = detect({
			issueComments: ["OWNER", "MEMBER", "COLLABORATOR"].map((author_association, i) => issueComment({ id: i + 1, author_association })),
		});
		expect(items.map(i => i.id)).toEqual(["ic:1", "ic:2", "ic:3"]);
	});

	test("skips seen ids", () => {
		const items = detect({
			reviews: [review({ id: 1 }), review({ id: 2 })],
			reviewComments: [reviewComment({ id: 10 }), reviewComment({ id: 11 })],
			issueComments: [issueComment({ id: 100 }), issueComment({ id: 101 })],
			seen: ["review:1", "rc:10", "ic:100"],
		});
		expect(items.map(i => i.id)).toEqual(["review:2", "rc:11", "ic:101"]);
	});

	test("seen ids are namespaced per kind", () => {
		const items = detect({ reviewComments: [reviewComment({ id: 5 })], seen: ["review:5", "ic:5"] });
		expect(items.map(i => i.id)).toEqual(["rc:5"]);
	});

	test("inline comments carry path, line and diff hunk", () => {
		const [item] = detect({ reviewComments: [reviewComment({})] });
		expect(item).toEqual({
			id: "rc:10",
			kind: "inline",
			author: "alice",
			body: "Off by one here.",
			path: "src/a.ts",
			line: 42,
			diffHunk: "@@ -1,3 +1,3 @@\n-a\n+b",
		});
	});

	test("outdated inline comments fall back to original_line", () => {
		const [item] = detect({ reviewComments: [reviewComment({ line: null, original_line: 40 })] });
		expect(item?.line).toBe(40);
	});

	test("inline comments with no line at all omit it", () => {
		const [item] = detect({ reviewComments: [reviewComment({ line: null, original_line: null })] });
		expect(item?.line).toBeUndefined();
	});
});
