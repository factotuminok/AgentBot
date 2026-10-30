#!/usr/bin/env bash
# Compose stack smoke test on real rootless Podman (architecture §7.2, requirements OPS-03; README.md next to this file).
#   test/e2e/compose/smoke.sh
# 1. Builds the image on the rootless engine (BUILD=0 reuses it), creates the secrets with scripts/init-secrets.sh (twice,
#    to show it keeps them) and starts compose.yaml with `podman compose up -d` under its own project, network, port,
#    secrets directory and worker-token secret name. Waits until orchestrator, web and launcher are healthy.
# 2. Worker network (security review F6): a container on the workers network, as a worker is, reaches the orchestrator
#    but not web, neither by name nor by web's address on the stack network.
# 3. Creates the admin through /setup with the setup token from `podman compose logs orchestrator`, saves an MCP server
#    on the omp page (a stdio server written in an inline `bun -e` script) and clicks "Test connection". The test runs on
#    a real worker container: exactly one must appear for it, on the workers network only, the test must connect and
#    list the server's tool, and no worker may remain afterwards. Prints `podman stats` for the stack and the worker
#    while it runs.
# 4. Runs the same image as the launcher service against the rootful socket: it must refuse with exit 2 (LCH-01).
# 5. Tears everything down (KEEP=1 leaves the stack running and prints how to remove it).
# Env: ROOTLESS_CONNECTION (default podman-machine-default; empty = the local podman), ROOTFUL_PODMAN (default
# `podman --connection podman-machine-default-root`; e.g. `sudo podman` on a Linux host), ROOTFUL_SOCKET, IMAGE
# (default localhost/agentbot:dev), BUILD (default 1), WEB_PORT (default 18080), MCP_DELAY_MS (default 4000: how long
# the MCP server takes to answer `initialize`, so the worker is visible), KEEP.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
rootless_conn="${ROOTLESS_CONNECTION-podman-machine-default}"
rootful_sock="${ROOTFUL_SOCKET:-/run/podman/podman.sock}"
image="${IMAGE:-localhost/agentbot:dev}"
port="${WEB_PORT:-18080}"
delay="${MCP_DELAY_MS:-4000}"
project=agentbot-e2e-compose
net=agentbot-e2e-compose
# compose.yaml names the workers network after the stack network.
workers_net="$net-workers"
worker_secret=agentbot_e2e_compose_worker_token
base="http://127.0.0.1:$port"
P="podman${rootless_conn:+ --connection $rootless_conn}"
R="${ROOTFUL_PODMAN:-podman --connection podman-machine-default-root}"
work="$(mktemp -d)"
# shellcheck source=rootless-socket.sh
. "$root/test/e2e/compose/rootless-socket.sh"

now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f s", ms / 1000 }'; }

# The compose provider talks to DOCKER_HOST. `podman compose` points it at the machine's API socket, which is the
# rootful engine on a rootful podman machine, so the rootless socket is forwarded over the connection's ssh instead.
forward_rootless_socket "$rootless_conn" "$work"

export AGENTBOT_IMAGE="$image" AGENTBOT_NETWORK="$net" AGENTBOT_WORKER_SECRET="$worker_secret" AGENTBOT_WEB_HOST_PORT="$port"
export AGENTBOT_HOST_PODMAN_SOCKET="$host_sock" AGENTBOT_SECRETS_DIR="$work/secrets" AGENTBOT_WORKER_CAPACITY=2
# PODMAN_COMPOSE_WARNING_LOGS=false drops podman's "Executing external compose provider" banner.
export PODMAN_COMPOSE_WARNING_LOGS=false
C="podman compose -f $root/compose.yaml -p $project"
compose() { $C "$@" 2>&1; }

teardown() {
	compose down -v --remove-orphans >/dev/null || true
	$P secret rm "$worker_secret" >/dev/null 2>&1 || true
}

cleanup() {
	if [ "${KEEP:-}" = 1 ]; then
		echo "== KEEP=1: the stack keeps running on $base (admin / ${password:-not created}). Remove it with:"
		echo "   DOCKER_HOST=$DOCKER_HOST $C down -v; $P secret rm $worker_secret"
		echo "   (the ssh forward $forward_pid and $work stay for that)"
		return
	fi
	teardown
	[ -n "$forward_pid" ] && kill "$forward_pid" 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	for s in orchestrator web launcher; do
		echo "== $s log" >&2
		compose logs --no-color --tail 30 "$s" >&2 || true
	done
	exit 1
}

# Containers of one compose service (works with docker-compose and podman-compose labels).
cid() { $P ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"; }
workers() { $P ps -a --filter label=agentbot.role=worker --filter "network=$workers_net" --format "$1"; }

echo "== clean state (project $project, networks $net and $workers_net, secret $worker_secret)"
teardown
[ -z "$($P ps -aq --filter "label=com.docker.compose.project=$project")" ] || fail "containers of $project left over"
[ -z "$(workers '{{.Names}}')" ] || fail "worker containers on $workers_net left over"

if [ "${BUILD:-1}" = 1 ]; then
	echo "== build $image (rootless)"
	start=$(now_ms)
	$P build -q -t "$image" "$root" >/dev/null
	echo "built in $(secs $(($(now_ms) - start)))"
fi

echo "== scripts/init-secrets.sh (twice: the second run keeps everything)"
"$root/scripts/init-secrets.sh" | sed "s|$work|\$work|; s/^/  /"
"$root/scripts/init-secrets.sh" | sed "s|$work|\$work|; s/^/  /"

echo "== podman compose up -d"
start=$(now_ms)
compose up -d >"$work/up.log" || { cat "$work/up.log"; fail "podman compose up -d failed"; }
sed 's/^/  /' "$work/up.log"
healthy=""
for _ in $(seq 1 120); do
	states=""
	for s in orchestrator web launcher; do
		id=$(cid "$s")
		[ -n "$id" ] || fail "no $s container"
		states="$states $($P inspect --format '{{.State.Health.Status}}' "$id")"
	done
	if [ "$states" = " healthy healthy healthy" ]; then healthy=1; break; fi
	sleep 1
done
[ -n "$healthy" ] || fail "services not healthy:$states"
up_ms=$(($(now_ms) - start))
$P ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}  {{.Status}}  {{.Ports}}' | sed 's/^/  /'
echo "all three services healthy $(secs $up_ms) after up -d"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/healthz")" = 200 ] || fail "web /healthz on $base is not 200"

echo "== worker network $workers_net (F6): only the orchestrator is reachable"
# podman-compose passes `isolate: strict` on; Podman's Docker API drops it (docker-compose), and Podman >= 6 isolates
# bridge networks by default. Either way the probe below must show the isolation.
options=$($P network inspect "$workers_net" --format '{{.Options}}')
echo "  options $options (podman $($P version --format '{{.Server.Version}}'))"
for s in orchestrator web launcher; do
	echo "  $s: $($P inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' "$(cid "$s")")"
done
web_ip=$($P inspect --format "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$(cid web)")
[ -n "$web_ip" ] || fail "web has no address on $net"
workers_gw=$($P network inspect "$workers_net" --format '{{range .Subnets}}{{.Gateway}}{{end}}')
probe_js='for (const url of process.argv.slice(1)) console.log(url, await fetch(url, { signal: AbortSignal.timeout(3000) }).then(r => String(r.status), e => e.name))'
# The last three are web's published host port, through the host address and the network's own gateway: Podman forwards
# a published port from there too, across isolated networks (netavark >= 2.1). Informational: the known residual of F6.
$P run --rm --network "$workers_net" --user 10001:10001 --entrypoint bun "$image" -e "$probe_js" \
	http://orchestrator:8081/healthz http://web:8080/healthz "http://$web_ip:8080/healthz" \
	"http://host.containers.internal:$port/healthz" "http://169.254.1.2:$port/healthz" "http://$workers_gw:$port/healthz" \
	>"$work/probe.log" 2>&1 || { cat "$work/probe.log"; fail "the probe container failed"; }
sed 's/^/  /' "$work/probe.log"
grep -qx 'http://orchestrator:8081/healthz 200' "$work/probe.log" || fail "a worker cannot reach the orchestrator"
grep -qE '^http://web:8080/healthz [0-9]+$' "$work/probe.log" && fail "a worker reaches web:8080 by name"
grep -qE "^http://$web_ip:8080/healthz [0-9]+$" "$work/probe.log" && fail "a worker reaches web at $web_ip:8080"
echo "a worker reaches the orchestrator, but not web:8080 by name or address (published host port: informational)"

echo "== /setup with the setup token from podman compose logs orchestrator"
token=$(compose logs --no-color orchestrator | grep -o '"setupToken":"[^"]*"' | tail -1 | cut -d'"' -f4)
[ -n "$token" ] || fail "no setup token in the orchestrator log"
password="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
jar="$work/cookies"
post() { curl -s -b "$jar" -c "$jar" -o "$work/body.html" -w '%{http_code} %{redirect_url}' -H "Origin: $base" "$@"; }
out=$(post --data-urlencode "token=$token" --data-urlencode username=admin --data-urlencode "password=$password" --data-urlencode "confirm=$password" "$base/setup")
[ "$out" = "303 $base/" ] || fail "setup answered $out"
echo "admin created"

echo "== save MCP server e2e (stdio: bun -e <inline MCP server, initialize answered after ${delay} ms>)"
mcp_script=$(cat <<'EOF'
let b="";const send=(m,r)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\n");process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;if(m.method==="initialize")setTimeout(()=>send(m,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"e2e",version:"1"}}),DELAY);else send(m,m.method==="tools/list"?{tools:[{name:"echo",description:"Echoes its input",inputSchema:{type:"object",properties:{}}}]}:{})}})
EOF
)
out=$(post --data-urlencode mcp.0.name=e2e --data-urlencode mcp.0.type=stdio --data-urlencode mcp.0.enabled=on \
	--data-urlencode mcp.0.command=bun --data-urlencode "mcp.0.args=-e
${mcp_script//DELAY/$delay}" "$base/admin/omp")
[ "$out" = "303 $base/admin/omp" ] || fail "saving the omp configuration answered $out: $(sed 's/<[^>]*>//g' "$work/body.html" | grep -i error)"
curl -s -b "$jar" -o "$work/omp.html" "$base/admin/omp"
grep -q 'MCP server e2e' "$work/omp.html" || fail "the omp page does not list MCP server e2e"
echo "saved"

echo "== Test connection"
events_since=$(($(date +%s) - 5))
start=$(now_ms)
out=$(post --data-urlencode server=e2e "$base/admin/omp/mcp/test")
case "$out" in "303 $base/admin/omp/mcp/test/"*) ;; *) fail "Test connection answered $out" ;; esac
page="${out#303 }"
echo "test page ${page#$base}"
seen=""
status=""
for _ in $(seq 1 300); do
	listed=$(workers '{{.Names}}  {{.Image}}  {{.Status}}  networks={{.Networks}}  ports=[{{.Ports}}]')
	if [ -n "$listed" ]; then
		for name in $(echo "$listed" | awk '{ print $1 }'); do
			case " $seen " in *" $name "*) ;; *)
				seen="$seen $name"
				echo "== podman ps --filter label=agentbot.role=worker --filter network=$workers_net (during the test)"
				echo "$listed" | sed 's/^/  /'
				echo "$listed" | grep "^$name " >>"$work/listed"
				echo "== podman stats --no-stream (during the test)"
				$P stats --no-stream --format '{{.Name}}  mem={{.MemUsage}}  cpu={{.CPUPerc}}' \
					$(cid orchestrator) $(cid web) $(cid launcher) "$name" 2>/dev/null | sed 's/^/  /' || true
				;;
			esac
		done
	fi
	status=$(curl -s -b "$jar" "$page.json" | bun -e 'process.stdout.write((await Bun.stdin.json()).status ?? "")' 2>/dev/null || true)
	if [ "$status" = done ] && [ -z "$listed" ] && [ -n "$seen" ]; then break; fi
	sleep 0.2
done
test_ms=$(($(now_ms) - start))
[ -n "$seen" ] || fail "no worker container appeared on $workers_net"
set -- $seen
[ $# = 1 ] || fail "$# worker containers appeared for one test:$seen"
worker="$1"
# The worker joined the workers network only, never the stack network with web on it (F6).
grep -qE "^$worker .*  networks=\[?$workers_net\]?  " "$work/listed" || fail "worker $worker is not on $workers_net alone: $(cat "$work/listed")"
[ "$status" = done ] || fail "the MCP test did not finish (status $status)"
[ -z "$(workers '{{.Names}}')" ] || fail "worker containers remain on $workers_net"
echo "== after the test: podman ps -a --filter label=agentbot.role=worker --filter network=$workers_net"
echo "  (none)"

echo "== worker events ($worker)"
# Read afterwards: a live `podman events` stream over the remote connection may not have flushed the last events yet.
for _ in $(seq 1 20); do
	$P events --since "$events_since" --until 0s --filter label=agentbot.role=worker \
		--format '{{.TimeNano}} {{.Status}} {{.Name}}' | awk -v w="$worker" '$3 == w' >"$work/events"
	grep -q ' remove ' "$work/events" && break
	sleep 0.5
done
while read -r ns event name; do
	echo "  $(date -r $((ns / 1000000000)) +%T 2>/dev/null || date -d @$((ns / 1000000000)) +%T) $event $name"
done <"$work/events"
created=$(awk '$2 == "create" { print $1; exit }' "$work/events")
removed=$(awk '$2 == "remove" { print $1; exit }' "$work/events")
[ -n "$created" ] && [ -n "$removed" ] || fail "missing create/remove events for $worker"
worker_ms=$(( (removed - created) / 1000000 ))

echo "== test result page"
curl -s -b "$jar" "$page" >"$work/result.html"
sed -n '/<h1>Test MCP server/,/Back to omp configuration/p' "$work/result.html" | sed 's/<[^>]*>/ /g; s/  */ /g; s/^ //; /^$/d' | sed 's/^/  /'
grep -q 'Connected to e2e: 1 tool' "$work/result.html" || fail "the MCP test did not connect"
grep -q 'mcp__e2e_echo' "$work/result.html" || fail "the MCP test did not list mcp__e2e_echo"

echo "== orchestrator and launcher log lines for the test"
compose logs --no-color orchestrator launcher | grep -E 'MCP connection test|worker (connected|disconnected)|starting workers|worker container started' | sed 's/^/  /'

echo "== launcher image against the rootful socket ($R, $rootful_sock)"
if [ "${BUILD:-1}" = 1 ]; then $R build -q -t "$image" "$root" >/dev/null; fi
set +e
out=$($R run --rm --user 0 --security-opt label=disable -v "$rootful_sock:/run/podman/podman.sock" \
	-v "$work/secrets/agentbot_scale_token:/run/secrets/agentbot_scale_token:ro" \
	-e AGENTBOT_ROLE=launcher -e AGENTBOT_IMAGE="$image" -e AGENTBOT_WORKER_NETWORK="$net" \
	-e AGENTBOT_SCALE_TOKEN_FILE=/run/secrets/agentbot_scale_token "$image" launcher 2>&1)
code=$?
set -e
echo "$out" | sed 's/^/  /'
[ "$code" = 2 ] || fail "rootful socket: the launcher exited $code, expected 2"
case "$out" in *'the Podman socket is rootful (LCH-01)'*) ;; *) fail "rootful socket: no LCH-01 refusal logged" ;; esac
echo "launcher exit=$code"

echo "== timings"
echo "  stack up -d to all healthy: $(secs $up_ms)"
echo "  worker container create to remove: $(secs $worker_ms) (MCP server answers initialize after ${delay} ms)"
echo "  Test connection to result shown and worker gone: $(secs $test_ms)"
echo "PASS"
