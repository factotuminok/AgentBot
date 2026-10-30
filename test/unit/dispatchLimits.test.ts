import { describe, expect, test } from "bun:test";
import { dispatchLimits } from "../../src/orchestrator/dispatch/workers";

describe("dispatchLimits (RUN-01)", () => {
	test("without saved settings only MCP connection tests run, up to the worker capacity (AGT-21)", () => {
		expect(dispatchLimits(undefined, 4)).toEqual({ maxConcurrentJobs: 0, maxChatSessions: 0, maxConcurrentRuns: 4 });
	});

	test("the settings' caps, with maxConcurrentRuns defaulting to the worker capacity", () => {
		const limits = { maxConcurrentJobs: 2, maxChatSessions: 3 };
		expect(dispatchLimits({ limits, workers: { reattachGraceSeconds: 90 } } as never, 4)).toEqual({ ...limits, maxConcurrentRuns: 4 });
		expect(dispatchLimits({ limits, workers: { maxConcurrentRuns: 1, reattachGraceSeconds: 90 } } as never, 4)).toEqual({ ...limits, maxConcurrentRuns: 1 });
	});
});
