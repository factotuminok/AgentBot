// Bun preload for the agent host in tests (`bun --preload test/fixtures/fake-cgroup.ts …`): `readOomKills` reads the
// file named by `TEST_MEMORY_EVENTS` instead of the cgroup v2 `memory.events`, so tests can raise the container's
// OOM-kill counter on any OS (AGT-17).
import { plugin } from "bun";

const events = process.env.TEST_MEMORY_EVENTS;
if (!events) throw new Error("fake-cgroup preload: TEST_MEMORY_EVENTS is required");

plugin({
	name: "fake-cgroup",
	setup(build) {
		build.onLoad({ filter: /src[\\/]worker[\\/]host[\\/]oom\.ts$/ }, async args => {
			const source = await Bun.file(args.path).text();
			const replaced = source.replace('"/sys/fs/cgroup/memory.events"', JSON.stringify(events));
			if (replaced === source) throw new Error("fake-cgroup preload: the memory.events path in oom.ts changed");
			return { contents: replaced, loader: "ts" };
		});
	},
});
