#!/usr/bin/env bash
# Launcher smoke test on real Podman (architecture LCH-01 to LCH-04, spike S6). Run from anywhere:
#   test/e2e/launcher/smoke.sh
# 1. Rootless engine: runs `agentbot launcher` in a container with the rootless socket mounted (keep-id + label=disable,
#    as compose does), against a stub orchestrator reporting STUB_PENDING runs and a stub worker image. Checks that
#    worker containers appear (never more than the capacity), get the S6 create spec, and are gone once the runs end;
#    that each worker runs with the F7 hardening (no_new_privileges, no capabilities, pids limit, the
#    AGENTBOT_WORKER_CPUS quota) and the OBS-01 health check;
#    that the reaper removed a labelled exited decoy and left unlabelled and other-role ones alone; that
#    `agentbot health` passes; and that SIGTERM stops the launcher with exit 0.
# 2. Rootful engine: the same launcher image with the rootful socket mounted must refuse with exit 2.
# Env: ROOTLESS_CONNECTION / ROOTLESS_SOCKET (VM path of the user socket), ROOTFUL_CONNECTION / ROOTFUL_SOCKET,
# STUB_PENDING (default 3), CAPACITY (default 2). Containers, the network and the secrets are removed on exit.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
rootless_conn="${ROOTLESS_CONNECTION:-podman-machine-default}"
rootless_sock="${ROOTLESS_SOCKET:-/run/user/501/podman/podman.sock}"
rootful_conn="${ROOTFUL_CONNECTION:-podman-machine-default-root}"
rootful_sock="${ROOTFUL_SOCKET:-/run/podman/podman.sock}"
pending="${STUB_PENDING:-3}"
capacity="${CAPACITY:-2}"
P="podman --connection $rootless_conn"
R="podman --connection $rootful_conn"
prefix=agentbot-e2e-launcher
launcher_image="localhost/$prefix:latest"
worker_image="localhost/$prefix-worker:latest"
net="$prefix-net"

fail() {
	echo "FAIL: $*" >&2
	echo "== launcher log" >&2
	$P logs "$prefix" 2>&1 | tail -40 >&2 || true
	exit 1
}

cleanup() {
	$P rm -f "$prefix" "$prefix-orchestrator" "$prefix-decoy-worker" "$prefix-decoy-plain" "$prefix-decoy-web" >/dev/null 2>&1 || true
	$P network rm "$net" >/dev/null 2>&1 || true
	rm -f "${worker_log:-}"
	$P secret rm "${prefix}_worker_token" "${prefix}_scale_token" >/dev/null 2>&1 || true
	$R rm -f "$prefix-rootful" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

build() {
	$1 build -q -f "$root/test/e2e/launcher/Containerfile" --ignorefile "$root/test/e2e/launcher/Containerfile.containerignore" --target "$2" -t "$3" "$root" >/dev/null
}

echo "== build (rootless)"
build "$P" launcher "$launcher_image"
build "$P" worker "$worker_image"

$P network create "$net" >/dev/null
openssl rand -hex 32 | $P secret create "${prefix}_worker_token" - >/dev/null
openssl rand -hex 32 | $P secret create "${prefix}_scale_token" - >/dev/null

# Exited decoys: only the one labelled agentbot.role=worker may be reaped.
$P run --name "$prefix-decoy-worker" --label agentbot.role=worker --entrypoint true "$worker_image" >/dev/null
$P run --name "$prefix-decoy-plain" --entrypoint true "$worker_image" >/dev/null
$P run --name "$prefix-decoy-web" --label agentbot.role=web --entrypoint true "$worker_image" >/dev/null

$P run -d --name "$prefix-orchestrator" --network "$net" --network-alias orchestrator \
	--secret "${prefix}_scale_token,target=scale_token,uid=10001" \
	--secret "${prefix}_worker_token,target=worker_token,uid=10001" \
	-e STUB_PENDING="$pending" --entrypoint bun "$launcher_image" /app/stub-orchestrator.ts >/dev/null

echo "== launcher on the rootless socket ($rootless_sock), pending=$pending capacity=$capacity"
$P run -d --name "$prefix" --network "$net" \
	--userns=keep-id:uid=10001,gid=10001 --security-opt label=disable \
	-v "$rootless_sock:/run/podman/podman.sock" \
	--secret "${prefix}_scale_token,target=scale_token,uid=10001" \
	-e AGENTBOT_SCALE_TOKEN_FILE=/run/secrets/scale_token \
	-e AGENTBOT_ORCHESTRATOR_URL=http://orchestrator:8081 \
	-e AGENTBOT_IMAGE="$launcher_image" -e AGENTBOT_WORKER_IMAGE="$worker_image" \
	-e AGENTBOT_WORKER_NETWORK="$net" -e AGENTBOT_WORKER_SECRET="${prefix}_worker_token" \
	-e AGENTBOT_WORKER_CAPACITY="$capacity" -e AGENTBOT_WORKER_MEMORY=256m -e AGENTBOT_WORKER_DISK=1g -e AGENTBOT_WORKER_CPUS=0.5 \
	"$launcher_image" launcher >/dev/null

max=0
inspected=""
worker_log=$(mktemp)
for _ in $(seq 1 180); do
	workers=$($P ps -q --filter label=agentbot.role=worker | wc -l | tr -d ' ')
	[ "$workers" -gt "$max" ] && max=$workers
	if [ "$workers" -gt "$capacity" ]; then fail "$workers workers running, capacity is $capacity"; fi
	if [ -z "$inspected" ] && [ "$workers" -gt 0 ]; then
		inspected=$($P ps --filter label=agentbot.role=worker --format '{{.Names}}' | head -1)
		echo "== podman ps (workers)"
		$P ps --filter label=agentbot.role=worker --format '{{.Names}} {{.Image}} {{.Status}} ports=[{{.Ports}}]'
		echo "== inspect $inspected"
		spec=$($P inspect "$inspected" --format 'Labels.role={{index .Config.Labels "agentbot.role"}} AutoRemove={{.HostConfig.AutoRemove}} Init={{.HostConfig.Init}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} PortBindings={{.HostConfig.PortBindings}} PublishAll={{.HostConfig.PublishAllPorts}} Networks={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}Tmpfs={{.HostConfig.Tmpfs}} User={{.Config.User}} Hostname={{.Config.Hostname}} Cmd={{.Config.Entrypoint}} {{.Config.Cmd}} SecurityOpt={{.HostConfig.SecurityOpt}} CapDrop={{.HostConfig.CapDrop}} EffectiveCaps={{.EffectiveCaps}} PidsLimit={{.HostConfig.PidsLimit}} CpuQuota={{.HostConfig.CpuQuota}} CpuPeriod={{.HostConfig.CpuPeriod}} Healthcheck={{.Config.Healthcheck.Test}} interval={{.Config.Healthcheck.Interval}} timeout={{.Config.Healthcheck.Timeout}} start={{.Config.Healthcheck.StartPeriod}} retries={{.Config.Healthcheck.Retries}}') \
			|| fail "worker $inspected was removed before it could be inspected"
		echo "$spec"
		case "$spec" in *"Init=true"*) ;; *) fail "worker created without init" ;; esac
		# F7 and OBS-01, as the engine applied them.
		for want in "no-new-privileges" "EffectiveCaps=[]" "PidsLimit=4096" "CpuQuota=50000 CpuPeriod=100000" \
			"Healthcheck=[CMD agentbot health] interval=30s timeout=5s start=30s retries=3"; do
			case "$spec" in *"$want"*) ;; *) fail "worker spec lacks: $want" ;; esac
		done
		$P logs -f "$inspected" >"$worker_log" 2>&1 &
	fi
	left=$($P exec "$prefix-orchestrator" bun -e 'console.log((await (await fetch("http://127.0.0.1:8081/pending")).json()).pendingRuns)' 2>/dev/null || echo "?")
	# Done once no run is pending and every worker container, running or exited, is gone (auto-remove lags exit).
	existing=$($P ps -aq --filter label=agentbot.role=worker --filter name="^agentbot-worker-" | wc -l | tr -d ' ')
	if [ "$left" = 0 ] && [ "$existing" = 0 ] && [ "$max" -gt 0 ]; then break; fi
	sleep 0.5
done
[ "$max" -gt 0 ] || fail "no worker container was started"
[ "$left" = 0 ] || fail "stub orchestrator still has $left pending runs"
[ "$existing" = 0 ] || fail "worker containers left behind"
echo "== workers: peak $max running (capacity $capacity), none left; first worker's log:"
sed 's/^/  /' "$worker_log"
# Podman bind-mounts catatonit at /run/podman-init, so PID 1's comm is `podman-init`.
grep -qE '"pid1":"(podman-init|catatonit)"' "$worker_log" || fail "PID 1 in the worker is not Podman's init (catatonit)"
# Inside the worker (F7): no capabilities at all, no privilege gain through setuid binaries, 4096 processes, half a CPU.
for want in '"noNewPrivs":"1"' '"capEff":"0000000000000000"' '"capBnd":"0000000000000000"' '"pidsMax":"4096"' '"cpuMax":"50000 100000"'; do
	grep -qF "$want" "$worker_log" || fail "worker log lacks $want"
done
echo "== stub orchestrator log"
$P logs "$prefix-orchestrator" | sed 's/^/  /'

echo "== reaper"
$P container exists "$prefix-decoy-worker" && fail "labelled exited decoy was not reaped"
$P container exists "$prefix-decoy-plain" || fail "unlabelled decoy was removed"
$P container exists "$prefix-decoy-web" || fail "agentbot.role=web decoy was removed"
echo "labelled decoy reaped; unlabelled and role=web decoys kept"

echo "== agentbot health (launcher)"
$P exec "$prefix" agentbot health || fail "launcher health failed"

echo "== SIGTERM"
$P stop -t 10 "$prefix" >/dev/null
code=$($P inspect "$prefix" --format '{{.State.ExitCode}}')
[ "$code" = 0 ] || fail "launcher exited $code on SIGTERM"
echo "launcher exit=$code"
echo "== launcher log"
$P logs "$prefix" | sed 's/^/  /'

echo "== launcher on the rootful socket ($rootful_conn: $rootful_sock)"
build "$R" launcher "$launcher_image"
# uid 0 with label=disable can open the rootful socket, so the refusal below is LCH-01's rootless check itself.
set +e
out=$($R run --name "$prefix-rootful" --user 0 --security-opt label=disable \
	-v "$rootful_sock:/run/podman/podman.sock" \
	-e AGENTBOT_WORKER_NETWORK="$net" -e AGENTBOT_IMAGE="$launcher_image" -e AGENTBOT_SCALE_TOKEN_FILE=/tmp/scale_token \
	--entrypoint sh "$launcher_image" -c 'echo test > /tmp/scale_token && exec agentbot launcher' 2>&1)
code=$?
set -e
echo "$out" | sed 's/^/  /'
[ "$code" = 2 ] || fail "rootful socket: launcher exited $code, expected 2"
echo "$out" | grep -q 'the Podman socket is rootful' || fail "rootful socket: no rootful refusal logged"
echo "rootful socket refused with exit 2"
echo "PASS"
