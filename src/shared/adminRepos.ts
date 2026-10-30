/**
 * The Repositories page (WEB-32) over the admin API:
 * - GET /internal/admin/repos[?refresh=1] → `RepoListing` (cached for at most 60 s; `refresh` reloads it);
 * - POST /internal/admin/repos/watch and /repos/unwatch with `RepoActionRequest` → `RepoActionResponse`, 400 `{error}`
 *   when refused (archived, missing Manage Channels, credentials not stored, not an available repository).
 */

/** WEB-32: shown before the App credentials are stored. */
export const REPOS_UNCONFIGURED = "Save the GitHub App id and private key to see repositories";

export interface RepoWatch {
	state: "watching" | "suspended" | "unwatched";
	channelId: string;
	/** `https://discord.com/channels/<guild>/<channel>`. */
	channelUrl: string;
}

export interface RepoEntry {
	id: number;
	/** `owner/name`. */
	fullName: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	/** The repository's watch row (DSC-35), kept after unwatching; null when it never was watched. */
	watch: RepoWatch | null;
}

export type RepoListing =
	| { state: "unconfigured"; message: string }
	/** Invalid key (GH-02 wording), wrong App id, GitHub unreachable. */
	| { state: "error"; error: string }
	/** The App has no installation with repositories; `installUrl` is `https://github.com/apps/<slug>/installations/new`. */
	| { state: "empty"; installUrl: string }
	/** Watched first, then by `owner/name`. */
	| { state: "ok"; repos: RepoEntry[]; installUrl: string };

export interface RepoActionRequest {
	/** `owner/name`. */
	repo: string;
}

export interface RepoActionResponse {
	/** Plain text for the page. */
	message: string;
	channelUrl?: string;
}
