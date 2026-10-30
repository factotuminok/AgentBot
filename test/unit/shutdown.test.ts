import { expect, test } from "bun:test";
import { shutdownOrchestrator } from "../../src/orchestrator/main";

test("shutdown stops update checks, the internal API, dispatch, the engine, then the database; a failure is logged, not thrown (ENG-04)", async () => {
	const order: string[] = [];
	const parts = {
		ompUpdates: { stop: () => void order.push("update checks") },
		api: { url: "http://x", stop: async () => void order.push("internal API") },
		dispatcher: { close: () => void order.push("dispatch") },
		controller: { stop: async () => void order.push("engine") },
		signins: { close: () => void order.push("signins") },
		db: { close: () => void order.push("database") },
	};
	await shutdownOrchestrator("SIGTERM", parts);
	expect(order).toEqual(["update checks", "internal API", "dispatch", "engine", "signins", "database"]);

	order.length = 0;
	await shutdownOrchestrator("SIGTERM", {
		...parts,
		controller: {
			stop: async () => {
				throw new Error("boom");
			},
		},
	});
	expect(order).toEqual(["update checks", "internal API", "dispatch"]);
});
