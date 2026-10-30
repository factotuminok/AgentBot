import { accessSync, constants } from "node:fs";
import type { Server } from "bun";
import { ADMIN_PREFIX } from "../../shared/adminApi";
import type { Config } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { Db } from "../store/db";
import type { AdminApi } from "./admin";
import { type EnginePhase, type HealthBody, healthLimits } from "./health";

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
}

export interface InternalApi {
	url: string;
	/** Stops listening; open sockets are closed (ENG-04). */
	stop(): Promise<void>;
}

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

/** The orchestrator's internal API on 8081 (architecture §4.5). Health endpoints are unauthenticated and contain no names, ids or error text (RUN-13). */
export function startInternalApi(opts: InternalApiOptions): InternalApi {
	const server: Server<undefined> = Bun.serve({
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
		fetch: req => {
			const { pathname } = new URL(req.url);
			if (pathname.startsWith(`${ADMIN_PREFIX}/`)) return opts.admin.handle(req);
			return Response.json({ error: "not found" }, { status: 404 });
		},
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
