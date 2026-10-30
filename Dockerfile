# The one AgentBot image (architecture §7.1, requirements OPS-01): the role is the command,
# `agentbot orchestrator|web|worker|launcher|health`. Everything runs as `agentbot` (10001:10001); no entrypoint runs as root.
#
# Build args:
#   AGENTBOT_OMP         latest (default): npm's latest omp with the package.json pin as fallback (UPD-01);
#                        pin: the pin only (CI MUST test it); or an exact version to try instead of npm's latest.
#   AGENTBOT_VERSION     build version shown on the home page and in health bodies; empty = package.json's version.
#   AGENTBOT_COMMIT      git commit the image is built from.
#   AGENTBOT_BUILD_DATE  build time (ISO 8601).
#   CODE_SERVER_VERSION  code-server release (spike S4 tested 4.143.1).

# The bundled VS Code extension, packaged by scripts/build-vsix.ts (WEB-14).
FROM docker.io/oven/bun:1.4.2-debian AS vsix
WORKDIR /src
COPY scripts/build-vsix.ts scripts/
COPY vscode/extension/ vscode/extension/
RUN bun scripts/build-vsix.ts

# code-server from the release tarball, in its own stage so curl stays out of the image (spike S4). Only JSON, YAML and
# Markdown support and the two default themes (no code) stay; every other built-in extension (debuggers, task providers,
# git, npm, copilot chat, ...) is deleted, because code-server has no per-extension disable flag. The bundled extension is
# installed as root into an extensions dir that holds only it, so agentbot can neither add nor remove extensions.
FROM docker.io/oven/bun:1.4.2-debian AS code-server
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/*
ARG CODE_SERVER_VERSION=4.143.1
RUN arch="$(dpkg --print-architecture)" \
	&& mkdir /opt/code-server \
	&& curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${arch}.tar.gz" \
		| tar -xz -C /opt/code-server --strip-components=1 \
	&& cd /opt/code-server/lib/vscode/extensions \
	&& for d in */; do \
		case "${d%/}" in json|json-language-features|yaml|markdown-basics|markdown-language-features|theme-defaults|theme-seti) ;; \
		*) rm -rf "$d" ;; esac; \
	done \
	&& /opt/code-server/bin/code-server --version
COPY --from=vsix /src/dist/agentbot.vsix /tmp/agentbot.vsix
RUN /opt/code-server/bin/code-server --user-data-dir /tmp/cs-build --extensions-dir /opt/agentbot/vscode-extensions \
		--install-extension /tmp/agentbot.vsix \
	&& rm -rf /tmp/cs-build /tmp/agentbot.vsix \
	&& ls -la /opt/agentbot/vscode-extensions

FROM docker.io/oven/bun:1.4.2-debian
# git: the orchestrator's mirrors and the workers' checkouts; procps: the agent's process tools and `pgrep` for operators.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git procps \
	&& rm -rf /var/lib/apt/lists/*

# agentbot's login shell is nologin: VS Code offers every shell in /etc/shells as a terminal profile, so it lists only
# nologin (WEB-14). /state (orchestrator) and /home/agentbot (web) are owned by agentbot so that named volumes mounted
# there inherit the ownership; /run/agentbot is the worker's run-local root (AGENTBOT_WORKER_RUN_DIR), where the
# launcher mounts a tmpfs and Helm a memory emptyDir.
RUN groupadd --gid 10001 agentbot \
	&& useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agentbot --shell /usr/sbin/nologin agentbot \
	&& printf '/usr/sbin/nologin\n' > /etc/shells \
	&& install -d -o 10001 -g 10001 -m 0700 /state /run/agentbot \
	&& printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/agentbot \
	&& chmod 0755 /usr/local/bin/agentbot

# Root-owned and read-only to agentbot: code-server, the locked user settings and tasks (symlinked at every start by
# src/web/vscode.ts) and the extensions dir with only the bundled extension.
COPY --from=code-server /opt/code-server/ /opt/code-server/
COPY --from=code-server /opt/agentbot/vscode-extensions/ /opt/agentbot/vscode-extensions/
COPY vscode/locked/ /opt/agentbot/vscode/
RUN chmod -R a+rX,go-w /opt/agentbot

# omp: npm's latest, not the one in bun.lock, with package.json's pin as the fallback (UPD-01). The layer cache keys ADD
# on the downloaded document, so this reinstalls exactly when a new omp is published.
WORKDIR /app
COPY package.json bun.lock ./
COPY src/shared/log.ts src/shared/ompPins.ts src/shared/
COPY scripts/omp-latest.ts scripts/
ARG AGENTBOT_OMP=latest
ADD https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest /tmp/omp-latest.json
RUN BUN_INSTALL_CACHE_DIR=/tmp/bun-cache AGENTBOT_OMP="${AGENTBOT_OMP}" bun scripts/omp-latest.ts install /tmp/omp-latest.json \
	&& rm -rf /tmp/bun-cache /tmp/omp-latest.json
COPY src/ src/
# Loads the app's omp entry modules with the installed omp and logs which omp the image has and why; reinstalls the pin
# when the candidate does not load.
RUN BUN_INSTALL_CACHE_DIR=/tmp/bun-cache bun scripts/omp-latest.ts verify && rm -rf /tmp/bun-cache

# The app identity (§7.1) over the final sources, lockfile and package.json, and the build info. The RUN reads the args:
# buildah caches steps by text, so without it a rebuild with a new version would keep the old identity.
ARG AGENTBOT_VERSION=
ARG AGENTBOT_COMMIT=unknown
ARG AGENTBOT_BUILD_DATE=
RUN AGENTBOT_VERSION="${AGENTBOT_VERSION}" AGENTBOT_COMMIT="${AGENTBOT_COMMIT}" AGENTBOT_BUILD_DATE="${AGENTBOT_BUILD_DATE}" \
	bun src/shared/version.ts --write-identity /app/IDENTITY

ENV AGENTBOT_VERSION=${AGENTBOT_VERSION} \
	AGENTBOT_COMMIT=${AGENTBOT_COMMIT} \
	AGENTBOT_BUILD_DATE=${AGENTBOT_BUILD_DATE} \
	AGENTBOT_HOME=/home/agentbot \
	AGENTBOT_STATE_DIR=/state \
	AGENTBOT_OMP_RUNTIME_DIR=/state/omp-runtime \
	AGENTBOT_WORKER_RUN_DIR=/run/agentbot \
	AGENTBOT_WEB_HOST=0.0.0.0 \
	AGENTBOT_WEB_PORT=8080 \
	AGENTBOT_INTERNAL_HOST=0.0.0.0 \
	AGENTBOT_INTERNAL_PORT=8081 \
	HOME=/home/agentbot \
	LANG=C.UTF-8

USER 10001:10001
WORKDIR /home/agentbot
# web: 8080 (UI, /healthz); orchestrator: 8081 (internal API, /readyz /livez /healthz).
EXPOSE 8080 8081
ENTRYPOINT ["agentbot"]
