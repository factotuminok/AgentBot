import type { LoginInputRequest, LoginStartRequest, SignOutRequest, SignOutResponse } from "../../shared/adminModels";
import { log } from "../../shared/log";
import type { Accounts } from "../store/accounts";
import { type AdminRoutes, actingAdmin, fail, jsonBody, str } from "./http";

/** `/internal/admin/models*`: model sign-ins (SEC-12, SEC-13); the contract is in `src/shared/adminModels.ts`. */
export function createModelsRoutes(accounts: Accounts): AdminRoutes {
	return {
		"/models": { methods: ["GET"], handle: () => Response.json(accounts.view()) },

		"/models/logins": {
			methods: ["POST"],
			async handle(req) {
				const provider = str((await jsonBody<LoginStartRequest>(req)).provider);
				try {
					const state = accounts.startLogin(provider);
					log("info", "model sign-in requested", { admin: actingAdmin(req), provider });
					return Response.json(state);
				} catch (err) {
					return fail(400, err instanceof Error ? err.message : String(err));
				}
			},
		},

		"/models/logins/": {
			methods: ["GET", "POST"],
			async handle(req, _url, path) {
				const [id = "", action] = path.slice("/models/logins/".length).split("/");
				const state = accounts.login(id);
				if (!state) return fail(404, "This sign-in does not exist or has expired.");
				if (req.method === "GET" && action === undefined) return Response.json(state);
				if (req.method !== "POST") return fail(405, "method not allowed");
				if (action === "input") {
					if (!accounts.submitInput(id, str((await jsonBody<LoginInputRequest>(req)).text))) {
						return fail(400, state.status === "needs_input" ? "Enter a value." : "This sign-in is not waiting for input.");
					}
					return Response.json(state);
				}
				if (action === "cancel") {
					accounts.cancelLogin(id);
					return Response.json(state);
				}
				return fail(404, "not found");
			},
		},

		"/models/signout": {
			methods: ["POST"],
			async handle(req) {
				const provider = str((await jsonBody<SignOutRequest>(req)).provider);
				if (!provider) return fail(400, "Choose a provider to sign out of.");
				const removed = await accounts.signOut(provider);
				if (removed) log("info", "model sign-out", { admin: actingAdmin(req), provider });
				return Response.json({ removed } satisfies SignOutResponse);
			},
		},
	};
}
