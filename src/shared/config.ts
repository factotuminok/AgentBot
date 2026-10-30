import { z } from "zod";

const labelName = z.string().min(1).max(50);

const configObject = z.object({
	discord: z
		.object({
			guildId: z.string().min(1),
			allowedUserIds: z.array(z.string()).default([]),
			allowedRoleIds: z.array(z.string()).default([]),
			/**
			 * The one channel where `/work` commands are used and issue threads live (DSC-33). Required to start the engine,
			 * not to save: a fresh install stores the bot token first, then picks this from the channel dropdown (WEB-20).
			 */
			workChannelId: z.string().min(1).optional(),
			/** Category new watch channels are created under (DSC-35); unset = top level. */
			watchCategoryId: z.string().min(1).optional(),
			/** Ask-only channels: anyone may run `/ask` there. Watch-channel clashes are checked at save (WEB-24). */
			askChannelIds: z.array(z.string().min(1)).default([]),
		})
		.refine(d => d.allowedUserIds.length + d.allowedRoleIds.length > 0, {
			message: "at least one of allowedUserIds/allowedRoleIds must be non-empty",
		}),
	github: z.object({
		appId: z.number().int().positive(),
		pollIntervalSeconds: z.number().int().positive().default(60),
		mentionKeyword: z.string().min(1).default("/agentbot"),
	}),
	agent: z.object({ name: z.string().min(1).max(32).default("AgentBot") }).prefault({}),
	labels: z
		.object({
			trigger: labelName.default("agentbot"),
			states: z
				.object({
					planning: labelName.optional(),
					awaitingApproval: labelName.optional(),
					implementing: labelName.optional(),
					inReview: labelName.optional(),
					failed: labelName.optional(),
				})
				.prefault({}),
		})
		.prefault({}),
	models: z
		.object({
			plan: z.string().min(1).optional(),
			implement: z.string().min(1).optional(),
			chat: z.string().min(1).optional(),
			thinking: z.enum(["auto", "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("high"),
		})
		.prefault({}),
	limits: z
		.object({
			maxConcurrentJobs: z.number().int().positive().default(2),
			maxChatSessions: z.number().int().positive().default(2),
			planMinutes: z.number().positive().default(30),
			implementMinutes: z.number().positive().default(120),
			fixMinutes: z.number().positive().default(45),
			maxCostUsdPerJob: z.number().positive().default(15),
			maxCiFixAttempts: z.number().int().nonnegative().default(3),
			ciWaitMinutes: z.number().positive().default(60),
			askTimeoutHours: z.number().positive().default(24),
			chatIdleMinutes: z.number().positive().default(30),
		})
		.prefault({}),
	workers: z
		.object({
			/** Unset = worker capacity. Never rejected here; health warns when it exceeds capacity (RUN-10). */
			maxConcurrentRuns: z.number().int().positive().optional(),
			reattachGraceSeconds: z.number().int().positive().default(90),
		})
		.prefault({}),
	logs: z.object({ maxGiB: z.number().min(0.1).default(5) }).prefault({}),
});

export type StateLabelKey = "planning" | "awaitingApproval" | "implementing" | "inReview" | "failed";

/** Effective GitHub label names: the trigger plus the five state labels (GH-08, GH-22). */
export interface LabelNames {
	trigger: string;
	states: Record<StateLabelKey, string>;
}

const STATE_LABEL_SUFFIX: Record<StateLabelKey, string> = {
	planning: "planning",
	awaitingApproval: "awaiting-approval",
	implementing: "implementing",
	inReview: "in-review",
	failed: "failed",
};

function deriveLabels(labels: z.infer<typeof configObject>["labels"]): LabelNames {
	const states = {} as Record<StateLabelKey, string>;
	for (const key of Object.keys(STATE_LABEL_SUFFIX) as StateLabelKey[]) {
		states[key] = labels.states[key] ?? `${labels.trigger}:${STATE_LABEL_SUFFIX[key]}`;
	}
	return { trigger: labels.trigger, states };
}

const configSchema = configObject.superRefine((config, ctx) => {
	const work = config.discord.workChannelId;
	const seen = new Set<string>();
	config.discord.askChannelIds.forEach((id, i) => {
		const path = ["discord", "askChannelIds", i];
		if (id === work) ctx.addIssue({ code: "custom", path, message: `channel ${id} is already the work channel` });
		else if (seen.has(id)) ctx.addIssue({ code: "custom", path, message: `duplicate channel ${id}` });
		seen.add(id);
	});
	const names = deriveLabels(config.labels);
	const byLower = new Map<string, string>([[names.trigger.toLowerCase(), "trigger"]]);
	for (const key of Object.keys(names.states) as StateLabelKey[]) {
		const lower = names.states[key].toLowerCase();
		const clash = byLower.get(lower);
		if (clash) {
			const other = clash === "trigger" ? "labels.trigger" : `labels.states.${clash}`;
			ctx.addIssue({ code: "custom", path: ["labels", "states", key], message: `label ${names.states[key]} is the same as ${other}` });
		}
		byLower.set(lower, key);
	}
});

const secretsSchema = z.object({
	discordToken: z.string().min(1),
	githubAppPrivateKey: z.string().min(1),
	providerKeys: z.record(z.string(), z.string()).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type Secrets = z.infer<typeof secretsSchema>;
/** Settings the engine can start with: the work channel is chosen (DSC-33). */
export type EngineConfig = Config & { discord: { workChannelId: string } };

export function hasWorkChannel(config: Config): config is EngineConfig {
	return config.discord.workChannelId !== undefined;
}

/** ENG-01: why the engine stays `unconfigured` after the first save. */
export const WORK_CHANNEL_MISSING = "Choose the work channel in Settings (Discord) to start the engine.";

/** Everything an admin enters (§13); stored encrypted in the vault. */
export interface Settings {
	config: Config;
	secrets: Secrets;
}

/** One settings error: where it is (`secrets.*` paths start with "secrets") and its `Invalid config: <path>: <message>` text. */
export interface SettingsIssue {
	path: (string | number)[];
	message: string;
}

/** Its message is the first issue's (§13); `issues` holds every one, for editors that mark each field. */
export class ConfigError extends Error {
	override name = "ConfigError";
	constructor(readonly issues: SettingsIssue[]) {
		super(issues[0]!.message);
	}
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, prefix: (string | number)[]): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	throw new ConfigError(
		result.error.issues.map(issue => {
			const path = [...prefix, ...issue.path.map(p => (typeof p === "number" ? p : String(p)))];
			return { path, message: `Invalid config: ${path.length ? path.join(".") : "(root)"}: ${issue.message}` };
		}),
	);
}

/** JSON Schema (draft 2020-12) of the config object as an admin writes it: settings with defaults are optional. */
export function configJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(configObject, { io: "input" });
}

/** Validate an already-parsed config object (everything in §13 except `secrets.*`). */
export function parseConfig(raw: unknown): Config {
	return parseOrThrow(configSchema, raw, []);
}

/** Validate `secrets.*`; errors carry the `secrets.` path prefix. */
export function parseSecrets(raw: unknown): Secrets {
	return parseOrThrow(secretsSchema, raw, ["secrets"]);
}

export function parseSettings(raw: { config: unknown; secrets: unknown }): Settings {
	return { config: parseConfig(raw.config), secrets: parseSecrets(raw.secrets) };
}

/** Effective label names from parsed config: unset state labels derive from the trigger. */
export function resolveLabelNames(config: Config): LabelNames {
	return deriveLabels(config.labels);
}

/** Discord authorization: user id in `allowedUserIds` or any role in `allowedRoleIds`. */
export function isAllowedMember(config: Config, userId: string, roleIds: Iterable<string>): boolean {
	if (config.discord.allowedUserIds.includes(userId)) return true;
	for (const role of roleIds) if (config.discord.allowedRoleIds.includes(role)) return true;
	return false;
}

/** True when `channelId` is one of the ask-only channels (`discord.askChannelIds`). */
export function isAskChannel(config: Config, channelId: string | null | undefined): boolean {
	return !!channelId && config.discord.askChannelIds.includes(channelId);
}
