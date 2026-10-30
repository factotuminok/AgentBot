// Stub orchestrator for the launcher smoke test: `/internal/scale` (scale token) returns `{pendingRuns}`; `/hello`
// (worker token) is what the stub worker calls instead of claiming a run, and takes one run off the queue.
import { readFileSync } from "node:fs";

const scaleToken = readFileSync("/run/secrets/scale_token", "utf8").trim();
const workerToken = readFileSync("/run/secrets/worker_token", "utf8").trim();
let pendingRuns = Number(process.env.STUB_PENDING ?? "1");

function log(msg: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), component: "stub-orchestrator", msg, ...fields }));
}

Bun.serve({
	port: 8081,
	fetch(req) {
		const { pathname } = new URL(req.url);
		const auth = req.headers.get("authorization");
		if (pathname === "/internal/scale") {
			if (auth !== `Bearer ${scaleToken}`) return Response.json({ error: "unauthorized" }, { status: 401 });
			return Response.json({ pendingRuns });
		}
		if (pathname === "/pending") return Response.json({ pendingRuns });
		if (pathname === "/hello") {
			if (auth !== `Bearer ${workerToken}`) {
				log("hello rejected");
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			pendingRuns = Math.max(0, pendingRuns - 1);
			log("hello accepted", { pendingRuns });
			return Response.json({ pendingRuns });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	},
});
log("listening", { port: 8081, pendingRuns });
