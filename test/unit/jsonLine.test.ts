import { describe, expect, test } from "bun:test";
import { jsonPathLine } from "../../src/web/workspace/jsonLine";

const SETTINGS = `{
	// comments and trailing commas, as VS Code edits JSON with comments
	"discord": {
		"guildId": "123",
		"allowedUserIds": [
			"1",
			"2",
		],
	},
	/* block
	   comment */ "limits": { "maxConcurrentJobs": "lots" },
	"labels": { "trigger": "a\\"b", "states": {} }
}
`;

describe("jsonPathLine", () => {
	test("finds keys and array elements", () => {
		expect(jsonPathLine(SETTINGS, ["discord"])).toBe(3);
		expect(jsonPathLine(SETTINGS, ["discord", "guildId"])).toBe(4);
		expect(jsonPathLine(SETTINGS, ["discord", "allowedUserIds", 1])).toBe(7);
		expect(jsonPathLine(SETTINGS, ["limits", "maxConcurrentJobs"])).toBe(11);
		expect(jsonPathLine(SETTINGS, ["labels", "states"])).toBe(12);
	});

	test("a missing step points at the deepest step that exists; the root path at the root value", () => {
		expect(jsonPathLine(SETTINGS, ["discord", "workChannelId"])).toBe(3);
		expect(jsonPathLine(SETTINGS, ["github", "appId"])).toBe(1);
		expect(jsonPathLine(SETTINGS, [])).toBe(1);
		expect(jsonPathLine("\n\n  []", [])).toBe(3);
	});

	test("the last of duplicate keys wins, as in JSON.parse", () => {
		expect(jsonPathLine('{\n"a": 1,\n"a": {\n"b": 2\n}\n}', ["a", "b"])).toBe(4);
		expect(jsonPathLine('{\n"a": { "b": 1 },\n"a": 2\n}', ["a", "b"])).toBe(3);
	});

	test("a syntax error keeps what was found before it", () => {
		expect(jsonPathLine('{\n"a": {\n"b": 1,\n"c": nope', ["a", "c"])).toBe(4);
		expect(jsonPathLine("", ["a"])).toBeUndefined();
	});
});
