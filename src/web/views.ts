import type { AdminState } from "../shared/adminApi";
import { CHANNELS_UNCONFIGURED, type ChannelListing } from "../shared/adminChannels";
import { CHANNEL_EXTRAS, channelFieldHtml } from "./channelFields";
import {
	CHANNEL_FIELDS,
	CONFIG_FIELDS,
	configDefault,
	MAX_USERNAME_CHARS,
	MIN_PASSWORD_CHARS,
	SECRET_FIELDS,
	SECTION_LABELS,
	type SettingsFormState,
} from "./forms";
import type { Cell } from "./live";
import type { Flash } from "./sessions";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escapes any value for use in text or a quoted attribute. */
export function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, c => ESCAPES[c]!);
}

/** Shown wherever the admin API cannot be reached (architecture §2.2). */
export const ORCHESTRATOR_UNAVAILABLE = "orchestrator unavailable";

/** Light palette (default) and dark palette; `auto` follows the OS via `prefers-color-scheme` (WEB-11). */
const LIGHT_THEME = `color-scheme: light;
	--fg: #222; --bg: #fff; --muted: #666; --muted-strong: #555; --border: #ccc; --rule: #eee; --surface: #f5f5f5;
	--badge: #eee; --link: #0645ad; --link-visited: #551a8b; --bar: #69c;
	--error-bg: #fdd; --error-border: #c00; --error-fg: #900;
	--ok-bg: #dfd; --ok-border: #090; --ok-fg: #060;
	--warn-bg: #ffd; --warn-fg: #860;
	--info-bg: #eef; --info-border: #99c;`;
const DARK_THEME = `color-scheme: dark;
	--fg: #e6e6e6; --bg: #16181c; --muted: #9aa0a6; --muted-strong: #b0b4b9; --border: #3a3f46; --rule: #2a2e34; --surface: #23272e;
	--badge: #2f343b; --link: #8ab4f8; --link-visited: #c58af9; --bar: #5b8fd1;
	--error-bg: #3d1f22; --error-border: #c2454c; --error-fg: #ff9a9a;
	--ok-bg: #1d3524; --ok-border: #3f9a55; --ok-fg: #8fdc9f;
	--warn-bg: #3a3317; --warn-fg: #e6c86e;
	--info-bg: #1f2638; --info-border: #4a5a8a;`;

const STYLE = `
:root { ${LIGHT_THEME} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_THEME} } }
:root[data-theme="dark"] { ${DARK_THEME} }
body { font-family: system-ui, sans-serif; max-width: 64rem; margin: 2rem auto; padding: 0 1rem; color: var(--fg); background: var(--bg); }
a { color: var(--link); }
a:visited { color: var(--link-visited); }
fieldset { margin: 1rem 0; border: 1px solid var(--border); border-radius: 4px; }
label { display: block; margin: .5rem 0; }
label > span:first-child { display: inline-block; min-width: 14rem; }
.info { position: relative; display: inline-block; width: 1.1em; height: 1.1em; margin-left: .3em; border: 1px solid var(--muted); border-radius: 50%;
	color: var(--muted); font: italic bold .75em/1.1em Georgia, serif; text-align: center; vertical-align: .1em; cursor: help; }
.info:hover { color: var(--fg); border-color: var(--fg); }
.info .tip { display: none; position: absolute; left: -.5rem; top: 1.6em; z-index: 10; width: 26rem; max-width: 80vw; padding: .5rem .7rem;
	background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
	font: normal .95rem/1.4 system-ui, sans-serif; text-align: left; white-space: normal; cursor: auto; }
.info:hover .tip { display: block; }
.info .tip-line { display: block; margin-top: .4rem; }
.info .tip code { white-space: pre-wrap; word-break: break-all; }
input[type=text], input[type=password], textarea { width: 22rem; max-width: 100%; }
textarea { height: 6rem; font-family: monospace; }
.error { background: var(--error-bg); border: 1px solid var(--error-border); padding: .5rem; }
.flash { background: var(--ok-bg); border: 1px solid var(--ok-border); padding: .5rem; }
.status { background: var(--info-bg); border: 1px solid var(--info-border); padding: .5rem; }
.warning { background: var(--warn-bg); color: var(--warn-fg); padding: .5rem; }
.hint { color: var(--muted); font-size: .9em; }
nav { position: relative; display: flex; align-items: center; gap: 1rem; border-bottom: 1px solid var(--border); padding-bottom: .5rem; }
nav .menu-toggle { margin-left: auto; }
nav .menu { position: absolute; right: 0; top: 100%; z-index: 20; box-sizing: border-box; width: 18rem; max-width: 100%;
	max-height: calc(100vh - 6rem); overflow-y: auto; margin-top: .25rem; padding: .5rem; background: var(--surface);
	border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, .25); }
nav .menu[hidden] { display: none; }
nav .menu ul { list-style: none; margin: 0 0 .5rem; padding: 0; }
nav .menu a { display: block; padding: .35rem .5rem; }
nav .menu .theme-switch, nav .menu form { display: block; padding: .35rem .5rem; border-top: 1px solid var(--rule); }
nav [aria-current] { font-weight: bold; }
.theme-switch { font-size: .9em; }
.theme-switch label { display: inline; margin: 0; }
body > .theme-switch { text-align: right; }
table { border-collapse: collapse; margin: .5rem 0; }
th, td { text-align: left; padding: .2rem .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
.chart { display: flex; gap: 4px; height: 10rem; margin: .5rem 0; }
.chart .day { flex: 1; display: flex; flex-direction: column; text-align: center; font-size: .7em; color: var(--muted-strong); }
.chart .track { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; }
.chart .bar { background: var(--bar); }
.badge { background: var(--badge); border-radius: 3px; padding: 0 .3rem; font-size: .85em; font-family: monospace; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
.card { border: 1px solid var(--border); border-radius: 4px; padding: .5rem .8rem; }
.card h3 { margin: .5rem 0 .25rem; }
.badge.ok { background: var(--ok-bg); color: var(--ok-fg); }
.badge.warn { background: var(--warn-bg); color: var(--warn-fg); }
.badge.bad { background: var(--error-bg); color: var(--error-fg); }
summary h2 { display: inline-block; margin: .75rem 0 .25rem; }
`;

/** Browser-local preference key; absent means "auto" (follow the OS). */
export const THEME_KEY = "agentbot-theme";

/** Runs in <head> before first paint so a stored choice never flashes the other theme (WEB-11). */
const THEME_BOOT = `<script>try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}</script>`;

/** Wires every theme select to the stored preference and the nav menu's disclosure button (absent on login/setup pages). */
const PAGE_SCRIPT = `<script>
(function () {
	var key = ${JSON.stringify(THEME_KEY)};
	var stored = null;
	try { stored = localStorage.getItem(key); } catch (e) {}
	document.querySelectorAll("select.theme-select").forEach(function (select) {
		select.value = stored === "light" || stored === "dark" ? stored : "auto";
		select.addEventListener("change", function () {
			var value = select.value;
			try { value === "auto" ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (e) {}
			if (value === "auto") delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = value;
		});
	});
	var toggle = document.querySelector("nav .menu-toggle");
	var menu = document.getElementById("site-menu");
	if (toggle && menu) {
		function setOpen(open) {
			menu.hidden = !open;
			toggle.setAttribute("aria-expanded", open ? "true" : "false");
		}
		toggle.addEventListener("click", function () { setOpen(menu.hidden); });
		document.addEventListener("keydown", function (event) {
			if (event.key === "Escape" && !menu.hidden) { setOpen(false); toggle.focus(); }
		});
		document.addEventListener("click", function (event) {
			if (!menu.hidden && !toggle.closest("nav").contains(event.target)) setOpen(false);
		});
	}
})();
</script>`;

/** Light / Dark / Auto selector; shown in the nav, or above the content on pages without one (login, setup). */
export const THEME_SWITCH = `<span class="theme-switch"><label>Theme <select class="theme-select" aria-label="Color theme">
<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>
</select></label></span>`;

export function layout(title: string, body: string): string {
	const switcher = body.includes('class="theme-select"') ? "" : `<div class="theme-switch">${THEME_SWITCH}</div>`;
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · AgentBot</title>${THEME_BOOT}<style>${STYLE}</style></head>
<body>${switcher}${body}${PAGE_SCRIPT}</body>
</html>`;
}

export type SitePageId = "status" | "logs" | "settings" | "repos" | "models" | "omp" | "skills" | "vscode" | "status-json" | "healthz";
export type NavPage = "home" | SitePageId;

export interface SitePage {
	id: SitePageId;
	title: string;
	href: string;
}

/** Every page, in order. The home cards and the ☰ menu are both built from this list (WEB-10), through `sitePages`. */
const SITE_PAGES: readonly SitePage[] = [
	{ id: "status", title: "Status", href: "/status" },
	{ id: "logs", title: "Logs", href: "/logs" },
	{ id: "settings", title: "Settings", href: "/admin" },
	{ id: "repos", title: "Repositories", href: "/admin/repos" },
	{ id: "models", title: "Model accounts", href: "/admin/models" },
	{ id: "omp", title: "omp and MCP", href: "/admin/omp" },
	{ id: "skills", title: "Skills and agents", href: "/admin/skills" },
	{ id: "vscode", title: "VS Code", href: "/admin/vscode/" },
	{ id: "status-json", title: "Status JSON", href: "/status.json" },
	{ id: "healthz", title: "Health check", href: "/healthz" },
];

const HOME_PAGE = { id: "home", title: "Home", href: "/" } as const;

/** The site pages; VS Code only when it is on (`AGENTBOT_WEB_VSCODE`). */
export function sitePages(vscode: boolean): readonly SitePage[] {
	return vscode ? SITE_PAGES : SITE_PAGES.filter(page => page.id !== "vscode");
}

/** The one anchor renderer for cards and menu entries; marks the page being viewed. */
export function pageLink(page: SitePage | typeof HOME_PAGE, current?: NavPage): string {
	return `<a href="${esc(page.href)}"${page.id === current ? ' aria-current="page"' : ""}>${esc(page.title)}</a>`;
}

/**
 * Navigation shared by the logged-in pages: a ☰ button that discloses every page, the theme selector and Log out.
 * `vscode`: VS Code is on, so the menu lists it.
 */
export function nav(current: NavPage, vscode: boolean): string {
	const items = [HOME_PAGE, ...sitePages(vscode)].map(page => `<li>${pageLink(page, current)}</li>`).join("\n");
	return `<nav><strong>AgentBot</strong>
<button type="button" class="menu-toggle" aria-expanded="false" aria-controls="site-menu"><span aria-hidden="true">☰</span> Menu</button>
<div id="site-menu" class="menu" hidden>
<ul>
${items}
</ul>
${THEME_SWITCH}
<form method="post" action="/logout"><button type="submit">Log out</button></form>
</div></nav>`;
}

export function cellHtml(cell: Cell): string {
	if (typeof cell === "string") return esc(cell);
	return `<a href="${esc(cell[1])}">${esc(cell[0])}</a>`;
}

/** Table with optional `tbody` id (for client-side re-rendering); a single spanning row shows `empty` when there are no rows. */
export function table(headers: string[], rows: Cell[][], empty: string, bodyId?: string): string {
	const body = rows.length
		? rows.map(row => `<tr>${row.map(cell => `<td>${cellHtml(cell)}</td>`).join("")}</tr>`).join("\n")
		: `<tr><td colspan="${Math.max(1, headers.length)}">${esc(empty)}</td></tr>`;
	const head = headers.length ? `<thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : "";
	return `<table>${head}<tbody${bodyId ? ` id="${bodyId}"` : ""}>\n${body}\n</tbody></table>`;
}

export function messages(error: string | undefined, flash?: Flash): string {
	let html = "";
	if (flash) {
		const details = flash.details?.length ? `<ul>${flash.details.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : "";
		html += `<div class="${flash.error ? "error" : "flash"}" role="status">${esc(flash.text)}${details}</div>`;
	}
	return html + (error ? `<p class="error" role="alert">${esc(error)}</p>` : "");
}

/** Hover help: the explanation, plus a sample value and the schema default when there are any. */
interface Help {
	text: string;
	example?: string;
	fallback?: string;
}

/**
 * An "i" icon after a label that shows `help` on hover. The icon is hidden from the label's accessible name;
 * inputs reference the text through `aria-describedby="${id}"` instead.
 */
function infoTip(id: string, help: Help): string {
	const example = help.example ? `<span class="tip-line">Example: <code>${esc(help.example)}</code></span>` : "";
	const fallback = help.fallback ? `<span class="tip-line">Default: <code>${esc(help.fallback)}</code></span>` : "";
	return ` <span class="info" aria-hidden="true">i<span class="tip" id="${esc(id)}" role="tooltip">${esc(help.text)}${example}${fallback}</span></span>`;
}

/** `<label>` text plus, when `help` is given, its info icon; returns the label HTML and the input attribute that references the help. */
function labelWithHelp(name: string, label: string, help: Help | undefined): { label: string; describedBy: string } {
	if (!help) return { label: esc(label), describedBy: "" };
	const id = `help-${name}`;
	return { label: esc(label) + infoTip(id, help), describedBy: ` aria-describedby="${esc(id)}"` };
}

function textInput(name: string, label: string, value: string, attrs = "", help?: Help): string {
	const l = labelWithHelp(name, label, help);
	return `<label><span>${l.label}</span> <input type="text" name="${esc(name)}" value="${esc(value)}"${l.describedBy} ${attrs}></label>`;
}

function passwordInput(name: string, label: string, autocomplete: string, help?: Help): string {
	const l = labelWithHelp(name, label, help);
	return `<label><span>${l.label}</span> <input type="password" name="${esc(name)}" autocomplete="${esc(autocomplete)}"${l.describedBy}></label>`;
}

export function setupPage(opts: { error?: string; username?: string }): string {
	return layout(
		"Setup",
		`<h1>AgentBot setup</h1>
<p>Create the admin account. The setup token is printed in the orchestrator's log.</p>
${messages(opts.error)}
<form method="post" action="/setup">
${textInput("token", "Setup token", "", 'autocomplete="off"')}
${textInput("username", "Username", opts.username ?? "", `autocomplete="username" maxlength="${MAX_USERNAME_CHARS}"`)}
${passwordInput("password", `Password (at least ${MIN_PASSWORD_CHARS} characters)`, "new-password")}
${passwordInput("confirm", "Confirm password", "new-password")}
<button type="submit">Create admin</button>
</form>`,
	);
}

export function loginPage(opts: { error?: string; username?: string }): string {
	return layout(
		"Log in",
		`<h1>AgentBot login</h1>
${messages(opts.error)}
<form method="post" action="/login">
${textInput("username", "Username", opts.username ?? "", 'autocomplete="username"')}
${passwordInput("password", "Password", "current-password")}
<button type="submit">Log in</button>
</form>`,
	);
}

export function notFoundPage(): string {
	return layout("Not found", `<h1>Not found</h1><p><a href="/">Home</a></p>`);
}

export function errorPage(message: string): string {
	return layout("Error", `<h1>Error</h1>${messages(message)}<p><a href="/">Home</a></p>`);
}

/** A logged-in page whose data could not be loaded because the orchestrator is unavailable. */
export function unavailablePage(current: NavPage, vscode: boolean, title: string, reason: string): string {
	return layout(title, `${nav(current, vscode)}<h1>${esc(title)}</h1>${messages(`${ORCHESTRATOR_UNAVAILABLE}: ${reason}`)}`);
}

function secretStatus(set: boolean): string {
	return `<span class="hint">${set ? "set" : "not set"}</span>`;
}

const FORM_HELP = {
	discordToken: {
		text: "The bot token from the Discord Developer Portal (your application → Bot → Reset Token). Stored encrypted and never shown again; leave blank to keep the stored token.",
		example: "MTIz… (about 70 characters: three parts separated by dots)",
	},
	githubAppPrivateKey: {
		text: "The .pem file GitHub downloaded when you clicked “Generate a private key” on your GitHub App. Paste the whole file, including the BEGIN and END lines. Stored encrypted; leave blank to keep the stored key.",
		example: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo…\n…\n-----END RSA PRIVATE KEY-----",
	},
	providerName: {
		text: "omp provider id the API key is for, such as anthropic, openai or openrouter.",
		example: "anthropic",
	},
	providerKey: {
		text: "The provider's API key, used by every run on that provider. Stored encrypted and never shown; leave blank to keep the stored key.",
		example: "sk-ant-api03-AbCdEf…",
	},
	providerRemove: { text: "Tick to delete this provider's stored API key when you save." },
	currentPassword: { text: "Your current AgentBot password. Required to change the username or the password." },
	username: { text: "The name you log in to this web UI with, 1–64 characters.", example: "admin" },
	password: {
		text: `The password for this web UI after the update, at least ${MIN_PASSWORD_CHARS} characters. Always required: to change only the username, enter your current password here again. Other logins are ended.`,
		example: "correct horse battery staple",
	},
	confirm: { text: "The new password again, to catch typos." },
} satisfies Record<string, Help>;

/** Channel fields are typed ids, dropdowns or a listing error (WEB-20 to WEB-23); `channels` says which. */
function settingsForm(state: SettingsFormState, channels: ChannelListing): string {
	const channelFields: string[] = Object.values(CHANNEL_FIELDS);
	const sections: string[] = [];
	for (const [section, legend] of Object.entries(SECTION_LABELS)) {
		const fields = CONFIG_FIELDS.filter(def => def.name.startsWith(`${section}.`)).map(def => {
			const hint = def.kind === "list" ? ' placeholder="comma or space separated"' : def.kind === "number" ? ' inputmode="decimal"' : "";
			const help = { text: def.help, example: def.example, fallback: configDefault(def) };
			const typed = textInput(def.name, def.label, state.config[def.name] ?? "", hint, help);
			return channelFields.includes(def.name) ? channelFieldHtml(def.name, state.config, channels, labelWithHelp(def.name, def.label, help), typed) : typed;
		});
		sections.push(`<fieldset><legend>${esc(legend)}</legend>${fields.join("\n")}</fieldset>`);
	}

	const providerRows = state.providers.map(
		(provider, i) => `<tr>
<td><input type="text" name="provider.${i}.name" value="${esc(provider.name)}" readonly aria-describedby="help-provider-name"></td>
<td><input type="password" name="provider.${i}.key" autocomplete="off" placeholder="blank keeps current" aria-describedby="help-provider-key"> ${secretStatus(provider.set)}</td>
<td><input type="checkbox" name="provider.${i}.remove" aria-label="Remove ${esc(provider.name)}" aria-describedby="help-provider-remove"></td>
</tr>`,
	);
	const next = state.providers.length;
	providerRows.push(`<tr>
<td><input type="text" name="provider.${next}.name" placeholder="new provider" aria-describedby="help-provider-name"></td>
<td><input type="password" name="provider.${next}.key" autocomplete="off" aria-describedby="help-provider-key"></td>
<td></td>
</tr>`);
	const discordToken = labelWithHelp(SECRET_FIELDS.discordToken, "Discord bot token", FORM_HELP.discordToken);
	const githubKey = labelWithHelp(SECRET_FIELDS.githubAppPrivateKey, "GitHub App private key (PEM)", FORM_HELP.githubAppPrivateKey);

	return `<form method="post" action="/admin/settings">
<fieldset><legend>Secrets</legend>
<p class="hint">Secrets are never shown. Leave a field blank to keep the current value.</p>
<label><span>${discordToken.label}</span> <input type="password" name="${SECRET_FIELDS.discordToken}" autocomplete="off"${discordToken.describedBy}> ${secretStatus(state.discordTokenSet)}</label>
<label><span>${githubKey.label}</span> <textarea name="${SECRET_FIELDS.githubAppPrivateKey}" autocomplete="off"${githubKey.describedBy}></textarea> ${secretStatus(state.githubAppPrivateKeySet)}</label>
<table><thead><tr><th>Provider${infoTip("help-provider-name", FORM_HELP.providerName)}</th><th>API key${infoTip("help-provider-key", FORM_HELP.providerKey)}</th><th>Remove${infoTip("help-provider-remove", FORM_HELP.providerRemove)}</th></tr></thead><tbody>
${providerRows.join("\n")}
</tbody></table>
</fieldset>
${sections.join("\n")}
<button type="submit">Save settings and restart engine</button>
</form>`;
}

/** Keeps the engine box current while the page is open. */
const ENGINE_SCRIPT = `<script>
setInterval(async () => {
	try {
		const res = await fetch("/admin/status", { headers: { accept: "application/json" } });
		if (!res.ok) return;
		const s = await res.json();
		document.getElementById("status-phase").textContent = s.phase;
		document.getElementById("status-since").textContent = s.since;
		const err = document.getElementById("status-error");
		err.textContent = s.error || "";
		err.hidden = !s.error;
	} catch {}
}, 3000);
</script>`;

export interface AdminPageOptions {
	state: AdminState;
	username: string;
	/** Undefined when the settings cannot be shown (vault locked); `settingsError` says why. */
	settings?: SettingsFormState;
	/** The Discord channel listing for the channel fields; omitted, they are typed ids (WEB-23). */
	channels?: ChannelListing;
	flash?: Flash;
	settingsError?: string;
	accountError?: string;
	/** VS Code is on (menu entry). */
	vscode: boolean;
}

export function adminPage(opts: AdminPageOptions): string {
	const { state } = opts;
	return layout(
		"Settings",
		`${nav("settings", opts.vscode)}
<h1>Settings</h1>
${messages(undefined, opts.flash)}
<section class="status" aria-live="polite">
<strong>Engine:</strong> <span id="status-phase">${esc(state.phase)}</span>
<span class="hint">since <span id="status-since">${esc(state.since)}</span></span>
<div id="status-error" class="error"${state.error ? "" : " hidden"}>${esc(state.error)}</div>
</section>
<h2>Settings</h2>
${messages(opts.settingsError)}
${opts.settings ? settingsForm(opts.settings, opts.channels ?? { state: "unconfigured", message: CHANNELS_UNCONFIGURED }) : ""}
${opts.settings && opts.channels && opts.channels.state !== "unconfigured" ? CHANNEL_EXTRAS : ""}
<h2>Account</h2>
${messages(opts.accountError)}
<form method="post" action="/admin/account">
${passwordInput("currentPassword", "Current password", "current-password", FORM_HELP.currentPassword)}
${textInput("username", "Username", opts.username, `autocomplete="username" maxlength="${MAX_USERNAME_CHARS}"`, FORM_HELP.username)}
${passwordInput("password", `New password (at least ${MIN_PASSWORD_CHARS} characters)`, "new-password", FORM_HELP.password)}
${passwordInput("confirm", "Confirm new password", "new-password", FORM_HELP.confirm)}
<button type="submit">Update account</button>
</form>
${ENGINE_SCRIPT}`,
	);
}
