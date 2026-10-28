# Architecture

This document describes how AgentBot is built and deployed. It builds on [requirements.md](requirements.md); where the design here changes a requirement, §10 lists the change and requirements.md has been updated.

DevForge runs everything in one container: web UI, Discord bot, GitHub poller, scheduler and one child process per agent run. AgentBot splits that apart:
- the bot keeps running while the web UI restarts;
- **every agent run gets its own short-lived worker** with a private checkout on a temporary branch;
- the worker is deleted when the run ends.

## 1. Decisions

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| A-1 | Separate components: **web**, **orchestrator** (the chatbot), **worker** (one per agent run) and, on Podman, a **launcher** that starts the workers. | Keep one process. | The bot must be independent of the website and the omp processes, and each run must be isolated. |
| A-2 | The orchestrator is a **singleton** and the only owner of the database, the vault, the git mirrors and all GitHub and Discord credentials. | Several replicas with leader election. | Discord allows one gateway session per bot, the poller must run once, and SQLite has one writer. Leader election would add a lot of moving parts for no throughput gain. |
| A-3 | **One worker per agent run, with a private checkout.** The worker makes a shallow checkout of the run's start commit from the orchestrator (read-only, no GitHub credentials), works on a temporary branch, and returns its commits as a git bundle. The orchestrator pushes. Workers share no volume. *(Replaces the earlier shared workspace volume.)* | A shared ReadWriteMany volume with one worktree per run. | Runs cannot see each other's code, sessions or files. No RWX storage is needed. Cost: a checkout and `setupCommand` at the start of every run. |
| A-4 | Kubernetes starts workers with a **KEDA ScaledJob**, 0–10: one Job pod per agent run. | Orchestrator creates Jobs itself; a Deployment with a KEDA ScaledObject. | A Job finishes when its run finishes, so scale-down never kills a busy pod. The orchestrator needs no Kubernetes API permissions. Cost: KEDA must be installed. |
| A-5 | Workers **pull** their run from the orchestrator over a WebSocket. | The orchestrator pushes to worker endpoints. | Workers need no Service or published port, and the same worker code runs under the launcher and under KEDA. |
| A-6 | omp updates stay **in place, for workers only**. After Discord approval the orchestrator installs and packs a newer omp. Each new worker downloads it, falling back to the image's omp if it fails. | Image-only updates. | Users can take a new omp without rebuilding or redeploying. Running runs are not interrupted, and no component restarts. |
| A-7 | **One image** with four roles (`agentbot orchestrator`, `agentbot web`, `agentbot worker`, `agentbot launcher`). The worker image can be overridden with a derived image that adds target-repo toolchains. | Separate images. | One build, one version and shared layers. Toolchains still go only where they are needed. |
| A-8 | **SQLite stays**, for both AgentBot's database and omp's model sign-in store, on a volume that only the orchestrator mounts (RWO). | Postgres; a separate credentials database. | There is a single writer (A-2), and omp already uses SQLite for sign-ins, so no new database is needed. |
| A-9 | **Model sign-ins stay in the orchestrator** (§6.1). Runs get a copy in the run spec, and token refreshes go through the orchestrator. | A shared sign-in store. | Keeps one refresh-token chain per provider. |
| A-10 | On Docker/Podman hosts, a **launcher** starts one worker container per run through a **rootless Podman** API socket. | A rootful Docker socket; long-lived pool workers. | Per-run containers need something that can start containers. A rootless socket limits that power to one unprivileged host user. Cost: per-run workers need Podman, not Docker Engine. |
| A-11 | **VS Code is a configuration editor.** It opens a workspace holding the settings, the omp settings and MCP servers, and the skills and agents, synced with the orchestrator, which validates and applies every save (§2.5). There is no browser terminal, no SSH, and VS Code's built-in terminal is disabled. | VS Code as a workbench over repo clones; the tmux browser terminal; SSH for desktop VS Code. | Workers' checkouts are private (A-3), so there is nothing useful left to browse. Editing configuration as files is easier than forms for skills, agents and large settings. |

## 2. Components

```mermaid
flowchart LR
    subgraph ext[External]
        D[Discord]
        G[GitHub]
        M[Model providers / web search]
        N[npm registry]
    end
    U[Admin browser] -->|HTTPS| W
    subgraph stack[AgentBot]
        W[web<br/>UI, VS Code config editor]
        O[orchestrator<br/>Discord bot, poller, scheduler,<br/>vault, DB, mirrors, git push]
        L[launcher<br/>Podman only]
        K1[worker: run A<br/>private checkout]
        K2[worker: run B<br/>private checkout]
    end
    W -->|admin API + SSE| O
    K1 -->|run WebSocket + git/artifact HTTP| O
    K2 -->|run WebSocket + git/artifact HTTP| O
    L -.->|GET /internal/scale| O
    L -.->|starts one container per run| K1
    KEDA[KEDA, Kubernetes only] -.->|GET /internal/scale| O
    KEDA -.->|creates one Job per run| K2
    O <--> D
    O <--> G
    O --> N
    K1 --> M
    K2 --> M
    SS[(state volume<br/>SQLite, sign-ins, mirrors, sessions,<br/>scratch, skills, omp-runtime, logs)]
    WH[(web home volume<br/>$HOME, config workspace copy,<br/>code-server)]
    O --- SS
    W --- WH
```

| | web | orchestrator | worker | launcher (Podman) |
|---|---|---|---|---|
| Role | UI and configuration editor | The chatbot and the system's brain | Runs exactly one omp session, then exits | Starts and removes worker containers |
| Replicas | 1 (login sessions are in memory) | exactly 1 | 0–10 in Kubernetes; 0–`AGENTBOT_WORKER_CAPACITY` under the launcher | 1 |
| Holds credentials | none (only its internal API token). The config workspace masks every secret. | Discord token, GitHub App key, master key, vault, model sign-ins | its run's provider API keys and sign-in copy, in memory or run-local storage only | the scale token; passes the worker token to workers by secret name |
| Storage | web home volume | state volume | ephemeral only (§5) | none |
| Ports | 8080 UI | 8081 internal API (never exposed) | none | none |

### 2.1 Orchestrator (the chatbot)

The orchestrator owns everything in requirements.md that is not the web UI or the agent session itself:
- the Discord bot: commands, threads, progress messages, questions and answers, steering;
- the GitHub poller, the issue state machine, the scheduler, the CI gate, PRs, labels and comments;
- git: the bare mirrors and fetches, the read-only git endpoint workers clone from (§4.6), importing result bundles, and pushing issue branches to GitHub;
- chats, `/work plan`, `/work issue` drafts, ask-only attachments in and out (scratch files live here and are copied to and from workers);
- the vault, settings, omp settings and MCP config, model-account sign-in and refresh (§6.1), and the skills and agents directory (served to workers);
- the **config workspace API**: it serves the editable files of the VS Code config workspace (§2.5), validates every file the web pod sends back, and applies it;
- tools that need credentials, run on a worker's behalf (relayed `tool_call`, §4.2), such as `create_issue`;
- listing the repositories the GitHub App can access (requirements GH-25) for `/work` autocomplete and the Repositories page, managing watches and creating watch channels (DSC-33 to DSC-38), and listing the guild's channels with the bot's effective permissions for the Settings dropdowns (requirements §9.7). Listing uses only the stored App and bot credentials over REST (no gateway connection) and works while the engine is `unconfigured`;
- reading each repository's `.agentbot.yml` (requirements GH-26) when it dispatches a run;
- usage accounting, agent transcripts, omp session files between runs;
- omp update checks and installs (§8);
- **run dispatch**: it turns jobs and chats into *runs*, hands each run to a fresh worker, relays its events, and enforces leases (§4).

It never runs an omp agent session itself. It still imports omp for settings validation, the settings reference and OAuth sign-in. MCP connection tests run on a worker (`mcp-test`, §4.2).

### 2.2 Web

The web component is a thin front end:
- It serves every page in requirements §9.3 and keeps login sessions and the login throttle in memory.
- It sets the security headers and checks the `Origin` header (WEB-05 to WEB-09).
- It reads and writes all data through the orchestrator's admin API, holding no database or vault of its own. Setup, login and unlock are forwarded to the orchestrator, which owns the vault. The setup token is printed in the **orchestrator's** log.
- It proxies the log stream (SSE) and log-file downloads from the orchestrator.
- It runs the **configuration editor**, code-server, on its own home volume as the `agentbot` user (§2.5). There is no SSH server. code-server's integrated terminal, extension marketplace, tasks and debuggers are disabled (requirements WEB-14, WEB-31).
  - The web pod holds no repo checkouts, no model sign-ins and no omp.

When the orchestrator is unreachable, the web UI MUST still serve: login fails with "orchestrator unavailable", and the home page shows it.

### 2.3 Worker

A worker exists for exactly one run. It:
1. connects to the orchestrator and claims one run (within `AGENTBOT_WORKER_CLAIM_TIMEOUT`, default 15 s; if nothing is left to claim, it exits 0, because another worker won the race);
2. downloads what the run needs: the skills and agents, the omp runtime copy if one applies (§8), the session file to resume, and the ask scratch inputs;
3. makes a shallow checkout of the run's start commit and creates the run's temporary branch (§4.6), then runs the repo's `setupCommand`;
4. spawns the agent host as a **child process** (AGT-01 still holds inside the worker), with a run-private auth store seeded from the run spec (CRED-02);
5. relays the host's IPC to the orchestrator, and uploads checkpoints while it runs (RUN-18);
6. when the host ends, uploads the result (RUN-19), wipes everything (RUN-20), and exits.

It has no GitHub or Discord credentials and never talks to GitHub. Its commits are signed with the bot's name and email (from the run spec) but only ever pushed by the orchestrator.

### 2.4 Launcher (Docker/Podman only)

- **LCH-01** The launcher MUST start worker containers through a **rootless** Podman API socket mounted into it. At start it MUST check that the engine is rootless and refuse to run otherwise. `AGENTBOT_LAUNCHER_ALLOW_ROOTFUL=1` overrides this and logs a warning at every start, because a rootful socket gives the launcher root on the host.
- **LCH-02** Every 2 s it MUST read `pendingRuns` from `/internal/scale` (scale token). It then starts that many worker containers, never more than `AGENTBOT_WORKER_CAPACITY` (default 4) at once. Each worker container MUST be started:
  - from the worker image, with `--rm`, on the stack's internal network, with no published ports;
  - with the label `agentbot.role=worker`;
  - with a memory limit (`AGENTBOT_WORKER_MEMORY`, default 4 GiB);
  - with the worker token as a Podman secret, a tmpfs for run-local storage, and a size-limited scratch area for the checkout (STO-06);
  - with the command `agentbot worker`.
- **LCH-03** At start, and every minute after that, it MUST remove exited worker containers it started. It MUST NOT touch any container without its label.
- **LCH-04** It MUST hold no secret other than the scale token. It reports its health with `agentbot health` (§4.5).

### 2.5 Configuration editor (VS Code)

The web pod keeps a **config workspace** at `~/config-workspace` on its home volume:

```
config-workspace/
  README.md                 how editing works
  settings.json             Settings (requirements §13), secrets masked
  omp.json                  omp setting overrides and MCP servers, secret values masked
  skills/<name>/SKILL.md    plus any supporting files
  agents/<name>.md
  .vscode/settings.json     JSON schema mapping for settings.json and omp.json
```

The orchestrator is the source of truth; the workspace is a synced copy.
- **Saving pushes.** A watcher in the web process, not in code-server, sends saved files to the orchestrator.
- **The orchestrator validates.** It checks every file with the same rules as the web pages, and applies it only if it is valid (requirements WEB-25 to WEB-31).
- **Remote changes pull.** Changes made on the web pages, or by another editor, are pulled back into the workspace.

## 3. Code layout (from DevForge)

| DevForge module | AgentBot component |
|---|---|
| `src/discord/*`, `src/engine/*`, `src/github/*`, `src/git/*`, `src/state.ts`, `src/db.ts`, `src/vault.ts`, `src/config.ts`, `src/configview.ts`, `src/sessions.ts`, `src/stats.ts`, `src/usage.ts`, `src/agentlog.ts`, `src/accounts.ts`, `src/ompUpdate.ts`, `src/ompconfig.ts`, `src/agent/ompAssets.ts` | orchestrator. `src/git/workspace.ts` keeps the mirrors and pushes, and gains the git endpoint and bundle import. `src/sshkeys.ts` is dropped. |
| `src/agent/runner.ts` | orchestrator: becomes the **dispatcher**. It keeps the `runAgent` API seen by the engine, but hands the run to a worker instead of spawning a process. |
| `src/agent/host.ts`, `serve.ts`, `session.ts`, `tools.ts`, `todos.ts`, `oom.ts`, `reap.ts`, `loadout.ts`, `scratchTools.ts` | worker. `legacyPlugin.ts` is dropped. |
| `src/agent/protocol.ts` | shared: the IPC message types, relayed unchanged (§4.2) |
| `src/agent/discord-ui.ts`, `src/discord/replies.ts` | orchestrator: questions are rendered there; the worker relays the UI requests |
| `src/web/*` | web, with data access replaced by an API client |
| `src/main.ts`, `src/controller.ts` | split into one entry point per role |

## 4. Runs, dispatch and scaling

### 4.1 Run lifecycle

A *run* is one agent session: a job (plan, implement, revise, fix_ci), a chat or ask turn, a `/work plan` planning turn, or a `/work issue` draft. Each run gets its own worker. Runs are stored in a new `runs` table:

```mermaid
stateDiagram-v2
    [*] --> pending: dispatcher.runAgent()
    pending --> assigned: new worker claims (lease issued)
    assigned --> running: worker relays registered
    running --> finishing: done / failed / aborted
    finishing --> finished: result imported, worker cleaned up
    assigned --> pending: lease expired before start
    running --> lost: lease expired
    lost --> pending: job, first loss (resume from checkpoint)
    lost --> finished: chat/plan/draft, or second loss
    pending --> finished: cancelled before claim
    finished --> [*]
```

- **RUN-01** A run becomes `pending` only when its caps allow it: `maxConcurrentJobs` for jobs, `maxChatSessions` for chats, plans and `/work issue` drafts, and `workers.maxConcurrentRuns` for everything. So `pending` is real demand. `mcp-test` tasks count only toward `workers.maxConcurrentRuns`.
- **RUN-02** A worker claims the oldest pending run. A claim is atomic and returns a **lease** (run id plus a random lease token). The lease token also authorises the run's git and artifact requests (§4.5). The worker MUST heartbeat every 10 s. A lease expires after 45 s without a heartbeat.
- **RUN-03** While a run is `pending` or `assigned`, its Discord progress line MUST read "Waiting for a worker…". This wait, including the checkout and `setupCommand`, MUST NOT count toward the run's time limit.
- **RUN-04** When a worker is lost (lease expired while running):
  - An issue job MUST be requeued once with `resume: true`. The new worker resumes from the last checkpoint: the session file plus the uncommitted work (RUN-18).
  - A second loss, or the loss of a chat, plan or draft run, MUST fail the run with "the worker running this was lost (pod evicted or crashed)" and offer the usual Retry or "send another message".
- **RUN-05** Abort, steering and answers MUST be delivered through the run's worker connection. An abort with no connected worker MUST finish a `pending` run immediately. For an `assigned` or `running` run, the abort MUST be delivered when the worker reconnects, or the run is finished when its lease expires.

### 4.2 Run protocol

Each worker opens one WebSocket, `ws://orchestrator:8081/internal/worker`, authenticated with the worker token (§6). It carries JSON messages of two kinds:
- **control** messages between the worker and the orchestrator;
- **relay** messages, which carry the agent host's IPC messages (DevForge's `protocol.ts`) unchanged, each wrapped with its run id and a sequence number per run and direction.

Bulk data (the clone, bundles, session files, scratch files, the omp runtime and skills) goes over plain HTTP endpoints authorised by the lease token (§4.5), not over the WebSocket.

**Control messages**

| Direction | Message | Content |
|---|---|---|
| worker → orch | `hello` | worker id (pod or container name), app identity (§7.1), image omp version, lease held (after a reconnect) |
| worker → orch | `claim` | asks for one run |
| orch → worker | `assign` | run id, lease token, kind (`run` or `mcp-test`), **run spec** or MCP server config |
| worker → orch | `heartbeat` | lease token |
| worker → orch | `run-info` | omp version used for the run; sent when the host starts and again after a UPD-08 fallback |
| worker → orch | `setup-output` | exit code and output tail of `setupCommand` (WS-05) |
| worker → orch | `checkpoint` | a checkpoint was uploaded (RUN-18) |
| worker → orch | `gone` | the host exited without `done` or `failed`: exit code, signal, OOM count (AGT-05) |
| worker → orch | `credential-request` | provider whose sign-in needs a refresh (CRED-03) |
| orch → worker | `credential-response` | the refreshed credential, or the refusal |
| orch → worker | `scratch-input` | a new ask attachment to download before the next steer (CHAT-08) |
| both | `ack` | per run and direction, the highest relay sequence number received and stored |

**Relay messages, agent host → orchestrator**, and what the orchestrator does with each:

| Message | Orchestrator |
|---|---|
| `progress` (tool, intent, usage, elapsed; at each turn end) | Edits the live status message: state, elapsed, cost, `↳ tool intent` (DSC-10, DSC-11). Stores the snapshot (RUN-14). |
| `todos` | Posts the to-do list the first time, then edits it (DSC-12). Stores the latest list (RUN-14). |
| `ui`, `ui_cancel` | Posts the question, or marks it cancelled. Stored with its message ids (RUN-08). |
| `session_file` | Records that the run's session exists (JOB-10), then sends the `reply` the host waits for. The file itself arrives by upload (RUN-18). |
| `registered` | Run becomes `running`. Steering and abort are delivered from now on (RUN-15). |
| `tool_call` | Runs the tool (`create_issue`, AGT-10) and sends the result as `reply`. |
| `reply` | Answer to a relayed `steer` or `abort` (RUN-15). |
| `transcript`, `usage`, `loadout`, `log` | Agent log, usage accounting, status page, orchestrator log. Nothing goes to Discord. |
| `done`, `failed` | Sent by the worker only after the result is uploaded (RUN-19). The orchestrator finishes the status message (✅ or ❌), settles the to-do list (DSC-13), updates the top icon, then continues the job (push, CI gate, PR) or posts the answer or plan. |

**Relay messages, orchestrator → agent host:** `steer`, `abort`, and `reply` (to `ui`, `tool_call` and `session_file`). The worker builds the host's `start` message from the run spec itself, so `start` is not relayed.

An `mcp-test` connects to one MCP server with the worker's omp, lists its tools and returns the result within 20 s (AGT-21). It starts no agent session and no checkout.

The **run spec** contains everything the worker needs:
- profile, prompt, output schema;
- time and cost limits, model, thinking level;
- the checkout, absent for `/ask` runs and `mcp-test`: repo, start ref and its commit sha, temporary branch name, whether the run writes code, and whether a kept result or checkpoint exists to restore (§4.6);
- the bot's git name and email, for local commits only;
- whether a session file exists to resume;
- omp setting overrides, MCP servers (implement profile only), and the content hash of the skills and agents bundle;
- provider API keys and a snapshot of the model sign-ins (CRED-02);
- the repo's `setupCommand`;
- for ask runs, the list of scratch inputs.

The spec is sent only over the connection, never written to disk.

```mermaid
sequenceDiagram
    participant O as orchestrator
    participant S as KEDA or launcher
    participant W as worker (new, for this run)
    participant H as agent host (child)
    O->>O: job claimed → run pending (mirror fetched, start sha fixed)
    S->>O: GET /internal/scale → pendingRuns=1
    S->>W: start one worker
    W->>O: hello, claim
    O->>W: assign(run, lease, spec)
    W->>O: GET git clone, skills, session (lease token)
    W->>W: temp branch agentbot/run-<id>, setupCommand
    W->>H: spawn, start(spec)
    H-->>W: session_file, registered, progress, todos, ui…
    W-->>O: relay(seq…) + heartbeats, checkpoint uploads
    O->>O: Discord status message, to-do list, question in thread
    O->>W: relay(reply to ui) / relay(steer)
    W->>H: forward
    H-->>W: done
    W->>O: PUT result bundle, final session, outputs
    W-->>O: relay(done)
    O->>W: ack
    W->>W: wipe checkout and run-local store, exit 0
    O->>O: import bundle, push issue branch, CI gate, PR
```

### 4.3 Reconnects and orchestrator restarts

- **RUN-06** A worker MUST keep its run going when the connection drops. It reconnects with backoff (1 s to 15 s) and re-announces its lease in `hello`. Relay messages MUST be sequenced and acknowledged in **both** directions; each side resends what the other has not acknowledged, and the receiver drops duplicates by sequence number. Buffering:
  - The worker buffers up to 10 000 messages or 16 MiB. When the buffer is full, it drops the oldest `progress`, `transcript` and `log` messages first, and keeps only the newest `todos`. It never drops any other message.
  - The orchestrator stores its outgoing relay messages in the database until they are acknowledged, so a steer or answer survives an orchestrator restart.
  - Uploads that fail while the orchestrator is away MUST be retried after the reconnect.
- **RUN-07** After a restart, the orchestrator MUST NOT requeue `assigned` or `running` runs straight away. It MUST wait `workers.reattachGraceSeconds` (default 90) for their workers to re-announce, then treat the missing ones as lost (RUN-04). This replaces DevForge's "abort everything on shutdown and requeue" (JOB-08).
- **RUN-08** Open questions MUST be stored with their Discord message ids, so that a re-attached run's pending `ui` request is bound to the question already posted instead of posting it again.
- **RUN-09** Orchestrator shutdown (SIGTERM) MUST stop Discord, the poller and dispatch, flush the database and exit. It MUST NOT abort runs on workers.
- **RUN-14** For every run, the orchestrator MUST store with the run:
  - the Discord ids of its thread, live status message and to-do message;
  - the latest progress snapshot (state, activity, elapsed, cost);
  - the latest to-do list.

  After an orchestrator restart it MUST keep editing those same messages, re-rendered from the stored snapshot and from any replayed messages. It MUST NOT post new ones. If a message was deleted in Discord, it posts a new one and stores the new id.
- **RUN-15** A steer, an answer or an abort counts as delivered only when the run confirms it:
  - **Steering** gets 👀 when the host's `reply` for that steer comes back ok.
  - **An answer** gets ✅ when the worker acknowledges the relayed `reply`.
  - **While undeliverable** (worker disconnected, or host not yet `registered`), the orchestrator MUST react ⏳ and keep the message queued (RUN-06). It replaces ⏳ with 👀 or ✅ on delivery.
  - **A steer refused** with "Agent session is not ready" MUST be resent after `registered`.
  - **If the run ends first**, the orchestrator MUST reply "Not delivered: the run ended before it could read this."
- **RUN-16** Workers MUST apply the OBS-03 field limits to `transcript` messages, and cut `log` lines at 8 KiB, before sending them. The orchestrator MUST reject any WebSocket message larger than 4 MiB and log the run and message type.

### 4.4 Scaling

Every run starts a new worker, in both runtimes, and every worker ends with its run.

**Docker / Podman.** The launcher (§2.4) starts one container per pending run, up to `AGENTBOT_WORKER_CAPACITY` (default 4: 2 jobs + 2 chats at the default limits). With nothing pending, no worker runs.

**Kubernetes.** A KEDA `ScaledJob`:

| Field | Value | Reason |
|---|---|---|
| trigger | `metrics-api` on `http://orchestrator:8081/internal/scale`, `valueLocation: pendingRuns`, `targetValue: "1"`, bearer token via `TriggerAuthentication` | one pod per pending run |
| `minReplicaCount` / `maxReplicaCount` | 0 / 10 (Helm `worker.maxReplicas`) | the requested range |
| `scalingStrategy.strategy` | `accurate` | `pendingRuns` excludes runs already claimed, which is the queue model `accurate` expects |
| `pollingInterval` | 5 s | short cold-start delay |
| Job `backoffLimit` | 0 | the orchestrator owns retries (RUN-04) |
| Job `restartPolicy` | `Never` | same reason |
| Job `ttlSecondsAfterFinished` | 60 | the pod and its `emptyDir` volumes are deleted a minute after the run (RUN-20) |
| Job `activeDeadlineSeconds` | unset | runs may wait up to `askTimeoutHours` for an answer |
| Pod `terminationGracePeriodSeconds` | 60 | time for a final checkpoint on eviction (RUN-18) |

KEDA can start one extra pod for a run claimed between two polls; that pod finds nothing to claim and exits after the claim timeout.

- **RUN-10** The orchestrator MUST know the worker capacity from `AGENTBOT_WORKER_CAPACITY`. Helm sets it to `worker.maxReplicas`, and compose sets it to the launcher's limit. The orchestrator MUST report the limits, capacity and warnings in its health responses (§4.5) and on the status page, together with pending runs and their age. A mismatch never blocks a settings save.
- **RUN-11** The concurrency actually reached is `min(maxConcurrentJobs + maxChatSessions, workers.maxConcurrentRuns, worker capacity)`. To use 10 workers, raise `maxConcurrentJobs` and `maxChatSessions`; the health warning says so while their sum is below the capacity.

A run waiting on a human answer keeps its worker for up to `askTimeoutHours`. Releasing the worker while waiting is a possible later improvement (§11).

### 4.5 Endpoints and health

| Endpoint | Component | Auth | Purpose |
|---|---|---|---|
| `GET /livez` | orchestrator | none | Liveness: 200 while the process responds. The body is the same as `/readyz`. |
| `GET /readyz` (alias `/healthz`) | orchestrator | none | Readiness: 200 whenever the database is open and the internal API can serve, **in every engine phase**, so that the web UI can always reach the admin API, even in `unconfigured` or `error`. 503 only when the database cannot be opened or the state volume is not writable. |
| `/internal/admin/*` | orchestrator | web token | Every web UI read and write, the log stream and log-file downloads, repo and channel listing, sign-in, and the config workspace: files, revisions, change notifications, JSON schemas and validation results (§2.5). |
| `/internal/worker` | orchestrator | worker token | Run protocol WebSocket (§4.2). |
| `/internal/git/<owner>/<repo>.git` | orchestrator | lease token | Read-only git smart HTTP (`git-upload-pack` only) from the mirror, for the run's repo only (RUN-17). |
| `/internal/runs/<id>/…` | orchestrator | that run's lease token | Run artifacts: `GET` session, checkpoint bundle, scratch inputs, skills bundle and omp runtime; `PUT` checkpoint, result bundle, session and scratch outputs (RUN-18, RUN-19). |
| `GET /internal/scale` | orchestrator | scale token | `{pendingRuns}` for KEDA and the launcher. |
| `GET /healthz` | web | none | 200 while the web UI serves, whatever the orchestrator's state (requirements §9.3). Relays the orchestrator's `phase` and `limits`. |
| `agentbot health` (command) | worker, launcher | — | Worker: prints `{status, version, phase, runId, connected}`, where phase is `claiming`, `checkout`, `running`, `uploading` or `cleanup`. Launcher: prints `{status, version, rootless, workers, capacity}`. Exits 0 while the process is alive. Used by the container `HEALTHCHECK` (output kept in `podman inspect`) and as the Kubernetes exec liveness probe. |

The orchestrator's health body reports its limits:

```json
{
  "status": "ok",
  "version": "0.4.12",
  "phase": "running",
  "runs": { "pending": 1, "running": 3 },
  "limits": {
    "maxConcurrentJobs": 2,
    "maxChatSessions": 2,
    "maxConcurrentRuns": 10,
    "workerCapacity": 10,
    "effectiveConcurrency": 4
  },
  "warnings": [
    "maxConcurrentJobs + maxChatSessions (4) is below worker capacity (10): at most 4 workers will be used"
  ]
}
```

- **RUN-12** `limits` MUST be `null` while the settings are locked or not yet saved. Warnings MUST be raised when the sum of `maxConcurrentJobs` and `maxChatSessions` is below the worker capacity, and when `workers.maxConcurrentRuns` exceeds the worker capacity (runs may wait with no worker coming). The status code MUST NOT depend on limits or warnings.
- **RUN-13** Health bodies are unauthenticated, so they MUST contain only the version, phase, counts, limits and fixed warning texts. They MUST NOT contain names, ids, error messages or any other data.

### 4.6 Checkouts, temporary branches and cleanup

```mermaid
flowchart LR
    GH[(GitHub<br/>agentbot/issue-n-slug)] -->|fetch| MR[(orchestrator mirror)]
    MR -->|shallow fetch of the start commit| WC[worker checkout<br/>branch agentbot/run-id]
    WC -->|checkpoint bundle every 5 min| CP[(refs/agentbot/checkpoints/id)]
    WC -->|result bundle| RR[(refs/agentbot/runs/id)]
    RR -->|fast-forward push| GH
```

- **RUN-17** **Checkout.** Before claiming, the orchestrator fetches the mirror (creating it on first use), reads `.agentbot.yml` (requirements GH-26), and fixes the run's start ref and commit:
  - the base branch for plan, chat, draft and fresh implement runs;
  - the issue branch head for revise and fix_ci runs;
  - for a run that continues an earlier one (requeued after a lost worker, or retried after a failure), the **earlier run's start commit**, so that its kept checkpoint applies. This holds even when the issue branch does not exist yet or has moved. The exception is a Retry after a rejected push (RUN-19): that run starts from the issue branch's new head, and the session tells the agent what it did before.

  The worker MUST then make a **shallow** checkout from `/internal/git/…`:
  1. initialise an empty repository;
  2. fetch only the start commit at depth 1 (the endpoint sets `uploadpack.allowReachableSHA1InWant`);
  3. check it out;
  4. create the temporary branch `agentbot/run-<runId>` on it.

  - The lease token reaches git only through a per-command `http.extraHeader` environment variable (as WS-02).
  - The endpoint MUST serve only that repo, only `git-upload-pack`, and MUST hide `refs/agentbot/*`.
  - If the run continues an earlier one, the worker fetches that run's kept checkpoint through the run artifact endpoint and restores it:
    1. check out the checkpoint commit on the temporary branch;
    2. reset to its parent with a mixed reset, which keeps the run's commits and turns the checkpoint's working tree back into uncommitted changes.

  The agent has no history: `git log`, `git blame` and diffs against older commits show only the start commit, and the prompts MUST say so. Bundles and pushes are unaffected, because the run's commits sit on top of the start commit.
- **RUN-18** **Checkpoints.** For runs that write code (implement, revise, fix_ci), the worker MUST upload a checkpoint:
  - when the host first reports `session_file` (the session file only);
  - every 5 minutes;
  - when it receives SIGTERM (eviction, shutdown);
  - before the result.

  A checkpoint is a bundle with one commit on top of the temporary branch that holds the whole working tree: tracked files plus untracked files that are not ignored. The session file is uploaded with it. The orchestrator keeps only the latest checkpoint per run, as `refs/agentbot/checkpoints/<runId>` in the mirror. Read-only runs upload only the session file at the same times.
- **RUN-19** **Result.** When the host ends, the worker MUST do the following before it relays `done` or `failed`:
  1. For runs that write code: commit any leftover changes on the temporary branch, as `AgentBot: remaining changes for #N` for implement and as `AgentBot: follow-up changes for #N` for revise and fix_ci (requirements JOB-19, JOB-22). Then upload a bundle of the temporary branch relative to the start commit.
  2. Upload the final session file.
  3. For ask runs, upload new or changed files from `outputs/`.

  The orchestrator MUST then:
  1. check that the bundle's only prerequisite is the run's start commit;
  2. fetch the bundle into `refs/agentbot/runs/<runId>`;
  3. push it to the issue branch on GitHub as a **fast-forward only**.

  If the issue branch moved on GitHub during the run, the push is rejected and the job MUST fail with "The branch changed on GitHub during this run; press Retry to start again from the new head." For read-only runs, any commits are discarded and nothing is pushed.
- **RUN-20** **Cleanup.** Whatever the outcome, once the orchestrator acknowledges `done` or `failed`, the worker MUST:
  1. delete its checkout, temporary branch, run-local auth store, session copy, skills copy and scratch copy;
  2. exit 0.

  The container (`--rm`, launcher) or Job pod (`ttlSecondsAfterFinished`) is then deleted. In the mirror:
  - **Successful run, or a run whose push was rejected:** the orchestrator MUST delete `refs/agentbot/runs/<runId>` after the push or discard, and `refs/agentbot/checkpoints/<runId>` when the run finishes.
  - **Failed job run** (a time or cost limit, or an error): it keeps both refs, unpushed, until a Retry's run finishes or the issue ends (requirements JOB-19, WS-08).
  - **Run requeued after a worker loss:** it keeps its checkpoint until the resumed run finishes.

  Session files stay in the orchestrator until their issue, plan or draft ends (requirements ENG-05). At start, the orchestrator MUST delete the `refs/agentbot/*` refs of runs that are finished and not kept for Retry.
- **RUN-21** **One run per issue.** At most one run per issue or chat thread MUST be pending or active at a time (the scheduler already guarantees this per issue), so two runs never race to move the same issue branch.

## 5. Storage

| Volume | Mounted by | Docker/Podman | Kubernetes | Contents |
|---|---|---|---|---|
| state | orchestrator | `agentbot-state` | PVC, RWO | `agentbot.db` (SQLite, WAL); `omp-agent/` (omp sign-in store `agent.db`, model cache); `repos/` (bare mirrors, temp refs); `sessions/`; `scratch/` (ask inputs and outputs); `omp/` (skills and agents); `omp-runtime/` (packed omp copies); `logs/agent/`, `logs/orchestrator/` |
| web home | web | `agentbot-web` | PVC, RWO | the `agentbot` user's `$HOME`: the config workspace copy and its last-synced revisions, queued saves (requirements WEB-27), code-server settings and extensions |
| worker checkout | one worker | container scratch, size-limited | `emptyDir`, `sizeLimit` (default 20 Gi) | the run's clone, session copy, skills copy, scratch copy |
| run-local | one worker | tmpfs | `emptyDir`, `medium: Memory` | run-private auth store |

- **STO-01** SQLite databases (`agentbot.db` and omp's `agent.db`) MUST live only on the state volume. No other component may open them.
- **STO-02** Every container MUST run as uid/gid 10001. In Kubernetes, `fsGroup: 10001` and `runAsNonRoot: true` MUST be set, so nothing has to re-own files at start.
- **STO-03** Mirrors MUST be read and written only by the orchestrator, under its per-repo lock. Workers and web reach them only through the read-only git endpoint.
- **STO-04** At most one run MUST use a given issue branch or chat thread at a time (RUN-21).
- **STO-05** Withdrawn: there is no shared volume.
- **STO-06** A worker's checkout space MUST be limited (default 20 GiB). A run that exceeds it fails with "the run ran out of disk space", which is reported like an OOM: the agent is told, and the run is flagged.

## 6. Security

| Secret | Lives in | Seen by |
|---|---|---|
| Discord bot token, GitHub App key, provider API keys | vault (state volume) | orchestrator. Provider keys are also sent per run to that run's worker, in memory. |
| Master key | Podman secret / Kubernetes Secret, file mount | orchestrator only |
| `web-api-token` | secret | web, orchestrator |
| `worker-token` | secret | workers, orchestrator |
| `scale-token` | secret | launcher, KEDA `TriggerAuthentication`, orchestrator |
| Lease token | issued per run at claim | that run's worker; valid only for that run's git and artifact endpoints, until the run finishes |
| Model sign-ins (OAuth) | `<state>/omp-agent/agent.db` | orchestrator. A per-run copy goes to the worker (CRED-02). |

- **SEC-14** Each token MUST be accepted only on its own API surface:
  - the web token on `/internal/admin/*`;
  - the worker token on `/internal/worker`;
  - the scale token on `/internal/scale`;
  - a lease token only on its own run's `/internal/runs/<id>/*` and its repo's `/internal/git/*`.

  Tokens MUST be compared in constant time.
- **SEC-15** The orchestrator's port 8081 MUST NOT be published outside the stack: no host port in compose, and a ClusterIP Service in Kubernetes. Kubernetes NetworkPolicies MUST restrict **ingress**:
  - to orchestrator:8081, only from web and worker pods and KEDA;
  - to web:8080, only from the ingress controller;
  - to workers, nothing;
  - worker → web is denied.

  Egress stays open for the orchestrator and workers: the orchestrator needs Discord, GitHub, npm and the model providers' sign-in endpoints; workers need model providers, web search and package registries. Web needs no egress beyond the orchestrator; the VS Code extension is bundled and the marketplace is off. On Podman the same applies: only the web service publishes ports.
- **SEC-16** The master key needs no root-entrypoint stdin trick (DevForge's approach), because no agent ever runs in the orchestrator's container. It is mounted as a file readable only by uid 10001 in the orchestrator.

**Isolation and accepted risks.**
- **What a run can't reach:** an agent's shell sees only its own worker. It cannot read other runs' code, sessions, scratch files or sign-in copies.
- **What a run can reach:** its worker's token, its own lease token and sign-in copy, and the internet.
- **The remaining risk:** with the worker token, an agent could open a second worker connection and claim a pending run, which would reveal that run's prompt, provider keys and sign-in copy. Mitigations:
  - the worker token grants only the run protocol;
  - a lease token works only for its own run;
  - a worker that has claimed a run MUST NOT be able to claim a second one on any connection made from it (one claim per worker id);
  - the status page lists every connected worker (id, pod or container, address), so an unknown one stands out.

  Running the agent host as a different user from the worker supervisor, in a second container, would close this gap (§11).

### 6.1 Model sign-ins

- **CRED-01** Model sign-ins MUST be stored only in the orchestrator, in omp's own SQLite store at `<state>/omp-agent/agent.db` on the state volume. Workers and web MUST NOT mount it.
- **CRED-02** Before dispatching a run, the orchestrator MUST refresh any sign-in that expires within 10 minutes. It then puts a snapshot of all sign-ins into the run spec. The worker MUST write the snapshot to a run-private auth store on run-local storage (§5), mode 0700, and delete it when the run ends.
- **CRED-03** Workers MUST NOT refresh tokens with the provider themselves. When a token needs a refresh, the worker sends `credential-request`. The orchestrator refreshes once per provider at a time, stores the result and answers every waiting request with it. This keeps one refresh-token chain: for providers that rotate refresh tokens, a refresh in one run would otherwise invalidate the orchestrator's copy and every other run's. This relies on omp letting AgentBot replace its auth store's refresh step; verify that against the omp SDK before building it.
- **CRED-04** Withdrawn: there is no browser terminal.
- **CRED-05** Signing out in `/admin/models` MUST remove the sign-in from the orchestrator at once. Runs that already hold a copy keep it until they end, but their refresh requests for that provider MUST be refused.

## 7. Deployment

### 7.1 Image

There is one image, `ghcr.io/<owner>/agentbot:<version>`, and the role is its command argument. It contains Bun, the app, git, omp (npm's latest at build time with the pin as fallback, UPD-01), code-server with the bundled AgentBot extension (requirements WEB-28) and procps. `worker.image` (Helm) or `AGENTBOT_WORKER_IMAGE` (launcher) MAY point to a derived image with target-repo toolchains, built `FROM` the same version.

The image carries an **app identity**: a file `/app/IDENTITY` holding the AgentBot version and a hash of the app sources and lockfile. A derived image inherits it unchanged. The omp-runtime checks in §8 compare app identities, not container image ids or digests, so derived worker images receive in-place omp updates.

| Role | Entrypoint duties |
|---|---|
| orchestrator | Open the state volume. Run `agentbot orchestrator`. |
| web | `agentbot web`, which starts code-server on first use with `SHELL=/usr/sbin/nologin`, the marketplace off and only the allowed extensions enabled (requirements WEB-14, WEB-31). The `agentbot` user's login shell in the image is `/usr/sbin/nologin`. |
| worker | `agentbot worker`: one run, then exit. |
| launcher | `agentbot launcher` (Podman only). |

No entrypoint runs as root.

### 7.2 Podman (compose)

`compose.yaml` defines three long-running services, `orchestrator`, `web` and `launcher`, on one internal network, run with `podman compose` under **rootless Podman ≥ 4.6**. The launcher starts the worker containers. Docker Engine can run the three services but cannot run workers: the launcher refuses a rootful socket (LCH-01).
- **Podman socket.** The host user enables it once with `systemctl --user enable --now podman.socket`. Compose mounts `$XDG_RUNTIME_DIR/podman/podman.sock` into the launcher only.
- **Restarts.** `restart: unless-stopped` on all three.
- **Health checks.**
  - orchestrator: `GET :8081/healthz` (= `/readyz`, §4.5);
  - web: `GET :8080/healthz`;
  - launcher: `agentbot health`.
- **Ports.** Only web publishes a port: `127.0.0.1:8080` (UI).
- **Secrets.** Podman secrets created once by `scripts/init-secrets.sh`: `agentbot_master_key`, `agentbot_web_api_token`, `agentbot_worker_token`, `agentbot_scale_token`. Compose mounts each only into the services that need it. The launcher passes `agentbot_worker_token` to workers by name.
- **Capacity.** `AGENTBOT_WORKER_CAPACITY` (default 4) is set on both the launcher and the orchestrator.
- **Start order.** `depends_on: orchestrator` with `condition: service_started`. The web UI and launcher retry their connection, so the order is a convenience.
- **Upgrade.** `podman compose pull && podman compose up -d`. Workers already running keep their image and finish their run; new workers use the new image. Runs continue across an orchestrator restart (RUN-06, RUN-07).

### 7.3 Kubernetes

A Helm chart, `deploy/helm/agentbot`:

| Object | Notes |
|---|---|
| Deployment `orchestrator` | `replicas: 1`, `strategy: Recreate` (never two gateways or two SQLite writers). Readiness `/readyz` and liveness `/livez` (§4.5): both succeed in every engine phase, so the web UI can reach the admin API while the engine is `unconfigured` or in `error`, and a configuration error does not crash-loop. Env `AGENTBOT_WORKER_CAPACITY` = `worker.maxReplicas`. |
| Service `orchestrator` | ClusterIP, port 8081 |
| Deployment `web` | `replicas: 1`. Readiness and liveness on `/healthz`, which never fails because of the orchestrator. |
| Service `web` (+ optional Ingress) | port 8080. The Ingress terminates TLS so the session cookie is `Secure` (WEB-05). |
| ScaledJob `worker` + TriggerAuthentication | §4.4. Exec liveness probe `agentbot health`. `emptyDir` for the checkout (`sizeLimit`) and a memory-backed `emptyDir` for run-local storage. |
| PVCs | `state` (RWO), `web-home` (RWO). No RWX storage. |
| Secrets | master key and the three tokens, generated by the chart on first install and kept on upgrade (`lookup`). Can be supplied instead (`existingSecret`). |
| NetworkPolicies | SEC-15 |

Default resources (values):

| Component | Requests | Limits |
|---|---|---|
| orchestrator | 250m CPU, 512 Mi | 1 Gi |
| web | 100m CPU, 768 Mi (code-server) | 2 Gi |
| worker | 500m CPU, 1.5 Gi, 20 Gi ephemeral storage | 4 Gi |

Requirements: Kubernetes ≥ 1.27 and KEDA ≥ 2.12.

## 8. omp updates (in place, workers only)

- **UPD-06** The orchestrator checks npm (UPD-02) and posts the Discord notice. On approval, it MUST:
  1. install the new omp into `<state>/omp-runtime/<version>-<time>/` (`bun install --omit=dev`, pinned packages);
  2. smoke-load the **worker** entry modules (`agent/host.ts`, `agent/session.ts`);
  3. check the installed version;
  4. pack the copy as one compressed archive and record its app identity and hash;
  5. mark it active.

  No component restarts. Failures are reported as in UPD-03.
- **UPD-07** At start, a worker MUST download and unpack the active copy when its recorded app identity (§7.1) equals the worker's own and the copy is not marked failed. Otherwise it uses the image's omp. The version actually used MUST be sent in `run-info` (again after a UPD-08 fallback) and recorded on the run.
- **UPD-08** The first run on a new copy is the canary. If the host from the copy exits before it relays `registered`, the worker MUST:
  1. report it, so the orchestrator marks the copy failed and posts the failure with a fresh Approve button;
  2. start the same run again with the image's omp.

  Only one fallback per run is allowed.
- **UPD-09** At start, the orchestrator MUST mark for deletion copies whose app identity differs from its own (a new image was deployed), and every copy except the active one. It MUST delete a marked copy only once no `assigned` run is still downloading it.
- **UPD-10** The orchestrator keeps the image's omp. It uses it for settings validation, the settings reference and sign-in. MCP tests run on workers. The web pod has no omp. The omp page MUST show both versions when they differ.

## 9. Failure behaviour

| Failure | Effect |
|---|---|
| Orchestrator restart or crash | Discord and polling pause. Runs keep going on their workers and re-attach within 90 s (RUN-06, RUN-07). Uploads are retried. The web UI shows "orchestrator unavailable". |
| Web restart | Admins are logged out (in-memory sessions). Open VS Code sessions end. Saves already sent are in the orchestrator; queued saves are on the web home volume and are sent after the restart. The workspace is re-synced on start. No effect on Discord or runs. |
| Orchestrator unreachable while editing | Saves are queued on the web home volume and the VS Code status bar shows "orchestrator unavailable". They are sent, and validated, once it is back (WEB-27). |
| Worker container or pod lost | Lease expiry after 45 s, then RUN-04: the job resumes on a new worker from its last checkpoint. |
| KEDA or the launcher missing or not starting workers | Runs stay pending. Discord shows "Waiting for a worker…" and the status page shows pending runs and their age. |
| Launcher pointed at a rootful socket | The launcher refuses to start (LCH-01). Runs stay pending. |
| Issue branch moved on GitHub during a run | The fast-forward push is rejected and the job fails with a Retry button (RUN-19). |
| OOM or full disk in a worker | AGT-17 to AGT-19 and STO-06. Each worker has its own limits, so it is reported for that run only. |

## 10. Changes to requirements

requirements.md has been updated for these:

| ID | Change |
|---|---|
| AGT-01, AGT-02, AGT-03, AGT-06 | The per-run child process runs inside a per-run worker. Credentials reach it only through the run spec. Reaping happens in the worker. |
| AGT-09, AGT-10, AGT-21 | Rationale names the worker token. `create_issue` runs in the orchestrator via the relayed `tool_call`. MCP tests run on a worker. |
| AGT-24, AGT-25 | Skills and agents live in the orchestrator and are copied to each worker; skills with extra files are uploaded as a zip. |
| WS-01, WS-03 to WS-05, WS-07, WS-08 | Mirrors on the state volume, created on first use and pruned when unused; private shallow checkouts on a temporary branch per run (RUN-17 to RUN-20); `setupCommand` from the repository's `.agentbot.yml` at the start of every run. |
| GH-03, GH-06, GH-10, GH-25 to GH-27, DSC-03, DSC-09, DSC-33 to DSC-38, WEB-15 to WEB-24, WEB-32 | No per-repository settings: every repository the App can access is available; a work channel for any repository; watched repositories get their own channel and are the only ones polled for new issues. |
| JOB-10, JOB-11, JOB-18, JOB-19, JOB-21, JOB-22, DSC-21 | Session files, commits and uncommitted work survive through uploads and checkpoints; a failed job keeps its work for Retry; fresh checkouts replace worktree resets; fast-forward push from the result bundle. |
| AGT-13, OPS-06, DSC-26, DSC-27, DSC-34 | Prompts state the shallow-checkout rule; the dry-run checks out like a worker; a `/work plan` Execute turns the plan thread into the issue thread. |
| CHAT-01, CHAT-03, CHAT-06, CHAT-07, DSC-25 | Chat, plan and draft runs check out privately per run; scratch files live in the orchestrator. |
| DSC-11, DSC-17, DSC-24, DSC-32, OBS-03 | One rate-aware Discord queue. ✅, 👀 and ⏳ follow delivery (RUN-15). Transcripts are cut on the worker (RUN-16). |
| JOB-08, DSC-06, DSC-28 | Orchestrator restarts no longer abort runs (RUN-04, RUN-07). The ask-user limit and plan failure follow the runs table. |
| ENG-02 to ENG-05 | Engine restarts and shutdown never abort runs (RUN-09). Start-up prunes finished runs' temp refs. Session files live on the state volume. |
| WEB-12 to WEB-14, WEB-25 to WEB-31, SEC-07 | The browser terminal is removed. VS Code edits a synced config workspace (§2.5), which replaces the redacted config export. Its built-in terminal, marketplace, tasks and debuggers are disabled. |
| CRED-04, CRED-05 | No terminal sign-in copies. |
| OBS-01, OBS-02, OBS-03 | Health per component with limits (§4.5). Logs per component. Transcripts on the state volume. |
| SEC-06, SEC-08 to SEC-11, SEC-13 | SEC-06 is replaced by SEC-16. The SSH server is removed. Sign-ins follow CRED-01 to CRED-05. |
| UPD-03 to UPD-05 | Replaced by UPD-06 to UPD-10. |
| DB-01 to DB-03 | Volumes per component (§5); the runs and questions tables; sign-ins, mirrors, sessions and scratch on the state volume. |
| OPS-01 to OPS-05, OPS-07 to OPS-09 | Four roles, Podman compose stack with launcher, Helm chart without RWX storage, health-based deploy check. |
| NFR-01 to NFR-04 | Memory and disk per worker; reliability across component restarts. |
| new | RUN-01 to RUN-21, STO-01 to STO-06, SEC-14 to SEC-16, CRED-01 to CRED-05, LCH-01 to LCH-04, OPS-07 to OPS-09, DSC-32 to DSC-38, GH-25 to GH-27, WEB-25 to WEB-32 |

## 11. Open items

1. **Releasing workers while waiting for an answer.** Checkpoint the session and stop the worker while waiting for a human answer, then resume on a new worker. This would free workers during up to 24 h question waits.
2. **The on-prem host.** DevForge's on-prem host runs one Quadlet unit. Moving it to this stack means either Quadlet units per service plus the Podman socket, or `podman compose` under systemd. Not decided.
3. **Web replicas.** More than one web replica needs sessions stored in the orchestrator. Not needed at one admin.
4. **omp refresh hook.** CRED-03 assumes AgentBot can route omp's token refresh through the orchestrator. Confirm the omp SDK allows a custom auth store or refresh callback before building it. If it doesn't, the fallback is short-lived access tokens only, with no refresh token in the run spec; a run that outlives its token then fails.
5. **Start-up cost per run.** Every run clones the repo and runs `setupCommand` from scratch. A per-repo dependency cache (a node-local volume in Kubernetes, a named volume under Podman), reused read-only by workers, would cut this. Measure first.
6. **Agent and supervisor in separate containers.** Running the agent host in a second container, as a different user and without the worker token, would close the remaining claim risk in §6.
7. **Size of the packed omp copy.** Each worker downloads it when an in-place update is active (UPD-07). Its size is not measured yet. If it is large, cache it per node.
