#!/bin/sh
# Spike S4 entrypoint: what `agentbot web` would do when code-server starts (WEB-14, WEB-31).
# Variants for the spike only: S4_GALLERY=<json> (gallery override), S4_NOEXT=1 (no lock-down extension, to test the
# nologin layer alone), S4_TRUST=1 (workspace trust on, workspace left untrusted / restricted mode).
set -eu

# An empty JSON object, not an empty string: code-server falls back to open-vsx when the variable is unset or empty.
if [ -n "${S4_GALLERY+x}" ]; then EXTENSIONS_GALLERY="$S4_GALLERY"; else EXTENSIONS_GALLERY='{}'; fi
export EXTENSIONS_GALLERY
export SHELL=/usr/sbin/nologin

data=/home/agentbot/.local/share/code-server
ws=/home/agentbot/workspace
mkdir -p "$data/User" "$data/Machine" "$ws/.vscode"

# Locked settings: symlinks to root-owned files, re-created at every start. Application-scoped settings
# (task.allowAutomaticTasks, security.workspace.trust.*, extensions.allowed) only take effect from User/.
settings=/opt/agentbot/vscode/settings.json
trust_flag=--disable-workspace-trust
if [ "${S4_TRUST-}" = 1 ]; then
	sed -e 's/"security.workspace.trust.enabled": false/"security.workspace.trust.enabled": true/' \
		-e 's/"security.workspace.trust.startupPrompt": "never"/"security.workspace.trust.startupPrompt": "never", "security.workspace.trust.banner": "never", "security.workspace.trust.emptyWindow": false/' \
		"$settings" > /tmp/settings-trust.json
	settings=/tmp/settings-trust.json
	trust_flag=
fi
ln -sfn "$settings" "$data/User/settings.json"
ln -sfn "$settings" "$data/Machine/settings.json"
ln -sfn /opt/agentbot/vscode/tasks.json "$data/User/tasks.json"

extensions=/opt/agentbot/vscode-extensions
if [ "${S4_NOEXT-}" = 1 ]; then extensions=/tmp/no-extensions; mkdir -p "$extensions"; fi

# Loopback only (WEB-14). The spike's forwarder exposes it on 13338 so the host can reach it through podman.
/opt/code-server/lib/node /opt/agentbot/fwd.js &

echo "s4: starting code-server at $(date +%s%3N)"
# shellcheck disable=SC2086
exec code-server \
	--bind-addr 127.0.0.1:13337 \
	--auth none \
	--extensions-dir "$extensions" \
	--disable-telemetry \
	--disable-update-check \
	--disable-getting-started-override \
	--disable-file-uploads \
	--disable-proxy \
	--ignore-last-opened \
	--enable-remote-storage \
	$trust_flag \
	"$ws"
