#!/bin/sh
# Builds the AgentBot image (the repository's Dockerfile), runs the web role in it with an orchestrator next to it (same
# container, so it shares loopback), creates the admin account, and checks that code-server starts through the
# /admin/vscode/ proxy with the S4 lock-down in place. Leaves the container running (published on
# 127.0.0.1:${PORT:-18080}) for a browser check unless KEEP=0. Run from anywhere: test/e2e/vscode/smoke.sh
# Podman's connection comes from CONTAINER_CONNECTION (use a rootless one, e.g. podman-machine-default).
set -eu

root="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${IMAGE:-agentbot:dev}"
name=agentbot-e2e-vscode
port="${PORT:-18080}"
user=admin
pass='correct horse battery'

podman build -t "$image" "$root"
podman rm -f "$name" >/dev/null 2>&1 || true

# Tokens and state live in /tmp inside the container: this is a test, not a deployment (that is compose.yaml).
podman run -d --name "$name" -p "127.0.0.1:$port:8080" \
	-e AGENTBOT_ORCHESTRATOR_URL=http://127.0.0.1:8081 -e AGENTBOT_WEB_API_TOKEN_FILE=/tmp/secrets/web-token \
	--entrypoint /bin/sh "$image" -c '
		mkdir -p /tmp/secrets /tmp/state
		head -c 48 /dev/urandom | base64 | tr -d "\n" > /tmp/secrets/master.key
		head -c 32 /dev/urandom | base64 | tr -d "\n" > /tmp/secrets/web-token
		AGENTBOT_STATE_DIR=/tmp/state AGENTBOT_MASTER_KEY_FILE=/tmp/secrets/master.key AGENTBOT_INTERNAL_HOST=127.0.0.1 \
			agentbot orchestrator > /tmp/orchestrator.log 2>&1 &
		exec agentbot web' >/dev/null

base="http://127.0.0.1:$port"
for _ in $(seq 1 60); do curl -fsS "$base/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
token=""
for _ in $(seq 1 60); do
	token="$(podman exec "$name" sh -c 'grep -o "\"setupToken\":\"[^\"]*\"" /tmp/orchestrator.log | cut -d\" -f4' 2>/dev/null || true)"
	[ -n "$token" ] && break
	sleep 0.5
done
[ -n "$token" ] || { echo "no setup token in the orchestrator log" >&2; exit 1; }

jar="$(mktemp)"
curl -fsS -o /dev/null -c "$jar" -H "Origin: $base" --data-urlencode "token=$token" --data-urlencode "username=$user" \
	--data-urlencode "password=$pass" --data-urlencode "confirm=$pass" "$base/setup"

echo "== without login"
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "$base/admin/vscode/"
echo "== first request (starts code-server; it redirects to ./?folder=<workspace>)"
workbench="$(mktemp)"
curl -sS -L -b "$jar" -o "$workbench" -w '%{http_code} %{url_effective} %{time_total}s\n' "$base/admin/vscode/"
grep -q 'workbench/workbench.js' "$workbench" && echo "workbench page served"
rm -f "$workbench"
echo "== WebSocket from a foreign origin"
curl -sS -b "$jar" -o /dev/null -w '%{http_code}\n' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
	-H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://evil.example' "$base/admin/vscode/"
echo "== inside the container"
podman exec "$name" sh -c '
	d=$HOME/.local/share/code-server
	ls -l $d/User/settings.json $d/Machine/settings.json $d/User/tasks.json
	ls $d/User/globalStorage 2>/dev/null || true
	pid=$(pgrep -f "code-server.*--bind-addr" | head -1)
	echo "code-server: $(tr "\0" " " < /proc/$pid/cmdline)"
	tr "\0" "\n" < /proc/$pid/environ | grep -E "^(SHELL|EXTENSIONS_GALLERY|AGENTBOT_HOME|HOME)="
	ls /opt/code-server/lib/vscode/extensions
	ls -ld /opt/agentbot/vscode /opt/agentbot/vscode-extensions /opt/agentbot/vscode-extensions/*
	cat /etc/shells; getent passwd agentbot
	ss -ltn 2>/dev/null || cat /proc/net/tcp | head -5'
rm -f "$jar"
if [ "${KEEP:-1}" = 0 ]; then podman rm -f "$name" >/dev/null; else echo "container $name left running at $base (login $user / $pass)"; fi
