#!/usr/bin/env bash
# Deploys AgentBot <version> on a Podman host with `podman compose` (architecture §7.2, requirements OPS-05).
#   deploy/podman/deploy.sh <version>
# Run it on the host as the user that runs the stack (rootless Podman keeps images, secrets and volumes per user); in CD
# that is the user of the self-hosted runner service (`podman` job of .github/workflows/cd.yml).
# 1. Copies compose.yaml from this checkout into the deploy directory and creates the secrets there once
#    (scripts/init-secrets.sh keeps existing ones).
# 2. `podman compose pull` (a failed pull leaves the running stack and .env as they were), then pins
#    AGENTBOT_IMAGE=<image>:<version> in the directory's .env (the rest of .env is the operator's) and runs
#    `podman compose up -d`. Running workers keep their image and finish their run.
# 3. With systemd: installs and enables the user unit deploy/podman/agentbot.service, so the stack starts at boot with
#    the pinned version (needs linger; checked first).
# 4. Waits up to TIMEOUT seconds for the orchestrator's /readyz and web's /healthz to report `version == <version>`
#    (read inside the containers with `bun -e fetch`), else prints diagnostics and exits 1.
# 5. Removes images of IMAGE other than this version and the previous one (quick rollback).
# Rollback: run it again with the previous version, ideally from a checkout of tag v<previous version>.
# Env: IMAGE (image repository, default ghcr.io/factotuminok/agentbot), AGENTBOT_DEPLOY_DIR (default ~/agentbot),
# TIMEOUT (default 120). Registry credentials: `podman login` as this user. The compose variables (compose.yaml header,
# e.g. AGENTBOT_WORKER_CAPACITY, AGENTBOT_SECRETS_DIR, AGENTBOT_WORKER_SECRET) and PODMAN_COMPOSE_PROVIDER belong in
# <deploy dir>/.env, in shell syntax: compose and the systemd unit read them from there, and this script does too.
set -euo pipefail

version="${1:-}"
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "usage: $0 <version>   (for example 0.1.42)" >&2
	exit 2
fi
root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${IMAGE:-ghcr.io/factotuminok/agentbot}"
dir="${AGENTBOT_DEPLOY_DIR:-$HOME/agentbot}"
timeout="${TIMEOUT:-120}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
env_file="$dir/.env"
mkdir -p "$dir"
touch "$env_file"
set -a
# shellcheck source=/dev/null
. "$env_file"
set +a
previous="${AGENTBOT_IMAGE:-}"
previous="${previous##*:}"
export AGENTBOT_IMAGE="$image:$version"
# Drops podman's "Executing external compose provider" banner.
export PODMAN_COMPOSE_WARNING_LOGS=false
# A service without a login session (the runner) has no XDG_RUNTIME_DIR; `systemctl --user` and rootless Podman need it.
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then
	XDG_RUNTIME_DIR="/run/user/$(id -u)"
	export XDG_RUNTIME_DIR
fi

say() { echo "deploy: $*" >&2; }
compose() { (cd "$dir" && podman compose "$@"); }

diagnostics() {
	say "diagnostics for $dir"
	compose ps >&2 || true
	for s in orchestrator web launcher; do
		echo "== $s log (last 30 lines)" >&2
		compose logs --no-color --tail 30 "$s" >&2 || true
	done
	[ -z "$systemd" ] || systemctl --user status agentbot.service --no-pager >&2 || true
}

fail() {
	say "FAILED: $*"
	diagnostics
	exit 1
}

# `<status> <version>` of GET http://127.0.0.1:<port><path> inside a service's container, or nothing.
health() {
	compose exec -T "$1" bun -e "
		const r = await fetch('http://127.0.0.1:$2$3', { signal: AbortSignal.timeout(3000) });
		console.log(r.status, (await r.json()).version ?? '')" 2>/dev/null || true
}

# --- preflight ---
# systemd as init; not `systemctl --user`, whose manager only runs with linger or a login session (the linger check).
systemd=""
if [ -d /run/systemd/system ]; then systemd=1; fi
user=$(id -un)
rootless=$(podman info --format '{{.Host.Security.Rootless}}') || { say "podman info failed"; exit 1; }
[ "$rootless" = true ] || { say "the Podman connection is rootful; deploy as the stack's user with rootless Podman"; exit 1; }
if [ -n "$systemd" ] && [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != yes ]; then
	say "linger is off for $user, so the stack would stop at logout and not start at boot. Run once: sudo loginctl enable-linger $user"
	exit 1
fi

# --- deploy directory: compose.yaml and secrets ---
say "deploying $AGENTBOT_IMAGE as $user into $dir (previous ${previous:-none})"
install -m 0644 "$root/compose.yaml" "$dir/compose.yaml"
# Relative paths in .env are relative to the deploy directory, for compose and here alike.
(cd "$dir" && AGENTBOT_SECRETS_DIR="${AGENTBOT_SECRETS_DIR:-$dir/secrets}" "$root/scripts/init-secrets.sh") | sed 's/^/  /' >&2 ||
	fail "scripts/init-secrets.sh failed"

# --- pull, pin the version in .env (the exported AGENTBOT_IMAGE wins over .env until then), start ---
compose pull >&2 || fail "podman compose pull failed; the stack and .env are unchanged"
grep -v '^AGENTBOT_IMAGE=' "$env_file" >"$env_file.new" || true
echo "AGENTBOT_IMAGE=$AGENTBOT_IMAGE" >>"$env_file.new"
mv "$env_file.new" "$env_file"
start=$SECONDS
compose up -d >&2 || fail "podman compose up -d failed"
if [ -n "$systemd" ]; then
	mkdir -p "$unit_dir"
	sed "s|%h/agentbot|$dir|g" "$root/deploy/podman/agentbot.service" >"$unit_dir/agentbot.service"
	systemctl --user daemon-reload
	systemctl --user enable --now agentbot.service >&2 || fail "systemctl --user enable --now agentbot.service failed"
else
	say "no systemd user manager: the stack will not start at boot by itself (deploy/podman/agentbot.service)"
fi

# --- verify ---
deadline=$((start + timeout))
orch_health=""
web_health=""
while :; do
	orch_health=$(health orchestrator 8081 /readyz)
	web_health=$(health web 8080 /healthz)
	[ "$orch_health" = "200 $version" ] && [ "$web_health" = "200 $version" ] && break
	[ "$SECONDS" -lt "$deadline" ] || fail "no version $version in health within $timeout s: orchestrator /readyz '${orch_health:-no answer}', web /healthz '${web_health:-no answer}'"
	sleep 2
done
say "$version is live after $((SECONDS - start)) s: orchestrator /readyz and web /healthz report it (rollback: $0 ${previous:-<previous version>})"

# --- cleanup: keep this version and the previous one; images still used by running workers stay too ---
podman images --format '{{.Repository}} {{.Tag}}' | while read -r repo tag; do
	[ "$repo" = "$image" ] && [ "$tag" != "$version" ] && [ "$tag" != "$previous" ] && [ "$tag" != "<none>" ] || continue
	podman rmi "$image:$tag" >/dev/null 2>&1 && say "removed $image:$tag" || true
done
