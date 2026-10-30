# Load test (phase 11)

The phase 11 load test (implementation.md §4 Phase 11): 10 concurrent implement runs on one repository, then 10 on 10
repositories, watching the Discord write queue (DSC-32) and each run's start-up time (NFR-06). It also answers
architecture §11 item 5, the per-repository dependency cache.

## Setup

- **Cluster.** kind (Kubernetes 1.34) with KEDA 2.21.0 on the rootful Podman machine (8 GiB, 5 CPUs), one node. The chart
  is installed unchanged except for `test/e2e/k8s/load.values.yaml`: capacity 10 (`worker.maxReplicas`), limits 10/2,
  small requests so 10 workers fit, worker memory limit 1.5 GiB, checkout `emptyDir` 2 GiB. The run-local tmpfs keeps
  the chart's 256 MiB.
- **Image.** The scenario image `test/e2e/k8s/Containerfile`. Its orchestrator `test/e2e/k8s/orchestrator.ts` runs the
  real internals (dispatcher, engine, poller, internal API, git endpoint) with the fake GitHub and fake Discord in
  process. The workers are real worker processes with the fixture agent host, so no model or omp runs.
- **Repositories.** Each one is generated: 3000 TypeScript files of 8 KiB and 8 random 2 MiB assets, a 23.2 MiB pack.
  Each has `.agentbot.yml` `setupCommand: bun install --frozen-lockfile && bun run build`. The install is a real lockfile
  from the npm registry. The light set has 7 packages and ~80 MB of `node_modules` (`test/e2e/k8s/load.bun.lock`). The
  heavy set is a typical web app (next, aws-sdk, eslint, vitest, ...) with 247 packages and ~450 MB of `node_modules`
  (`load-heavy.bun.lock`). The build transpiles all 3000 files.
- **Runs.** Each issue gets a 2 s fixture plan. After all plans are done and their pods are gone, the plans are approved
  one after another. Each implement run commits, holds for 60 s while reporting progress every 2 s, commits again, and
  its branch is pushed and a PR opened.
- **Discord.** The fake simulates REST: 100 ms per write, and 5 writes per 5 s per channel. Above that a write gets a
  rate-limit error with retry-after, which the outbound queue honours like discord.js's.
- **Measured.**
  - Per run: pending (`created_at`), Job pod created, scheduled, container started (pod status), claimed (`claimed_at`),
    checkout made and `setupCommand` finished (worker log), agent registered (`started_at`), and finished.
  - The status API's `setupMs`, which matched claim → registered for every run.
  - On the orchestrator: mirror fetch, push and git endpoint timings, cgroup CPU, memory and pressure, event-loop lag
    per second, and the state volume's append and fsync latency (a probe child process).
  - The Discord queue's length and oldest age, sampled every 200 ms.
- **Command.** `bun test/e2e/k8s/load.ts [same] [multi] [heavy]`. It prints the tables below and writes the raw samples
  as JSON. The driver shares `test/e2e/k8s/harness.ts` with `scenarios.ts`.

The Podman machine was shared with other test stacks running at the same time (the chaos tests' rootless compose
stack), so absolute times varied by up to 3× between runs. The tables come from the final run with both fixes below;
the earlier runs are summarised where they differ.

## Results

All runs succeeded in every final scenario: 10/10 in "same", 10/10 in "multi" and 3/3 in "heavy", each with its own
plan run first. KEDA started one pod per run (20 pods for 20 runs) and at most 10 ran at once. Each issue branch got the
fixture's two commits on the seed commit, and each issue got its own PR. In "same", all 10 branches were pushed to the
same repository with no ref conflict (push p95 73 ms). No run committed `node_modules`.

### Implement-run start-up (NFR-06), 10 concurrent runs

Times between consecutive steps. Pod timestamps have 1 s resolution.

| Step | same repo p50 | p95 | 10 repos p50 | p95 |
|---|---|---|---|---|
| approved → run pending | 0.3 s | 3.3 s | 0.3 s | 0.4 s |
| pending → Job pod created (KEDA) | 1.7 s | 2.9 s | 1.3 s | 4.7 s |
| pod created → container started | 0.0 s | 2.0 s | 0.0 s | 3.0 s |
| container started → claimed | 0.7 s | 0.9 s | 0.4 s | 1.0 s |
| claimed → checkout made | 2.7 s | 5.9 s | 3.7 s | 8.8 s |
| checkout → `setupCommand` done | 5.6 s | 7.4 s | 3.5 s | 6.0 s |
| setup done → agent registered | 0.1 s | 0.3 s | 0.0 s | 0.1 s |
| **setup time (claim → registered, NFR-06)** | **8.6 s** | **10.4 s** | **7.2 s** | **13.9 s** |
| pending → registered | 11.9 s | 13.2 s | 9.0 s | 20.8 s |
| approved → registered (what the user waits) | 12.2 s | 15.2 s | 9.3 s | 21.1 s |

Heavy dependency set, 3 concurrent runs on one repository: setup 16.2 s p50 and 16.3 s max. Of that, `setupCommand`
took 14.2 s, the checkout 2.0 s, and pending → registered was 19.2 s.

The fixture host registers almost at once. A real omp host adds its own start: loading its modules took 0.6–0.7 s
alone and 4.6 s for 10 at once on 5 CPUs (measured in the image, below).

### Plan runs (issue intake)

| | same repo p50 | p95 | 10 repos p50 | p95 |
|---|---|---|---|---|
| issue filed → plan run pending | 26.4 s | 31.7 s | 4.4 s | 6.9 s |
| setup time (claim → registered) | 3.4 s | 9.2 s | 24.7 s | 26.0 s |
| filed → registered | 33.6 s | 40.3 s | 31.7 s | 32.9 s |

In "same", intake is serialised by Discord's per-channel rate limit (see the next section). In "multi", the 10 plan
runs started together: 10 mirrors were cloned at once and the git endpoint served 10 different repositories, hence
the longer checkout (11.8 s p50).

### Discord write queue (DSC-32)

| | same repo | 10 repos | heavy |
|---|---|---|---|
| max queue length | 11 | 7 | 3 |
| max age of the oldest write | 14.8 s | 2.8 s | 4.6 s |
| REST writes | 350 | 365 | 107 |
| simulated 429s (all retried) | 12 | 5 | 2 |

Intake writes two messages per issue to the repository's watch channel: the top message and the thread. In "same", 10
issues share one channel (bucket), so the queue reached 11 writes, 15 s old, and the last plan started 32 s after its
issue was filed. With one channel per repository, the oldest write was under 3 s old. Activity edits (progress every
2 s per run) coalesced. No write was lost, and the queue drained within seconds after each burst.

The fake keeps one bucket per channel. Real Discord rate-limits thread creation separately from message posts, so the
real intake delay should be about half of this.

### Orchestrator

| | same repo | 10 repos | heavy |
|---|---|---|---|
| git endpoint upload-pack (23.7 MB each), p50 / p95 / max | 0.31 / 0.86 / 1.06 s | 1.19 / 3.20 / 3.26 s | 0.25 / 0.31 / 0.31 s |
| mirror fetch p50 / p95 / max | 8 / 75 / 248 ms | 21 / 977 / 1313 ms | 10 / 271 / 271 ms |
| push p50 / max | 27 / 73 ms | 21 / 56 ms | 27 / 42 ms |
| CPU peak (2 s samples) / average | 35 % / 6 % | 127 % / 14 % | 36 % / 7 % |
| anonymous memory max / process RSS max | 312 / 366 MiB | 306 / 357 MiB | 292 / 345 MiB |
| cgroup memory max (with page cache) | 494 MiB | 887 MiB | 947 MiB |
| worst event-loop lag | 104 ms | 441 ms | 816 ms |

- The CPU peak in "multi" is 10 concurrent `git pack-objects` on 10 different mirrors. The chart requests 250m and sets
  no CPU limit, so this is fine.
- Anonymous memory stays near 300 MiB, and that figure includes the in-process fakes.
- The cgroup's memory comes close to the 1 GiB limit only through page cache (mirrors, seeded repositories), which the
  kernel reclaims.

## Fixes

Product bugs the load test found, each with a regression test:

1. **`setupCommand: bun install` ran out of space for any real web app.**
   - The cause: the agent host's `HOME` and `TMPDIR` are on the run-local tmpfs (256 MiB, architecture §5), so bun's
     and npm's package caches went to memory. The heavy set failed every run: `setupCommand failed (exit 1): ...
     ENOSPC extracting tarball for "next"`.
   - Fix (`src/worker/runner.ts`): `makeRunDirs` adds `<root>/cache` on container storage, and `hostEnv` sets
     `XDG_CACHE_HOME` and `npm_config_cache` to it, for `setupCommand` and for the agent's own commands. omp ignores
     `XDG_CACHE_HOME` unless `<it>/omp` exists, so its run-local files do not move.
   - Test: `test/unit/checkout.test.ts`, "with the host environment, package-manager caches land on the run root". After
     the fix the heavy scenario passed 3/3.
   - Architecture §5 now lists the cache directory.
2. **The orchestrator's event loop stalled for up to 17 s when the node's disk was busy.**
   - With SQLite's default `synchronous=FULL`, every commit fsyncs the WAL, and bun:sqlite is synchronous. While 10
     workers wrote `node_modules` to the same disk, single fsyncs on the state volume took up to 2.5 s.
   - Measured with `FULL`: the plan completions' commits blocked the event loop for 7.6 s and 17.3 s. During the 17 s
     stall nothing was served: not the health probes, not KEDA's scale endpoint, not the worker WebSockets, not Discord.
     In an earlier run, 5 Job pods were created 58 s after their runs became pending, which fits KEDA's polls going
     unanswered [inference: that run had no lag probe yet]. A stall over the 45 s lease would lose every run.
   - Same scenario, back to back: `FULL` had a worst lag of 17.3 s (and 1.45 s on a quieter repeat); `NORMAL` had 24 ms
     and 41 ms. Setup p50 was 31.3 s with `FULL` and 10.4 s with `NORMAL` (7.4 s and 6.9 s on the quieter repeat).
   - Fix (`src/orchestrator/store/db.ts`): `PRAGMA synchronous=NORMAL`. Under WAL, a commit still survives a process
     crash; an OS crash or power loss can lose the last few commits. Final run: worst lag 816 ms, even with a 2.3 s fsync.
   - Test: `test/unit/db.test.ts`, "the store is WAL with synchronous=NORMAL". The scenario image's
     `POST /internal/admin/e2e/sqlite` and `LOAD_SQLITE_SYNC=FULL` reproduce the old behaviour.
3. **A newly watched repository was suspended at once.**
   - The poller checks access against the GitHub App's repository listing, which is cached for 60 s (GH-25). A
     repository added to the installation and watched within that minute was missing from the listing. Watching from the
     web Repositories page triggers this, because that page lists with its own client.
   - The effect: the watch was suspended with a "Watch suspended" message and resumed with "Watch resumed" up to a
     minute later.
   - Fix (`src/orchestrator/github/poller.ts`): when a watch that is not suspended is missing from the cached listing,
     list again with `refresh` before suspending.
   - Test: `test/integration/poller.test.ts`, "a repository watched after the cached listing was made is not suspended".

Test harness additions:

- **Fake Discord** (`test/fakes/discord.ts`): REST simulation via the `simulate` option or `simulateRest()`, and
  `restStats()`.
- **Fixture host:** `fixture-progress-seconds:<n>` in `fixture:slow`.
- **Scenario orchestrator:** routes `repos`, `discord`, `sqlite` and `metrics`, a `repo` field on `issues`, `approve`
  and `branch`, timing wrappers, and the disk probe `test/e2e/k8s/diskprobe.ts`.
- **Shared driver:** `test/e2e/k8s/harness.ts`, used by `scenarios.ts` and `load.ts`.
- **Coverage:** `test/integration/k8sharness.test.ts` covers the new routes.

## Recommendation: per-repository dependency cache (architecture §11 item 5)

**Not needed for release.** Revisit it from the status page's "Setup time by repository" once real repositories run.

- **Setup is small next to a run.** At 10 concurrent runs, setup (claim → agent registered) was 7–9 s p50 and 10–14 s
  p95 with an ~80 MB install. For a typical web app (~450 MB) it was 16 s. Implement runs take minutes, so this is a few
  percent of a run. NFR-06 asks for the time to be visible, and it is: the status API's `setupMs` matched the measured
  claim → registered for every run. NFR-06 sets no ceiling.
- **A cache would save little.** It would only shorten the install inside `setupCommand`:
  - Measured in the image: the heavy set installs cold in 5.3–7.3 s alone, and in 14 s with 3 at once in kind. From a
    warm cache on a separate volume (copyfile) it takes 0.5–0.8 s.
  - So a cache saves about 13 s per run for a typical web app and 2–4 s for the light set.
  - It does not help the checkout (2.7–3.7 s p50, the 23 MiB pack from the orchestrator), worker start (≈1 s from pod
    to claim), or the build part of `setupCommand`.
- **A cache costs real complexity and a security boundary.**
  - It needs a node-local volume (hostPath or a per-node PVC) in Kubernetes and a named volume under Podman.
  - Something trusted has to fill it, keyed by lockfile hash. A cache that runs can write to lets one run plant
    packages for later runs, possibly of other repositories. So workers could only read it, and the orchestrator or a
    dedicated job would fill it.
  - That is a new component and a new shared-state path, worth building only when a repository's setup actually hurts.
- **What release needed has been fixed.** Without fix 1, a `bun install` of a real web app did not fit at all. That
  fix, not a cache, was the release blocker.
- **When to build it.** Build the cache when a watched repository's average setup time exceeds ~60 s, or setup exceeds
  ~20 % of its runs' duration. Until then the per-repository setup times on the status page are the trigger.

The omp transpile cost asked about during the test (a fresh `HOME` per run) does not apply as stated. The base image
sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, so bun keeps no transpiler cache at all, under `HOME` or anywhere else.
Measured in the image, loading the host modules (`src/worker/host/session.ts` and `serve.ts`) took:

| | no cache (image) | warm cache |
|---|---|---|
| one at a time | 0.62–0.84 s | 0.62–0.69 s |
| 10 at once (5 CPUs) | 4.6 s | 3.2 s |

A cache built into the image would save about 1.4 s per run only when 10 hosts start at once. It is not worth changing
the Dockerfile for release.

## Limits of this test

- **No real model or omp.** The fixture host replaces omp, so the agent's own start and its tool traffic are not
  included. Discord and GitHub are fakes in the orchestrator's process: their CPU and memory count toward the
  orchestrator's figures, and GitHub has no network latency.
- **Shared, single-node machine.** One node shares its disk between the state volume and every worker's checkout. That
  is the worst case for fsync latency, but a realistic one for a small cluster. The Podman machine was shared with other
  test stacks.
- **Fake Discord buckets.** Rate limits are one bucket per channel, at Discord's documented 5 messages per 5 s. There is
  no global limit.
