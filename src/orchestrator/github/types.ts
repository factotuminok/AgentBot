/**
 * The GitHub App client the engine uses (requirements §2). Ported from DevForge `src/github/app.ts` with these changes:
 * no configured repos — every repository the App's installations can access is available (GH-25), installations are
 * looked up per repo on first use and cached (GH-03); label names are configurable (GH-08, GH-22).
 * `createGitHub` (github/app.ts) implements it; `test/fakes/github.ts` serves the same REST routes for octokit's `baseUrl`.
 */

export interface GhUser {
	login: string;
	type: string;
}

export interface GhIssue {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: string[];
	html_url: string;
	updated_at: string;
	author: string;
	/** Present when the "issue" is a pull request (the issues API lists both). */
	isPullRequest: boolean;
}

export interface GhReview {
	id: number;
	user: GhUser | null;
	body: string | null;
	state: string;
	author_association: string;
}

export interface GhReviewComment {
	id: number;
	user: GhUser | null;
	body: string;
	path: string;
	line: number | null;
	original_line?: number | null;
	diff_hunk: string;
	author_association: string;
}

export interface GhIssueComment {
	id: number;
	user: GhUser | null;
	body: string | null;
	author_association: string;
	created_at: string;
}

export interface GhCheckRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	app: { slug: string } | null;
	/** Check suite the run belongs to; `null` when GitHub omits it. */
	check_suite: { id: number } | null;
	output: { summary: string | null };
	/** GitHub Actions job URL, when the run belongs to Actions (GH-21). */
	details_url?: string | null;
}

export interface GhWorkflowRun {
	id: number;
	workflow_id: number;
	run_number: number;
	event: string;
	status: string;
	conclusion: string | null;
	head_sha: string;
	check_suite_id?: number;
}

export interface RepoWorkflow {
	name: string;
	path: string;
	/** YAML source at the ref; null when it could not be read. */
	source: string | null;
}

/** Commit identity (GH-04): `<slug>[bot]`, `<id>+<slug>[bot]@users.noreply.github.com`. */
export interface BotIdentity {
	name: string;
	email: string;
	login: string;
}

/** A repository an installation can access (GH-25, WEB-32). */
export interface AvailableRepo {
	/** GitHub repository id; watches are keyed by it (DSC-37). */
	id: number;
	/** `owner/name` */
	fullName: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	installationId: number;
}

/** GH-03: the App cannot access the repository. Message names it and links the App's installation page. */
export class RepoNotAccessible extends Error {
	override name = "RepoNotAccessible";
	constructor(
		readonly repo: string,
		readonly installUrl: string,
	) {
		super(`The GitHub App cannot access ${repo}; install it on that repository: ${installUrl}`);
	}
}

export interface GitHub {
	identity: BotIdentity;
	/** `https://github.com/apps/<slug>/installations/new` */
	installUrl: string;
	/** Every repository of every installation, all pages; cached for at most 60 s unless `refresh` (GH-25, WEB-32). */
	listRepositories(opts?: { refresh?: boolean }): Promise<AvailableRepo[]>;
	/** The repository, or throws `RepoNotAccessible` (GH-03). */
	repo(fullName: string): Promise<AvailableRepo>;
	/** Installation access token for git (WS-02). */
	gitToken(repo: string): Promise<string>;
	getIssue(repo: string, n: number): Promise<GhIssue>;
	/** Issue AND PR conversation comments, all pages. */
	listIssueComments(repo: string, n: number): Promise<GhIssueComment[]>;
	/** Open issues carrying `label`, updated since `since`, excluding PRs, all pages (GH-10). */
	listLabeledIssues(repo: string, label: string, since?: string): Promise<GhIssue[]>;
	commentIssue(repo: string, n: number, body: string): Promise<{ id: number; url: string }>;
	updateComment(repo: string, commentId: number, body: string): Promise<{ id: number; url: string }>;
	/** Creates missing labels in the repo (GH-08) with a colour, then adds them. */
	addLabels(repo: string, n: number, labels: string[]): Promise<void>;
	/** Ignores 404 (label not present). */
	removeLabel(repo: string, n: number, label: string): Promise<void>;
	createIssue(repo: string, title: string, body: string, labels?: string[]): Promise<{ number: number; url: string }>;
	createPull(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }>;
	getPull(repo: string, n: number): Promise<{ state: "open" | "closed"; merged: boolean; headSha: string; url: string }>;
	listReviews(repo: string, pr: number): Promise<GhReview[]>;
	listReviewComments(repo: string, pr: number): Promise<GhReviewComment[]>;
	listCheckRuns(repo: string, sha: string): Promise<GhCheckRun[]>;
	/** Active workflows (state `active`, not under `dynamic/`) with their YAML at `ref`. */
	listActiveWorkflows(repo: string, ref: string): Promise<RepoWorkflow[]>;
	listWorkflowRuns(repo: string, sha: string): Promise<GhWorkflowRun[]>;
	/** Head commit of a branch; `null` when the branch does not exist. */
	getBranchSha(repo: string, branch: string): Promise<string | null>;
	/** Last `lines` lines of an Actions job log (GH-21). */
	getActionsJobLogTail(repo: string, jobId: number, lines?: number): Promise<string>;
}
