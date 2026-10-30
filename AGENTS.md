# AgentBot agent guidance

## Docs
- `wiki/requirements.md` — what the system must do (stable requirement IDs).
- `wiki/architecture.md` — components, run protocol, storage, deployment.
- `wiki/implementation.md` — phased plan; each phase lists the requirement IDs it delivers.
- `wiki/spikes/` — phase 0 spike notes; a spike's outcome overrides the plan where it says so.

## Porting
- DevForge (`../DevForge`, commit `64ba5ca`) is the reference implementation. Port modules as mapped in architecture §3, then change them; don't rewrite what already works.
- Drop DevForge-only features the requirements withdraw (SSH, browser terminal, per-repo settings, legacy plugin).
- Rename: `devforge` → `agentbot`, `DEVFORGE_*` → `AGENTBOT_*`, `/forge` → `/work`.

## Code
- Bun + TypeScript strict. Tabs. One JSON log line per event via `src/shared/log.ts`.
- Layout follows implementation.md §2: `src/shared`, `src/orchestrator/*`, `src/web`, `src/worker`, `src/launcher`.
- Tests live in `test/unit`, `test/integration`, `test/e2e`. Port DevForge tests with their modules; delete tests that pin DevForge wording or single-process wiring.
- `bun run typecheck` and `bun test` must pass before a change is done.
