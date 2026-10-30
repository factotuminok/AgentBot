import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig, parseSecrets, resolveLabelNames } from "../../src/shared/config";

const minimal = {
	discord: { guildId: "1", allowedUserIds: ["42"], workChannelId: "100" },
	github: { appId: 7 },
};

describe("parseConfig", () => {
	test("applies defaults", () => {
		const config = parseConfig(minimal);
		expect(config.discord.allowedRoleIds).toEqual([]);
		expect(config.discord.askChannelIds).toEqual([]);
		expect(config.discord.watchCategoryId).toBeUndefined();
		expect(config.github).toEqual({ appId: 7, pollIntervalSeconds: 60, mentionKeyword: "/agentbot" });
		expect(config.agent.name).toBe("AgentBot");
		expect(config.labels.trigger).toBe("agentbot");
		expect(config.models).toEqual({ thinking: "high" });
		expect(config.workers).toEqual({ reattachGraceSeconds: 90 });
		expect(config.logs).toEqual({ maxGiB: 5 });
		expect(config.limits).toEqual({
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
		});
	});

	test("errors use `Invalid config: <path>: <message>`", () => {
		expect(() => parseConfig({ ...minimal, github: { appId: -1 } })).toThrow(/^Invalid config: github\.appId: /);
	});

	test("old repos/updates sections are dropped", () => {
		const config = parseConfig({ ...minimal, repos: [{ name: "a/b" }], updates: {} });
		expect(config).not.toHaveProperty("repos");
		expect(config).not.toHaveProperty("updates");
	});

	test("agent.name is 1-32 characters", () => {
		expect(parseConfig({ ...minimal, agent: { name: "x".repeat(32) } }).agent.name).toHaveLength(32);
		expect(() => parseConfig({ ...minimal, agent: { name: "x".repeat(33) } })).toThrow(/agent\.name:/);
		expect(() => parseConfig({ ...minimal, agent: { name: "" } })).toThrow(/agent\.name:/);
	});

	test("models.thinking accepts only the listed levels", () => {
		expect(parseConfig({ ...minimal, models: { thinking: "xhigh", chat: "m" } }).models.chat).toBe("m");
		expect(() => parseConfig({ ...minimal, models: { thinking: "ultra" } })).toThrow(/models\.thinking:/);
	});

	test("workers settings", () => {
		expect(parseConfig({ ...minimal, workers: { maxConcurrentRuns: 50 } }).workers.maxConcurrentRuns).toBe(50);
		expect(() => parseConfig({ ...minimal, workers: { maxConcurrentRuns: 0 } })).toThrow(/workers\.maxConcurrentRuns:/);
		expect(() => parseConfig({ ...minimal, workers: { reattachGraceSeconds: 1.5 } })).toThrow(/workers\.reattachGraceSeconds:/);
	});

	test("logs.maxGiB rejects less than 0.1", () => {
		expect(parseConfig({ ...minimal, logs: { maxGiB: 0.1 } }).logs.maxGiB).toBe(0.1);
		expect(() => parseConfig({ ...minimal, logs: { maxGiB: 0.05 } })).toThrow(/logs\.maxGiB:/);
	});

	test("rejects empty allow-lists", () => {
		const raw = { ...minimal, discord: { ...minimal.discord, allowedUserIds: [], allowedRoleIds: [] } };
		expect(() => parseConfig(raw)).toThrow(ConfigError);
	});

	test("rejects a duplicate ask-only channel and the work channel", () => {
		expect(parseConfig({ ...minimal, discord: { ...minimal.discord, askChannelIds: ["200", "201"] } }).discord.askChannelIds).toEqual(["200", "201"]);
		const dup = { ...minimal, discord: { ...minimal.discord, askChannelIds: ["200", "200"] } };
		expect(() => parseConfig(dup)).toThrow(/discord\.askChannelIds\.1: duplicate channel 200/);
		const clash = { ...minimal, discord: { ...minimal.discord, askChannelIds: ["100"] } };
		expect(() => parseConfig(clash)).toThrow(/discord\.askChannelIds\.0: channel 100 is already the work channel/);
	});
});

describe("labels", () => {
	test("default names", () => {
		expect(resolveLabelNames(parseConfig(minimal))).toEqual({
			trigger: "agentbot",
			states: {
				planning: "agentbot:planning",
				awaitingApproval: "agentbot:awaiting-approval",
				implementing: "agentbot:implementing",
				inReview: "agentbot:in-review",
				failed: "agentbot:failed",
			},
		});
	});

	test("unset state labels derive from a custom trigger; set ones are kept", () => {
		const names = resolveLabelNames(parseConfig({ ...minimal, labels: { trigger: "bot", states: { failed: "broken" } } }));
		expect(names).toEqual({
			trigger: "bot",
			states: { planning: "bot:planning", awaitingApproval: "bot:awaiting-approval", implementing: "bot:implementing", inReview: "bot:in-review", failed: "broken" },
		});
	});

	test("names are 1-50 characters", () => {
		expect(parseConfig({ ...minimal, labels: { trigger: "t".repeat(50) } }).labels.trigger).toHaveLength(50);
		expect(() => parseConfig({ ...minimal, labels: { trigger: "t".repeat(51) } })).toThrow(/labels\.trigger:/);
		expect(() => parseConfig({ ...minimal, labels: { trigger: "" } })).toThrow(/labels\.trigger:/);
		expect(() => parseConfig({ ...minimal, labels: { states: { inReview: "" } } })).toThrow(/labels\.states\.inReview:/);
		expect(() => parseConfig({ ...minimal, labels: { states: { planning: "p".repeat(51) } } })).toThrow(/labels\.states\.planning:/);
	});

	test("rejects case-insensitive duplicates, including with the trigger", () => {
		expect(() => parseConfig({ ...minimal, labels: { states: { failed: "AgentBot:Planning" } } })).toThrow(
			/Invalid config: labels\.states\.failed: label AgentBot:Planning is the same as labels\.states\.planning/,
		);
		expect(() => parseConfig({ ...minimal, labels: { states: { planning: "AGENTBOT" } } })).toThrow(/labels\.states\.planning: .*labels\.trigger/);
	});
});

describe("parseSecrets", () => {
	test("rejects missing discordToken with a secrets path", () => {
		expect(() => parseSecrets({ githubAppPrivateKey: "pem" })).toThrow(/^Invalid config: secrets\.discordToken:/);
		expect(() => parseSecrets({ discordToken: "t" })).toThrow(/secrets\.githubAppPrivateKey:/);
	});

	test("accepts valid secrets; providerKeys defaults to {}", () => {
		expect(parseSecrets({ discordToken: "t", githubAppPrivateKey: "pem" })).toEqual({ discordToken: "t", githubAppPrivateKey: "pem", providerKeys: {} });
		expect(parseSecrets({ discordToken: "t", githubAppPrivateKey: "pem", providerKeys: { openai: "k" } }).providerKeys).toEqual({ openai: "k" });
	});
});
