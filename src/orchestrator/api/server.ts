import { accessSync, constants } from "node:fs";
import type { Server } from "bun";
import { ADMIN_PREFIX } from "../../shared/adminApi";
import type { Config } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import { WORKER_WS_PATH } from "../../shared/wire";
import { RUNS_PREFIX } from "../dispatch/artifacts";
import type { Dispatcher } from "../dispatch/dispatcher";
import { sameToken } from "../dispatch/leases";
import type { WorkerDispatcher, WorkerSocketData } from "../dispatch/workers";
import type { Db } from "../store/db";
import type { AdminApi } from "./admin";
import { type EnginePhase, type HealthBody, healthLimits } from "./health";

export const SCALE_PATH = "/internal/scale";

/** The worker-facing surfaces of the dispatcher (architecture §4.5). */
export type WorkerEndpoints = Pick<WorkerDispatcher, "socketData" | "websocket" | "artifact" | "pendingRuns">;

export interface InternalApiOptions {
	host: string;
	port: number;
	stateDir: string;
	db: Db;
	version: string;
	workerCapacity: number;
	/** Current engine phase. */
	phase(): EnginePhase;
	/** Parsed settings, or undefined while locked or not yet saved (RUN-12). */
	config(): Config | undefined;
	/** Run counts for the health body (architecture §4.5). */
	dispatcher: Pick<Dispatcher, "counts">;
	/** `/internal/admin/*`, web token only (SEC-14). */
	admin: AdminApi;
	/** `/internal/worker`, `/internal/runs/<id>/…` and `/internal/scale`; absent, they answer 503. */
	workers?: WorkerEndpoints;
	/** Content of `AGENTBOT_WORKER_TOKEN_FILE`; undefined refuses every worker connection (SEC-14). */
	workerToken?: string;
	/** Content of `AGENTBOT_SCALE_TOKEN_FILE`; undefined refuses every scale request (SEC-14). */
	scaleToken?: string;
}

export interface InternalApi {
	url: string;
	/** Stops listening; open sockets are closed (ENG-04). */
	stop(): Promise<void>;
}

/**
 * Reads a mounted internal token (SEC-14). Undefined (and one log line) when the variable is unset or the file is
 * missing or empty: that surface then refuses everything.
 */
export async function loadInternalToken(path: string | undefined, variable: string, surface: string): Promise<string | undefined> {
	if (!path) {
		log("error", `${variable} is not set: ${surface} refuses every request`);
		return undefined;
	}
	try {
		const token = (await Bun.file(path).text()).trim();
		if (token) return token;
		log("error", `the ${variable} file is empty: ${surface} refuses every request`, { path });
	} catch (err) {
		log("error", `the ${variable} file cannot be read: ${surface} refuses every request`, { path, error: errorMessage(err) });
	}
	return undefined;
}

/** True when the request carries `Authorization: Bearer <expected>` (constant time; never with an undefined token). */
function bearerIs(req: Request, expected: string | undefined): boolean {
	const auth = req.headers.get("authorization") ?? "";
	return expected !== undefined && auth.startsWith("Bearer ") && sameToken(auth.slice(7).trim(), expected);
}

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
const unavailable = () => Response.json({ error: "workers are not served by this process" }, { status: 503 });

/** Ready means the database answers and the state volume is writable (architecture §4.5); never the engine phase. */
function ready(opts: InternalApiOptions): boolean {
	try {
		opts.db.kvGet("health.probe");
		accessSync(opts.stateDir, constants.W_OK);
		return true;
	} catch (err) {
		log("warn", "orchestrator not ready", { error: errorMessage(err) });
		return false;
	}
}

function healthBody(opts: InternalApiOptions, ok: boolean): HealthBody {
	let runs = { pending: 0, running: 0 };
	let config: Config | undefined;
	if (ok) {
		const { pending, running } = opts.dispatcher.counts();
		runs = { pending, running };
	}
	try {
		config = opts.config();
	} catch {
		config = undefined;
	}
	return {
		status: ok ? "ok" : "unavailable",
		version: opts.version,
		phase: opts.phase(),
		runs,
		...healthLimits(config, opts.workerCapacity),
	};
}

/**
 * The orchestrator's internal API on 8081 (architecture §4.5). Health endpoints are unauthenticated and contain no names,
 * ids or error text (RUN-13). Every other surface takes only its own token (SEC-14): the web token on `/internal/admin/*`,
 * the worker token on `/internal/worker`, the scale token on `/internal/scale`, and a run's lease token on that run's
 * `/internal/runs/<id>/…`.
 */
export function startInternalApi(opts: InternalApiOptions): InternalApi {
	const { workers } = opts;
	const server: Server<WorkerSocketData> = Bun.serve<WorkerSocketData>({
		hostname: opts.host,
		port: opts.port,
		routes: {
			// Liveness: 200 while the process responds; same body as readiness.
			"/livez": () => Response.json(healthBody(opts, ready(opts))),
			"/readyz": () => {
				const ok = ready(opts);
				return Response.json(healthBody(opts, ok), { status: ok ? 200 : 503 });
			},
			"/healthz": () => {
				const ok = ready(opts);
				return Response.json(healthBody(opts, ok), { status: ok ? 200 : 503 });
			},
		},
		fetch: (req, srv) => {
			const { pathname } = new URL(req.url);
			if (pathname.startsWith(`${ADMIN_PREFIX}/`)) return opts.admin.handle(req);
			if (pathname === WORKER_WS_PATH) {
				if (!workers) return unavailable();
				if (!bearerIs(req, opts.workerToken)) return unauthorized();
				const address = srv.requestIP(req)?.address ?? "unknown";
				if (srv.upgrade(req, { data: workers.socketData(address) })) return undefined;
				return Response.json({ error: "expected a WebSocket upgrade" }, { status: 400 });
			}
			if (pathname === SCALE_PATH) {
				if (!workers) return unavailable();
				if (!bearerIs(req, opts.scaleToken)) return unauthorized();
				return Response.json({ pendingRuns: workers.pendingRuns() });
			}
			if (pathname.startsWith(RUNS_PREFIX)) return workers ? workers.artifact(req) : unavailable();
			return Response.json({ error: "not found" }, { status: 404 });
		},
		// Never reached without `workers`: nothing upgrades then.
		websocket: workers?.websocket ?? { message: () => {} },
		error: err => {
			log("error", "internal API error", { error: errorMessage(err) });
			return Response.json({ error: "internal error" }, { status: 500 });
		},
	});
	return {
		url: `http://${server.hostname}:${server.port}`,
		stop: () => server.stop(true),
	};
}
