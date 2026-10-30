import type { SecretsView, SettingsSaveRequest, SettingsView } from "../shared/adminApi";
import { type Config, parseConfig } from "../shared/config";

export type FieldKind = "text" | "number" | "list";

export interface FieldDef {
	/** Dotted path into `Config`; also the form field name. */
	name: string;
	label: string;
	kind: FieldKind;
	/** Hover help next to the label; the schema default is appended by the view. */
	help: string;
	/** A sample value shown in the hover help. */
	example: string;
	/** Default shown in the hover help when the schema has no literal one (derived values). */
	defaultText?: string;
}

const MODEL_HELP =
	"A model id from omp's model list; its provider needs an API key under Secrets (or a sign-in, from a later release). Blank uses omp's default model.";

const CHANNEL_ID_HELP =
	"Once the bot token and guild ID are saved, choose it from the list, which shows what the bot is missing in each channel. Before that, enter its ID: in Discord, turn on Developer Mode (User Settings → Advanced), then right-click the channel → Copy Channel ID.";

function stateLabel(key: string, suffix: string, what: string): FieldDef {
	return {
		name: `labels.states.${key}`,
		label: `${what} label`,
		kind: "text",
		example: `ai:${suffix}`,
		defaultText: `<trigger>:${suffix}`,
		help: `GitHub label set on an issue while it is ${what.toLowerCase()}. Renaming it relabels every tracked issue without cancelling anything. Blank derives it from the trigger label. All labels must differ (case-insensitive).`,
	};
}

/** Every scalar/list field of `Config`, in display order. Sections come from the first path segment. */
export const CONFIG_FIELDS: FieldDef[] = [
	{
		name: "discord.guildId",
		label: "Guild ID",
		kind: "text",
		example: "123456789012345678",
		help: "ID of the Discord server (guild) AgentBot works in. The /work and /ask commands are registered there, and every channel below must be in it. Turn on Developer Mode (User Settings → Advanced), then right-click the server icon → Copy Server ID.",
	},
	{
		name: "discord.allowedUserIds",
		label: "Allowed user IDs",
		kind: "list",
		example: "234567890123456789, 345678901234567890",
		help: "Discord users allowed to control AgentBot: the /work commands, plan approval, answering agent questions and steering runs. Everyone else is refused. Right-click a user → Copy User ID. Separate several with commas or spaces. At least one user or role is required.",
	},
	{
		name: "discord.allowedRoleIds",
		label: "Allowed role IDs",
		kind: "list",
		example: "456789012345678901",
		help: "Members of these roles get the same control as the allowed users. Server Settings → Roles → right-click a role → Copy Role ID. Separate several with commas or spaces.",
	},
	{
		name: "discord.workChannelId",
		label: "Work channel",
		kind: "text",
		example: "567890123456789012",
		help: `The one text channel where /work commands are used. Issues of repositories that are not watched get their threads here. It cannot be an ask-only channel or a watch channel. The engine starts once it is chosen; on a fresh install, save the bot token and guild ID first, then choose it here. ${CHANNEL_ID_HELP}`,
	},
	{
		name: "discord.watchCategoryId",
		label: "Watch category",
		kind: "text",
		example: "678901234567890123",
		help: "Category that /work watch and the Repositories page create repository channels under. The bot needs Manage Channels there. Once the bot token and guild ID are saved, choose it from the list; before that, right-click the category → Copy Category ID. Blank creates them at the top level.",
	},
	{
		name: "discord.askChannelIds",
		label: "Ask-only channels",
		kind: "list",
		example: "789012345678901234",
		help: `Channels where anyone who can use the channel may run /ask, a general assistant with no repository. Separate several with commas or spaces. A channel cannot also be the work channel or a watch channel. ${CHANNEL_ID_HELP}`,
	},
	{
		name: "github.appId",
		label: "App ID",
		kind: "number",
		example: "1234567",
		help: "The numeric App ID at the top of your GitHub App's settings page (not the Client ID). AgentBot uses it with the private key under Secrets to act as the app. The repositories are the ones the App is installed on.",
	},
	{
		name: "github.pollIntervalSeconds",
		label: "Poll interval (seconds)",
		kind: "number",
		example: "30",
		help: "How often AgentBot checks GitHub for newly labelled issues in watched repositories, and for reviews, comments and CI results on tracked issues. Lower reacts faster but uses more of the App's API rate limit.",
	},
	{
		name: "github.mentionKeyword",
		label: "Mention keyword",
		kind: "text",
		example: "@agentbot",
		help: "Text that turns a general comment on an AgentBot pull request into a change request, such as “/agentbot rename the helper”. Reviews and inline comments always count. Only comments from the repository's owners, members and collaborators are acted on.",
	},
	{
		name: "agent.name",
		label: "Agent name",
		kind: "text",
		example: "Forge",
		help: "The bot's nickname in the guild and the name it uses in Discord messages, 1–32 characters.",
	},
	{
		name: "labels.trigger",
		label: "Trigger label",
		kind: "text",
		example: "ai-ready",
		help: "Adding this label to an issue in a watched repository hands it to AgentBot: it writes a plan and posts it in Discord for approval. AgentBot creates the labels in each repository when they are missing.",
	},
	stateLabel("planning", "planning", "Planning"),
	stateLabel("awaitingApproval", "awaiting-approval", "Awaiting approval"),
	stateLabel("implementing", "implementing", "Implementing"),
	stateLabel("inReview", "in-review", "In review"),
	stateLabel("failed", "failed", "Failed"),
	{
		name: "models.plan",
		label: "Plan model",
		kind: "text",
		example: "anthropic/claude-opus-4-5",
		help: `Model for issue planning and /work plan, including revisions you request. ${MODEL_HELP}`,
	},
	{
		name: "models.implement",
		label: "Implement model",
		kind: "text",
		example: "xai-oauth/grok-4",
		help: `Model for implementing an approved plan and for revise and fix-CI runs. ${MODEL_HELP}`,
	},
	{
		name: "models.chat",
		label: "Chat model",
		kind: "text",
		example: "google-gemini-cli/gemini-2.5-pro",
		help: `Model for /work ask, /ask and /work issue drafts. ${MODEL_HELP}`,
	},
	{
		name: "models.thinking",
		label: "Thinking level",
		kind: "text",
		example: "medium",
		help: "How much the model reasons before acting, for every run: auto, inherit, off, minimal, low, medium, high, xhigh or max. Higher is slower and costs more; models without reasoning ignore it.",
	},
	{
		name: "limits.maxConcurrentJobs",
		label: "Max concurrent jobs",
		kind: "number",
		example: "3",
		help: "How many issue jobs (plan, implement, revise, fix CI) run at the same time across all repositories; further jobs wait in the queue. Chats are limited separately.",
	},
	{
		name: "limits.maxChatSessions",
		label: "Max chat sessions",
		kind: "number",
		example: "4",
		help: "How many Discord chats (/work ask and /ask) can have an agent answering at the same time.",
	},
	{
		name: "limits.planMinutes",
		label: "Plan minutes",
		kind: "number",
		example: "45",
		help: "Time limit for one planning run. Time spent waiting for your answers in Discord doesn't count.",
	},
	{
		name: "limits.implementMinutes",
		label: "Implement minutes",
		kind: "number",
		example: "180",
		help: "Time limit for one implementation or revise run. Waiting for CI and for your answers doesn't count.",
	},
	{
		name: "limits.fixMinutes",
		label: "Fix minutes",
		kind: "number",
		example: "60",
		help: "Time limit for one run that fixes failing CI checks.",
	},
	{
		name: "limits.maxCostUsdPerJob",
		label: "Max cost per job (USD)",
		kind: "number",
		example: "7.50",
		help: "Spending cap for a single agent run, computed from the model's token prices. The run is stopped when it reaches the cap.",
	},
	{
		name: "limits.maxCiFixAttempts",
		label: "Max CI fix attempts",
		kind: "number",
		example: "2",
		help: "How many times AgentBot tries to fix failing CI for one issue, before and after the pull request is opened. 0 turns automatic CI fixes off.",
	},
	{
		name: "limits.ciWaitMinutes",
		label: "CI wait minutes",
		kind: "number",
		example: "90",
		help: "How long AgentBot waits for CI on its pushed branch before opening the pull request anyway.",
	},
	{
		name: "limits.askTimeoutHours",
		label: "Ask timeout (hours)",
		kind: "number",
		example: "8",
		help: "How long an agent waits for an answer to a question in Discord before it continues with the options it recommended.",
	},
	{
		name: "limits.chatIdleMinutes",
		label: "Chat idle minutes",
		kind: "number",
		example: "60",
		help: "After a chat thread has been quiet this long, its working copy or scratch folder is deleted. The conversation is kept.",
	},
	{
		name: "workers.maxConcurrentRuns",
		label: "Max concurrent runs",
		kind: "number",
		example: "8",
		defaultText: "worker capacity",
		help: "How many agent runs may be dispatched to workers at once. Never rejected on save; the status page warns when it exceeds the worker capacity. Blank uses the worker capacity.",
	},
	{
		name: "workers.reattachGraceSeconds",
		label: "Re-attach grace (seconds)",
		kind: "number",
		example: "120",
		help: "How long a run's worker may stay disconnected (for example during an orchestrator restart) before the run is treated as lost.",
	},
	{
		name: "logs.maxGiB",
		label: "Rolling log size (GiB)",
		kind: "number",
		example: "2",
		help: "Total disk space for the orchestrator's rolling logs (agent transcripts and its own log); the oldest files are deleted when it is exceeded. AGENTBOT_AGENT_LOG_MAX_BYTES overrides it.",
	},
];

export const SECTION_LABELS: Record<string, string> = {
	discord: "Discord",
	github: "GitHub",
	agent: "Agent",
	labels: "Labels",
	models: "Models",
	limits: "Limits",
	workers: "Workers",
	logs: "Logs",
};

export const SECRET_FIELDS = {
	discordToken: "secrets.discordToken",
	githubAppPrivateKey: "secrets.githubAppPrivateKey",
} as const;

export interface ProviderRow {
	name: string;
	/** A key is stored for this provider. */
	set: boolean;
}

/** Everything the settings form renders. Holds no secret values, only whether each one is set. */
export interface SettingsFormState {
	/** Keyed by `CONFIG_FIELDS[].name`. */
	config: Record<string, string>;
	providers: ProviderRow[];
	discordTokenSet: boolean;
	githubAppPrivateKeySet: boolean;
}

/** Config defaults, read from the schema by parsing a minimal valid config. */
const DEFAULT_CONFIG: Config = parseConfig({
	discord: { guildId: "-", allowedUserIds: ["-"], workChannelId: "-" },
	github: { appId: 1 },
});
/** Fields whose placeholder value in `DEFAULT_CONFIG` must not be shown as a default. */
const NO_DEFAULT_FIELDS = ["discord.guildId", "discord.allowedUserIds", "discord.workChannelId", "github.appId"];

/** Schema default of a config field for its hover help; "" when it has none. */
export function configDefault(def: FieldDef): string {
	if (def.defaultText !== undefined) return def.defaultText;
	return NO_DEFAULT_FIELDS.includes(def.name) ? "" : display(readPath(DEFAULT_CONFIG, def.name));
}

/** String value of a form field; files and missing fields read as "". */
export function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === "string" ? value : "";
}

function readPath(obj: unknown, path: string): unknown {
	let current = obj;
	for (const key of path.split(".")) {
		if (current === null || typeof current !== "object" || !(key in current)) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let current = obj;
	for (const key of keys.slice(0, -1)) {
		const next = current[key];
		if (next !== null && typeof next === "object") {
			current = next as Record<string, unknown>; // only objects created here are stored under config keys
		} else {
			const created: Record<string, unknown> = {};
			current[key] = created;
			current = created;
		}
	}
	current[keys.at(-1)!] = value;
}

function display(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

/** Blank → undefined (schema default applies); unparsable text is kept so validation reports it with its path. */
function parseField(kind: FieldKind, raw: string): unknown {
	const text = raw.trim();
	if (kind === "list") return text ? text.split(/[\s,]+/).filter(Boolean) : [];
	if (!text) return undefined;
	if (kind === "number") {
		const number = Number(text);
		return Number.isNaN(number) ? text : number;
	}
	return text;
}

/** Sorted row indices present in the form for fields named `<prefix>.<index>.<field>`. */
export function rowIndices(form: FormData, prefix: string): number[] {
	const pattern = new RegExp(`^${prefix.replaceAll(".", "\\.")}\\.(\\d+)\\.`);
	const indices = new Set<number>();
	for (const key of form.keys()) {
		const match = pattern.exec(key);
		if (match) indices.add(Number(match[1]));
	}
	return [...indices].sort((a, b) => a - b);
}

/** Submitted provider rows that have a name, with whether each is marked for removal. */
function providerRows(form: FormData): { name: string; key: string; remove: boolean }[] {
	const rows: { name: string; key: string; remove: boolean }[] = [];
	for (const i of rowIndices(form, "provider")) {
		const name = field(form, `provider.${i}.name`).trim();
		if (name) rows.push({ name, key: field(form, `provider.${i}.key`).trim(), remove: form.has(`provider.${i}.remove`) });
	}
	return rows;
}

/** Form names of the channel fields (WEB-20); the ask-only control adds `.add` (a dropdown) and `.remove` (checkboxes). */
export const CHANNEL_FIELDS = { work: "discord.workChannelId", category: "discord.watchCategoryId", ask: "discord.askChannelIds" } as const;

/**
 * The submitted text of a config field. Ask-only channels come as one typed list, or as one hidden input per channel
 * with Remove checkboxes and an Add dropdown (WEB-20); they are merged into one list.
 */
function submitted(form: FormData, name: string): string {
	if (name !== CHANNEL_FIELDS.ask) return field(form, name);
	const removed = new Set(form.getAll(`${name}.remove`));
	const ids = form
		.getAll(name)
		.flatMap(value => (typeof value === "string" ? value.split(/[\s,]+/) : []))
		.filter(id => id && !removed.has(id));
	const added = field(form, `${name}.add`).trim();
	if (added && !ids.includes(added)) ids.push(added);
	return ids.join(", ");
}

/**
 * Builds the admin API save request from the settings form; the orchestrator validates it as a whole (§13).
 * Blank optional fields are omitted so schema defaults apply. Blank secret inputs are omitted, which keeps the stored
 * value; a provider row marked for removal is sent with an empty key, which deletes it.
 */
export function saveRequestFromForm(form: FormData): SettingsSaveRequest {
	const config: Record<string, unknown> = {};
	for (const def of CONFIG_FIELDS) {
		const value = parseField(def.kind, submitted(form, def.name));
		if (value !== undefined) setPath(config, def.name, value);
	}
	for (const section of Object.keys(SECTION_LABELS)) config[section] ??= {};

	const secrets: SettingsSaveRequest["secrets"] = {};
	const discordToken = field(form, SECRET_FIELDS.discordToken).trim();
	if (discordToken) secrets.discordToken = discordToken;
	const githubAppPrivateKey = field(form, SECRET_FIELDS.githubAppPrivateKey).trim();
	if (githubAppPrivateKey) secrets.githubAppPrivateKey = githubAppPrivateKey;
	const providerKeys: Record<string, string> = {};
	for (const row of providerRows(form)) {
		if (row.remove) providerKeys[row.name] = "";
		else if (row.key) providerKeys[row.name] = row.key;
	}
	if (Object.keys(providerKeys).length > 0) secrets.providerKeys = providerKeys;
	return { config, secrets };
}

/** Form state for the stored settings, or schema defaults when nothing was saved yet. */
export function formStateFromView(view: SettingsView): SettingsFormState {
	const config: Record<string, string> = {};
	for (const def of CONFIG_FIELDS) {
		config[def.name] = view.config || !NO_DEFAULT_FIELDS.includes(def.name) ? display(readPath(view.config ?? DEFAULT_CONFIG, def.name)) : "";
	}
	return {
		config,
		providers: view.secrets.providerKeys.map(name => ({ name, set: true })),
		discordTokenSet: view.secrets.discordToken,
		githubAppPrivateKeySet: view.secrets.githubAppPrivateKey,
	};
}

/** Form state echoing a rejected submission. Secret values are dropped; set/not set reflects what is stored. */
export function formStateFromSubmission(form: FormData, secrets: SecretsView): SettingsFormState {
	const config: Record<string, string> = {};
	for (const def of CONFIG_FIELDS) config[def.name] = submitted(form, def.name);
	return {
		config,
		providers: providerRows(form)
			.filter(row => !row.remove)
			.map(row => ({ name: row.name, set: secrets.providerKeys.includes(row.name) })),
		discordTokenSet: secrets.discordToken,
		githubAppPrivateKeySet: secrets.githubAppPrivateKey,
	};
}

/** What a settings save reports (ENG-02), on the Settings page and in VS Code after a `settings.json` save (WEB-28). */
export function settingsSavedText(result: { phase: string; error?: string }): string {
	return `Settings saved. Engine is ${result.phase}${result.error ? `: ${result.error.replace(/\.$/, "")}` : ""}.`;
}

export const MIN_PASSWORD_CHARS = 12;
export const MAX_USERNAME_CHARS = 64;

/** Returns an error message for unacceptable admin credentials (WEB-02), or undefined. */
export function credentialsError(username: string, password: string, confirm: string): string | undefined {
	if (username.length < 1 || username.length > MAX_USERNAME_CHARS) return `Username must be 1-${MAX_USERNAME_CHARS} characters.`;
	if (password.length < MIN_PASSWORD_CHARS) return `Password must be at least ${MIN_PASSWORD_CHARS} characters.`;
	if (password !== confirm) return "Passwords do not match.";
	return undefined;
}
