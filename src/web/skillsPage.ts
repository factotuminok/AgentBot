import { MAX_SKILL_UPLOAD_BYTES, type SkillAssetKind, type SkillAssetView, type SkillRemoveRequest, type SkillsListing, type SkillUploadResponse } from "../shared/adminSkills";
import { AdminApiError } from "./adminClient";
import { field } from "./forms";
import { html, type PageContext, type PageRoutes, redirect } from "./http";
import type { Flash } from "./sessions";
import { esc, layout, messages, nav } from "./views";

/**
 * `/admin/skills` (AGT-24 to AGT-26): upload and remove the admin's skills and task agents. The files live in the
 * orchestrator; uploads are forwarded as raw bytes.
 */

export interface SkillsPageOptions {
	listing: SkillsListing;
	flash?: Flash;
	error?: string;
	vscode: boolean;
}

function assetTable(kind: SkillAssetKind, entries: SkillAssetView[], empty: string): string {
	const rows = entries.length
		? entries
				.map(
					entry => `<tr><td><code>${esc(entry.name)}</code></td>
<td>${esc(entry.description ?? "")}${entry.problem ? ` <span class="error">${esc(entry.problem)}</span>` : ""}</td>
<td><form method="post" action="/admin/skills/remove"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="name" value="${esc(entry.name)}"><button type="submit">Remove</button></form></td></tr>`,
				)
				.join("\n")
		: `<tr><td colspan="3">${empty}</td></tr>`;
	return `<table><thead><tr><th>Name</th><th>Description</th><th></th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

export function skillsPage(opts: SkillsPageOptions): string {
	const { listing } = opts;
	return layout(
		"Skills and agents",
		`${nav("skills", opts.vscode)}
<h1>Skills and agents</h1>
<p>These files are stored in the orchestrator at <code>${esc(listing.dir)}</code>: skills in <code>skills/&lt;name&gt;/SKILL.md</code>, task agents in <code>agents/&lt;name&gt;.md</code>.
Every agent session started after a change uses it; sessions already running keep what they started with.</p>
${messages(opts.error, opts.flash)}
<form method="post" action="/admin/skills/upload" enctype="multipart/form-data">
<label><span>Type</span> <select name="kind"><option value="skill">Skill</option><option value="agent">Agent</option></select></label>
<label><span>File</span> <input type="file" name="file" accept=".md,.zip,text/markdown,application/zip" required></label>
<p class="hint">An agent is one <code>.md</code> file of at most 256 KiB. A skill is its <code>SKILL.md</code>, or a <code>.zip</code> of the skill folder (at most 5 MiB unpacked, <code>SKILL.md</code> at the top, no symlinks) to include the files it references; a zip replaces the whole folder.
The frontmatter needs a <code>name</code> (lowercase letters, digits and hyphens) and a <code>description</code>; the name, not the file name, decides where the file is stored, and replaces an entry with the same name.</p>
<button type="submit">Upload</button>
</form>
<h2>Skills</h2>
${assetTable("skill", listing.skills, "No skills.")}
<h2>Agents</h2>
${assetTable("agent", listing.agents, "No agents.")}`,
	);
}

async function render(ctx: PageContext, error?: string, status = 200): Promise<Response> {
	let listing: SkillsListing;
	try {
		listing = await ctx.admin.call<SkillsListing>("GET", "/skills");
	} catch (err) {
		if (!(err instanceof AdminApiError)) throw err;
		listing = { dir: "", skills: [], agents: [] };
		error ??= err.message;
	}
	const flash = ctx.session.flash;
	ctx.session.flash = undefined;
	return html(skillsPage({ listing, flash, error, vscode: ctx.vscode }), status);
}

export const skillsPages: PageRoutes = {
	"GET /admin/skills": { handle: (_req, _url, ctx) => render(ctx) },
	"POST /admin/skills/upload": {
		async handle(req, _url, ctx) {
			const form = await req.formData();
			const kind = field(form, "kind");
			const file = form.get("file");
			if (kind !== "skill" && kind !== "agent") return render(ctx, "Choose whether the file is a skill or an agent.", 400);
			if (!(file instanceof File) || file.size === 0) return render(ctx, "Choose a file to upload.", 400);
			if (file.size > MAX_SKILL_UPLOAD_BYTES) return render(ctx, `${file.name} is too large.`, 400);
			const query = new URLSearchParams({ kind, file: file.name });
			const res = await ctx.admin.fetch("POST", `/skills/upload?${query}`, {
				body: await file.arrayBuffer(),
				headers: { "Content-Type": "application/octet-stream" },
				admin: ctx.session.username,
			});
			const body = (await res.json().catch(() => undefined)) as (SkillUploadResponse & { error?: string }) | undefined;
			if (res.status === 400) return render(ctx, body?.error ?? "The upload was refused.", 400);
			if (!res.ok || !body) throw new AdminApiError(res.status, body?.error ?? `HTTP ${res.status}`);
			ctx.session.flash = { text: `${body.replaced ? "Replaced" : "Added"} ${body.kind} "${body.name}".` };
			return redirect("/admin/skills");
		},
	},
	"POST /admin/skills/remove": {
		async handle(req, _url, ctx) {
			const form = await req.formData();
			const request: SkillRemoveRequest = { kind: field(form, "kind") as SkillAssetKind, name: field(form, "name") };
			try {
				await ctx.admin.call("POST", "/skills/remove", { body: request, admin: ctx.session.username });
				ctx.session.flash = { text: `Removed ${request.kind} "${request.name}".` };
			} catch (err) {
				if (!(err instanceof AdminApiError && (err.status === 400 || err.status === 404))) throw err;
				ctx.session.flash = { text: err.message, error: true };
			}
			return redirect("/admin/skills");
		},
	},
};
