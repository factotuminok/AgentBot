import { describe, expect, test } from "bun:test";
import { parseRepoConfig } from "../../src/orchestrator/dispatch/checkouts";

describe(".agentbot.yml (GH-26)", () => {
	test("reads baseBranch and setupCommand; an empty file is an empty configuration", () => {
		expect(parseRepoConfig("baseBranch: develop\nsetupCommand: bun install\n")).toEqual({ baseBranch: "develop", setupCommand: "bun install" });
		expect(parseRepoConfig("")).toEqual({});
		expect(parseRepoConfig("# nothing yet\n")).toEqual({});
	});

	test("a misspelt key, a wrong type or broken YAML is refused with the problem", () => {
		expect(() => parseRepoConfig("setupComand: make\n")).toThrow(/\.agentbot\.yml: .*setupComand/);
		expect(() => parseRepoConfig("baseBranch: [a, b]\n")).toThrow(/\.agentbot\.yml: baseBranch/);
		expect(() => parseRepoConfig("baseBranch: : :\n  - x")).toThrow(/not valid YAML/);
		expect(() => parseRepoConfig("- a list\n")).toThrow(/\.agentbot\.yml/);
	});
});
