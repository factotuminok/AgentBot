import type { EnginePhase } from "../../shared/adminApi";
import type { Config } from "../../shared/config";

export type { EnginePhase };

export interface HealthLimits {
	maxConcurrentJobs: number;
	maxChatSessions: number;
	maxConcurrentRuns: number;
	workerCapacity: number;
	effectiveConcurrency: number;
}

/** The orchestrator's unauthenticated health body (architecture §4.5). RUN-13: version, phase, counts, limits and fixed warning texts only. */
export interface HealthBody {
	status: "ok" | "unavailable";
	version: string;
	phase: EnginePhase;
	runs: { pending: number; running: number };
	limits: HealthLimits | null;
	warnings: string[];
}

/**
 * Limits and warnings (RUN-10 to RUN-12). `config` is undefined while the settings are locked or not yet saved, and then `limits` is null.
 * An unset `workers.maxConcurrentRuns` means "worker capacity".
 */
export function healthLimits(config: Config | undefined, workerCapacity: number): { limits: HealthLimits | null; warnings: string[] } {
	if (!config) return { limits: null, warnings: [] };
	const { maxConcurrentJobs, maxChatSessions } = config.limits;
	const maxConcurrentRuns = config.workers.maxConcurrentRuns ?? workerCapacity;
	const sum = maxConcurrentJobs + maxChatSessions;
	const effectiveConcurrency = Math.min(sum, maxConcurrentRuns, workerCapacity);
	const warnings: string[] = [];
	if (sum < workerCapacity) {
		warnings.push(`maxConcurrentJobs + maxChatSessions (${sum}) is below worker capacity (${workerCapacity}): at most ${effectiveConcurrency} workers will be used`);
	}
	if (maxConcurrentRuns > workerCapacity) {
		warnings.push(`workers.maxConcurrentRuns (${maxConcurrentRuns}) exceeds worker capacity (${workerCapacity}): runs may wait with no worker coming`);
	}
	return { limits: { maxConcurrentJobs, maxChatSessions, maxConcurrentRuns, workerCapacity, effectiveConcurrency }, warnings };
}
