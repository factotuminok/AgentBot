# AgentBot

A long-running service that uses the omp coding agent (`@oh-my-pi/pi-coding-agent`) to develop and maintain the GitHub repositories its GitHub App is installed on. GitHub issues drive the work, Discord is the control surface, and a password-protected web UI handles configuration and operations. The design lives in [`wiki/`](wiki/): [requirements](wiki/requirements.md), [architecture](wiki/architecture.md) and the [implementation plan](wiki/implementation.md).

## Running on Podman

`compose.yaml` runs three long-running services from one image: `orchestrator`, `web` and `launcher`. The launcher starts one short-lived worker container per agent run through your rootless Podman socket (architecture §7.2).

**Requirements:** rootless Podman ≥ 4.6 and a compose provider for `podman compose`: docker-compose or podman-compose (tested with docker-compose 5.6.0 and podman-compose 1.6.0 on Podman 6.1.4). **Docker Engine is not supported**: the launcher refuses a rootful socket (LCH-01), so no worker would ever start. A rootful Podman socket is refused the same way.

1. **Enable your user's Podman socket** once, as the user that will run the stack:

   ```sh
   systemctl --user enable --now podman.socket
   loginctl enable-linger "$USER"   # keep it, and the stack, running after you log out
   ```

2. **Get the image.** Released images are `ghcr.io/factotuminok/agentbot:<version>` and `:latest` (the default):

   ```sh
   podman compose pull
   ```

   Or build it from this repository and point compose at it:

   ```sh
   podman build -t localhost/agentbot:dev .
   export AGENTBOT_IMAGE=localhost/agentbot:dev   # or put AGENTBOT_IMAGE=... into .env next to compose.yaml
   ```

3. **Create the secrets** once:

   ```sh
   scripts/init-secrets.sh
   ```

   It writes the master key and the web, worker and scale tokens as random files (mode 0400) into `secrets/` next to `compose.yaml` (`AGENTBOT_SECRETS_DIR` moves it), and stores the worker token a second time as the Podman secret `agentbot_worker_token`, which the launcher hands to workers. Running it again keeps everything. Back up `secrets/` with the volumes: without the master key the settings stay locked until an admin logs in (SEC-05).

4. **Start the stack:**

   ```sh
   podman compose up -d
   podman compose ps   # orchestrator, web and launcher report (healthy) after about 20 s
   ```

5. **Open <http://127.0.0.1:8080>** (only web publishes a port, on loopback; put a TLS reverse proxy in front for remote access). On first start the page asks for the setup token, which the orchestrator prints once:

   ```sh
   podman compose logs orchestrator | grep setupToken
   ```

   Create the admin account there, then fill in the settings (Discord, GitHub App, models).

**Upgrade:** `podman compose pull && podman compose up -d`. Runs in progress keep their worker and finish; new workers use the new image.

**Settings in the environment** (shell or `.env` next to `compose.yaml`; the header of `compose.yaml` lists them all): `AGENTBOT_WORKER_CAPACITY` (most concurrent workers, default 4), `AGENTBOT_WORKER_MEMORY` (limit per worker, no swap, default `4g`), `AGENTBOT_WORKER_CPUS` (CPU quota per worker, default 2), `AGENTBOT_WORKER_DISK` (checkout limit, default `20g`), `AGENTBOT_WORKER_IMAGE` (a derived worker image with your repositories' toolchains, built `FROM` the same version), `AGENTBOT_WEB_HOST_PORT` (default 8080), `AGENTBOT_NETWORK` (default `agentbot`; workers get their own network, `<AGENTBOT_NETWORK>-workers`, where they reach only the orchestrator), `AGENTBOT_WEB_TRUSTED_PROXIES` (your reverse proxy's address as web sees it, so failed logins count against the client and not the proxy), `AGENTBOT_WORKER_ADDRESS_BINDING` (default `on`; see architecture §6).

**Rotating the web token.** The web token opens the whole admin API, never expires, and is readable inside the VS Code editor (WEB-30). Replace it when it may have leaked; the orchestrator and web read it only at start, and runs in progress are not affected (RUN-09):

```sh
rm -f secrets/agentbot_web_api_token        # or under $AGENTBOT_SECRETS_DIR
scripts/init-secrets.sh                      # creates a new one, keeps the others
podman compose up -d --force-recreate orchestrator web
```

### Memory budget

Plan for **4 GiB minimum, 8 GiB recommended** (NFR-01). Measured with `podman stats` on an idle stack (Podman 6.1.4): orchestrator about 280 MB, web about 25 MB (plus about 0.5 GB while the VS Code editor runs), launcher about 16 MB, and a worker about 110 MB while it connects an MCP server. A worker running an agent needs about 250 MB, plus about 1.2 GB during a heavy check such as `tsc` or `bun test` on a large project; each worker is capped by `AGENTBOT_WORKER_MEMORY`. On a small host lower `AGENTBOT_WORKER_CAPACITY`, and in Settings `maxConcurrentJobs` and `maxChatSessions`.

### On macOS (podman machine)

The stack runs in the machine's VM; use its rootless connection (`export CONTAINER_CONNECTION=podman-machine-default` when the machine is rootful). Two things differ from a Linux host:

- `podman compose` with docker-compose talks to the machine's API socket, which is the **rootful** engine on a rootful machine. Point `DOCKER_HOST` at the rootless socket instead (forward `/run/user/<uid>/podman/podman.sock` from the VM over ssh), or use podman-compose, which follows `CONTAINER_CONNECTION`.
- `XDG_RUNTIME_DIR` is the Mac's, not the VM's: set `AGENTBOT_HOST_PODMAN_SOCKET=/run/user/<uid>/podman/podman.sock` (the VM path; `podman info --format '{{.Host.RemoteSocket.Path}}'` prints it).

`test/e2e/compose/smoke.sh` does both; see [its README](test/e2e/compose/README.md).

## Running on Kubernetes

The Helm chart `deploy/helm/agentbot` runs the orchestrator and web as single-replica Deployments and the workers as a KEDA `ScaledJob`: one Job pod per pending run, from 0 up to `worker.maxReplicas` (default 10), each deleted a minute after its run (architecture §7.3).

**Requirements:** Kubernetes ≥ 1.27 and KEDA ≥ 2.12 (≥ 2.19 recommended: older versions can start one extra worker pod near `worker.maxReplicas`). The chart refuses to install on an older cluster or without KEDA's `ScaledJob` API. ReadWriteOnce storage for two PVCs; no ReadWriteMany.

```sh
helm install agentbot deploy/helm/agentbot -n agentbot --create-namespace --set image.tag=<version>
kubectl -n agentbot logs deploy/agentbot-orchestrator | grep setupToken
kubectl -n agentbot port-forward svc/agentbot-web 8080:8080   # or enable web.ingress (TLS)
```

- **Secrets:** the master key and the web, worker and scale tokens are generated on first install into Secret `agentbot` and kept on every upgrade. `secrets.existingSecret` names your own Secret instead (keys `master-key`, `web-api-token`, `worker-token`, `scale-token`). The Secret and the state PVC are kept on `helm uninstall`; back them up together. To rotate the web token, put a new value into the Secret and restart both readers (upgrades keep the new value):

  ```sh
  kubectl -n agentbot patch secret agentbot --type merge -p "{\"data\":{\"web-api-token\":\"$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | base64 | tr -d '\n')\"}}"
  kubectl -n agentbot rollout restart deploy/agentbot-orchestrator deploy/agentbot-web
  ```
- **Behind the ingress:** set `web.trustedProxies` to the ingress controller pods' addresses (e.g. the pod CIDR), so the login throttle counts each client, not the controller.
- **Concurrency:** `worker.maxReplicas` is also the orchestrator's worker capacity. To use all of it, raise `maxConcurrentJobs` and `maxChatSessions` in Settings; the orchestrator's health warns while their sum is lower.
- **Workers:** `worker.diskLimit` (checkout space, default 20Gi), `worker.resources` (default 500m CPU / 1.5 Gi requested, 4 Gi limit), `worker.image` (a derived image with your repositories' toolchains).
- **NetworkPolicies** (on by default): the orchestrator accepts only web, workers and the KEDA operator (`networkPolicy.keda` selects it), web only the ingress controller (`networkPolicy.web.ingressController`, or `networkPolicy.web.allowAll=true`), workers nothing. Web may connect only to DNS and the orchestrator. Workers may connect to DNS, the orchestrator and the internet, but not to link-local addresses (cloud metadata) or `networkPolicy.worker.clusterCIDRs` (default: every private range). Narrow that list to your cluster's pod and Service CIDRs if workers need a private registry or proxy. Set `networkPolicy.dns` if your cluster's DNS is not kube-dns in `kube-system`, and add NodeLocal DNSCache's address there if you use it.

**Upgrade:** `helm upgrade agentbot deploy/helm/agentbot -n agentbot --reuse-values --set image.tag=<version>`. The orchestrator and web restart once each (`Recreate`); runs in progress keep their worker pod and finish.

`values.yaml` documents every value. `test/e2e/k8s/install-smoke.sh` installs the chart on a local kind cluster (`test/e2e/k8s/kind.sh up`, kind on Podman with KEDA) and runs a real worker through it.

Deployments of a particular installation (which version, where, when) are not run from this repository: CI only tests, publishes `ghcr.io/factotuminok/agentbot:<version>` and `:latest`, and tags `v<version>`.

## Configuration

Everything an admin enters lives in the orchestrator's encrypted settings vault and is edited in the web UI ([requirements §13](wiki/requirements.md) lists every setting):

1. **Settings** (`/admin`): the Discord bot token and guild, allowed users and roles, the GitHub App id and private key, labels, models, limits and logs. Once the bot token and guild are saved, the channel fields become dropdowns; the engine starts when a work channel is chosen.
2. **Repositories** (`/admin/repos`): watch or unwatch the repositories the GitHub App can reach. Each watch gets its own Discord channel.
3. **Model accounts** (`/admin/models`): sign in to model providers, or add provider API keys under Settings.
4. **omp and MCP** (`/admin/omp`), **Skills and agents** (`/admin/skills`): omp setting overrides, MCP servers, and the skills and task agents runs load. The omp page also shows the omp update status; updates are approved in Discord.
5. **VS Code** (`/admin/vscode/`, unless `AGENTBOT_WEB_VSCODE=off`): the same settings, omp configuration, skills and agents as files, validated on save. Secrets show only as `<set>` and are changed on the pages above.

A repository can add `.agentbot.yml` on its default branch with a `setupCommand` that every run executes after checkout (for example `bun install`). The home page has sample configs and a getting-started checklist.

## Security notes

Read [architecture §6](wiki/architecture.md) before exposing AgentBot to untrusted input. In short:

- **Treat every watched repository, and everyone who can file issues on it, as able to run code in a worker.** Issue text can steer the agent, and the repository's `setupCommand` and its dependencies' install scripts run in the worker. Within its own run that code can read the run's provider keys and model sign-ins (SEC-13).
- **Workers can't claim other runs from their own address.** Claims are tied to the worker's network address (`AGENTBOT_WORKER_ADDRESS_BINDING`, on by default; leave it on unless a service mesh rewrites source addresses). Moving the agent into a separate container from its supervisor is planned as the first change after this release.
- **Keep all watched repositories at one trust level** (same owner, no public repositories accepting issues from strangers) until that split ships.
- **On Podman, workers can reach the web UI's published port through the host.** They can't sign in without the password, but repeated failed logins count against the same address as a browser on the host. Put a TLS reverse proxy in front for remote access and set `AGENTBOT_WEB_TRUSTED_PROXIES`.

## Planning dry run

`bun run dry-run` runs the planning agent on a local repository and an issue file, without GitHub or Discord (OPS-06): a shallow checkout of the start commit like a worker's, the plan job's profile, prompt and output schema, questions answered on the console, then the plan (JSON) and usage on stdout. The temporary checkout is removed afterwards, also on Ctrl-C.

```sh
bun run dry-run --repo ../my-project --issue issue.md [--ref HEAD] [--model anthropic/claude-haiku-4-5] [--thinking low]
```

The issue file's first line is the title (a leading `#` is dropped), the rest its body. Model sign-ins come from your own omp (`--agent-dir`, else `PI_CODING_AGENT_DIR`, else `~/.omp/agent`; sign in with `omp` first), and provider API keys such as `ANTHROPIC_API_KEY` from the environment.
