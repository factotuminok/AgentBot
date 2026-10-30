import { openSessionRuntime, runSession } from "./session";
import { serveAgentHost } from "./serve";

// Entry of an agent process: `runner.ts` spawns `bun host.ts` once per run and talks to it over IPC.
serveAgentHost({ run: runSession, openRuntime: openSessionRuntime });
