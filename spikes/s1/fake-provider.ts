/**
 * Spike S1: a fake OAuth model provider, registered the same way in the orchestrator ("parent") and the worker
 * ("child"). Its `refreshToken` posts to the local fake token endpoint and tags the request with the calling role, so
 * the endpoint can count who exchanged a refresh token. No real provider and no real credential is involved.
 */
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER = "s1-fake-oauth";
export const MODEL_ID = "s1-fake-model";

export interface FakeTokens {
	access: string;
	refresh: string;
	expires: number;
}

/** Registers the fake provider (OpenAI-compatible chat API at `baseUrl`, OAuth refresh at `tokenUrl`). */
export function registerFakeProvider(
	registry: ModelRegistry,
	opts: { baseUrl: string; tokenUrl: string; role: string; headers?: Record<string, string> },
): void {
	registry.registerProvider(PROVIDER, {
		baseUrl: opts.baseUrl,
		api: "openai-completions",
		headers: opts.headers,
		oauth: {
			name: "S1 fake OAuth",
			login: async () => {
				throw new Error("s1: login is not part of the spike");
			},
			refreshToken: async credentials => {
				const res = await fetch(opts.tokenUrl, {
					method: "POST",
					headers: { "content-type": "application/json", "x-s1-role": opts.role },
					body: JSON.stringify({ grant_type: "refresh_token", refresh_token: credentials.refresh }),
				});
				if (!res.ok) throw new Error(`s1 token endpoint: ${res.status} ${await res.text()}`);
				const body = (await res.json()) as FakeTokens;
				return { ...credentials, ...body };
			},
		},
		models: [
			{
				id: MODEL_ID,
				name: "S1 fake model",
				reasoning: false,
				input: ["text"],
				supportsTools: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 1_000,
			},
		],
	});
}
