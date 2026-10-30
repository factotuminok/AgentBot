import { z } from "zod";

/**
 * Minimal libpod REST client over the Podman API unix socket (spike S6). Only the calls the launcher makes, with the
 * replies it reads parsed by zod; any host works in the URL because the socket is chosen by Bun's `unix` option.
 */

export const LIBPOD_BASE = "http://d/v5.0.0/libpod";
export const ROLE_LABEL = "agentbot.role";
export const WORKER_ROLE = "worker";
/** libpod list states of a worker that exists and is not finished (`dead`/`configured` are rejected with 500). */
export const ACTIVE_STATES = ["created", "running", "paused", "stopping"] as const;
/** Finished workers the reaper removes; never `created`, which would race with a create that has not started yet. */
export const FINISHED_STATES = ["exited", "stopped"] as const;
type ContainerState = (typeof ACTIVE_STATES)[number] | (typeof FINISHED_STATES)[number];

const infoSchema = z.object({
	host: z.object({ security: z.object({ rootless: z.boolean() }) }),
	version: z.object({ Version: z.string() }).optional(),
});

const containerSchema = z.object({
	Id: z.string(),
	Names: z.array(z.string()).nullish(),
	State: z.string(),
	Labels: z.record(z.string(), z.string()).nullish(),
	/** RFC 3339. */
	Created: z.string(),
});
const containerListSchema = z.array(containerSchema);
const createdSchema = z.object({ Id: z.string(), Warnings: z.array(z.string()).nullish() });

export type ContainerSummary = z.infer<typeof containerSchema>;

/** What `GET /info` says about the engine; `rootless` is undefined when the reply is not libpod's (LCH-01). */
export interface EngineInfo {
	status: number;
	rootless?: boolean;
	version?: string;
}

/** The libpod `SpecGenerator` fields a worker container is created with (architecture LCH-02, spike S6). */
export interface WorkerContainerSpec {
	name: string;
	hostname: string;
	image: string;
	entrypoint: string[];
	command: string[];
	user: string;
	labels: Record<string, string>;
	remove: true;
	init: true;
	netns: { nsmode: "bridge" };
	Networks: Record<string, Record<string, never>>;
	portmappings: [];
	publish_image_ports: false;
	env: Record<string, string>;
	/** No privilege gain through setuid binaries (`su`, `mount`, …) and no capabilities, like the Helm worker (F7). */
	no_new_privileges: true;
	cap_drop: string[];
	/** CPU quota per `period` µs (`--cpus`), process/thread limit, and memory with swap equal to it. */
	resource_limits: { memory: { limit: number; swap: number }; cpu: { quota: number; period: number }; pids: { limit: number } };
	/** libpod's `Schema2HealthConfig`: durations in nanoseconds (OBS-01). */
	healthconfig: { Test: string[]; Interval: number; Timeout: number; StartPeriod: number; Retries: number };
	mounts: { destination: string; type: "tmpfs"; source: "tmpfs"; options: string[] }[];
	secrets: { source: string; target: string; uid: number; gid: number; mode: number }[];
}

/** A libpod reply other than the expected status. */
export class PodmanError extends Error {
	constructor(
		readonly call: string,
		readonly status: number,
		readonly body: string,
	) {
		super(`${call} -> ${status} ${body.trim().slice(0, 500)}`);
	}
}

export class PodmanClient {
	constructor(readonly socket: string) {}

	async #call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
		const res = await fetch(`${LIBPOD_BASE}${path}`, {
			method,
			unix: this.socket,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, text: await res.text() };
	}

	/** `GET /info`. Throws only when the socket cannot be reached. */
	async info(): Promise<EngineInfo> {
		const { status, text } = await this.#call("GET", "/info");
		if (status !== 200) return { status };
		const parsed = infoSchema.safeParse(parseJson(text));
		if (!parsed.success) return { status };
		return { status, rootless: parsed.data.host.security.rootless, version: parsed.data.version?.Version };
	}

	/** Containers labelled `agentbot.role=worker` in `states`; the label is checked again on every result (S6). */
	async listWorkers(states: readonly ContainerState[]): Promise<ContainerSummary[]> {
		const filters = encodeURIComponent(JSON.stringify({ label: [`${ROLE_LABEL}=${WORKER_ROLE}`], status: states }));
		const path = `/containers/json?all=true&filters=${filters}`;
		const call = `GET ${path}`;
		const { status, text } = await this.#call("GET", path);
		if (status !== 200) throw new PodmanError(call, status, text);
		const parsed = containerListSchema.safeParse(parseJson(text));
		if (!parsed.success) throw new PodmanError(call, status, `unexpected reply: ${parsed.error.message}`);
		return parsed.data.filter(c => c.Labels?.[ROLE_LABEL] === WORKER_ROLE);
	}

	/** `POST /containers/create`; 201 expected. */
	async create(spec: WorkerContainerSpec): Promise<{ id: string; warnings: string[] }> {
		const { status, text } = await this.#call("POST", "/containers/create", spec);
		if (status !== 201) throw new PodmanError("POST /containers/create", status, text);
		const parsed = createdSchema.safeParse(parseJson(text));
		if (!parsed.success) throw new PodmanError("POST /containers/create", status, `unexpected reply: ${parsed.error.message}`);
		return { id: parsed.data.Id, warnings: parsed.data.Warnings ?? [] };
	}

	/** `POST /containers/{id}/start`; 204 expected (304: already started). */
	async start(id: string): Promise<number> {
		const { status, text } = await this.#call("POST", `/containers/${encodeURIComponent(id)}/start`);
		if (status !== 204 && status !== 304) throw new PodmanError(`POST /containers/${id}/start`, status, text);
		return status;
	}

	/** `DELETE /containers/{id}` without force; 200 expected (404: already gone, e.g. auto-removed). */
	async remove(id: string): Promise<number> {
		const { status, text } = await this.#call("DELETE", `/containers/${encodeURIComponent(id)}?force=false&v=true`);
		if (status !== 200 && status !== 204 && status !== 404) throw new PodmanError(`DELETE /containers/${id}`, status, text);
		return status;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
