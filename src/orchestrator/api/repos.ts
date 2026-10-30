import { RequestError } from "octokit";
import { REPOS_UNCONFIGURED, type RepoActionRequest, type RepoActionResponse, type RepoEntry, type RepoListing } from "../../shared/adminRepos";
import { resolveLabelNames, type Settings } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import { unwatchRepo, type WatchDeps, WatchRefused, watchChannelName, watchRepo } from "../engine/watches";
import { type CreateGitHubOptions, createGitHub } from "../github/app";
import type { AvailableRepo, GitHub } from "../github/types";
import type { Db } from "../store/db";
import type { Vault } from "../store/vault";
import type { ChannelDirectory } from "./channels";
import { actingAdmin, type AdminRoutes, HttpError, jsonBody, str } from "./http";

/**
 * The Repositories page's endpoints (WEB-32): every installation's repositories with the App credentials from the vault,
 * and Watch/Unwatch as `/work watch` and `/work unwatch` do (DSC-35, DSC-36), over Discord's REST API so they work in
 * every engine phase. A running engine's poller reads the watches every cycle, so a new watch is polled from its next one.
 */

export interface ReposRoutesOptions {
	db: Db;
	vault: Pick<Vault, "isInitialized" | "isUnlocked" | "readSettings">;
	/** The Discord REST clients (shared with the channel dropdowns). */
	channels: Pick<ChannelDirectory, "rest">;
	/** octokit `baseUrl` and throttling; tests point it at `test/fakes/github.ts`. */
	github?: Pick<CreateGitHubOptions, "baseUrl" | "throttle">;
}

/** A listing failure as the admin sees it: GH-02 key wording, a wrong App id, or GitHub unreachable. */
function githubProblem(err: unknown, appId: number, connecting: boolean): string {
	const message = errorMessage(err);
	if (!(err instanceof RequestError)) return message.startsWith("GitHub App private key:") ? message : `GitHub is unreachable: ${message}`;
	if (err.status >= 500) return `GitHub is unreachable: ${message}`;
	if (connecting && (err.status === 401 || err.status === 403 || err.status === 404)) {
		return `GitHub rejected App id ${appId} with this private key (HTTP ${err.status}: ${message}). Check the App ID on the GitHub App's settings page, and that the key was generated for that App.`;
	}
	return `GitHub refused the request (HTTP ${err.status}): ${message}`;
}

export function createReposRoutes(opts: ReposRoutesOptions): AdminRoutes {
	const { db, vault } = opts;
	/** One App client per credentials, independent of the engine's; a failed connect is not kept, so Retry retries. */
	let client: { key: string; github: Promise<GitHub> } | undefined;

	function storedSettings(): Settings | undefined {
		if (!vault.isInitialized() || !vault.isUnlocked()) throw new HttpError(409, "Settings are locked; log in to unlock them.");
		return vault.readSettings();
	}

	async function connect(settings: Settings): Promise<GitHub> {
		const appId = settings.config.github.appId;
		const privateKey = settings.secrets.githubAppPrivateKey;
		const key = `${appId}\0${privateKey}`;
		if (client?.key !== key) {
			const entry = { key, github: createGitHub({ appId, privateKey, ...opts.github }) };
			client = entry;
			entry.github.catch(() => {
				if (client === entry) client = undefined;
			});
		}
		try {
			return await client.github;
		} catch (err) {
			throw new HttpError(400, githubProblem(err, appId, true));
		}
	}

	async function repositories(settings: Settings, refresh: boolean): Promise<{ github: GitHub; repos: AvailableRepo[] }> {
		const github = await connect(settings);
		try {
			return { github, repos: await github.listRepositories({ refresh }) };
		} catch (err) {
			throw new HttpError(400, githubProblem(err, settings.config.github.appId, false));
		}
	}

	const channelUrl = (settings: Settings, channelId: string) => `https://discord.com/channels/${settings.config.discord.guildId}/${channelId}`;

	async function listing(refresh: boolean): Promise<RepoListing> {
		const settings = storedSettings();
		if (!settings) return { state: "unconfigured", message: REPOS_UNCONFIGURED };
		let found: { github: GitHub; repos: AvailableRepo[] };
		try {
			found = await repositories(settings, refresh);
		} catch (err) {
			if (!(err instanceof HttpError)) throw err;
			log("warn", "repository listing failed", { error: err.message });
			return { state: "error", error: err.message };
		}
		if (found.repos.length === 0) return { state: "empty", installUrl: found.github.installUrl };
		const watches = new Map(db.listWatches().map(w => [w.repo_id, w]));
		const repos: RepoEntry[] = found.repos.map(r => {
			const watch = watches.get(r.id);
			return {
				id: r.id,
				fullName: r.fullName,
				private: r.private,
				archived: r.archived,
				defaultBranch: r.defaultBranch,
				watch: watch ? { state: watch.state, channelId: watch.channel_id, channelUrl: channelUrl(settings, watch.channel_id) } : null,
			};
		});
		const watched = (r: RepoEntry) => (r.watch && r.watch.state !== "unwatched" ? 0 : 1);
		repos.sort((a, b) => watched(a) - watched(b) || a.fullName.localeCompare(b.fullName));
		return { state: "ok", repos, installUrl: found.github.installUrl };
	}

	/** The acting admin, the requested `owner/name`, the stored settings and the REST-backed watch deps. */
	async function action(req: Request) {
		const admin = actingAdmin(req);
		if (!admin) throw new HttpError(400, "The acting admin (X-Agentbot-Admin) is required.");
		const repo = str((await jsonBody<RepoActionRequest>(req)).repo).trim();
		if (!repo) throw new HttpError(400, "Choose a repository.");
		const settings = storedSettings();
		if (!settings) throw new HttpError(400, REPOS_UNCONFIGURED);
		const discord = opts.channels.rest(settings.secrets.discordToken);
		const deps: WatchDeps & { discord: typeof discord } = { db, config: settings.config, labels: resolveLabelNames(settings.config), discord };
		return { admin, repo, settings, deps };
	}

	async function watch(req: Request): Promise<RepoActionResponse> {
		const { admin, repo: name, settings, deps } = await action(req);
		const { repos } = await repositories(settings, false);
		const repo = repos.find(r => r.fullName.toLowerCase() === name.toLowerCase());
		if (!repo) throw new HttpError(400, `${name} is not an available repository.`);
		const botUserId = await deps.discord.me().then(
			user => user.id,
			() => undefined,
		);
		try {
			const outcome = await watchRepo(deps, repo, admin, botUserId);
			const url = channelUrl(settings, outcome.channelId);
			if (outcome.alreadyWatched) return { message: `${repo.fullName} is already watched.`, channelUrl: url };
			const where = outcome.created ? `a new channel #${watchChannelName(repo.fullName)}` : "its earlier channel";
			return {
				message: `Watching ${repo.fullName} in ${where}. Issues labelled ${deps.labels.trigger} are picked up while the engine is running.`,
				channelUrl: url,
			};
		} catch (err) {
			if (err instanceof WatchRefused) throw new HttpError(400, err.message.replaceAll("**", ""));
			log("warn", "watch from the Repositories page failed", { repo: repo.fullName, admin, error: errorMessage(err) });
			throw new HttpError(400, `Could not watch ${repo.fullName}: ${errorMessage(err)}`);
		}
	}

	async function unwatch(req: Request): Promise<RepoActionResponse> {
		const { admin, repo: name, settings, deps } = await action(req);
		const before = db.watchByName(name);
		if (!before || before.state === "unwatched") return { message: `${name} is not watched.` };
		await unwatchRepo(deps, before.repo, admin);
		return { message: `Stopped watching ${before.repo}. Its channel is kept.`, channelUrl: channelUrl(settings, before.channel_id) };
	}

	return {
		"/repos": { methods: ["GET"], handle: async (_req, url) => Response.json(await listing(url.searchParams.has("refresh"))) },
		"/repos/watch": { methods: ["POST"], handle: async req => Response.json(await watch(req)) },
		"/repos/unwatch": { methods: ["POST"], handle: async req => Response.json(await unwatch(req)) },
	};
}
