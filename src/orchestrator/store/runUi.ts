import { ownerKey, type RunOwner, type RunUiState } from "../dispatch/dispatcher";
import type { Db } from "./db";

/**
 * RUN-14: the Discord state of a run's live messages (status and to-do message ids, latest progress and to-do list),
 * stored per run owner in the key-value store as `runui:<ownerKey>`. A job or chat re-executed after an orchestrator
 * restart reads it to keep editing the same messages; the engine clears it once it is done with the run.
 */

export const runUiKey = (owner: RunOwner): string => `runui:${ownerKey(owner)}`;

export interface RunUiStore {
	get(owner: RunOwner): RunUiState | undefined;
	set(owner: RunOwner, state: RunUiState): void;
	clear(owner: RunOwner): void;
}

export function createRunUiStore(db: Db): RunUiStore {
	const remove = db.raw.query<null, [string]>("DELETE FROM kv WHERE key = ?");
	return {
		get(owner) {
			const raw = db.kvGet(runUiKey(owner));
			if (!raw) return undefined;
			try {
				return JSON.parse(raw) as RunUiState;
			} catch {
				return undefined;
			}
		},
		set: (owner, state) => db.kvSet(runUiKey(owner), JSON.stringify(state)),
		clear: owner => void remove.run(runUiKey(owner)),
	};
}
