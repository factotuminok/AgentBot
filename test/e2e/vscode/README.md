# VS Code end-to-end check

`smoke.sh` checks the web role of the AgentBot image (the repository's `Dockerfile`) with the code-server layout from spike S4 (`wiki/spikes/S4.md`, WEB-14, WEB-30, WEB-31):

- code-server 4.143.1 from the release tarball under `/opt/code-server`, built-in extensions pruned to `json json-language-features yaml markdown-basics markdown-language-features theme-defaults theme-seti`;
- user `agentbot` (10001) with login shell `/usr/sbin/nologin`, and `/etc/shells` listing only nologin;
- `vscode/locked/{settings,tasks}.json` root-owned at `/opt/agentbot/vscode`;
- the bundled extension (`vscode/extension`, packaged by `scripts/build-vsix.ts` in a build stage) preinstalled into the root-owned `/opt/agentbot/vscode-extensions`.

At the first request to `/admin/vscode/`, `src/web/vscode.ts` symlinks the locked files into `~/.local/share/code-server`, deletes `User/globalStorage/state.vscdb`, and starts code-server on `127.0.0.1:13337` with the S4 flags.

## Build and smoke test

```sh
CONTAINER_CONNECTION=podman-machine-default test/e2e/vscode/smoke.sh   # KEEP=0 removes the container afterwards; PORT=18080, IMAGE=agentbot:dev by default
```

The script builds the image from the repository root (`podman build -t agentbot:dev .`; use a rootless Podman connection). It then runs the container with an orchestrator started next to the web process in the same container (`agentbot orchestrator` in the background, then `agentbot web`), with throwaway state, master key and web token under `/tmp`. It creates the admin account `admin` / `correct horse battery` through `/setup` with the setup token from the orchestrator log, and checks that:

- `/admin/vscode/` redirects to the login page without a session;
- code-server starts through the proxy after login and serves the workbench;
- a WebSocket from a foreign origin is refused;
- inside the container, the symlinks, the code-server flags and environment, the pruned built-ins, the root-owned dirs, `/etc/shells` and the loopback-only listener are as described above.

Then open `http://127.0.0.1:18080/` in a browser and log in to try the editor. Stop the container with `podman rm -f agentbot-e2e-vscode`.

## Against a separate orchestrator

Run only the web role and point it at an orchestrator elsewhere:

```sh
podman run --rm -p 127.0.0.1:18080:8080 \
  -e AGENTBOT_ORCHESTRATOR_URL=http://host.containers.internal:8081 \
  -e AGENTBOT_WEB_API_TOKEN_FILE=/run/secrets/web-token -v ./web-token:/run/secrets/web-token:ro,Z \
  agentbot:dev web
```
