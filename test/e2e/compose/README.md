# Compose stack end-to-end check

`smoke.sh` runs the repository's `compose.yaml` on real rootless Podman and drives one real worker run without Discord, GitHub or model credentials (architecture §7.2, LCH-01 to LCH-04, OPS-03).

```sh
test/e2e/compose/smoke.sh            # BUILD=0 reuses localhost/agentbot:dev; KEEP=1 leaves the stack running
PODMAN_COMPOSE_PROVIDER=podman-compose test/e2e/compose/smoke.sh   # the same with podman-compose instead of docker-compose
```

Defaults fit a macOS podman machine whose default connection is rootful: the stack uses the rootless connection `podman-machine-default` (`ROOTLESS_CONNECTION`), the rootful check uses `podman --connection podman-machine-default-root` (`ROOTFUL_PODMAN`). On a Linux host run it as the stack user with `ROOTLESS_CONNECTION= ROOTFUL_PODMAN="sudo podman"`.

It uses its own compose project, networks (`agentbot-e2e-compose` and the workers network `agentbot-e2e-compose-workers`), web port (`127.0.0.1:18080`, `WEB_PORT`), secrets directory (a temporary one) and worker-token secret name (`agentbot_e2e_compose_worker_token`), so it does not touch a real stack on the same engine. It removes leftovers of an earlier run first, and everything it created at the end (`podman compose down -v`, the Podman secret, the secrets directory), unless `KEEP=1`.

Steps and checks:

1. Builds `localhost/agentbot:dev` on the rootless engine, runs `scripts/init-secrets.sh` twice (the second run keeps everything) and `podman compose up -d`. Waits until all three services report `healthy`.
2. Worker network (security review F6): prints the workers network's options (podman-compose passes `isolate=strict`, Podman's Docker API drops it, Podman ≥ 6 isolates by default), then runs the image as uid 10001 on it, where workers run, and fetches `orchestrator:8081/healthz` (must be 200), `web:8080/healthz` and web's address on the stack network (both must fail). It also prints, for information, whether web's published host port answers through `host.containers.internal`, `169.254.1.2` and the network's gateway: Podman forwards published ports from there, which is the known residual of F6.
3. Creates the admin through `/setup` with the setup token from `podman compose logs orchestrator`.
4. Saves the MCP server `e2e` on the omp page: `bun -e <script>`, a stdio MCP server in one line that offers one tool, `echo`, and answers `initialize` after `MCP_DELAY_MS` (default 4000) so that the worker stays up long enough to be seen.
5. Clicks "Test connection" (`POST /admin/omp/mcp/test`). The orchestrator queues the test, the launcher starts a worker container, and the worker connects the server. Checks that exactly one worker container (`label=agentbot.role=worker` on the workers network, and on no other network) appears, prints `podman ps` and `podman stats` while it runs, and checks that the result page says "Connected to e2e: 1 tool" with `mcp__e2e_echo` and that no worker container is left. Prints the worker's create/start/died/remove events.
6. Runs the image as the launcher service against the rootful socket (`--user 0 --security-opt label=disable`, `/run/podman/podman.sock`): it must exit 2 with "the Podman socket is rootful (LCH-01)".
7. Prints the timings: `up -d` to all healthy, worker create to remove, and Test connection to result.

## How it reaches the rootless engine

`podman compose` hands docker-compose the machine's API socket, which is the rootful engine on a rootful podman machine, whatever `CONTAINER_CONNECTION` says. The script therefore forwards the rootless socket from the VM (`podman info --format '{{.Host.RemoteSocket.Path}}'`) over the connection's ssh to a local socket and exports `DOCKER_HOST`, which `podman compose` keeps. podman-compose runs the `podman` CLI and follows `CONTAINER_CONNECTION`, which the script also exports. On macOS `XDG_RUNTIME_DIR` is the Mac's, so the script passes the VM path of the socket as `AGENTBOT_HOST_PODMAN_SOCKET`. `rootless-socket.sh` holds the forwarding, shared with the chaos tests.
