import type { AdminState, EnginePhase } from "../shared/adminApi";
import type { VersionInfo } from "../shared/version";
import { type Cell, formatTime } from "./live";
import { esc, layout, messages, nav, ORCHESTRATOR_UNAVAILABLE, pageLink, SITE_PAGES, type SitePageId, table } from "./views";

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
	status: "Engine state, Discord and GitHub, watched repositories, queues, limits, issues and usage.",
	settings: "Discord, GitHub, labels, models, limits, secrets and the admin account.",
	"status-json": "Machine-readable status and usage.",
	healthz: "Unauthenticated web health, with the orchestrator's phase and limits.",
};

export interface HomePageOptions {
	/** Undefined when the orchestrator is unavailable. */
	state?: AdminState;
	/** This web process's versions. */
	version: VersionInfo;
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

export function homePage(opts: HomePageOptions): string {
	const { state } = opts;
	const cards = SITE_PAGES.map(page => `<article class="card"><h3>${pageLink(page)}</h3><p class="hint">${esc(CARD_TEXT[page.id])}</p></article>`);
	const engine = state
		? `<p>Engine <span class="badge ${PHASE_BADGE[state.phase] ?? "warn"}">${esc(state.phase)}</span>
<span class="hint">since ${esc(formatTime(state.since))}</span></p>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}`
		: messages(`The ${ORCHESTRATOR_UNAVAILABLE}: the engine state and settings can't be shown until it is back.`);
	return layout(
		"Home",
		`${nav("home")}
<h1>AgentBot</h1>
${engine}
<div class="cards">
${cards.join("\n")}
</div>
${versionSection(opts.version, state?.version)}`,
	);
}
