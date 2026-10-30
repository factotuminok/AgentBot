#!/usr/bin/env bash
# Creates the stack's secrets once (architecture §7.2): run it before the first `podman compose up -d`.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/init-secrets.sh

Creates AgentBot's four secrets for compose.yaml with strong random values, once. Existing secrets are kept, so it is
safe to run again; values are never printed.

  agentbot_master_key     orchestrator: unlocks the settings at start (SEC-16)
  agentbot_web_api_token  orchestrator + web: the admin API
  agentbot_worker_token   orchestrator, and workers through the launcher: the run protocol
  agentbot_scale_token    orchestrator + launcher: /internal/scale

Each is a file (mode 0400) in the secrets directory, which compose mounts per service. The worker token is also a
Podman secret with the same value, created on the current Podman connection: the launcher hands it to workers by name.
Run it as the user that runs the stack, on the rootless connection (CONTAINER_CONNECTION or `podman system connection`).

Environment:
  AGENTBOT_SECRETS_DIR    secrets directory (default: secrets/ next to compose.yaml); compose reads the same variable
  AGENTBOT_WORKER_SECRET  name of the worker token's Podman secret (default agentbot_worker_token)
  PODMAN                  podman command (default podman)
EOF
}

case "${1:-}" in
-h | --help) usage; exit 0 ;;
"") ;;
*) usage >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="${AGENTBOT_SECRETS_DIR:-$root/secrets}"
worker_secret="${AGENTBOT_WORKER_SECRET:-agentbot_worker_token}"
podman="${PODMAN:-podman}"

die() {
	echo "init-secrets: $*" >&2
	exit 1
}

rootless=$($podman info --format '{{.Host.Security.Rootless}}') || die "podman info failed; is the Podman connection up?"
[ "$rootless" = true ] || die "the current Podman connection is rootful; the stack needs rootless Podman (set CONTAINER_CONNECTION)"

# 64 hex characters (256 bits) from the kernel's CSPRNG.
random_value() {
	od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

mkdir -p "$dir"
chmod 0700 "$dir"
for name in agentbot_master_key agentbot_web_api_token agentbot_worker_token agentbot_scale_token; do
	file="$dir/$name"
	if [ -s "$file" ]; then
		echo "kept    $file"
	else
		(umask 077 && random_value >"$file")
		echo "created $file"
	fi
	chmod 0400 "$file"
done

# A confined container may read a bind-mounted file only with the container_file_t label (SELinux hosts).
if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then
	chcon -t container_file_t "$dir"/agentbot_*
fi

token_file="$dir/agentbot_worker_token"
if $podman secret exists "$worker_secret"; then
	# --showsecret needs Podman >= 4.7; without it the values cannot be compared.
	if stored=$($podman secret inspect --showsecret --format '{{.SecretData}}' "$worker_secret" 2>/dev/null); then
		[ "$stored" = "$(cat "$token_file")" ] \
			|| die "Podman secret $worker_secret differs from $token_file; remove it (podman secret rm $worker_secret) and run this again"
	fi
	echo "kept    Podman secret $worker_secret"
else
	$podman secret create "$worker_secret" - <"$token_file" >/dev/null
	echo "created Podman secret $worker_secret"
fi
