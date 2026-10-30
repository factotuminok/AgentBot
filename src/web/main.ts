import { loadEnv } from "../shared/env";
import { errorMessage, log } from "../shared/log";
import { readTokenFile } from "../shared/tokens";
import { createAdminClient } from "./adminClient";
import { FEATURE_PAGES } from "./pages";
import { startWebServer } from "./server";
import { startWorkspaceSync } from "./workspace/sync";

/** The web role (architecture §2.2): the admin UI on `AGENTBOT_WEB_HOST:AGENTBOT_WEB_PORT`, backed by the orchestrator's admin API. */
export async function runWeb(): Promise<void> {
	const env = loadEnv();
	const admin = createAdminClient({ baseUrl: env.orchestratorUrl, token: await readTokenFile(env.webApiTokenFile, "AGENTBOT_WEB_API_TOKEN_FILE") });
	const server = startWebServer({
		admin,
		host: env.webHost,
		port: env.webPort,
		pages: FEATURE_PAGES,
		vscode: env.webVscode ? { home: env.home } : undefined,
		trustedProxies: env.webTrustedProxies,
	});
	log("info", "web started", { url: server.url, orchestrator: env.orchestratorUrl });
	// WEB-26/27: the config workspace code-server opens, kept in step with the orchestrator.
	const sync = env.webVscode ? await startWorkspaceSync({ admin, home: env.home }) : undefined;

	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) return;
		stopping = true;
		log("info", "shutting down", { reason: signal });
		Promise.all([server.stop(), sync?.stop()])
			.catch(err => log("error", "shutdown failed", { error: errorMessage(err) }))
			.finally(() => {
				log("info", "shutdown complete");
				process.exit(0);
			});
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
