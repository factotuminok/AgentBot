import type { AdminState, EnginePhase, HomeFacts } from "../shared/adminApi";
import type { VersionInfo } from "../shared/version";
import { type Cell, formatTime } from "./live";
import { esc, layout, messages, nav, ORCHESTRATOR_UNAVAILABLE, pageLink, type SitePageId, sitePages, table } from "./views";

const PHASE_BADGE: Record<EnginePhase, string> = {
	setup: "warn",
	locked: "warn",
	unconfigured: "warn",
	starting: "warn",
	running: "ok",
	stopping: "warn",
	error: "bad",
};

/** One-line description per page. `Record` makes a new `SitePageId` fail to compile without card text. */
const CARD_TEXT: Record<SitePageId, string> = {
	status: "Engine state, Discord and GitHub, watched repositories, queues, limits, workers, runs and their setup time, issues, usage and loadouts.",
	logs: "Live agent transcripts, and the agent and orchestrator log files to download.",
	settings: "Discord, GitHub, labels, models, limits, secrets and the admin account.",
	repos: "Repositories the GitHub App can access; watch and unwatch them.",
	models: "Sign in to model providers and see the available model ids.",
	omp: "omp setting overrides and MCP servers.",
	skills: "Upload and remove the skills and task agents runs load.",
	vscode: "Edit settings, omp settings, skills and agents as files in VS Code; each save is validated and applied.",
	"status-json": "Machine-readable status and usage.",
	healthz: "Unauthenticated web health, with the orchestrator's phase and limits.",
};

export interface HomePageOptions {
	/** Undefined when the orchestrator is unavailable. */
	state?: AdminState;
	/** This web process's versions. */
	version: VersionInfo;
	/** VS Code is on: it gets a card and a menu entry. */
	vscode: boolean;
}

export function versionSection(version: VersionInfo, orchestratorVersion: string | undefined): string {
	const dep = (name: string) => version.dependencies[name] ?? "unknown";
	const rows: Cell[][] = [
		["AgentBot (web)", version.agentbot],
		["AgentBot (orchestrator)", orchestratorVersion ?? ORCHESTRATOR_UNAVAILABLE],
		["Commit", version.commit],
		["Image built at", version.builtAt ? formatTime(version.builtAt) : "— (not set)"],
		["omp SDK", dep("@oh-my-pi/pi-coding-agent")],
		["discord.js", dep("discord.js")],
		["octokit", dep("octokit")],
		["zod", dep("zod")],
		["Bun", version.runtime.bun],
		["OS / arch", `${version.runtime.os} / ${version.runtime.arch}`],
		["Running in a container", version.runtime.container ? "yes" : "no"],
		["Web started at", formatTime(version.startedAt)],
	];
	const mismatch =
		orchestratorVersion !== undefined && orchestratorVersion !== version.agentbot
			? `<p class="warning">The web pod and the orchestrator run different AgentBot versions.</p>`
			: "";
	return `<details open><summary><h2>Version</h2></summary>
${table([], rows, "")}
${mismatch}</details>`;
}

/** A copyable code sample: caption (trusted HTML), Copy button, `<pre><code>`. */
function codeBlock(caption: string, code: string): string {
	return `<figure class="code"><figcaption>${caption}</figcaption>
<button type="button" class="copy">Copy</button><pre><code>${esc(code)}</code></pre></figure>`;
}

/** Copies the sibling `<pre>`'s text; no HTML is ever written. */
const COPY_SCRIPT = `<script>
for (const button of document.querySelectorAll("button.copy")) {
	button.addEventListener("click", async () => {
		const pre = button.parentElement.querySelector("pre");
		try {
			await navigator.clipboard.writeText(pre.textContent);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Copy failed";
		}
		setTimeout(() => { button.textContent = "Copy"; }, 1500);
	});
}
</script>`;

const HOME_STYLE = `<style>
figure.code { margin: .5rem 0 1rem; }
figure.code pre { overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; padding: .5rem; }
ol.steps li { margin: .25rem 0; }
</style>`;

type ChecklistStep = keyof HomeFacts["checklist"];

/** Getting-started steps in order, each with where it is done (trusted HTML). */
const CHECKLIST: readonly { step: ChecklistStep; html: string }[] = [
	{ step: "setup", html: `Create the admin account on <a href="/setup">Setup</a> with the token from the orchestrator log.` },
	{
		step: "credentials",
		html: `Enter the Discord bot token, the GitHub App ID and its private key on <a href="/admin">Settings</a>.`,
	},
	{ step: "workChannel", html: `Choose the Discord work channel, where <code>/work</code> is used and issue threads live, on <a href="/admin">Settings</a>.` },
	{ step: "watchedRepo", html: `Watch a repository on <a href="/admin/repos">Repositories</a>.` },
	{
		step: "modelAccess",
		html: `Sign in to a model provider on <a href="/admin/models">Model accounts</a>, or add a provider API key on <a href="/admin">Settings</a>.`,
	},
];

function gettingStarted(checklist: HomeFacts["checklist"]): string {
	const steps = CHECKLIST.map(({ step, html }) => {
		const done = checklist[step];
		const mark = done ? '<span class="badge ok" title="done">✓</span>' : '<span class="badge warn" title="to do">to do</span>';
		return `<li data-step="${step}" class="${done ? "done" : "todo"}">${mark} ${html}</li>`;
	});
	return `<details open id="getting-started"><summary><h2>Getting started</h2></summary>
<ol class="steps">
${steps.join("\n")}
<li>Then check <a href="/status">Status</a> and start work: label a GitHub issue with the trigger label, or use <code>/work</code> in the work channel.</li>
</ol></details>`;
}

/** Sample settings document (§13); exported so tests check it against the real schema. Secrets are placeholders. */
export const SAMPLE_SETTINGS = {
	config: {
		discord: {
			guildId: "123456789012345678",
			allowedUserIds: ["234567890123456789"],
			allowedRoleIds: [],
			workChannelId: "345678901234567890",
			askChannelIds: [],
		},
		github: { appId: 1234567, pollIntervalSeconds: 60, mentionKeyword: "/agentbot" },
		agent: { name: "AgentBot" },
		labels: { trigger: "agentbot" },
		models: { plan: "anthropic/claude-opus-4-5", implement: "anthropic/claude-sonnet-4-5", chat: "google-gemini-cli/gemini-2.5-pro", thinking: "high" },
		limits: {
			maxConcurrentJobs: 2,
			maxChatSessions: 2,
			planMinutes: 30,
			implementMinutes: 120,
			fixMinutes: 45,
			maxCostUsdPerJob: 15,
			maxCiFixAttempts: 3,
			ciWaitMinutes: 60,
			askTimeoutHours: 24,
			chatIdleMinutes: 30,
		},
		workers: { reattachGraceSeconds: 90 },
		logs: { maxGiB: 5 },
	},
	secrets: { discordToken: "<bot token>", githubAppPrivateKey: "<PEM private key>", providerKeys: { openai: "<API key>" } },
};

/** Sample omp overrides and MCP servers (the omp page); exported so tests check it against the real schema. */
export const SAMPLE_OMP = {
	settings: { "compaction.enabled": true },
	mcpServers: {
		github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<token>" } },
		docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer <token>" } },
	},
};

/** Sample `.agentbot.yml` on a repository's default branch (GH-26); exported so tests check it against the real parser. */
export const SAMPLE_REPO_CONFIG = `# .agentbot.yml on the default branch; both keys are optional.
baseBranch: develop        # branch work starts from and pull requests target; default: the repository's default branch
setupCommand: bun install  # runs in every fresh checkout before the agent starts (counts as setup time on Status)`;

const SAMPLE_ISSUE = `Title: Add CSV export to the widgets report

The widgets report (src/reports/widgets.ts) can only be viewed in the browser.
Add a "Download CSV" button that exports the rows currently shown, with the same
columns and filters. Use the existing csv helper in src/lib/csv.ts.

Done when: the button downloads a CSV matching the table, and there is a unit test
for the export function.`;

function sampleConfigs(): string {
	return `<details id="samples"><summary><h2>Sample configs</h2></summary>
${codeBlock(`Settings as a whole (§13), as <a href="/admin">Settings</a> stores them; secrets are write-only there:`, JSON.stringify(SAMPLE_SETTINGS, null, 2))}
${codeBlock(`omp overrides and MCP servers, as on <a href="/admin/omp">omp and MCP</a>:`, JSON.stringify(SAMPLE_OMP, null, 2))}
${codeBlock("<code>.agentbot.yml</code> in a watched repository:", SAMPLE_REPO_CONFIG)}
${codeBlock("A GitHub issue that works well; label it with the trigger label:", SAMPLE_ISSUE)}
</details>`;
}

export function homePage(opts: HomePageOptions): string {
	const { state } = opts;
	const cards = sitePages(opts.vscode).map(page => `<article class="card"><h3>${pageLink(page)}</h3><p class="hint">${esc(CARD_TEXT[page.id])}</p></article>`);
	const engine = state
		? `<p>Engine <span class="badge ${PHASE_BADGE[state.phase] ?? "warn"}">${esc(state.phase)}</span>
<span class="hint">since ${esc(formatTime(state.since))}</span></p>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
<ul class="facts">
<li>Model accounts: <strong id="model-accounts">${state.home.modelAccounts ?? "—"}</strong></li>
<li>MCP servers: <strong id="mcp-servers">${state.home.mcpServers ?? "—"}</strong></li>
</ul>`
		: messages(`The ${ORCHESTRATOR_UNAVAILABLE}: the engine state and settings can't be shown until it is back.`);
	return layout(
		"Home",
		`${nav("home", opts.vscode)}
${HOME_STYLE}
<h1>AgentBot</h1>
${engine}
<div class="cards">
${cards.join("\n")}
</div>
${state ? gettingStarted(state.home.checklist) : ""}
${versionSection(opts.version, state?.version)}
${sampleConfigs()}
${COPY_SCRIPT}`,
	);
}
