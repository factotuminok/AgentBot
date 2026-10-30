// Spike S6: stub orchestrator. /internal/scale (scale token) and /hello (worker token).
const scaleToken = (await Bun.file("/run/secrets/scale_token").text()).trim();
const workerToken = (await Bun.file("/run/secrets/worker_token").text()).trim();
let pendingRuns = Number(process.env.SPIKE_PENDING ?? "1");

function log(msg: string, fields: Record<string, unknown> = {}): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), component: "stub", msg, ...fields }));
}

Bun.serve({
	port: 8081,
	fetch(req) {
		const url = new URL(req.url);
		const auth = req.headers.get("authorization");
		if (url.pathname === "/internal/scale") {
			if (auth !== `Bearer ${scaleToken}`) return new Response("unauthorized", { status: 401 });
			return Response.json({ pendingRuns });
		}
		if (url.pathname === "/hello") {
			if (auth !== `Bearer ${workerToken}`) {
				log("hello rejected");
				return new Response("unauthorized", { status: 401 });
			}
			pendingRuns = Math.max(0, pendingRuns - 1);
			log("hello accepted", { pendingRuns });
			return Response.json({ hello: "worker", pendingRuns });
		}
		return new Response("not found", { status: 404 });
	},
});
log("listening", { port: 8081, pendingRuns });
