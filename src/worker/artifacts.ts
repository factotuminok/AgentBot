import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage, log } from "../shared/log";
import { runArtifactPath } from "../shared/wire";

/**
 * Run artifact endpoints (architecture §4.5) with the run's lease token. Network errors and 5xx answers are retried
 * with backoff (1 s to 15 s) until they succeed or the run is stopped, so an upload that fails while the
 * orchestrator is away goes through after it is back (RUN-06). Any other non-2xx answer throws `ArtifactError`.
 */

export class ArtifactError extends Error {
	constructor(
		readonly status: number,
		message: string,
		/** The response body: the orchestrator's reason, e.g. why it rejected a bundle. */
		readonly detail = "",
	) {
		super(message);
		this.name = "ArtifactError";
	}
}

export interface ArtifactClientOptions {
	orchestratorUrl: string;
	runId: string;
	leaseToken: string;
	/** Aborted when the run stops (lease invalid): pending retries end with an `AbortError`. */
	signal: AbortSignal;
	retryMinMs?: number;
	retryMaxMs?: number;
}

export class ArtifactClient {
	readonly #opts: ArtifactClientOptions;

	constructor(opts: ArtifactClientOptions) {
		this.#opts = opts;
	}

	#url(artifact: string): string {
		return `${this.#opts.orchestratorUrl}${runArtifactPath(this.#opts.runId, artifact)}`;
	}

	async #request(method: "GET" | "PUT", artifact: string, body?: () => Blob): Promise<Response> {
		const { signal } = this.#opts;
		const min = this.#opts.retryMinMs ?? 1_000;
		const max = this.#opts.retryMaxMs ?? 15_000;
		for (let attempt = 0; ; attempt++) {
			signal.throwIfAborted();
			let problem: string;
			try {
				const res = await fetch(this.#url(artifact), {
					method,
					headers: { Authorization: `Bearer ${this.#opts.leaseToken}`, ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
					body: body?.(),
					signal,
				});
				if (res.ok || res.status === 404 || (res.status >= 400 && res.status < 500)) return res;
				problem = `HTTP ${res.status}`;
				await res.body?.cancel().catch(() => {});
			} catch (err) {
				if (signal.aborted) throw err;
				problem = errorMessage(err);
			}
			const delay = Math.min(max, min * 2 ** attempt);
			log("warn", "artifact request failed; retrying", { run: this.#opts.runId, method, artifact, error: problem, retryInMs: delay });
			await Bun.sleep(delay);
		}
	}

	/** Downloads `artifact` to `path`. Returns false on 404. */
	async download(artifact: string, path: string): Promise<boolean> {
		const res = await this.#request("GET", artifact);
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			return false;
		}
		if (!res.ok) throw new ArtifactError(res.status, `GET ${artifact} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.part`;
		await Bun.write(tmp, res);
		await rename(tmp, path);
		return true;
	}

	/** Downloads `artifact` into memory. Returns undefined on 404. */
	async bytes(artifact: string): Promise<Uint8Array | undefined> {
		const res = await this.#request("GET", artifact);
		if (res.status === 404) {
			await res.body?.cancel().catch(() => {});
			return undefined;
		}
		if (!res.ok) throw new ArtifactError(res.status, `GET ${artifact} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
		return new Uint8Array(await res.arrayBuffer());
	}

	/** Uploads the file at `path` as `artifact`. */
	async upload(artifact: string, path: string): Promise<void> {
		const res = await this.#request("PUT", artifact, () => Bun.file(path));
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).trim();
			throw new ArtifactError(res.status, `PUT ${artifact} failed: HTTP ${res.status} ${detail}`.trim(), detail);
		}
		await res.body?.cancel().catch(() => {});
	}
}
