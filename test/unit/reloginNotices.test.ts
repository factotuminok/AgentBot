import { afterEach, describe, expect, test } from "bun:test";
import {
	createReloginNotices,
	RELOGIN_CHECK_INTERVAL_MS,
	RELOGIN_NOTICE_KEY,
	type ReloginNotices,
} from "../../src/orchestrator/discord/reloginNotices";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import type { StoredAccount } from "../../src/shared/adminModels";
import { hasWorkChannel, parseConfig } from "../../src/shared/config";
import { createFakeDiscord, type FakeDiscord } from "../fakes/discord";

/**
 * SEC-17: re-login notices in the work channel. Real `kv` (in-memory db) and fake Discord; the clock and the interval are
 * injected, so nothing waits.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The deadline of the main account. */
const R = Date.UTC(2031, 5, 15, 12, 0, 0);

const dbs: Db[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
});

function anthropic(over: Partial<StoredAccount> = {}): StoredAccount {
	return { credentialId: 1, provider: "anthropic", type: "oauth", email: "alice@example.com", orgName: "Acme", reloginBy: new Date(R).toISOString(), ...over };
}

interface Rig {
	db: Db;
	discord: FakeDiscord;
	accounts: StoredAccount[];
	/** Moves the clock. */
	at(ms: number): void;
	/** A notifier like a new engine would build, over the same db and Discord. */
	notifier(): ReloginNotices;
	/** Moves the clock, checks, and returns every message in the work channel so far. */
	check(notices: ReloginNotices, ms: number): Promise<string[]>;
	intervals: { fn: () => void; ms: number; cancelled: boolean }[];
}

function rig(opts: { workChannelId?: string; accounts?: StoredAccount[] } = {}): Rig {
	const discord = createFakeDiscord({ channels: [{ id: "work", name: "work" }] });
	const config = parseConfig({
		discord: { guildId: "g", allowedUserIds: ["u"], workChannelId: opts.workChannelId ?? "work" },
		github: { appId: 1 },
	});
	if (!hasWorkChannel(config)) throw new Error("work channel expected");
	const db = openDb(":memory:");
	dbs.push(db);
	let t = 0;
	const intervals: Rig["intervals"] = [];
	const r: Rig = {
		db,
		discord,
		accounts: opts.accounts ?? [anthropic()],
		intervals,
		at: ms => {
			t = ms;
		},
		notifier: () =>
			createReloginNotices(
				{ config, db, discord },
				{
					accounts: () => r.accounts,
					now: () => t,
					every: (fn, ms) => {
						const entry = { fn, ms, cancelled: false };
						intervals.push(entry);
						return () => {
							entry.cancelled = true;
						};
					},
				},
			),
		check: async (notices, ms) => {
			t = ms;
			await notices.check();
			await discord.settled();
			return discord.messages(config.discord.workChannelId).map(m => m.content);
		},
	};
	return r;
}

describe("re-login notices (SEC-17)", () => {
	test("the first notice comes at the 3-day point, not earlier, and names the account, the date and /admin/models", async () => {
		const r = rig();
		const n = r.notifier();
		expect(await r.check(n, R - 3 * DAY - 1)).toEqual([]);
		const [notice, ...rest] = await r.check(n, R - 3 * DAY);
		expect(rest).toEqual([]);
		expect(notice).toContain("anthropic");
		expect(notice).toContain("`alice@example.com (Acme)`");
		expect(notice).toContain(`<t:${R / 1000}:F>`);
		expect(notice).toContain("/admin/models");
	});

	test("at most one notice per 24 hours and 3 per deadline", async () => {
		const r = rig();
		const n = r.notifier();
		const start = R - 3 * DAY;
		expect(await r.check(n, start)).toHaveLength(1);
		expect(await r.check(n, start + 23 * HOUR)).toHaveLength(1);
		expect(await r.check(n, start + 24 * HOUR)).toHaveLength(2);
		expect(await r.check(n, start + 47 * HOUR)).toHaveLength(2);
		expect(await r.check(n, start + 48 * HOUR)).toHaveLength(3);
		expect(await r.check(n, R - 1)).toHaveLength(3);
	});

	test("a missed notice goes out late, but never faster than one per 24 hours", async () => {
		const r = rig();
		const n = r.notifier();
		expect(await r.check(n, R - 12 * HOUR)).toHaveLength(1);
		expect(await r.check(n, R - 1)).toHaveLength(1);
	});

	test("a deadline that has passed gets no notice, on a fresh start or mid-cycle", async () => {
		const r = rig();
		const n = r.notifier();
		expect(await r.check(n, R)).toEqual([]);
		expect(await r.check(n, R + DAY)).toEqual([]);

		const cycle = rig();
		const m = cycle.notifier();
		expect(await cycle.check(m, R - 2 * DAY)).toHaveLength(1);
		expect(await cycle.check(m, R)).toHaveLength(1);
	});

	test("sign-ins without a re-login deadline never produce a notice", async () => {
		const r = rig({
			accounts: [
				{ credentialId: 1, provider: "openai-codex", type: "oauth", email: "bob@example.com", expiresAt: new Date(R - HOUR).toISOString() },
				{ credentialId: 2, provider: "openai", type: "api_key" },
			],
		});
		const n = r.notifier();
		expect(await r.check(n, R - 2 * DAY)).toEqual([]);
		expect(await r.check(n, R - HOUR)).toEqual([]);
		expect(r.db.kvGet(RELOGIN_NOTICE_KEY)).toBeUndefined();
	});

	test("an engine restart neither repeats nor skips a notice", async () => {
		const r = rig();
		expect(await r.check(r.notifier(), R - 3 * DAY)).toHaveLength(1);
		const second = r.notifier();
		expect(await r.check(second, R - 3 * DAY + HOUR)).toHaveLength(1);
		expect(await r.check(second, R - 2 * DAY)).toHaveLength(2);
		const third = r.notifier();
		expect(await r.check(third, R - 2 * DAY + HOUR)).toHaveLength(2);
		expect(await r.check(third, R - DAY)).toHaveLength(3);
		expect(await r.check(r.notifier(), R - HOUR)).toHaveLength(3);
	});

	test("a new sign-in resets the cycle: nothing for the old deadline, notices for the new one from its 3-day point", async () => {
		const r = rig();
		const n = r.notifier();
		await r.check(n, R - 3 * DAY);
		expect(await r.check(n, R - 2 * DAY)).toHaveLength(2);

		const newDeadline = R + 30 * DAY;
		r.accounts = [anthropic({ reloginBy: new Date(newDeadline).toISOString() })];
		expect(await r.check(n, R - DAY)).toHaveLength(2);
		expect(await r.check(n, R)).toHaveLength(2);
		expect(await r.check(n, newDeadline - 3 * DAY - 1)).toHaveLength(2);
		const messages = await r.check(n, newDeadline - 3 * DAY);
		expect(messages).toHaveLength(3);
		expect(messages[2]).toContain(`<t:${newDeadline / 1000}:F>`);
		// The cycle counts from 0 again.
		expect(await r.check(n, newDeadline - 2 * DAY)).toHaveLength(4);
		expect(await r.check(n, newDeadline - DAY)).toHaveLength(5);
		expect(await r.check(n, newDeadline - HOUR)).toHaveLength(5);
	});

	test("signing out stops the notices and drops the stored state", async () => {
		const r = rig({ accounts: [anthropic(), anthropic({ credentialId: 2, email: "carol@example.com" })] });
		const n = r.notifier();
		expect(await r.check(n, R - 3 * DAY)).toHaveLength(2);
		r.accounts = [anthropic({ credentialId: 2, email: "carol@example.com" })];
		expect(await r.check(n, R - 2 * DAY)).toHaveLength(3);
		expect(Object.keys(JSON.parse(r.db.kvGet(RELOGIN_NOTICE_KEY)!))).toEqual(["2"]);
		r.accounts = [];
		expect(await r.check(n, R - DAY)).toHaveLength(3);
		expect(JSON.parse(r.db.kvGet(RELOGIN_NOTICE_KEY)!)).toEqual({});
	});

	test("a failed send is logged, records nothing, does not stop the other accounts, and is retried at the next check", async () => {
		const r = rig({ workChannelId: "late", accounts: [anthropic(), anthropic({ credentialId: 2, email: "carol@example.com" })] });
		const n = r.notifier();
		r.at(R - 3 * DAY);
		await n.check();
		expect(r.discord.channels().map(c => c.id)).not.toContain("late");
		expect(r.db.kvGet(RELOGIN_NOTICE_KEY)).toBeUndefined();

		r.discord.addChannel({ id: "late", name: "late" });
		r.at(R - 3 * DAY + HOUR);
		await n.check();
		await r.discord.settled();
		const sent = r.discord.messages("late").map(m => m.content);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toContain("alice@example.com");
		expect(sent[1]).toContain("carol@example.com");
	});

	test("a throwing account source is survived and the next check runs", async () => {
		const r = rig();
		const n = r.notifier();
		const good = r.accounts;
		r.accounts = new Proxy([], {
			get() {
				throw new Error("store closed");
			},
		});
		r.at(R - 3 * DAY);
		await n.check();
		r.accounts = good;
		expect(await r.check(n, R - 3 * DAY + HOUR)).toHaveLength(1);
	});

	test("start checks at once and every hour; stop cancels the interval and ends the checks", async () => {
		const r = rig();
		r.at(R - 3 * DAY);
		const n = r.notifier();
		n.start();
		await n.check();
		await r.discord.settled();
		expect(r.discord.messages("work")).toHaveLength(1);
		expect(r.intervals).toHaveLength(1);
		expect(r.intervals[0]!.ms).toBe(RELOGIN_CHECK_INTERVAL_MS);

		r.at(R - 2 * DAY);
		r.intervals[0]!.fn();
		await n.check();
		await r.discord.settled();
		expect(r.discord.messages("work")).toHaveLength(2);

		n.stop();
		expect(r.intervals[0]!.cancelled).toBe(true);
		r.at(R - DAY);
		r.intervals[0]!.fn();
		await n.check();
		await r.discord.settled();
		expect(r.discord.messages("work")).toHaveLength(2);
	});

	test("bad stored state counts as no state", async () => {
		const r = rig();
		r.db.kvSet(RELOGIN_NOTICE_KEY, "{not json");
		expect(await r.check(r.notifier(), R - 3 * DAY)).toHaveLength(1);
		expect(JSON.parse(r.db.kvGet(RELOGIN_NOTICE_KEY)!)).toEqual({ "1": { reloginBy: new Date(R).toISOString(), sent: 1, lastAt: new Date(R - 3 * DAY).toISOString() } });
	});

	test("markdown in a credential's email cannot escape the code span", async () => {
		const r = rig({ accounts: [anthropic({ email: "`**x**`", orgName: undefined })] });
		const [notice] = await r.check(r.notifier(), R - 3 * DAY);
		expect(notice).toContain("model sign-in `'**x**'` must");
	});
});
