import { afterEach, expect, test } from "bun:test";
import { createDiscordRest } from "../../src/orchestrator/discord/rest";
import { type FakeDiscordRest, startFakeDiscordRest } from "../fakes/discordRest";

/** DSC-07 on the wire: what discord.js actually sends as `allowed_mentions` (the gateway adapter uses the same `restMessage`). */

let fake: FakeDiscordRest | undefined;
afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

test("user or model text is sent with every mention disabled; only listed users are notified (DSC-07)", async () => {
	fake = startFakeDiscordRest();
	const channel = fake.addChannel({ name: "work" });
	const rest = createDiscordRest({ token: fake.token, api: fake.api });

	await rest.send(channel.id, { content: "Hey @everyone, @here and <@123> <@&456>, look" });
	await rest.send(channel.id, { content: "<@u1> Plan ready", mentions: { users: ["u1"] } });

	expect(fake.messages.map(m => m.allowedMentions)).toEqual([
		{ parse: [], users: [], roles: [] },
		{ parse: [], users: ["u1"], roles: [] },
	]);
});
