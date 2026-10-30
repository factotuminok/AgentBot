import { expect, test } from "bun:test";
import { createUsageMeter, type SessionStatsSource } from "../../src/worker/host/usage";

/** A session whose cumulative stats the test sets, like omp's `getSessionStats` over the in-memory transcript. */
function session(cost: number, input: number, output = 0) {
	const stats = { cost, tokens: { input, output, cacheRead: 0, cacheWrite: 0 } };
	const source: SessionStatsSource = { getSessionStats: () => structuredClone(stats) };
	return { stats, source };
}

test("a resumed session counts only usage after the baseline; shrinking stats after compaction add nothing (OBS-05)", () => {
	// The resumed history already cost $2 and 1000 input tokens.
	const s = session(2, 1000);
	const meter = createUsageMeter(s.source);
	expect(meter.update()).toEqual({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	s.stats.cost = 2.5;
	s.stats.tokens.input = 1200;
	s.stats.tokens.output = 30;
	expect(meter.update()).toMatchObject({ costUsd: 0.5, input: 200, output: 30 });
	// Compaction drops messages: the cumulative stats shrink; nothing is subtracted or recounted.
	s.stats.cost = 0.25;
	s.stats.tokens.input = 100;
	expect(meter.update()).toMatchObject({ costUsd: 0.5, input: 200, output: 30 });
	// New turns after compaction count from the shrunken sample.
	s.stats.cost = 0.5;
	s.stats.tokens.input = 150;
	expect(meter.update()).toMatchObject({ costUsd: 0.75, input: 250, output: 30 });
	expect(meter.total).toMatchObject({ input: 250 });
});
