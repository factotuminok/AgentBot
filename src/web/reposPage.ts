import type { RepoActionResponse, RepoEntry, RepoListing } from "../shared/adminRepos";
import { errorMessage, log } from "../shared/log";
import { AdminApiError } from "./adminClient";
import { field } from "./forms";
import { html, type PageContext, type PageRoutes, redirect } from "./http";
import type { Flash } from "./sessions";
import { esc, layout, messages, nav } from "./views";

/**
 * The Repositories page (WEB-32): every repository the GitHub App can access, with Watch and Unwatch. The orchestrator
 * lists them and watches over Discord's REST API, so the page works in every engine phase.
 */

/** Lists with more entries than this get a filter box. */
const FILTER_ABOVE = 20;

const refreshButton = (label: string) =>
	`<form method="get" action="/admin/repos" style="display:inline"><input type="hidden" name="refresh" value="1"><button type="submit">${esc(label)}</button></form>`;

function watchCell(r: RepoEntry): string {
	if (!r.watch) return "no";
	const link = (text: string) => `<a href="${esc(r.watch!.channelUrl)}">${esc(text)}</a>`;
	if (r.watch.state === "watching") return link("watched");
	if (r.watch.state === "suspended") return `${link("suspended")} <span class="hint">the App lost access</span>`;
	return `no <span class="hint">(${link("former channel")})</span>`;
}

function actionCell(r: RepoEntry): string {
	const form = (action: "watch" | "unwatch", label: string) =>
		`<form method="post" action="/admin/repos/${action}"><input type="hidden" name="repo" value="${esc(r.fullName)}"><button type="submit">${label}</button></form>`;
	if (r.watch && r.watch.state !== "unwatched") return form("unwatch", "Unwatch");
	// GH-25: archived repositories are read-only.
	if (r.archived) return `<button type="button" disabled title="Archived repositories cannot be watched">Watch</button>`;
	return form("watch", "Watch");
}

const FILTER_SCRIPT = `<script>
(function () {
	var box = document.getElementById("repo-filter");
	if (!box) return;
	box.addEventListener("input", function () {
		var q = box.value.trim().toLowerCase();
		document.querySelectorAll("#repo-rows tr").forEach(function (row) {
			row.hidden = !!q && row.getAttribute("data-name").indexOf(q) < 0;
		});
	});
})();
</script>`;

function listingHtml(listing: RepoListing): string {
	switch (listing.state) {
		case "unconfigured":
			return `<p class="status">${esc(listing.message)} on the <a href="/admin">Settings</a> page.</p>`;
		case "error":
			return `<p class="error" role="alert">${esc(listing.error)} ${refreshButton("Retry")}</p>`;
		case "empty":
			return `<p class="status">The GitHub App is not installed on any repository yet. Install it on the repositories AgentBot should work on: <a href="${esc(listing.installUrl)}">${esc(listing.installUrl)}</a></p>
<p>${refreshButton("Refresh")}</p>`;
		case "ok": {
			const rows = listing.repos.map(
				r => `<tr data-name="${esc(r.fullName.toLowerCase())}"><td>${esc(r.fullName)}</td><td>${r.private ? "private" : "public"}</td><td>${esc(r.defaultBranch)}</td><td>${r.archived ? "archived" : ""}</td><td>${watchCell(r)}</td><td>${actionCell(r)}</td></tr>`,
			);
			const filter =
				listing.repos.length > FILTER_ABOVE ? ` <label style="display:inline">Filter <input type="search" id="repo-filter" placeholder="owner/name"></label>` : "";
			return `<p>${listing.repos.length} repositories. ${refreshButton("Refresh")}${filter} <a href="${esc(listing.installUrl)}">Add repositories to the App</a></p>
<table><thead><tr><th>Repository</th><th>Visibility</th><th>Default branch</th><th>Archived</th><th>Watched</th><th></th></tr></thead>
<tbody id="repo-rows">
${rows.join("\n")}
</tbody></table>
<p class="hint">Watching creates a channel named after the repository (in the watch category when one is set); issues labelled with the trigger label start there while the engine is running. Unwatching keeps the channel.</p>
${filter ? FILTER_SCRIPT : ""}`;
		}
	}
}

export function reposPage(listing: RepoListing, vscode: boolean, flash?: Flash): string {
	return layout("Repositories", `${nav("repos", vscode)}<h1>Repositories</h1>${messages(undefined, flash)}${listingHtml(listing)}`);
}

async function show(_req: Request, url: URL, ctx: PageContext): Promise<Response> {
	let listing: RepoListing;
	try {
		listing = await ctx.admin.call<RepoListing>("GET", `/repos${url.searchParams.has("refresh") ? "?refresh=1" : ""}`);
	} catch (err) {
		if (!(err instanceof AdminApiError)) throw err;
		listing = { state: "error", error: err.message };
	}
	const flash = ctx.session.flash;
	ctx.session.flash = undefined;
	return html(reposPage(listing, ctx.vscode, flash));
}

function act(action: "watch" | "unwatch") {
	return async (req: Request, _url: URL, ctx: PageContext): Promise<Response> => {
		const repo = field(await req.formData(), "repo").trim();
		try {
			const result = await ctx.admin.call<RepoActionResponse>("POST", `/repos/${action}`, { body: { repo }, admin: ctx.session.username });
			ctx.session.flash = { text: result.message };
		} catch (err) {
			if (!(err instanceof AdminApiError)) throw err;
			log("warn", `${action} from the Repositories page refused`, { repo, admin: ctx.session.username, error: errorMessage(err) });
			ctx.session.flash = { text: err.message, error: true };
		}
		return redirect("/admin/repos");
	};
}

export const reposPages: PageRoutes = {
	"GET /admin/repos": { handle: show },
	"POST /admin/repos/watch": { handle: act("watch") },
	"POST /admin/repos/unwatch": { handle: act("unwatch") },
};
