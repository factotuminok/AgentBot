/** Tokens and cost consumed by one agent run (excluding the history of a resumed session). */
export interface RunUsage {
	costUsd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function emptyUsage(): RunUsage {
	return { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** The part of an omp `AgentSession` the meter reads: cumulative stats over the in-memory transcript. */
export interface SessionStatsSource {
	getSessionStats(): { cost: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } };
}

export interface UsageMeter {
	/** Running total for this run; mutated by `update`. */
	readonly total: RunUsage;
	/** Samples the session and adds the growth since the previous sample. */
	update(): RunUsage;
}

/**
 * Measures one run's usage from the session's cumulative stats. Those stats include a resumed session's
 * history (excluded by sampling a baseline at creation) and can shrink when compaction drops messages, so only
 * positive deltas between samples are counted.
 */
export function createUsageMeter(session: SessionStatsSource): UsageMeter {
	const sample = (): RunUsage => {
		const { cost, tokens } = session.getSessionStats();
		return { costUsd: cost, input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite };
	};
	let previous = sample();
	const total = emptyUsage();
	return {
		total,
		update() {
			const now = sample();
			for (const key of Object.keys(total) as (keyof RunUsage)[]) total[key] += Math.max(0, now[key] - previous[key]);
			previous = now;
			return total;
		},
	};
}
