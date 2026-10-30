import type { CreateGitHubOptions } from "../github/app";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { Controller } from "../engine/controller";
import { DISCORD_API } from "../discord/rest";
import { type Accounts, createAccounts, ompSigninBackend, type SigninBackend } from "../store/accounts";
import type { AgentLog } from "../store/agentlog";
import type { Db } from "../store/db";
import type { Signins } from "../store/signins";
import type { Vault } from "../store/vault";
import type { OmpUpdater } from "../omp/updates";
import type { RollingFiles } from "../../shared/rollinglog";
import type { Settings } from "../../shared/config";
import { type ChannelCheck, createChannelDirectory, createChannelsRoutes } from "./channels";
import type { AdminRoutes } from "./http";
import { createLogsRoutes } from "./logs";
import { createModelsRoutes } from "./models";
import { createOmpRoutes } from "./omp";
import { createReposRoutes } from "./repos";
import { createSkillsRoutes } from "./skills";
import { createWorkspaceRoutes } from "./workspace";

/**
 * The admin UI's feature endpoints (§9.3) and the hooks the built-in admin API needs from them, composed in one place
 * so the orchestrator and the end-to-end tests mount exactly the same set. External services are reached through
 * `discordApi`, `github` and `signinBackend`, which default to the real ones.
 */

export interface AdminFeatureDeps {
	db: Db;
	vault: Vault;
	signins: Signins;
	dispatcher: Pick<Dispatcher, "mcpTest">;
	agentLog: AgentLog;
	processLog: RollingFiles;
	stateDir: string;
	ompDir: string;
	/** The engine, restarted by a settings.json save from the config workspace (ENG-02). */
	controller: Controller;
	/** `AGENTBOT_WORKER_CAPACITY`, for the save's health warnings. */
	workerCapacity: number;
	/** In-place omp updates, for the omp page's status and "Check now" (UPD-10). */
	ompUpdates: Pick<OmpUpdater, "status" | "check">;
	/** Discord's API root; default the public API. */
	discordApi?: string;
	/** octokit `baseUrl` and throttling for the Repositories page; default api.github.com. */
	github?: Pick<CreateGitHubOptions, "baseUrl" | "throttle">;
	/** omp's provider sign-ins; default omp's own (SEC-12). */
	signinBackend?: SigninBackend;
}

export interface AdminFeatures {
	routes: AdminRoutes;
	accounts: Accounts;
	/** WEB-24: the save-time check of the configured channels. */
	checkChannels(settings: Settings): Promise<ChannelCheck>;
	/** Model sign-ins, for the home page's count. */
	modelAccounts(): number;
}

export function createAdminFeatures(deps: AdminFeatureDeps): AdminFeatures {
	const channels = createChannelDirectory({ db: deps.db, vault: deps.vault, discordApi: deps.discordApi ?? DISCORD_API });
	const accounts = createAccounts({ signins: deps.signins, backend: deps.signinBackend ?? ompSigninBackend(deps.signins, deps.stateDir) });
	const checkChannels = (settings: Settings) => channels.check(settings);
	return {
		routes: {
			...createSkillsRoutes({ ompDir: deps.ompDir }),
			...createLogsRoutes({ agentLog: deps.agentLog, processLog: deps.processLog }),
			...createModelsRoutes(accounts),
			...createOmpRoutes({ vault: deps.vault, dispatcher: deps.dispatcher, updates: deps.ompUpdates }),
			...createChannelsRoutes(channels),
			...createReposRoutes({ db: deps.db, vault: deps.vault, channels, ...(deps.github ? { github: deps.github } : {}) }),
			...createWorkspaceRoutes({ vault: deps.vault, controller: deps.controller, workerCapacity: deps.workerCapacity, checkChannels, ompDir: deps.ompDir }),
		},
		accounts,
		checkChannels,
		modelAccounts: () => deps.signins.authStorage.credentials.list().length,
	};
}
