// Bun preload for the agent host in tests (`bun --preload test/fixtures/fast-clock.ts …`): the session's wall-clock
// check (AGT-14, every 15 s) runs every `TEST_CLOCK_CHECK_MS` instead, so a time-limit test needs no 15 s wait.
import { plugin } from "bun";

const ms = Number(process.env.TEST_CLOCK_CHECK_MS);
if (!(ms > 0)) throw new Error("fast-clock preload: TEST_CLOCK_CHECK_MS must be a positive number");

plugin({
	name: "fast-clock",
	setup(build) {
		build.onLoad({ filter: /src[\\/]worker[\\/]host[\\/]session\.ts$/ }, async args => {
			const source = await Bun.file(args.path).text();
			const replaced = source.replace("const WALL_CLOCK_CHECK_MS = 15_000;", `const WALL_CLOCK_CHECK_MS = ${ms};`);
			if (replaced === source) throw new Error("fast-clock preload: WALL_CLOCK_CHECK_MS in session.ts changed");
			return { contents: replaced, loader: "ts" };
		});
	},
});
