import { createPrivateKey } from "node:crypto";
import { App, Octokit, RequestError } from "octokit";
import type { LabelNames, StateLabelKey } from "../../shared/config";
import { log } from "../../shared/log";
import {
	type AvailableRepo,
	type BotIdentity,
	type GhIssue,
	type GhUser,
	type GitHub,
	RepoNotAccessible,
} from "./types";

/** How long `listRepositories` answers from its cache (GH-25, WEB-32). */
const REPO_LIST_TTL_MS = 60_000;

const TRIGGER_LABEL_COLOR = "5319e7";
const STATE_LABEL_COLORS: Record<StateLabelKey, string> = {
	planning: "fbca04",
	awaitingApproval: "d93f0b",
	implementing: "0e8a16",
	inReview: "1d76db",
	failed: "b60205",
};
const OTHER_LABEL_COLOR = "ededed";

function split(repo: string): { owner: string; repo: string } {
	const [owner, name, extra] = repo.split("/");
	if (!owner || !name || extra !== undefined) throw new Error(`Invalid repo name: ${repo}`);
	return { owner, repo: name };
}

function isStatus(err: unknown, status: number): boolean {
	return err instanceof RequestError && err.status === status;
}

function toUser(user: { login: string; type: string } | null | undefined): GhUser | null {
	return user ? { login: user.login, type: user.type } : null;
}

interface RawIssue {
	number: number;
	title: string;
	body?: string | null;
	state: string;
	labels: (string | { name?: string })[];
	html_url: string;
	updated_at: string;
	user: { login: string } | null;
	pull_request?: unknown;
}

function toIssue(raw: RawIssue): GhIssue {
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? "",
		state: raw.state === "closed" ? "closed" : "open",
		labels: raw.labels.flatMap(label => {
			const name = typeof label === "string" ? label : label.name;
			return name ? [name] : [];
		}),
		html_url: raw.html_url,
		updated_at: raw.updated_at,
		author: raw.user?.login ?? "",
		isPullRequest: !!raw.pull_request,
	};
}

interface RawRepo {
	id: number | bigint;
	full_name: string;
	private: boolean;
	archived?: boolean;
	default_branch?: string;
}

function toRepo(raw: RawRepo, installationId: number): AvailableRepo {
	return {
		id: Number(raw.id),
		fullName: raw.full_name,
		private: raw.private,
		archived: raw.archived ?? false,
		defaultBranch: raw.default_branch ?? "main",
		installationId,
	};
}

const PEM_BEGIN = /^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n/;
const PEM_END = /\n-----END (RSA )?PRIVATE KEY-----$/;

/**
 * GH-02: why `pem` can't sign GitHub App JWTs, or undefined if it can. Octokit only reports "Invalid keyData" for most
 * wrong inputs, and its PEM parsing needs the BEGIN/END lines to be the first and last lines.
 */
export function githubKeyProblem(pem: string): string | undefined {
	pem = pem.trim();
	const whole = "paste the whole .pem file GitHub downloaded, from the -----BEGIN RSA PRIVATE KEY----- line through the -----END RSA PRIVATE KEY----- line";
	if (/-----BEGIN [A-Z ]*PUBLIC KEY-----|^ssh-(rsa|ed25519) /.test(pem)) return `this is a public key; ${whole}`;
	if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) return `this is an OpenSSH key, not the GitHub App key; ${whole}`;
	if (!PEM_BEGIN.test(pem) || !PEM_END.test(pem)) return whole;
	try {
		const type = createPrivateKey(pem).asymmetricKeyType;
		if (type !== "rsa") return `this is a ${type ?? "non-RSA"} key, but GitHub App keys are RSA; ${whole}`;
	} catch (err) {
		return `the key could not be read (${err instanceof Error ? err.message : String(err)}); ${whole} without changes`;
	}
	return undefined;
}

export interface CreateGitHubOptions {
	appId: number;
	privateKey: string;
	/** REST API root; tests point it at `startFakeGitHub().url`. */
	baseUrl?: string;
	/** Effective label names; decides the colour of labels created by `addLabels` (GH-08). */
	labels?: LabelNames;
	/** octokit's request throttling (writes ≥ 1 s apart); default true. Tests against the fake pass false. */
	throttle?: boolean;
}

/** GH-01 to GH-04: validates the key, resolves the App's identity, and returns the client. */
export async function createGitHub(opts: CreateGitHubOptions): Promise<GitHub> {
	const keyProblem = githubKeyProblem(opts.privateKey);
	if (keyProblem) throw new Error(`GitHub App private key: ${keyProblem}`);
	const OctokitClass = Octokit.defaults({
		...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
		...(opts.throttle === false ? { throttle: { enabled: false } } : {}),
	});
	const app = new App({ appId: opts.appId, privateKey: opts.privateKey.trim(), Octokit: OctokitClass });

	const { data: appInfo } = await app.octokit.request("GET /app");
	const slug = appInfo?.slug;
	if (!slug) throw new Error("GET /app returned no slug");
	const login = `${slug}[bot]`;
	const installUrl = `https://github.com/apps/${slug}/installations/new`;

	const clients = new Map<number, Promise<Octokit>>();
	function installationClient(installationId: number): Promise<Octokit> {
		let client = clients.get(installationId);
		if (!client) {
			client = app.getInstallationOctokit(installationId) as Promise<Octokit>;
			client.catch(() => clients.delete(installationId));
			clients.set(installationId, client);
		}
		return client;
	}

	async function installationIds(): Promise<number[]> {
		const installations = await app.octokit.paginate("GET /app/installations", { per_page: 100 });
		return installations.map(i => i.id);
	}

	// GH-04: the bot user's id. `/users/<login>` needs installation (or no) auth, not the App JWT.
	const firstInstallation = (await installationIds())[0];
	const userClient = firstInstallation !== undefined ? await installationClient(firstInstallation) : new OctokitClass();
	const { data: botUser } = await userClient.request("GET /users/{username}", { username: login });
	const identity: BotIdentity = { name: login, email: `${botUser.id}+${login}@users.noreply.github.com`, login };

	/** Lowercased `owner/name` → repo, filled by listings and lookups (GH-03). */
	const repos = new Map<string, AvailableRepo>();
	let listing: { at: number; repos: AvailableRepo[] } | undefined;

	async function listRepositories(refresh = false): Promise<AvailableRepo[]> {
		if (!refresh && listing && Date.now() - listing.at < REPO_LIST_TTL_MS) return listing.repos;
		const all: AvailableRepo[] = [];
		for (const id of await installationIds()) {
			const octokit = await installationClient(id);
			const raw = await octokit.paginate("GET /installation/repositories", { per_page: 100 });
			for (const r of raw as RawRepo[]) all.push(toRepo(r, id));
		}
		all.sort((a, b) => a.fullName.localeCompare(b.fullName));
		repos.clear();
		for (const r of all) repos.set(r.fullName.toLowerCase(), r);
		listing = { at: Date.now(), repos: all };
		return all;
	}

	async function repo(fullName: string): Promise<AvailableRepo> {
		const cached = repos.get(fullName.toLowerCase());
		if (cached) return cached;
		const target = split(fullName);
		try {
			const { data: installation } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", target);
			const octokit = await installationClient(installation.id);
			const { data } = await octokit.request("GET /repos/{owner}/{repo}", target);
			const found = toRepo(data, installation.id);
			repos.set(fullName.toLowerCase(), found);
			return found;
		} catch (err) {
			if (isStatus(err, 404)) throw new RepoNotAccessible(fullName, installUrl);
			throw err;
		}
	}

	async function client(fullName: string): Promise<Octokit> {
		return installationClient((await repo(fullName)).installationId);
	}

	const labelColors = new Map<string, string>();
	if (opts.labels) {
		labelColors.set(opts.labels.trigger.toLowerCase(), TRIGGER_LABEL_COLOR);
		for (const [key, name] of Object.entries(opts.labels.states) as [StateLabelKey, string][]) {
			labelColors.set(name.toLowerCase(), STATE_LABEL_COLORS[key]);
		}
	}
	/** `repo\0label` already ensured to exist in the repo during this instance. */
	const ensured = new Set<string>();

	async function ensureLabel(octokit: Octokit, fullName: string, name: string): Promise<void> {
		const key = `${fullName.toLowerCase()}\0${name.toLowerCase()}`;
		if (ensured.has(key)) return;
		try {
			const color = labelColors.get(name.toLowerCase()) ?? OTHER_LABEL_COLOR;
			await octokit.request("POST /repos/{owner}/{repo}/labels", { ...split(fullName), name, color });
			log("info", "created label", { repo: fullName, label: name });
		} catch (err) {
			// 422: the label exists already.
			if (!isStatus(err, 422)) throw err;
		}
		ensured.add(key);
	}

	return {
		identity,
		installUrl,

		listRepositories: o => listRepositories(o?.refresh ?? false),
		repo,

		async gitToken(fullName) {
			// Installation octokits use createAppAuth with installationId bound; type "installation" returns a cached token object.
			const auth = (await (await client(fullName)).auth({ type: "installation" })) as { token?: unknown };
			if (typeof auth.token !== "string") throw new Error(`Installation auth for ${fullName} returned no token`);
			return auth.token;
		},

		async getIssue(fullName, n) {
			const { data } = await (await client(fullName)).rest.issues.get({ ...split(fullName), issue_number: n });
			return toIssue(data);
		},

		async listIssueComments(fullName, n) {
			const octokit = await client(fullName);
			const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...split(fullName), issue_number: n, per_page: 100 });
			return comments.map(c => ({
				id: c.id,
				user: toUser(c.user),
				body: c.body ?? null,
				author_association: c.author_association,
				created_at: c.created_at,
			}));
		},

		async listLabeledIssues(fullName, label, since) {
			const octokit = await client(fullName);
			const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
				...split(fullName),
				labels: label,
				state: "open",
				per_page: 100,
				...(since ? { since } : {}),
			});
			return issues.filter(issue => !issue.pull_request).map(toIssue);
		},

		async commentIssue(fullName, n, body) {
			const { data } = await (await client(fullName)).rest.issues.createComment({ ...split(fullName), issue_number: n, body });
			return { id: data.id, url: data.html_url };
		},

		async updateComment(fullName, commentId, body) {
			const { data } = await (await client(fullName)).rest.issues.updateComment({ ...split(fullName), comment_id: commentId, body });
			return { id: data.id, url: data.html_url };
		},

		async addLabels(fullName, n, labels) {
			if (labels.length === 0) return;
			const octokit = await client(fullName);
			for (const label of labels) await ensureLabel(octokit, fullName, label);
			await octokit.rest.issues.addLabels({ ...split(fullName), issue_number: n, labels });
		},

		async removeLabel(fullName, n, label) {
			try {
				await (await client(fullName)).rest.issues.removeLabel({ ...split(fullName), issue_number: n, name: label });
			} catch (err) {
				if (!isStatus(err, 404)) throw err;
			}
		},

		async createIssue(fullName, title, body, labels) {
			const octokit = await client(fullName);
			for (const label of labels ?? []) await ensureLabel(octokit, fullName, label);
			const { data } = await octokit.rest.issues.create({ ...split(fullName), title, body, ...(labels?.length ? { labels } : {}) });
			return { number: data.number, url: data.html_url };
		},

		async createPull(fullName, p) {
			const octokit = await client(fullName);
			// A job that opened the PR but stopped before recording its number finds it here instead of opening a second (NFR-03).
			const [owner] = fullName.split("/");
			const { data: open } = await octokit.rest.pulls.list({ ...split(fullName), head: `${owner}:${p.head}`, base: p.base, state: "open", per_page: 1 });
			const existing = open[0];
			if (existing) return { number: existing.number, url: existing.html_url };
			const { data } = await octokit.rest.pulls.create({ ...split(fullName), ...p });
			return { number: data.number, url: data.html_url };
		},

		async getPull(fullName, n) {
			const { data } = await (await client(fullName)).rest.pulls.get({ ...split(fullName), pull_number: n });
			return { state: data.state === "closed" ? "closed" : "open", merged: data.merged, headSha: data.head.sha, url: data.html_url };
		},

		async listReviews(fullName, pr) {
			const octokit = await client(fullName);
			const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { ...split(fullName), pull_number: pr, per_page: 100 });
			return reviews.map(r => ({
				id: r.id,
				user: toUser(r.user),
				body: r.body ?? null,
				state: r.state,
				author_association: r.author_association,
			}));
		},

		async listReviewComments(fullName, pr) {
			const octokit = await client(fullName);
			const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, { ...split(fullName), pull_number: pr, per_page: 100 });
			return comments.map(c => ({
				id: c.id,
				user: toUser(c.user),
				body: c.body,
				path: c.path,
				line: c.line ?? null,
				original_line: c.original_line ?? null,
				diff_hunk: c.diff_hunk,
				author_association: c.author_association,
			}));
		},

		async listCheckRuns(fullName, sha) {
			const octokit = await client(fullName);
			const runs = await octokit.paginate(octokit.rest.checks.listForRef, { ...split(fullName), ref: sha, per_page: 100 });
			return runs.map(r => ({
				id: r.id,
				name: r.name,
				status: r.status,
				conclusion: r.conclusion,
				app: r.app?.slug ? { slug: r.app.slug } : null,
				check_suite: r.check_suite ? { id: r.check_suite.id } : null,
				output: { summary: r.output.summary ?? null },
				details_url: r.details_url ?? null,
			}));
		},

		async listActiveWorkflows(fullName, ref) {
			const octokit = await client(fullName);
			const all = await octokit.paginate(octokit.rest.actions.listRepoWorkflows, { ...split(fullName), per_page: 100 });
			const active = all.filter(w => w.state === "active" && !w.path.startsWith("dynamic/"));
			return Promise.all(
				active.map(async w => {
					try {
						const { data } = await octokit.rest.repos.getContent({ ...split(fullName), path: w.path, ref });
						const file = Array.isArray(data) || data.type !== "file" ? null : data;
						return { name: w.name, path: w.path, source: file ? Buffer.from(file.content, "base64").toString("utf8") : null };
					} catch (err) {
						if (isStatus(err, 404)) return { name: w.name, path: w.path, source: null };
						throw err;
					}
				}),
			);
		},

		async listWorkflowRuns(fullName, sha) {
			const octokit = await client(fullName);
			const runs = await octokit.paginate(octokit.rest.actions.listWorkflowRunsForRepo, { ...split(fullName), head_sha: sha, per_page: 100 });
			return runs.map(r => ({
				id: r.id,
				workflow_id: r.workflow_id,
				run_number: r.run_number,
				event: r.event,
				status: r.status ?? "completed",
				conclusion: r.conclusion ?? null,
				head_sha: r.head_sha,
				...(r.check_suite_id != null ? { check_suite_id: r.check_suite_id } : {}),
			}));
		},

		async getBranchSha(fullName, branch) {
			try {
				const { data } = await (await client(fullName)).rest.repos.getBranch({ ...split(fullName), branch });
				return data.commit.sha;
			} catch (err) {
				if (isStatus(err, 404)) return null;
				throw err;
			}
		},

		async getActionsJobLogTail(fullName, jobId, lines = 300) {
			// The endpoint answers 302 to a signed blob URL; fetch follows it and octokit returns text or an ArrayBuffer.
			const { data } = await (await client(fullName)).rest.actions.downloadJobLogsForWorkflowRun({ ...split(fullName), job_id: jobId });
			const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data ?? "");
			return text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
		},
	};
}
