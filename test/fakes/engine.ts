import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractionRouter } from "../../src/orchestrator/discord/interactionRouter";
import { createThreadReplies } from "../../src/orchestrator/discord/replies";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import type { EngineDeps } from "../../src/orchestrator/engine/deps";
import { createGitHub } from "../../src/orchestrator/github/app";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { parseConfig, resolveLabelNames } from "../../src/shared/config";
import { createFakeDiscord, type FakeDiscord } from "./discord";
import { type FakeGitHub, startFakeGitHub } from "./github";

/**
 * Real `EngineDeps` over the fakes: fake Discord (with a work channel), the fake GitHub server behind the real client,
 * the fake dispatcher, an in-memory DB and temporary state directories. `stop()` aborts the engine signal and cleans up.
 */
export interface EngineHarness {
	deps: EngineDeps;
	db: Db;
	discord: FakeDiscord;
	gh: FakeGitHub;
	dispatcher: FakeDispatcher;
	/** Aborts `deps.signal` (engine stop). */
	controller: AbortController;
	workChannelId: string;
	stateDir: string;
	stop(): Promise<void>;
}

export const ALLOWED_USER = "u-allowed";

export async function createEngineHarness(opts: { config?: Record<string, unknown>; dispatcher?: FakeDispatcher } = {}): Promise<EngineHarness> {
	const discord = createFakeDiscord({ guildId: "g1" });
	const work = discord.addChannel({ name: "work", guildId: "g1" });
	const config = parseConfig({
		discord: { guildId: "g1", allowedUserIds: [ALLOWED_USER], workChannelId: work.id },
		github: { appId: 1 },
		...opts.config,
	});
	const labels = resolveLabelNames(config);
	const gh = startFakeGitHub();
	const github = await createGitHub({ appId: gh.appId, privateKey: gh.privateKey, baseUrl: gh.url, labels, throttle: false });
	const stateDir = mkdtempSync(join(tmpdir(), "agentbot-engine-"));
	const db = openDb(":memory:");
	const controller = new AbortController();
	const dispatcher = opts.dispatcher ?? createFakeDispatcher();
	const deps: EngineDeps = {
		config,
		labels,
		db,
		github,
		discord,
		dispatcher,
		replies: createThreadReplies(),
		interactions: createInteractionRouter(),
		agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
		sessionDir: join(stateDir, "sessions"),
		signal: controller.signal,
	};
	return {
		deps,
		db,
		discord,
		gh,
		dispatcher,
		controller,
		workChannelId: work.id,
		stateDir,
		async stop() {
			controller.abort();
			await gh.stop();
			db.close();
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}
