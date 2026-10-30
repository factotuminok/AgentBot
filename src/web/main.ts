import { loadEnv } from "../shared/env";
import { errorMessage, log } from "../shared/log";
import { createAdminClient } from "./adminClient";
import { startWebServer } from "./server";

/** Reads the mounted web API token (SEC-14); the web pod cannot reach the admin API without it. */
async function readWebApiToken(path: string | undefined): Promise<string> {
	if (!path) throw new Error("AGENTBOT_WEB_API_TOKEN_FILE must be set: the web UI talks to the orchestrator with that token");
	let token: string;
	try {
		token = (await Bun.file(path).text()).trim();
	} catch (err) {
		throw new Error(`AGENTBOT_WEB_API_TOKEN_FILE ${path} could not be read: ${errorMessage(err)}`);
	}
	if (!token) throw new Error(`AGENTBOT_WEB_API_TOKEN_FILE ${path} is empty`);
	return token;
}

/** The web role (architecture §2.2): the admin UI on `AGENTBOT_WEB_HOST:AGENTBOT_WEB_PORT`, backed by the orchestrator's admin API. */
export async function runWeb(): Promise<void> {
	const env = loadEnv();
	const admin = createAdminClient({ baseUrl: env.orchestratorUrl, token: await readWebApiToken(env.webApiTokenFile) });
	const server = startWebServer({ admin, host: env.webHost, port: env.webPort });
	log("info", "web started", { url: server.url, orchestrator: env.orchestratorUrl });

	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) return;
		stopping = true;
		log("info", "shutting down", { reason: signal });
		server
			.stop()
			.catch(err => log("error", "shutdown failed", { error: errorMessage(err) }))
			.finally(() => {
				log("info", "shutdown complete");
				process.exit(0);
			});
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
