import { generateKeyPairSync } from "node:crypto";

/**
 * In-memory GitHub REST API serving exactly the routes `createGitHub` (src/orchestrator/github/app.ts) calls. App JWTs
 * and installation tokens are accepted without verification. Listing routes paginate with `per_page`/`page` and a
 * `Link` header, like GitHub.
 */

export interface FakeRepo {
	id: number;
	fullName: string;
	private: boolean;
	archived: boolean;
	defaultBranch: string;
	installationId: number;
	/** False once access was revoked (`revokeRepo`): the repo disappears from listings and its routes answer 404. */
	accessible: boolean;
	labels: Map<string, { name: string; color: string }>;
	issues: Map<number, FakeIssue>;
	branches: Map<string, string>;
	workflows: { id: number; name: string; path: string; state: string; source: string | null }[];
	workflowRuns: Record<string, unknown>[];
	checkRuns: Map<string, Record<string, unknown>[]>;
	jobLogs: Map<number, string>;
	nextNumber: number;
}

export interface FakeIssue {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: string[];
	author: string;
	updated_at: string;
	isPull: boolean;
	comments: { id: number; user: { login: string; type: string }; body: string; author_association: string; created_at: string; html_url: string }[];
	pull?: { head: string; base: string; headSha: string; merged: boolean };
	reviews: Record<string, unknown>[];
	reviewComments: Record<string, unknown>[];
}

export interface RecordedRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
}

export interface FakeGitHub {
	/** octokit `baseUrl`. */
	url: string;
	appId: number;
	privateKey: string;
	slug: string;
	botUserId: number;
	requests: RecordedRequest[];
	repos: Map<number, FakeRepo>;
	addInstallation(): number;
	addRepo(fullName: string, opts?: { installationId?: number; private?: boolean; archived?: boolean; defaultBranch?: string }): FakeRepo;
	getRepo(fullName: string): FakeRepo;
	renameRepo(fullName: string, to: string): void;
	revokeRepo(fullName: string): void;
	restoreRepo(fullName: string): void;
	addIssue(fullName: string, issue: { title: string; body?: string; labels?: string[]; author?: string }): FakeIssue;
	getIssue(fullName: string, n: number): FakeIssue;
	updateIssue(fullName: string, n: number, patch: Partial<Pick<FakeIssue, "title" | "body" | "state" | "labels">>): FakeIssue;
	addPull(fullName: string, p: { head: string; base?: string; title?: string; headSha?: string }): FakeIssue;
	addReview(fullName: string, pr: number, review: { body?: string; state?: string; login?: string; association?: string; type?: string }): void;
	addIssueComment(fullName: string, n: number, c: { body: string; login?: string; association?: string; type?: string }): void;
	addCheckRun(fullName: string, sha: string, run: { name: string; status?: string; conclusion?: string | null; app?: string; summary?: string }): number;
	/** Every request whose `METHOD path` matches answers `status` until cleared with `undefined`. */
	failRoute(pattern: RegExp, status: number | undefined): void;
	stop(): Promise<void>;
}

const now = () => new Date().toISOString();

export function startFakeGitHub(): FakeGitHub {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
	});
	const slug = "agentbot-test";
	const botUserId = 4242;
	const installations: number[] = [];
	const repos = new Map<number, FakeRepo>();
	const requests: RecordedRequest[] = [];
	const failures = new Map<string, { pattern: RegExp; status: number }>();
	let nextId = 1000;

	function findRepo(fullName: string): FakeRepo | undefined {
		for (const r of repos.values()) if (r.fullName.toLowerCase() === fullName.toLowerCase()) return r;
		return undefined;
	}
	function getRepo(fullName: string): FakeRepo {
		const r = findRepo(fullName);
		if (!r) throw new Error(`fake: no repo ${fullName}`);
		return r;
	}
	function getIssue(fullName: string, n: number): FakeIssue {
		const i = getRepo(fullName).issues.get(n);
		if (!i) throw new Error(`fake: no issue ${fullName}#${n}`);
		return i;
	}

	let server: ReturnType<typeof Bun.serve>;
	const base = () => `http://127.0.0.1:${server.port}`;

	function repoJson(r: FakeRepo) {
		return { id: r.id, full_name: r.fullName, name: r.fullName.split("/")[1], private: r.private, archived: r.archived, default_branch: r.defaultBranch };
	}
	function issueJson(r: FakeRepo, i: FakeIssue) {
		return {
			id: i.number,
			number: i.number,
			title: i.title,
			body: i.body,
			state: i.state,
			labels: i.labels.map(name => ({ name })),
			html_url: `https://github.com/${r.fullName}/${i.isPull ? "pull" : "issues"}/${i.number}`,
			updated_at: i.updated_at,
			user: { login: i.author, type: "User" },
			...(i.isPull ? { pull_request: { url: "" } } : {}),
		};
	}
	function touch(i: FakeIssue) {
		// Strictly increasing so cursors behave.
		const t = Date.now();
		const prev = Date.parse(i.updated_at);
		i.updated_at = new Date(Math.max(t, prev + 1000)).toISOString();
	}

	function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
		return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
	}
	function notFound(): Response {
		return json({ message: "Not Found" }, 404);
	}
	function page<T>(url: URL, items: T[], wrap?: (items: T[]) => unknown): Response {
		const perPage = Number(url.searchParams.get("per_page") ?? 30);
		const pageNo = Number(url.searchParams.get("page") ?? 1);
		const slice = items.slice((pageNo - 1) * perPage, pageNo * perPage);
		const headers: Record<string, string> = {};
		if (pageNo * perPage < items.length) {
			const next = new URL(url);
			next.searchParams.set("page", String(pageNo + 1));
			headers.link = `<${next.toString()}>; rel="next"`;
		}
		return json(wrap ? wrap(slice) : slice, 200, headers);
	}

	/** Request bodies as `app.ts` sends them; unchecked because the only client is our own octokit. */
	interface ReqBody {
		title: string;
		body: string;
		labels?: string[];
		name: string;
		color: string;
		head: string;
		base: string;
	}
	type Handler = (m: string[], url: URL, body: ReqBody, req: Request) => Response | Promise<Response>;
	const routes: [string, RegExp, Handler][] = [];
	const route = (method: string, path: string, h: Handler) => {
		routes.push([method, new RegExp(`^${path.replace(/\{[^}]+\}/g, "([^/]+)")}$`), h]);
	};
	/** Repo routes: resolves `{owner}/{repo}` and 404s when inaccessible. */
	const repoRoute = (method: string, path: string, h: (r: FakeRepo, m: string[], url: URL, body: ReqBody) => Response | Promise<Response>) =>
		route(method, `/repos/{owner}/{repo}${path}`, (m, url, body) => {
			const r = findRepo(`${m[0]}/${m[1]}`);
			if (!r || !r.accessible) return notFound();
			return h(r, m.slice(2), url, body);
		});
	const issueOf = (r: FakeRepo, n: string) => r.issues.get(Number(n));

	route("GET", "/app", () => json({ id: 1, slug, name: "AgentBot Test" }));
	route("GET", "/app/installations", (_m, url) => page(url, installations.map(id => ({ id, account: { login: "owner" } }))));
	route("POST", "/app/installations/{id}/access_tokens", m =>
		json({ token: `ghs_fake_${m[0]}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "selected" }, 201),
	);
	route("GET", "/installation/repositories", (_m, url, _b, req) => {
		const token = req.headers.get("authorization") ?? "";
		const id = Number(/ghs_fake_(\d+)/.exec(token)?.[1]);
		const list = [...repos.values()].filter(r => r.installationId === id && r.accessible).map(repoJson);
		return page(url, list, items => ({ total_count: list.length, repositories: items }));
	});
	route("GET", "/users/{username}", m => (decodeURIComponent(m[0]!) === `${slug}[bot]` ? json({ id: botUserId, login: `${slug}[bot]`, type: "Bot" }) : notFound()));
	repoRoute("GET", "", r => json(repoJson(r)));
	repoRoute("GET", "/installation", r => json({ id: r.installationId }));
	repoRoute("GET", "/issues", (r, _m, url) => {
		const labels = url.searchParams.get("labels")?.split(",").filter(Boolean) ?? [];
		const state = url.searchParams.get("state") ?? "open";
		const since = url.searchParams.get("since");
		const list = [...r.issues.values()]
			.filter(i => (state === "all" || i.state === state) && labels.every(l => i.labels.includes(l)) && (!since || i.updated_at >= since))
			.sort((a, b) => b.number - a.number)
			.map(i => issueJson(r, i));
		return page(url, list);
	});
	repoRoute("POST", "/issues", (r, _m, _u, body) => {
		const i = api.addIssue(r.fullName, { title: body.title, body: body.body, labels: body.labels, author: `${slug}[bot]` });
		return json(issueJson(r, i), 201);
	});
	repoRoute("GET", "/issues/{n}", (r, m) => {
		const i = issueOf(r, m[0]!);
		return i ? json(issueJson(r, i)) : notFound();
	});
	repoRoute("GET", "/issues/{n}/comments", (r, m, url) => {
		const i = issueOf(r, m[0]!);
		return i ? page(url, i.comments) : notFound();
	});
	repoRoute("POST", "/issues/{n}/comments", (r, m, _u, body) => {
		const i = issueOf(r, m[0]!);
		if (!i) return notFound();
		const id = nextId++;
		const c = { id, user: { login: `${slug}[bot]`, type: "Bot" }, body: body.body, author_association: "NONE", created_at: now(), html_url: `https://github.com/${r.fullName}/issues/${i.number}#issuecomment-${id}` };
		i.comments.push(c);
		return json(c, 201);
	});
	repoRoute("PATCH", "/issues/comments/{id}", (r, m, _u, body) => {
		for (const i of r.issues.values()) {
			const c = i.comments.find(c => c.id === Number(m[0]));
			if (c) {
				c.body = body.body;
				return json(c);
			}
		}
		return notFound();
	});
	repoRoute("POST", "/labels", (r, _m, _u, body) => {
		if (r.labels.has(body.name.toLowerCase())) return json({ message: "Validation Failed", errors: [{ code: "already_exists" }] }, 422);
		r.labels.set(body.name.toLowerCase(), { name: body.name, color: body.color });
		return json({ name: body.name, color: body.color }, 201);
	});
	repoRoute("POST", "/issues/{n}/labels", (r, m, _u, body) => {
		const i = issueOf(r, m[0]!);
		if (!i) return notFound();
		const names = (Array.isArray(body) ? body : body.labels) as string[];
		for (const name of names) {
			if (!r.labels.has(name.toLowerCase())) r.labels.set(name.toLowerCase(), { name, color: "ededed" });
			if (!i.labels.includes(name)) i.labels.push(name);
		}
		touch(i);
		return json(i.labels.map(name => ({ name })));
	});
	repoRoute("DELETE", "/issues/{n}/labels/{name}", (r, m) => {
		const i = issueOf(r, m[0]!);
		const name = decodeURIComponent(m[1]!);
		if (!i || !i.labels.includes(name)) return notFound();
		i.labels = i.labels.filter(l => l !== name);
		touch(i);
		return json(i.labels.map(name => ({ name })));
	});
	repoRoute("POST", "/pulls", (r, _m, _u, body) => {
		const i = api.addPull(r.fullName, { head: body.head, base: body.base, title: body.title });
		return json({ number: i.number, html_url: `https://github.com/${r.fullName}/pull/${i.number}` }, 201);
	});
	repoRoute("GET", "/pulls/{n}", (r, m) => {
		const i = issueOf(r, m[0]!);
		if (!i?.pull) return notFound();
		return json({
			number: i.number,
			state: i.state,
			merged: i.pull.merged,
			head: { ref: i.pull.head, sha: i.pull.headSha },
			base: { ref: i.pull.base },
			html_url: `https://github.com/${r.fullName}/pull/${i.number}`,
		});
	});
	repoRoute("GET", "/pulls/{n}/reviews", (r, m, url) => {
		const i = issueOf(r, m[0]!);
		return i?.pull ? page(url, i.reviews) : notFound();
	});
	repoRoute("GET", "/pulls/{n}/comments", (r, m, url) => {
		const i = issueOf(r, m[0]!);
		return i?.pull ? page(url, i.reviewComments) : notFound();
	});
	repoRoute("GET", "/commits/{ref}/check-runs", (r, m, url) => {
		const list = r.checkRuns.get(m[0]!) ?? [];
		return page(url, list, items => ({ total_count: list.length, check_runs: items }));
	});
	repoRoute("GET", "/actions/workflows", (r, _m, url) => {
		const list = r.workflows.map(w => ({ id: w.id, name: w.name, path: w.path, state: w.state }));
		return page(url, list, items => ({ total_count: list.length, workflows: items }));
	});
	route("GET", "/repos/{owner}/{repo}/contents/(.+)", (m, url) => {
		const r = findRepo(`${m[0]}/${m[1]}`);
		const path = decodeURIComponent(m[2]!);
		const w = r?.accessible ? r.workflows.find(w => w.path === path) : undefined;
		if (!w || w.source === null) return notFound();
		void url;
		return json({ type: "file", path, encoding: "base64", content: Buffer.from(w.source).toString("base64") });
	});
	repoRoute("GET", "/actions/runs", (r, _m, url) => {
		const sha = url.searchParams.get("head_sha");
		const list = r.workflowRuns.filter(w => !sha || w.head_sha === sha);
		return page(url, list, items => ({ total_count: list.length, workflow_runs: items }));
	});
	repoRoute("GET", "/branches/{branch}", (r, m) => {
		const sha = r.branches.get(decodeURIComponent(m[0]!));
		return sha ? json({ name: m[0], commit: { sha } }) : notFound();
	});
	repoRoute("GET", "/actions/jobs/{id}/logs", (r, m) => {
		const text = r.jobLogs.get(Number(m[0]));
		return text === undefined ? notFound() : new Response(text, { headers: { "content-type": "text/plain" } });
	});

	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
			let body: unknown;
			try {
				body = text ? JSON.parse(text) : undefined;
			} catch {
				body = text;
			}
			requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
			const line = `${req.method} ${url.pathname}`;
			for (const f of failures.values()) if (f.pattern.test(line)) return json({ message: `fake failure ${f.status}` }, f.status);
			for (const [method, re, h] of routes) {
				if (method !== req.method) continue;
				const m = re.exec(url.pathname);
				if (m) return h(m.slice(1), url, body as ReqBody, req);
			}
			return json({ message: `fake: no route ${line}` }, 404);
		},
	});

	const api: FakeGitHub = {
		url: base(),
		appId: 1,
		privateKey,
		slug,
		botUserId,
		requests,
		repos,
		addInstallation() {
			const id = 100 + installations.length;
			installations.push(id);
			return id;
		},
		addRepo(fullName, opts = {}) {
			const installationId = opts.installationId ?? installations[0] ?? api.addInstallation();
			const r: FakeRepo = {
				id: nextId++,
				fullName,
				private: opts.private ?? false,
				archived: opts.archived ?? false,
				defaultBranch: opts.defaultBranch ?? "main",
				installationId,
				accessible: true,
				labels: new Map(),
				issues: new Map(),
				branches: new Map([[opts.defaultBranch ?? "main", "basesha"]]),
				workflows: [],
				workflowRuns: [],
				checkRuns: new Map(),
				jobLogs: new Map(),
				nextNumber: 1,
			};
			repos.set(r.id, r);
			return r;
		},
		getRepo,
		renameRepo(fullName, to) {
			getRepo(fullName).fullName = to;
		},
		revokeRepo(fullName) {
			getRepo(fullName).accessible = false;
		},
		restoreRepo(fullName) {
			getRepo(fullName).accessible = true;
		},
		addIssue(fullName, issue) {
			const r = getRepo(fullName);
			const i: FakeIssue = {
				number: r.nextNumber++,
				title: issue.title,
				body: issue.body ?? "",
				state: "open",
				labels: [...(issue.labels ?? [])],
				author: issue.author ?? "alice",
				updated_at: new Date(0).toISOString(),
				isPull: false,
				comments: [],
				reviews: [],
				reviewComments: [],
			};
			touch(i);
			r.issues.set(i.number, i);
			return i;
		},
		getIssue,
		updateIssue(fullName, n, patch) {
			const i = getIssue(fullName, n);
			Object.assign(i, patch);
			touch(i);
			return i;
		},
		addPull(fullName, p) {
			const i = api.addIssue(fullName, { title: p.title ?? p.head });
			i.isPull = true;
			i.pull = { head: p.head, base: p.base ?? getRepo(fullName).defaultBranch, headSha: p.headSha ?? `sha-${i.number}`, merged: false };
			return i;
		},
		addReview(fullName, pr, review) {
			getIssue(fullName, pr).reviews.push({
				id: nextId++,
				user: { login: review.login ?? "alice", type: review.type ?? "User" },
				body: review.body ?? "",
				state: review.state ?? "COMMENTED",
				author_association: review.association ?? "MEMBER",
			});
		},
		addIssueComment(fullName, n, c) {
			const id = nextId++;
			getIssue(fullName, n).comments.push({
				id,
				user: { login: c.login ?? "alice", type: c.type ?? "User" },
				body: c.body,
				author_association: c.association ?? "MEMBER",
				created_at: now(),
				html_url: `https://github.com/${fullName}/issues/${n}#issuecomment-${id}`,
			});
		},
		addCheckRun(fullName, sha, run) {
			const r = getRepo(fullName);
			const id = nextId++;
			const list = r.checkRuns.get(sha) ?? [];
			list.push({
				id,
				name: run.name,
				status: run.status ?? "completed",
				conclusion: run.conclusion === undefined ? "success" : run.conclusion,
				app: { slug: run.app ?? "github-actions" },
				check_suite: { id: 1 },
				output: { summary: run.summary ?? null },
				details_url: `https://github.com/${fullName}/actions/runs/1/job/${id}`,
			});
			r.checkRuns.set(sha, list);
			return id;
		},
		failRoute(pattern, status) {
			if (status === undefined) failures.delete(pattern.source);
			else failures.set(pattern.source, { pattern, status });
		},
		async stop() {
			await server.stop(true);
		},
	};
	return api;
}
