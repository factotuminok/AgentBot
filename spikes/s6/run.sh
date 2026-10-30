#!/usr/bin/env bash
# Spike S6 driver. Runs against the rootless engine of the podman machine.
# Setup (once): see wiki/spikes/S6.md "Reproduce". Usage: spikes/s6/run.sh [none|tmpfs|storage-opt]
# Env: S6_PENDING, S6_CAPACITY, S6_MEMORY (bytes), S6_DURATION_MS.
set -uo pipefail
P="podman -c ${S6_CONNECTION:-podman-machine-default}"
I=localhost/agentbot-spike-s6:latest
SOCK=${S6_SOCKET:-/run/user/501/podman/podman.sock}
SCRATCH=${1:-none}

# Fresh stub orchestrator, reachable as "orchestrator" (the compose service name) on the network.
$P rm -f agentbot-spike-s6-stub >/dev/null 2>&1
$P run -d --name agentbot-spike-s6-stub --network agentbot-spike-s6-net --network-alias orchestrator \
	--secret agentbot_spike_s6_scale_token,target=scale_token \
	--secret agentbot_spike_s6_worker_token,target=worker_token \
	-e SPIKE_PENDING=${S6_PENDING:-1} "$I" stub.ts >/dev/null
sleep 1

EVLOG=$(mktemp)
$P events --filter label=agentbot.role=worker --format '{{.Time}} {{.Status}} {{.Name}} exit={{.ContainerExitCode}}' >"$EVLOG" 2>&1 &
EVPID=$!

$P run -d --name agentbot-spike-s6-launcher \
	--network agentbot-spike-s6-net \
	--userns=keep-id:uid=10001,gid=10001 \
	--security-opt label=disable \
	-e AGENTBOT_WORKER_MEMORY=${S6_MEMORY:-268435456} \
	-e AGENTBOT_WORKER_CAPACITY=${S6_CAPACITY:-4} \
	-e AGENTBOT_ORCHESTRATOR_URL=http://orchestrator:8081 \
	-v "$SOCK:/run/podman/podman.sock" \
	--secret agentbot_spike_s6_scale_token,target=scale_token,uid=10001 \
	-e SPIKE_DURATION_MS=${S6_DURATION_MS:-14000} \
	-e SPIKE_SCRATCH="$SCRATCH" -e SPIKE_SCRATCH_SIZE=512m \
	"$I" launcher.ts >/dev/null

# Inspect the first worker while it runs.
for _ in $(seq 1 40); do
	W=$($P ps --filter label=agentbot.role=worker --filter status=running --format '{{.Names}}' | grep worker- | head -1)
	[ -n "$W" ] && break
	sleep 0.5
done
if [ -n "${W:-}" ]; then
	WLOG=$(mktemp)
	$P logs -f "$W" >"$WLOG" 2>&1 &
	echo "== inspect $W"
	$P inspect "$W" --format 'Labels.role={{index .Config.Labels "agentbot.role"}} AutoRemove={{.HostConfig.AutoRemove}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} Ports={{.NetworkSettings.Ports}} PortBindings={{.HostConfig.PortBindings}} PublishAll={{.HostConfig.PublishAllPorts}} Networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}} Tmpfs={{.HostConfig.Tmpfs}} User={{.Config.User}}'
	$P inspect "$W" --format '{{json .Mounts}}'
	$P port "$W"; echo "port exit=$?"
fi

$P wait agentbot-spike-s6-launcher >/dev/null
echo "== launcher log"
$P logs agentbot-spike-s6-launcher | grep -v '"msg":"create"'
echo "== create spec (first)"
$P logs agentbot-spike-s6-launcher | grep -m1 '"msg":"create"'
$P rm agentbot-spike-s6-launcher >/dev/null
if [ -n "${WLOG:-}" ]; then
	echo "== worker log ($W)"
	cat "$WLOG"; rm -f "$WLOG"
	echo "== worker still exists?"; $P container exists "$W"; echo "exists exit=$? (1 = removed)"
fi
kill $EVPID 2>/dev/null
echo "== worker events"
cat "$EVLOG"; rm -f "$EVLOG"
echo "== stub log"
$P logs agentbot-spike-s6-stub
echo "== containers left"
$P ps -a --format '{{.Names}} {{.Status}}'
echo "== containers left with agentbot.role=worker"
$P ps -a --filter label=agentbot.role=worker --format '{{.Names}} {{.Status}}'
