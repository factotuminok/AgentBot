import { FINISHED_LOGIN, type LoginProvider, type LoginState, type LoginStatus, type ModelsView, type SignOutResponse, type StoredAccount } from "../shared/adminModels";
import { AdminApiError } from "./adminClient";
import { field } from "./forms";
import { html, json, type PageContext, type PageRoutes, redirect } from "./http";
import { formatTime } from "./live";
import type { Flash } from "./sessions";
import { esc, layout, messages, nav } from "./views";

/** `/admin/models`: model sign-ins and available model ids (SEC-12, SEC-13), over the admin API's `/models*`. */

const RELOGIN_WARN_MS = 7 * 86_400_000;
const STATUS_LABELS: Record<LoginStatus, string> = {
	starting: "Starting…",
	waiting: "Waiting for you to finish signing in",
	needs_input: "Waiting for your input",
	done: "Signed in",
	failed: "Failed",
	cancelled: "Cancelled",
};

/** "Re-login by" cell: highlighted when the grant ends within 7 days or has ended. */
function reloginCell(iso: string | undefined, now: number): string {
	if (!iso) return "—";
	const left = Date.parse(iso) - now;
	const text = esc(formatTime(iso));
	if (left <= 0) return `<span class="badge bad">expired ${text}</span>`;
	return left < RELOGIN_WARN_MS ? `<span class="badge warn">${text}</span>` : text;
}

function accountsTable(accounts: StoredAccount[], now: number): string {
	const signOutShown = new Set<string>();
	const rows = accounts.map(account => {
		const who = [account.email, account.orgName].filter(Boolean).join(" · ") || account.accountId || "—";
		// Sign-out removes every sign-in of the provider (CRED-05): one button per provider.
		const signOut = signOutShown.has(account.provider)
			? ""
			: `<form method="post" action="/admin/models/signout"><input type="hidden" name="provider" value="${esc(account.provider)}"><button type="submit">Sign out of ${esc(account.provider)}</button></form>`;
		signOutShown.add(account.provider);
		return `<tr><td>${esc(account.provider)}</td><td>${esc(account.type)}</td><td>${esc(who)}</td>
<td>${account.expiresAt ? esc(formatTime(account.expiresAt)) : "—"}</td><td>${reloginCell(account.reloginBy, now)}</td>
<td>${account.disabledCause ? `<span class="badge bad">${esc(account.disabledCause)}</span>` : ""}</td>
<td>${signOut}</td></tr>`;
	});
	const body = rows.length ? rows.join("\n") : `<tr><td colspan="7">No accounts signed in yet.</td></tr>`;
	return `<table><thead><tr><th>Provider</th><th>Type</th><th>Account</th><th>Access token expires</th><th>Re-login by</th><th>Disabled</th><th></th></tr></thead>
<tbody>
${body}
</tbody></table>`;
}

function signInSection(providers: LoginProvider[]): string {
	const featured = providers
		.filter(provider => provider.featured)
		.map(provider => `<button type="submit" name="provider" value="${esc(provider.id)}">${esc(provider.name)}</button>`);
	const others = providers.filter(provider => !provider.featured).map(provider => `<option value="${esc(provider.id)}">${esc(provider.name)}</option>`);
	return `<h2>Sign in</h2>
<form method="post" action="/admin/models/login" class="toolbar">${featured.join(" ")}</form>
${
	others.length
		? `<form method="post" action="/admin/models/login" class="toolbar"><label>Other provider <select name="provider">${others.join("")}</select></label>
<button type="submit">Sign in</button></form>`
		: ""
}
<p class="hint">Claude subscription sign-ins must be repeated every 30 days. Check each provider's terms for automated use of consumer subscriptions.</p>`;
}

/** SEC-13: where sign-ins live and who can read a run's copy. */
const STORAGE_NOTICE = `<p class="warning">Sign-ins are stored and refreshed only by the orchestrator; a new sign-in is used by the next run without a restart.
Unlike stored API keys, a run's copy of these tokens is readable by that run's agent shell (its refresh token stays with the orchestrator, and signing out refuses that run's later refresh requests).</p>`;

export function modelsPage(view: ModelsView, now: number, vscode: boolean, flash?: Flash): string {
	const models = view.models.map(model => `<tr><td><code>${esc(model.id)}</code></td><td>${esc(model.name)}</td></tr>`);
	return layout(
		"Models",
		`${nav("models", vscode)}
<h1>Models &amp; accounts</h1>
${messages(undefined, flash)}
${STORAGE_NOTICE}
<h2>Signed-in accounts</h2>
${accountsTable(view.accounts, now)}
${signInSection(view.providers)}
<h2>Available models</h2>
<p class="hint">Models usable with the sign-ins above; use these ids in <a href="/admin">Settings</a>. API keys stored in Settings add their providers' models to runs.</p>
<details><summary>Available models (${view.models.length})</summary>
<table><thead><tr><th>Id</th><th>Name</th></tr></thead><tbody>
${models.length ? models.join("\n") : `<tr><td colspan="2">No models available; sign in to a provider first.</td></tr>`}
</tbody></table></details>`,
	);
}

/**
 * Everything the sign-in page renders from the state. The device code and sign-in URL arrive while the status is still
 * `waiting`, so polling must compare this, not just the status. Inlined into the page script via `toString()`, so it may
 * only use its argument.
 */
function loginFingerprint(s: Pick<LoginState, "status" | "url" | "instructions" | "input" | "progress">): string {
	return [s.status, s.url ?? "", s.instructions ?? "", s.input?.kind ?? "", s.input?.message ?? "", s.progress.length].join("\u0000");
}

/** Reloads the page when anything it shows changes (no script once the sign-in is finished). */
function pollScript(state: LoginState): string {
	return `<script>
${loginFingerprint.toString()}
const shown = ${JSON.stringify(loginFingerprint(state))};
setInterval(async () => {
	try {
		const res = await fetch(${JSON.stringify(`/admin/models/login/${encodeURIComponent(state.id)}.json`)}, { headers: { accept: "application/json" } });
		if (!res.ok) return location.reload();
		if (loginFingerprint(await res.json()) !== shown) location.reload();
	} catch {}
}, 2000);
</script>`;
}

export function modelLoginPage(state: LoginState, vscode: boolean, error?: string): string {
	const base = `/admin/models/login/${encodeURIComponent(state.id)}`;
	const finished = FINISHED_LOGIN[state.status];
	const parts: string[] = [`<p>Status: <strong>${esc(STATUS_LABELS[state.status] ?? state.status)}</strong></p>`, messages(error)];
	if (state.status === "done") {
		const who = [state.account?.email, state.account?.orgName].filter(Boolean).join(" · ");
		parts.push(`<p class="flash">Signed in to ${esc(state.providerName)}${who ? ` as ${esc(who)}` : ""}. The next run uses this sign-in.</p>`);
	}
	if (state.status === "failed") parts.push(`<p class="error" role="alert">${esc(state.error ?? "Sign-in failed.")}</p>`);
	if (state.status === "cancelled") parts.push(`<p class="error" role="alert">Sign-in was cancelled.</p>`);
	if (!finished && state.url) {
		parts.push(`<p class="signin-link"><a href="${esc(state.url)}" target="_blank" rel="noopener noreferrer">Open the ${esc(state.providerName)} sign-in page ↗</a></p>
<p class="hint"><code>${esc(state.url)}</code></p>`);
	}
	if (!finished && state.instructions) parts.push(`<p class="device-code"><strong>${esc(state.instructions)}</strong></p>`);
	if (!finished && state.status === "waiting" && state.instructions) parts.push(`<p class="hint">This page updates by itself once you finish signing in.</p>`);
	if (state.progress.length) parts.push(`<ul class="hint">${state.progress.map(line => `<li>${esc(line)}</li>`).join("")}</ul>`);
	if (state.status === "needs_input" && state.input) {
		const input =
			state.input.kind === "redirect"
				? `<textarea name="text" rows="3" autocomplete="off" spellcheck="false" placeholder="${esc(state.input.placeholder ?? "Paste the full URL from your browser's address bar")}"></textarea>`
				: `<input type="text" name="text" autocomplete="off" placeholder="${esc(state.input.placeholder ?? "")}">`;
		parts.push(`<form method="post" action="${base}/input">
<label><span>${esc(state.input.message)}</span> ${input}</label>
<button type="submit">Continue</button>
</form>`);
	}
	if (!finished) parts.push(`<form method="post" action="${base}/cancel"><button type="submit">Cancel</button></form>`);
	parts.push(`<p><a href="/admin/models">Back to models &amp; accounts</a></p>`);
	return layout(
		`Sign in to ${state.providerName}`,
		`${nav("models", vscode)}
<h1>Sign in to ${esc(state.providerName)}</h1>
${parts.join("\n")}
${finished ? "" : pollScript(state)}`,
	);
}

export function loginNotFoundPage(vscode: boolean): string {
	return layout(
		"Sign-in not found",
		`${nav("models", vscode)}
<h1>Sign-in not found</h1>
<p>This sign-in does not exist or has expired.</p>
<p><a href="/admin/models">Back to models &amp; accounts</a></p>`,
	);
}

/** `/admin/models/login/<id>[.json|/input|/cancel]` → the id and the action. */
function loginPath(url: URL): { id: string; rest: string } {
	const tail = url.pathname.slice("/admin/models/login/".length);
	const slash = tail.indexOf("/");
	return slash < 0 ? { id: decodeURIComponent(tail), rest: "" } : { id: decodeURIComponent(tail.slice(0, slash)), rest: tail.slice(slash) };
}

async function loginState(ctx: PageContext, id: string): Promise<LoginState | undefined> {
	try {
		return await ctx.admin.call<LoginState>("GET", `/models/logins/${encodeURIComponent(id)}`);
	} catch (err) {
		if (err instanceof AdminApiError && err.status === 404) return undefined;
		throw err;
	}
}

export const modelsPages: PageRoutes = {
	"GET /admin/models": {
		async handle(_req, _url, ctx) {
			const view = await ctx.admin.call<ModelsView>("GET", "/models");
			const flash = ctx.session.flash;
			ctx.session.flash = undefined;
			return html(modelsPage(view, ctx.now(), ctx.vscode, flash));
		},
	},

	"POST /admin/models/login": {
		async handle(req, _url, ctx) {
			const provider = field(await req.formData(), "provider");
			try {
				const state = await ctx.admin.call<LoginState>("POST", "/models/logins", { body: { provider }, admin: ctx.session.username });
				return redirect(`/admin/models/login/${encodeURIComponent(state.id)}`);
			} catch (err) {
				if (!(err instanceof AdminApiError && err.status === 400)) throw err;
				ctx.session.flash = { text: err.message, error: true };
				return redirect("/admin/models");
			}
		},
	},

	"GET /admin/models/login/": {
		async handle(_req, url, ctx) {
			const asJson = url.pathname.endsWith(".json");
			const { id, rest } = loginPath(url);
			if (rest) return html(loginNotFoundPage(ctx.vscode), 404);
			const state = await loginState(ctx, asJson ? id.slice(0, -".json".length) : id);
			if (asJson) return state ? json(state) : json({ error: "not found" }, 404);
			return state ? html(modelLoginPage(state, ctx.vscode)) : html(loginNotFoundPage(ctx.vscode), 404);
		},
	},

	"POST /admin/models/login/": {
		async handle(req, url, ctx) {
			const { id, rest } = loginPath(url);
			if (rest !== "/input" && rest !== "/cancel") return html(loginNotFoundPage(ctx.vscode), 404);
			const body = rest === "/input" ? { text: field(await req.formData(), "text") } : {};
			try {
				await ctx.admin.call<LoginState>("POST", `/models/logins/${encodeURIComponent(id)}${rest}`, { body, admin: ctx.session.username });
			} catch (err) {
				if (!(err instanceof AdminApiError)) throw err;
				if (err.status === 404) return html(loginNotFoundPage(ctx.vscode), 404);
				if (err.status !== 400) throw err;
				const state = await loginState(ctx, id);
				return state ? html(modelLoginPage(state, ctx.vscode, err.message), 400) : html(loginNotFoundPage(ctx.vscode), 404);
			}
			return redirect(`/admin/models/login/${encodeURIComponent(id)}`);
		},
	},

	"POST /admin/models/signout": {
		async handle(req, _url, ctx) {
			const provider = field(await req.formData(), "provider");
			try {
				const { removed } = await ctx.admin.call<SignOutResponse>("POST", "/models/signout", { body: { provider }, admin: ctx.session.username });
				ctx.session.flash = removed ? { text: `Signed out of ${provider}. Runs already holding a copy can no longer refresh it.` } : { text: `No sign-in for ${provider}.`, error: true };
			} catch (err) {
				if (!(err instanceof AdminApiError && err.status === 400)) throw err;
				ctx.session.flash = { text: err.message, error: true };
			}
			return redirect("/admin/models");
		},
	},
};
