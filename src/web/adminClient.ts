import {
	ADMIN_PREFIX,
	type AdminState,
	type CredentialsRequest,
	type EnginePhase,
	type LoginRequest,
	type LoginResponse,
	type SettingsSaveRequest,
	type SettingsSaveResponse,
	type SettingsView,
	type SetupRequest,
	type StatusReport,
	type UsageWindow,
} from "../shared/adminApi";
import { z } from "zod";
import { errorMessage } from "../shared/log";

/** The orchestrator could not be reached, or rejected this pod's web API token (architecture §2.2). `reason` is for logs and logged-in pages. */
export class OrchestratorUnavailable extends Error {
	override name = "OrchestratorUnavailable";
	constructor(readonly reason: string) {
		super("orchestrator unavailable");
	}
}

/** A non-2xx answer other than 401: `status` and the orchestrator's `{error}` text (400 = validation, shown to the admin; 409 = wrong vault state). */
export class AdminApiError extends Error {
	override name = "AdminApiError";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The orchestrator's `/readyz`, reduced to what web's unauthenticated `/healthz` may relay (RUN-13). */
export interface OrchestratorHealth {
	reachable: boolean;
	phase: EnginePhase | null;
	limits: {
		maxConcurrentJobs: number;
		maxChatSessions: number;
		maxConcurrentRuns: number;
		workerCapacity: number;
		effectiveConcurrency: number;
	} | null;
}

/** Every web read and write, over the orchestrator's admin API (`src/shared/adminApi.ts`). `admin` is the acting username (WEB-29). */
export interface AdminClient {
	state(): Promise<AdminState>;
	setup(req: SetupRequest): Promise<void>;
	login(req: LoginRequest): Promise<LoginResponse>;
	credentials(req: CredentialsRequest, admin: string): Promise<void>;
	settings(): Promise<SettingsView>;
	saveSettings(req: SettingsSaveRequest, admin: string): Promise<SettingsSaveResponse>;
	status(window: UsageWindow): Promise<StatusReport>;
	/** Never throws: an unreachable orchestrator or a body that isn't a health body reads as unreachable. */
	health(): Promise<OrchestratorHealth>;
}

export interface AdminClientOptions {
	/** `AGENTBOT_ORCHESTRATOR_URL`, without a trailing slash. */
	baseUrl: string;
	/** Contents of `AGENTBOT_WEB_API_TOKEN_FILE` (SEC-14). */
	token: string;
	/** Per-request timeout for reads and most writes; default 15 s. */
	timeoutMs?: number;
	/** Timeout for a settings save, which waits for the engine to apply them (ENG-02); default 120 s. */
	saveTimeoutMs?: number;
	/** Timeout of the `/readyz` probe behind web `/healthz`; default 3 s. */
	healthTimeoutMs?: number;
}

const PHASES = ["setup", "locked", "unconfigured", "starting", "running", "stopping", "error"] as const satisfies readonly EnginePhase[];

const healthSchema = z.object({
	phase: z.enum(PHASES),
	limits: z
		.object({
			maxConcurrentJobs: z.number(),
			maxChatSessions: z.number(),
			maxConcurrentRuns: z.number(),
			workerCapacity: z.number(),
			effectiveConcurrency: z.number(),
		})
		.nullable()
		.catch(null),
});

/** Only a known phase and numeric limits survive (zod strips other keys), so nothing else from the orchestrator's body can reach an unauthenticated response. */
function healthFrom(body: unknown): OrchestratorHealth {
	const parsed = healthSchema.safeParse(body);
	if (!parsed.success) return { reachable: false, phase: null, limits: null };
	return { reachable: true, phase: parsed.data.phase, limits: parsed.data.limits };
}

/** The `{error}` text of an error body, if it has one. */
function errorText(body: unknown): string | undefined {
	if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
	return undefined;
}

export function createAdminClient(opts: AdminClientOptions): AdminClient {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const saveTimeoutMs = opts.saveTimeoutMs ?? 120_000;
	const healthTimeoutMs = opts.healthTimeoutMs ?? 3_000;

	async function call<T>(method: string, path: string, init: { body?: unknown; admin?: string; timeoutMs?: number } = {}): Promise<T> {
		const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}`, Accept: "application/json" };
		if (init.body !== undefined) headers["Content-Type"] = "application/json";
		// Header values must be ASCII; the orchestrator decodes this with decodeURIComponent.
		if (init.admin !== undefined) headers["X-Agentbot-Admin"] = encodeURIComponent(init.admin);
		let res: Response;
		try {
			res = await fetch(`${opts.baseUrl}${ADMIN_PREFIX}${path}`, {
				method,
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
			});
		} catch (err) {
			throw new OrchestratorUnavailable(errorMessage(err));
		}
		if (res.status === 401) {
			await res.body?.cancel();
			throw new OrchestratorUnavailable("the orchestrator rejected the web API token (AGENTBOT_WEB_API_TOKEN_FILE)");
		}
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			body = undefined;
		}
		if (!res.ok) {
			const message = errorText(body) ?? `HTTP ${res.status}`;
			throw new AdminApiError(res.status, message);
		}
		return body as T;
	}

	return {
		state: () => call<AdminState>("GET", "/state"),
		async setup(req) {
			await call("POST", "/setup", { body: req, admin: req.username });
		},
		login: req => call<LoginResponse>("POST", "/login", { body: req, admin: req.username }),
		async credentials(req, admin) {
			await call("POST", "/credentials", { body: req, admin });
		},
		settings: () => call<SettingsView>("GET", "/settings"),
		saveSettings: (req, admin) => call<SettingsSaveResponse>("PUT", "/settings", { body: req, admin, timeoutMs: saveTimeoutMs }),
		status: window => call<StatusReport>("GET", `/status?window=${encodeURIComponent(window)}`),
		async health() {
			try {
				const res = await fetch(`${opts.baseUrl}/readyz`, { signal: AbortSignal.timeout(healthTimeoutMs) });
				return healthFrom(await res.json());
			} catch {
				return { reachable: false, phase: null, limits: null };
			}
		},
	};
}
