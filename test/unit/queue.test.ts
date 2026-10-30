import { describe, expect, test } from "bun:test";
import { createOutboundQueue, type QueueClock, type RateLimitInfo } from "../../src/orchestrator/discord/queue";

/** A clock whose timers fire only when the test advances it. */
function manualClock(): QueueClock & { advance(ms: number): void } {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		setTimeout(fn, ms) {
			const id = nextId++;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout(handle) {
			timers.delete(handle as number);
		},
		advance(ms) {
			now += ms;
			for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.fn();
			}
		},
	};
}

class Limited extends Error {
	constructor(readonly info: RateLimitInfo) {
		super("rate limited");
	}
}

/** Lets queued microtasks (the queue's pump and task continuations) run. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

function setup() {
	const clock = manualClock();
	const queue = createOutboundQueue({ clock, rateLimitOf: err => (err instanceof Limited ? err.info : undefined) });
	const ran: string[] = [];
	const task = (name: string) => async () => {
		ran.push(name);
		return name;
	};
	return { clock, queue, ran, task };
}

describe("outbound queue", () => {
	test("runs high before state before activity, first in first out within a priority", async () => {
		const { queue, ran, task } = setup();
		queue.pause();
		const results = [
			queue.push({ priority: "activity", bucket: "c1", run: task("heartbeat") }),
			queue.push({ priority: "state", bucket: "c1", run: task("state-1") }),
			queue.push({ priority: "high", bucket: "c1", run: task("send-1") }),
			queue.push({ priority: "state", bucket: "c1", run: task("state-2") }),
			queue.push({ priority: "high", bucket: "c1", run: task("send-2") }),
		];
		expect(queue.stats().length).toBe(5);
		queue.resume();
		expect(await Promise.all(results)).toEqual(["heartbeat", "state-1", "send-1", "state-2", "send-2"]);
		expect(ran).toEqual(["send-1", "send-2", "state-1", "state-2", "heartbeat"]);
		expect(queue.stats()).toEqual({ length: 0, oldestAgeMs: null });
	});

	test("one task per bucket at a time; other buckets run alongside", async () => {
		const { queue } = setup();
		const events: string[] = [];
		const slow = (name: string) => {
			const gate = Promise.withResolvers<void>();
			return {
				gate,
				run: async () => {
					events.push(`start ${name}`);
					await gate.promise;
					events.push(`end ${name}`);
				},
			};
		};
		const a1 = slow("a1");
		const a2 = slow("a2");
		const b1 = slow("b1");
		const done = [queue.push({ priority: "high", bucket: "a", run: a1.run }), queue.push({ priority: "high", bucket: "a", run: a2.run }), queue.push({ priority: "high", bucket: "b", run: b1.run })];
		await flush();
		expect(events).toEqual(["start a1", "start b1"]);
		a1.gate.resolve();
		await flush();
		expect(events).toEqual(["start a1", "start b1", "end a1", "start a2"]);
		a2.gate.resolve();
		b1.gate.resolve();
		await Promise.all(done);
	});

	test("a newer edit replaces an unsent one: the latest content wins, the replaced promise resolves, priority is the higher", async () => {
		const { queue, ran, task } = setup();
		queue.pause();
		const first = queue.push({ priority: "state", bucket: "c1", coalesce: "edit:m1", run: task("edit v1") });
		const other = queue.push({ priority: "state", bucket: "c1", run: task("other state") });
		const second = queue.push({ priority: "activity", bucket: "c1", coalesce: "edit:m1", run: task("edit v2") });
		expect(await first).toBeUndefined();
		expect(queue.stats().length).toBe(2);
		queue.resume();
		expect(await second).toBe("edit v2");
		await other;
		// v2 took over v1's place in line and its `state` priority, so it still runs before the later state write.
		expect(ran).toEqual(["edit v2", "other state"]);
	});

	test("an edit pushed while the same message's edit is in flight waits for it instead of replacing it", async () => {
		const { queue, ran } = setup();
		const gate = Promise.withResolvers<void>();
		const first = queue.push({
			priority: "state",
			bucket: "c1",
			coalesce: "edit:m1",
			run: async () => {
				await gate.promise;
				ran.push("v1");
			},
		});
		await flush();
		const second = queue.push({ priority: "state", bucket: "c1", coalesce: "edit:m1", run: async () => void ran.push("v2") });
		gate.resolve();
		await Promise.all([first, second]);
		expect(ran).toEqual(["v1", "v2"]);
	});

	test("a rate-limited task is retried after retry-after; meanwhile activity edits for that channel are skipped, other channels go on", async () => {
		const { clock, queue, ran, task } = setup();
		let failures = 1;
		const send = queue.push({
			priority: "high",
			bucket: "c1",
			run: async () => {
				if (failures-- > 0) throw new Limited({ retryAfterMs: 1000, global: false });
				ran.push("send c1");
				return "sent";
			},
		});
		await flush();
		expect(queue.isLimited("c1")).toBe(true);
		expect(ran).toEqual([]);

		const heartbeat = queue.push({ priority: "activity", bucket: "c1", run: task("heartbeat c1") });
		expect(await heartbeat).toBeUndefined();
		const stateEdit = queue.push({ priority: "state", bucket: "c1", coalesce: "edit:m1", run: task("state c1") });
		expect(await queue.push({ priority: "activity", bucket: "c2", run: task("heartbeat c2") })).toBe("heartbeat c2");
		await flush();
		expect(ran).toEqual(["heartbeat c2"]);

		clock.advance(999);
		await flush();
		expect(ran).toEqual(["heartbeat c2"]);
		clock.advance(1);
		expect(await send).toBe("sent");
		await stateEdit;
		expect(ran).toEqual(["heartbeat c2", "send c1", "state c1"]);
		expect(queue.isLimited("c1")).toBe(false);
	});

	test("activity tasks already queued for a channel are dropped when it becomes rate-limited", async () => {
		const { clock, queue, ran, task } = setup();
		queue.pause();
		const heartbeat = queue.push({ priority: "activity", bucket: "c1", coalesce: "edit:m1", run: task("heartbeat") });
		const state = queue.push({ priority: "state", bucket: "c1", run: task("state") });
		queue.limited("c1", 500);
		expect(await heartbeat).toBeUndefined();
		expect(queue.stats().length).toBe(1);
		queue.resume();
		await flush();
		expect(ran).toEqual([]);
		clock.advance(500);
		await state;
		expect(ran).toEqual(["state"]);
	});

	test("a global limit holds every bucket until it expires", async () => {
		const { clock, queue, ran, task } = setup();
		queue.limited(null, 200);
		const a = queue.push({ priority: "high", bucket: "a", run: task("a") });
		const b = queue.push({ priority: "high", bucket: "b", run: task("b") });
		expect(await queue.push({ priority: "activity", bucket: "c", run: task("c") })).toBeUndefined();
		await flush();
		expect(ran).toEqual([]);
		clock.advance(200);
		await Promise.all([a, b]);
		expect(ran).toEqual(["a", "b"]);
	});

	test("stats report the length and the age of the oldest queued write", async () => {
		const { clock, queue, task } = setup();
		queue.pause();
		void queue.push({ priority: "high", bucket: "a", run: task("a") });
		clock.advance(300);
		void queue.push({ priority: "high", bucket: "b", run: task("b") });
		clock.advance(200);
		expect(queue.stats()).toEqual({ length: 2, oldestAgeMs: 500 });
		queue.resume();
		await queue.idle();
		expect(queue.stats()).toEqual({ length: 0, oldestAgeMs: null });
	});

	test("other failures reject the task's promise and the queue carries on", async () => {
		const { queue, task } = setup();
		const failed = queue.push({
			priority: "high",
			bucket: "a",
			run: async () => {
				throw new Error("Unknown Message");
			},
		});
		const next = queue.push({ priority: "high", bucket: "a", run: task("next") });
		await expect(failed).rejects.toThrow("Unknown Message");
		expect(await next).toBe("next");
	});

	test("close rejects queued writes and later pushes", async () => {
		const { queue, task } = setup();
		queue.pause();
		const pending = queue.push({ priority: "high", bucket: "a", run: task("a") });
		queue.close(new Error("closed"));
		await expect(pending).rejects.toThrow("closed");
		await expect(queue.push({ priority: "high", bucket: "a", run: task("b") })).rejects.toThrow("closed");
	});
});
