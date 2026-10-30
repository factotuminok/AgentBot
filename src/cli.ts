#!/usr/bin/env bun
import { ROLES } from "./shared/env";
import { errorMessage, log, setLogComponent } from "./shared/log";

/** One image, one entry point: a role (architecture A-7, requirements §13) or the `health` probe command (architecture §4.5). */
const COMMANDS = [...ROLES, "health"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
	return COMMANDS.includes(value as Command);
}

async function main(): Promise<void> {
	const arg = process.argv[2] ?? process.env.AGENTBOT_ROLE;
	if (!isCommand(arg)) {
		process.stderr.write(`usage: agentbot <${COMMANDS.join("|")}>\n`);
		process.exit(2);
	}
	setLogComponent(arg);
	switch (arg) {
		case "orchestrator": {
			// Role-selected at runtime: each role loads only its own module graph (the worker must not load discord.js, the web pod has no omp).
			const { runOrchestrator } = await import("./orchestrator/main");
			await runOrchestrator();
			return;
		}
		case "web": {
			const { runWeb } = await import("./web/main");
			await runWeb();
			return;
		}
		case "worker":
		case "launcher":
		case "health":
			log("error", `the ${arg} command is not built yet`, { command: arg });
			process.exit(2);
	}
}

main().catch(err => {
	log("error", "fatal", { error: errorMessage(err) });
	process.exit(1);
});
