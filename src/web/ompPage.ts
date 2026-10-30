import type { McpRow, McpTestState, OmpSettingInfo, OmpUpdateView, OmpView, PinnedSetting, SecretKeyRow } from "../shared/adminOmp";
import { MCP_TRANSPORTS } from "../shared/adminOmp";
import { AdminApiError } from "./adminClient";
import { field } from "./forms";
import { html, json, type PageContext, type PageRoutes, redirect } from "./http";
import { type OmpFormState, ompFormFromSubmission, ompFormFromView, ompSaveRequestFromForm, settingText } from "./ompForms";
import type { Flash } from "./sessions";
import { esc, layout, messages, nav } from "./views";

/** `/admin/omp`: omp setting overrides with a searchable reference, and MCP servers (AGT-20 to AGT-23). */

export const OMP_SAVED = "Saved. New agent runs use these settings; runs already in progress keep the configuration they started with.";
export const MCP_WAITING = "Waiting for a worker…";

function setBadge(set: boolean): string {
	return `<span class="hint">${set ? "set" : "not set"}</span>`;
}

function options(values: readonly string[], selected: string): string {
	const all = values.includes(selected) || !selected ? values : [selected, ...values];
	return all.map(value => `<option${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("");
}

/** Value control for an override: write-only for credentials, a select for enums/booleans, JSON textarea for arrays/records. */
function valueInput(name: string, info: OmpSettingInfo | undefined, value: string, credentialSet: boolean): string {
	if (info?.credential) {
		const input =
			info.type === "string"
				? `<input type="password" name="${name}" autocomplete="off" placeholder="blank keeps current">`
				: `<textarea name="${name}" autocomplete="off" placeholder="JSON; blank keeps current"></textarea>`;
		return `${input} ${setBadge(credentialSet)}`;
	}
	if (info?.type === "enum") return `<select name="${name}">${options(info.enumValues ?? [], value)}</select>`;
	if (info?.type === "boolean") return `<select name="${name}">${options(["true", "false"], value)}</select>`;
	if (info?.type === "array" || info?.type === "record") return `<textarea name="${name}">${esc(value)}</textarea>`;
	return `<input type="text" name="${name}" value="${esc(value)}">`;
}

function describe(info: OmpSettingInfo | undefined): string {
	if (!info) return "";
	const text = [info.label, info.description].filter(Boolean).join(" — ");
	return text ? `<div class="hint">${esc(text)}</div>` : "";
}

function settingsSection(form: OmpFormState, byId: Map<string, OmpSettingInfo>, reference: OmpSettingInfo[]): string {
	const rows = form.settings.map((row, i) => {
		const info = byId.get(row.id);
		return `<tr>
<td><input type="text" name="setting.${i}.id" value="${esc(row.id)}" readonly>${describe(info)}</td>
<td>${esc(info?.type ?? "?")}</td>
<td><code>${esc(info ? settingText(info, info.default) : "")}</code></td>
<td>${valueInput(`setting.${i}.value`, info, row.value, row.credentialSet)}</td>
<td><input type="checkbox" name="setting.${i}.remove" aria-label="Remove ${esc(row.id)}"></td>
</tr>`;
	});
	const newInfo = byId.get(form.newSetting.id);
	rows.push(`<tr>
<td><input type="text" name="setting.new.id" list="omp-setting-ids" placeholder="add setting id" value="${esc(form.newSetting.id)}"></td>
<td colspan="2" class="hint">Booleans true/false; arrays and records as JSON.</td>
<td><textarea name="setting.new.value" rows="2" placeholder="value">${esc(newInfo?.credential ? "" : form.newSetting.value)}</textarea></td>
<td></td>
</tr>`);
	const ids = reference.filter(info => !info.locked).map(info => `<option value="${esc(info.id)}">`);
	return `<h2>Setting overrides</h2>
<table><thead><tr><th>Setting</th><th>Type</th><th>Default</th><th>Value</th><th>Remove</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>
<datalist id="omp-setting-ids">${ids.join("")}</datalist>`;
}

function pinnedSection(pinned: PinnedSetting[]): string {
	const rows = pinned.map(
		pin => `<tr><td><code>${esc(pin.id)}</code> <span class="badge">PINNED</span></td><td><code>${esc(JSON.stringify(pin.value))}</code></td><td>${esc(pin.reason)}</td></tr>`,
	);
	return `<h2>Pinned by AgentBot</h2>
<p class="hint">Applied last on every run; these cannot be overridden.</p>
<table><thead><tr><th>Setting</th><th>Value</th><th>Why</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>`;
}

function referenceSection(reference: OmpSettingInfo[]): string {
	const rows = reference.map(
		info => `<tr><td><code>${esc(info.id)}</code>${info.locked ? ` <span class="badge">PINNED</span><div class="hint">${esc(info.locked)}</div>` : ""}${info.credential ? ` <span class="badge">write-only</span>` : ""}</td>
<td>${esc(info.type)}${info.enumValues ? `<div class="hint">${esc(info.enumValues.join(" | "))}</div>` : ""}</td>
<td><code>${esc(settingText(info, info.default))}</code></td><td>${esc([info.label, info.description].filter(Boolean).join(" — "))}</td></tr>`,
	);
	return `<details><summary>All omp settings (${reference.length})</summary>
<label>Filter <input type="search" id="omp-ref-filter" placeholder="id or description"></label>
<table><thead><tr><th>Setting</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody id="omp-ref">
${rows.join("\n")}
</tbody></table></details>
<script>
document.getElementById("omp-ref-filter").addEventListener("input", event => {
	const query = event.target.value.trim().toLowerCase();
	for (const row of document.getElementById("omp-ref").rows) row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
});
</script>`;
}

/** Key/value editor with write-only values: stored keys are read-only, plus one empty add row. */
function keyValueTable(prefix: string, label: string, rows: SecretKeyRow[]): string {
	const body = rows.map(
		(row, j) => `<tr><td><input type="text" name="${prefix}.${j}.key" value="${esc(row.key)}" readonly></td>
<td><input type="password" name="${prefix}.${j}.value" autocomplete="off" placeholder="blank keeps current"> ${setBadge(row.set)}</td>
<td><input type="checkbox" name="${prefix}.${j}.remove" aria-label="Remove ${esc(row.key)}"></td></tr>`,
	);
	body.push(`<tr><td><input type="text" name="${prefix}.${rows.length}.key" placeholder="new ${esc(label.toLowerCase())}"></td>
<td><input type="password" name="${prefix}.${rows.length}.value" autocomplete="off"></td><td></td></tr>`);
	return `<table><thead><tr><th>${esc(label)}</th><th>Value (write-only)</th><th>Remove</th></tr></thead><tbody>
${body.join("\n")}
</tbody></table>`;
}

const EMPTY_SERVER: McpRow = {
	name: "",
	existing: false,
	type: "stdio",
	enabled: true,
	instructions: true,
	timeout: "",
	command: "",
	args: "",
	cwd: "",
	url: "",
	env: [],
	headers: [],
};

/** One server's fieldset; `row` undefined renders the empty "Add server" fieldset. */
function serverFieldset(row: McpRow | undefined, i: number): string {
	const server = row ?? EMPTY_SERVER;
	const p = `mcp.${i}`;
	const text = (name: string, label: string, value: string, attrs = "") =>
		`<label><span>${esc(label)}</span> <input type="text" name="${p}.${name}" value="${esc(value)}" ${attrs}></label>`;
	const check = (name: string, label: string, checked: boolean) => `<label><input type="checkbox" name="${p}.${name}"${checked ? " checked" : ""}> ${esc(label)}</label>`;
	const transports = MCP_TRANSPORTS.map(type => `<option${type === server.type ? " selected" : ""}>${type}</option>`).join("");
	const legend = row ? `MCP server ${esc(row.name)}` : "Add server";
	const actions = server.existing
		? `${check("delete", "Delete this server", false)}
<button type="submit" formaction="/admin/omp/mcp/test" name="server" value="${esc(server.name)}">Test connection</button> <span class="hint">tests the saved configuration on a worker</span>`
		: "";
	return `<fieldset><legend>${legend}</legend>
${text("name", "Name", server.name, server.existing ? "readonly" : 'placeholder="letters, digits, - and _ (max 48)"')}
<label><span>Transport</span> <select name="${p}.type">${transports}</select></label>
${check("enabled", "Enabled", server.enabled)}
${check("instructions", "Include server instructions in the system prompt", server.instructions)}
${text("timeout", "Timeout (ms)", server.timeout, 'inputmode="numeric"')}
<h4>stdio</h4>
${text("command", "Command", server.command)}
<label><span>Arguments (one per line)</span> <textarea name="${p}.args">${esc(server.args)}</textarea></label>
${text("cwd", "Working directory", server.cwd)}
${keyValueTable(`${p}.env`, "Environment variable", server.env)}
<h4>http / sse</h4>
${text("url", "URL", server.url)}
${keyValueTable(`${p}.header`, "Header", server.headers)}
${actions}
</fieldset>`;
}

/** UPD-10: the image's omp and the workers' copy when they differ, the npm check, the last attempt, and "Check now". */
function updateSection(update: OmpUpdateView): string {
	const workers = update.active
		? `<p>Workers use omp <code>${esc(update.active.version)}</code> (in-place update ${esc(update.active.copy)}, approved by ${esc(update.active.by)}, ${(update.active.size / 1024 ** 2).toFixed(1)} MiB).
The orchestrator keeps the image's omp <code>${esc(update.image)}</code> for settings validation and sign-in.</p>`
		: `<p>Image omp <code>${esc(update.image)}</code>, used by the orchestrator and by workers.</p>`;
	const rows: [string, string][] = [
		["Latest on npm", update.latest ? `<code>${esc(update.latest)}</code>` : "not checked yet"],
		["Checked at", update.checkedAt ? esc(update.checkedAt) : "never"],
	];
	if (update.checkError) rows.push(["Check error", `<span class="error">${esc(update.checkError)}</span>`]);
	const state = !update.supported
		? esc(update.unsupportedReason ?? "updates are not supported here")
		: update.installing
			? `installing omp ${esc(update.installing.version)} (approved by ${esc(update.installing.by)} at ${esc(update.installing.startedAt)})`
			: update.available
				? `omp ${esc(update.available)} is available: approve it in the Discord work channel`
				: "up to date";
	rows.push(["Update", state]);
	const attempt = update.lastAttempt;
	if (attempt) {
		const error = attempt.error ? `: ${esc(attempt.error)}` : "";
		const log = attempt.log ? `<details><summary>Output</summary><pre>${esc(attempt.log)}</pre></details>` : "";
		rows.push(["Last attempt", `omp ${esc(attempt.version)} (from ${esc(attempt.from)}), ${esc(attempt.outcome)}${error}; approved by ${esc(attempt.by)}, ${esc(attempt.at)}${log}`]);
	}
	return `<h2>omp version and updates</h2>
${workers}
<table><tbody>
${rows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join("\n")}
</tbody></table>
<form method="post" action="/admin/omp/update-check"><button type="submit">Check now</button></form>`;
}

export function ompPage(view: OmpView, form: OmpFormState, opts: { vscode: boolean; flash?: Flash; error?: string }): string {
	const byId = new Map(view.reference.map(info => [info.id, info]));
	const servers = [...form.servers, undefined].map((row, i) => serverFieldset(row, i));
	const storedError = view.storedError
		? `<p class="warning">The stored omp configuration no longer validates (${esc(view.storedError)}); the form shows what still does. Saving replaces it.</p>`
		: "";
	return layout(
		"omp",
		`${nav("omp", opts.vscode)}
<h1>omp configuration</h1>
${messages(opts.error, opts.flash)}
${updateSection(view.update)}
<p class="hint">Changes apply to agent runs that start after saving; runs already in progress keep the configuration they started with.
MCP servers are connected only by implement runs and their subagents.</p>
${storedError}
<form method="post" action="/admin/omp">
<button type="submit">Save omp configuration</button>
${settingsSection(form, byId, view.reference)}
<h2>MCP servers</h2>
${servers.join("\n")}
<button type="submit">Save omp configuration</button>
</form>
${pinnedSection(view.pinned)}
${referenceSection(view.reference)}`,
	);
}

const TEST_LABELS: Record<McpTestState["status"], string> = { starting: "Starting…", waiting: MCP_WAITING, running: "Connecting…", done: "Finished" };

/** Reloads the page when the test's status changes (no script once it is done). */
function testPollScript(state: McpTestState): string {
	return `<script>
setInterval(async () => {
	try {
		const res = await fetch(${JSON.stringify(`/admin/omp/mcp/test/${encodeURIComponent(state.id)}.json`)}, { headers: { accept: "application/json" } });
		if (!res.ok) return location.reload();
		if ((await res.json()).status !== ${JSON.stringify(state.status)}) location.reload();
	} catch {}
}, 1000);
</script>`;
}

export function mcpTestPage(state: McpTestState, vscode: boolean): string {
	const parts = [`<p>Status: <strong>${esc(TEST_LABELS[state.status])}</strong></p>`];
	if (state.status === "waiting") parts.push(`<p class="hint">The 20 s connection timeout starts when a worker picks the test up.</p>`);
	const result = state.result;
	if (result?.ok) {
		const tools = result.tools.length ? `<ul>${result.tools.map(tool => `<li><code>${esc(tool)}</code></li>`).join("")}</ul>` : "<p>The server offers no tools.</p>";
		parts.push(`<p class="flash">Connected to ${esc(state.name)}: ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}.</p>${tools}`);
	} else if (result) {
		parts.push(`<p class="error" role="alert">Connection failed: ${esc(result.error ?? "unknown error")}</p>`);
	}
	parts.push(`<p><a href="/admin/omp">Back to omp configuration</a></p>`);
	return layout(
		`Test ${state.name}`,
		`${nav("omp", vscode)}
<h1>Test MCP server ${esc(state.name)}</h1>
${parts.join("\n")}
${state.status === "done" ? "" : testPollScript(state)}`,
	);
}

function testNotFoundPage(vscode: boolean): string {
	return layout(
		"Test not found",
		`${nav("omp", vscode)}
<h1>Test not found</h1>
<p>This connection test does not exist or has expired.</p>
<p><a href="/admin/omp">Back to omp configuration</a></p>`,
	);
}

/** The omp view, or a page explaining why it can't be shown (vault locked). */
async function loadView(ctx: PageContext): Promise<OmpView | Response> {
	try {
		return await ctx.admin.call<OmpView>("GET", "/omp");
	} catch (err) {
		if (!(err instanceof AdminApiError && err.status === 409)) throw err;
		return html(layout("omp", `${nav("omp", ctx.vscode)}<h1>omp configuration</h1>${messages(err.message)}`), 409);
	}
}

export const ompPages: PageRoutes = {
	"GET /admin/omp": {
		async handle(_req, _url, ctx) {
			const view = await loadView(ctx);
			if (view instanceof Response) return view;
			const flash = ctx.session.flash;
			ctx.session.flash = undefined;
			return html(ompPage(view, ompFormFromView(view), { vscode: ctx.vscode, flash }));
		},
	},

	"POST /admin/omp": {
		async handle(req, _url, ctx) {
			const form = await req.formData();
			try {
				await ctx.admin.call("PUT", "/omp", { body: ompSaveRequestFromForm(form), admin: ctx.session.username });
			} catch (err) {
				// 409: the vault locked meanwhile; loading the view answers with the locked page.
				if (!(err instanceof AdminApiError && (err.status === 400 || err.status === 409))) throw err;
				const view = await loadView(ctx);
				if (view instanceof Response) return view;
				return html(ompPage(view, ompFormFromSubmission(form, view), { vscode: ctx.vscode, error: err.message }), 400);
			}
			ctx.session.flash = { text: OMP_SAVED };
			return redirect("/admin/omp");
		},
	},

	"POST /admin/omp/update-check": {
		async handle(_req, _url, ctx) {
			const update = await ctx.admin.call<OmpUpdateView>("POST", "/omp/update-check", { admin: ctx.session.username });
			ctx.session.flash = update.checkError
				? { text: `The npm check failed: ${update.checkError}`, error: true }
				: { text: `Checked npm: the latest omp is ${update.latest ?? "unknown"}.${update.available ? ` omp ${update.available} is available for workers; approve it in the Discord work channel.` : ""}` };
			return redirect("/admin/omp");
		},
	},

	"POST /admin/omp/mcp/test": {
		async handle(req, _url, ctx) {
			const name = field(await req.formData(), "server");
			try {
				const state = await ctx.admin.call<McpTestState>("POST", "/omp/mcp-tests", { body: { name }, admin: ctx.session.username });
				return redirect(`/admin/omp/mcp/test/${encodeURIComponent(state.id)}`);
			} catch (err) {
				if (!(err instanceof AdminApiError && (err.status === 404 || err.status === 409))) throw err;
				ctx.session.flash = { text: err.message, error: true };
				return redirect("/admin/omp");
			}
		},
	},

	"GET /admin/omp/mcp/test/": {
		async handle(_req, url, ctx) {
			const tail = decodeURIComponent(url.pathname.slice("/admin/omp/mcp/test/".length));
			const asJson = tail.endsWith(".json");
			const id = asJson ? tail.slice(0, -".json".length) : tail;
			let state: McpTestState | undefined;
			try {
				state = id && !id.includes("/") ? await ctx.admin.call<McpTestState>("GET", `/omp/mcp-tests/${encodeURIComponent(id)}`) : undefined;
			} catch (err) {
				if (!(err instanceof AdminApiError && err.status === 404)) throw err;
			}
			if (asJson) return state ? json(state) : json({ error: "not found" }, 404);
			return state ? html(mcpTestPage(state, ctx.vscode)) : html(testNotFoundPage(ctx.vscode), 404);
		},
	},
};
