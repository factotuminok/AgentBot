import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import type { CredentialSnapshot } from "../shared/wire";

/**
 * Seeds the run-private omp auth store `<agentDir>/agent.db` from the run spec's sign-in snapshot (CRED-02, spikes S1
 * and S2). The host opens the same store with the refresh hook (CRED-03) and names credentials by their local row
 * ids; the returned map translates those to the orchestrator's ids for `credential-request`. The snapshot carries
 * `__remote__` instead of refresh tokens, so nothing here can refresh with the provider.
 *
 * Loaded lazily (it imports omp): the worker sets `HOME` and `PI_CODING_AGENT_DIR` to run-local paths first.
 */

interface SnapshotEntry {
	id: number | string;
	provider: string;
	credential: { type: string; access?: string; key?: string } & Record<string, unknown>;
}

function isEntry(value: CredentialSnapshot): value is CredentialSnapshot & SnapshotEntry {
	const credential = value.credential as SnapshotEntry["credential"] | undefined;
	return (typeof value.id === "number" || typeof value.id === "string") && typeof value.provider === "string" && !!credential && typeof credential.type === "string";
}

/** What identifies one credential among a provider's rows: its access token or API key. */
function credentialKey(credential: { type: string; access?: unknown; key?: unknown }): string {
	return `${credential.type}:${String(credential.access ?? credential.key ?? "")}`;
}

/** Writes `snapshot` into `<agentDir>/agent.db`; returns local row id → orchestrator credential id. */
export async function seedAuthStore(agentDir: string, snapshot: readonly CredentialSnapshot[]): Promise<Map<string, string>> {
	const byProvider = new Map<string, SnapshotEntry[]>();
	for (const entry of snapshot) {
		if (!isEntry(entry)) throw new Error("invalid credential snapshot entry in the run spec");
		const list = byProvider.get(entry.provider) ?? [];
		list.push(entry);
		byProvider.set(entry.provider, list);
	}
	const ids = new Map<string, string>();
	const storage = await AuthStorage.create(join(agentDir, "agent.db"));
	try {
		for (const [provider, entries] of byProvider) {
			await storage.credentials.set(provider, entries.map(entry => entry.credential) as never);
			const byKey = new Map(entries.map(entry => [credentialKey(entry.credential), entry]));
			for (const row of storage.credentials.list(provider)) {
				const source = byKey.get(credentialKey(row.credential as { type: string }));
				if (source) ids.set(String(row.id), String(source.id));
			}
		}
	} finally {
		storage.close();
	}
	return ids;
}
