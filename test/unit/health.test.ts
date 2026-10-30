import { describe, expect, test } from "bun:test";
import { healthLimits } from "../../src/orchestrator/api/health";
import { type Config, parseConfig } from "../../src/shared/config";

function config(limits: { maxConcurrentJobs: number; maxChatSessions: number }, maxConcurrentRuns?: number): Config {
	return parseConfig({
		discord: { guildId: "g", allowedUserIds: ["u"], workChannelId: "c" },
		github: { appId: 1 },
		limits,
		workers: maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns },
	});
}

describe("healthLimits (RUN-10 to RUN-12)", () => {
	test("limits are null while settings are locked or unsaved", () => {
		expect(healthLimits(undefined, 10)).toEqual({ limits: null, warnings: [] });
	});

	test("job + chat caps below capacity bound concurrency and warn", () => {
		const { limits, warnings } = healthLimits(config({ maxConcurrentJobs: 2, maxChatSessions: 2 }), 10);
		expect(limits).toEqual({ maxConcurrentJobs: 2, maxChatSessions: 2, maxConcurrentRuns: 10, workerCapacity: 10, effectiveConcurrency: 4 });
		expect(warnings).toEqual(["maxConcurrentJobs + maxChatSessions (4) is below worker capacity (10): at most 4 workers will be used"]);
	});

	test("caps equal to capacity raise no warning", () => {
		expect(healthLimits(config({ maxConcurrentJobs: 2, maxChatSessions: 2 }), 4).warnings).toEqual([]);
	});

	test("maxConcurrentRuns above capacity warns; capacity still bounds concurrency", () => {
		const { limits, warnings } = healthLimits(config({ maxConcurrentJobs: 5, maxChatSessions: 5 }, 12), 10);
		expect(limits?.effectiveConcurrency).toBe(10);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith("workers.maxConcurrentRuns (12) exceeds worker capacity (10)");
	});

	test("maxConcurrentRuns below the caps bounds concurrency", () => {
		expect(healthLimits(config({ maxConcurrentJobs: 4, maxChatSessions: 4 }, 3), 10).limits?.effectiveConcurrency).toBe(3);
	});
});
