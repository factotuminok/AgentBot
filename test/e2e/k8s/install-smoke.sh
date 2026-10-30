#!/usr/bin/env bash
# Helm chart install smoke test on kind with KEDA and the real image (architecture §7.3, requirements OPS-07, OPS-08).
#   test/e2e/k8s/install-smoke.sh
# 1. Builds localhost/agentbot:dev on the rootful Podman engine (BUILD=0 reuses it), brings up the shared kind cluster
#    with test/e2e/k8s/kind.sh and loads the image.
# 2. Shows the chart's KEDA check: `helm template` without the ScaledJob API fails with the OPS-08 message, and renders
#    against the cluster's own API list (`--validate`), which has it.
# 3. `helm install --wait` with small resources (worker.maxReplicas 2) into its own namespace; prints the objects, the
#    orchestrator's /readyz body (limits, capacity) and NOTES.
# 4. Through a port-forward to the web Service: /setup with the setup token from `kubectl logs deploy/<orchestrator>`,
#    saves an MCP server and clicks "Test connection". The test runs on a real worker Job pod: exactly one must appear,
#    become Ready (claimed), connect and list the tool, and no worker pod may remain (Job TTL 60 s).
# 5. NetworkPolicies (SEC-15, F5): a pod labelled as a worker reaches orchestrator:8081 and the public npm registry but
#    neither web:8080 nor another pod's address (CoreDNS's readiness port); an unlabelled pod reaches neither AgentBot
#    service.
# 6. `helm upgrade` (a changed value) keeps the generated Secret's values.
# 7. Uninstalls and deletes the namespace (KEEP=1 leaves it; the cluster always stays: kind.sh down removes it).
# Env: IMAGE (default localhost/agentbot:dev), BUILD (default 1), ROOTFUL_PODMAN (default
# `podman --connection podman-machine-default-root`), HELM (default .tools/helm), NAMESPACE (default agentbot-smoke),
# RELEASE (default agentbot), WEB_PORT (default 18090), MCP_DELAY_MS (default 4000), KEEP.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${IMAGE:-localhost/agentbot:dev}"
R="${ROOTFUL_PODMAN:-podman --connection podman-machine-default-root}"
helm="${HELM:-$root/.tools/helm}"
ns="${NAMESPACE:-agentbot-smoke}"
release="${RELEASE:-agentbot}"
port="${WEB_PORT:-18090}"
delay="${MCP_DELAY_MS:-4000}"
chart="$root/deploy/helm/agentbot"
ctx=kind-agentbot-e2e
k="kubectl --context $ctx -n $ns"
base="http://127.0.0.1:$port"
work="$(mktemp -d)"
forward_pid=""
# The chart's object names for release "agentbot" (fullname = the release name when it contains the chart name).
case "$release" in *agentbot*) full="$release" ;; *) full="$release-agentbot" ;; esac
orch="$full-orchestrator"
web="$full-web"
worker_sel="app.kubernetes.io/instance=$release,app.kubernetes.io/component=worker"

now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f s", ms / 1000 }'; }

teardown() {
	"$helm" --kube-context "$ctx" -n "$ns" uninstall "$release" --wait >/dev/null 2>&1 || true
	kubectl --context "$ctx" delete namespace "$ns" --ignore-not-found --wait=true >/dev/null 2>&1 || true
}

cleanup() {
	code=$?
	[ -z "$forward_pid" ] || kill "$forward_pid" 2>/dev/null || true
	if [ "${KEEP:-0}" = 1 ]; then
		echo "KEEP=1: release $release left in namespace $ns; remove with: $helm --kube-context $ctx -n $ns uninstall $release && kubectl --context $ctx delete namespace $ns"
	else
		teardown
	fi
	rm -rf "$work"
	exit $code
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	echo "== pods" >&2
	$k get pods -o wide >&2 2>&1 || true
	echo "== orchestrator log (last 40 lines)" >&2
	$k logs "deploy/$orch" --tail 40 >&2 2>&1 || true
	echo "== events (last 30)" >&2
	$k get events --sort-by .lastTimestamp 2>/dev/null | tail -30 >&2 || true
	exit 1
}

# GET http://127.0.0.1:<port><path> from inside a Deployment's container (the image has no curl).
in_pod() { $k exec "deploy/$1" -- bun -e "const r = await fetch('http://127.0.0.1:$2$3'); console.log(r.status, await r.text())"; }

if [ "${BUILD:-1}" = 1 ]; then
	echo "== build $image (rootful engine)"
	$R build -q -t "$image" "$root" | sed 's/^/  /'
fi

echo "== kind cluster (test/e2e/k8s/kind.sh up $image)"
"$root/test/e2e/k8s/kind.sh" up "$image" 2>&1 | grep -E '^kind.sh:|successfully rolled out' | sed 's/^/  /'
kubectl --context "$ctx" version 2>/dev/null | sed 's/^/  /'
echo "  KEDA $(kubectl --context "$ctx" -n keda get deploy keda-operator -o jsonpath='{.metadata.labels.app\.kubernetes\.io/version}')"

echo "== helm lint"
"$helm" lint "$chart" --strict | sed 's/^/  /'

echo "== KEDA check (OPS-08)"
set +e
out=$("$helm" template "$release" "$chart" -n "$ns" 2>&1)
code=$?
set -e
echo "  helm template without the ScaledJob API: exit $code"
echo "$out" | grep -m1 'KEDA is not installed' | sed 's/^/  /'
[ "$code" != 0 ] && [[ "$out" == *"KEDA is not installed: this cluster has no keda.sh/v1alpha1 ScaledJob API"* ]] || fail "helm template without KEDA did not fail with the KEDA message"
kubectl --context "$ctx" api-resources --api-group keda.sh 2>/dev/null | sed 's/^/  /'
"$helm" --kube-context "$ctx" template "$release" "$chart" -n "$ns" --validate >/dev/null || fail "helm template --validate against the cluster failed"
echo "  helm template --validate against the cluster (its API list has keda.sh/v1alpha1/ScaledJob): ok"

echo "== clean namespace $ns"
teardown

cat >"$work/values.yaml" <<EOF
image:
  repository: ${image%:*}
  tag: ${image##*:}
  pullPolicy: Never
orchestrator:
  resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { memory: 1Gi } }
  persistence: { size: 1Gi }
web:
  resources: { requests: { cpu: 50m, memory: 128Mi }, limits: { memory: 1Gi } }
  persistence: { size: 1Gi }
worker:
  maxReplicas: 2
  diskLimit: 1Gi
  resources: { requests: { cpu: 100m, memory: 256Mi, ephemeral-storage: 100Mi }, limits: { memory: 1Gi } }
EOF

echo "== helm install $release -n $ns (values: $(tr '\n' ' ' <"$work/values.yaml" | tr -s ' ' | cut -c1-120)...)"
start=$(now_ms)
"$helm" --kube-context "$ctx" install "$release" "$chart" -n "$ns" --create-namespace -f "$work/values.yaml" --wait --timeout 5m >"$work/install.log" 2>&1 \
	|| { cat "$work/install.log"; fail "helm install failed"; }
install_ms=$(($(now_ms) - start))
sed -n '1,6p' "$work/install.log" | sed 's/^/  /'
echo "  NOTES:"
sed -n '/^NOTES:/,$p' "$work/install.log" | sed '1d; s/^/    /'
$k rollout status "deploy/$orch" --timeout 60s >/dev/null && $k rollout status "deploy/$web" --timeout 60s >/dev/null || fail "deployments not ready"
echo "orchestrator and web Ready $(secs $install_ms) after helm install"
$k get deploy,svc,pvc,secret,networkpolicy,scaledjob,triggerauthentication 2>&1 | sed 's/^/  /'
secret_before=$($k get secret "$full" -o jsonpath='{.data}' | shasum -a 256 | cut -c1-16)
scale_before=$($k get secret "$full" -o jsonpath='{.data.scale-token}')
# Not Ready until KEDA's first successful /internal/scale poll after the orchestrator listens.
$k wait --for condition=Ready "scaledjob/$full-worker" --timeout 60s >/dev/null || fail "the ScaledJob is not Ready"
$k get scaledjob "$full-worker" | sed 's/^/  /'

echo "== secret files in the orchestrator (readable by 10001 only)"
$k exec "deploy/$orch" -- sh -c 'id; ls -lL /run/secrets/' | sed 's/^/  /'

echo "== orchestrator /readyz (before setup: limits null)"
in_pod "$orch" 8081 /readyz | sed 's/^/  /'

echo "== port-forward svc/$web $port:8080"
$k port-forward "svc/$web" "$port:8080" >"$work/forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 50); do
	[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/healthz" || true)" = 200 ] && break
	sleep 0.2
done
echo "  web /healthz: $(curl -s "$base/healthz")"

echo "== /setup with the setup token from kubectl logs deploy/$orch"
token=$($k logs "deploy/$orch" | grep -o '"setupToken":"[^"]*"' | tail -1 | cut -d'"' -f4)
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
[ "$out" = "303 $base/admin/omp" ] || fail "saving the omp configuration answered $out"
echo "saved"

echo "== Test connection (a worker Job pod runs it)"
[ -z "$($k get pods -l "$worker_sel" -o name)" ] || fail "worker pods exist before the test"
start=$(now_ms)
out=$(post --data-urlencode server=e2e "$base/admin/omp/mcp/test")
case "$out" in "303 $base/admin/omp/mcp/test/"*) ;; *) fail "Test connection answered $out" ;; esac
page="${out#303 }"
echo "test page ${page#$base}"
seen=""
ready=""
status=""
last=""
for _ in $(seq 1 300); do
	listed=$($k get pods -l "$worker_sel" --no-headers -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status' 2>/dev/null || true)
	if [ -n "$listed" ] && [ "$listed" != "$last" ]; then
		echo "  $(date +%T) $(echo "$listed" | tr '\n' ' ')"
		last="$listed"
	fi
	for name in $(echo "$listed" | awk '{ print $1 }'); do
		case " $seen " in *" $name "*) ;; *) seen="$seen $name" ;; esac
	done
	echo "$listed" | awk '$3 == "True"' | grep -q . && ready=1
	status=$(curl -s -b "$jar" "$page.json" | bun -e 'process.stdout.write((await Bun.stdin.json()).status ?? "")' 2>/dev/null || true)
	if [ "$status" = done ] && [ -n "$seen" ]; then break; fi
	sleep 0.5
done
done_ms=$(($(now_ms) - start))
[ -n "$seen" ] || fail "no worker pod appeared"
[ "$status" = done ] || fail "the MCP test did not finish (status $status)"
[ -n "$ready" ] || fail "the worker pod never became Ready (health --claimed)"
echo "test done $(secs $done_ms) after the click"
curl -s -b "$jar" "$page" >"$work/result.html"
sed -n '/<h1>Test MCP server/,/Back to omp configuration/p' "$work/result.html" | sed 's/<[^>]*>/ /g; s/  */ /g; s/^ //; /^$/d' | sed 's/^/  /'
grep -q 'Connected to e2e: 1 tool' "$work/result.html" || fail "the MCP test did not connect"
grep -q 'mcp__e2e_echo' "$work/result.html" || fail "the MCP test did not list mcp__e2e_echo"

echo "== worker pods until none remain (Job ttlSecondsAfterFinished 60)"
for _ in $(seq 1 240); do
	listed=$($k get pods -l "$worker_sel" --no-headers -o custom-columns='NAME:.metadata.name,PHASE:.status.phase' 2>/dev/null || true)
	for name in $(echo "$listed" | awk '{ print $1 }'); do
		case " $seen " in *" $name "*) ;; *) seen="$seen $name" ;; esac
	done
	if [ "$listed" != "$last" ]; then
		echo "  $(date +%T) ${listed:-(none)}" | tr '\n' ' '
		echo
		last="$listed"
	fi
	[ -z "$listed" ] && break
	sleep 1
done
[ -z "$listed" ] || fail "worker pods remain: $listed"
gone_ms=$(($(now_ms) - start))
set -- $seen
[ $# = 1 ] || fail "$# worker pods appeared for one test:$seen"
echo "exactly one worker pod ($1); none left $(secs $gone_ms) after the click"
$k logs "deploy/$orch" | grep -E 'MCP connection test|worker (connected|disconnected)|run claimed' | tail -6 | cut -c1-220 | sed 's/^/  /'

echo "== orchestrator /readyz (after setup: limits and warnings)"
in_pod "$orch" 8081 /readyz | sed 's/^/  /'

echo "== NetworkPolicies (SEC-15, F5)"
# A cluster address the ingress rules leave open: CoreDNS's readiness port. (The Kubernetes API is no such target on a
# one-node kind cluster: it runs on the node itself, and pod-to-own-node traffic is not filtered.)
dns_ip=$(kubectl --context "$ctx" -n kube-system get pod -l k8s-app=kube-dns -o jsonpath='{.items[0].status.podIP}')
[ -n "$dns_ip" ] || fail "no CoreDNS pod address"
probe() {
	# $1 pod name, $2 extra labels; prints "<target> <status|blocked>" for orchestrator:8081, web:8080, CoreDNS:8181 and
	# the npm registry.
	$k run "$1" --image "$image" --image-pull-policy Never --restart Never --labels "$2" \
		--overrides '{"spec":{"automountServiceAccountToken":false,"enableServiceLinks":false,"securityContext":{"runAsUser":10001,"runAsNonRoot":true}}}' \
		--command -- bun -e "for (const u of ['http://$orch:8081/livez', 'http://$web:8080/healthz', 'http://$dns_ip:8181/ready', 'https://registry.npmjs.org/-/ping']) { try { const r = await fetch(u, { signal: AbortSignal.timeout(5000) }); console.log(u, r.status) } catch { console.log(u, 'blocked') } }" >/dev/null
	$k wait --for jsonpath='{.status.phase}'=Succeeded "pod/$1" --timeout 90s >/dev/null || fail "probe pod $1 did not finish"
	$k logs "$1" | sed "s/^/  $1: /"
	$k delete pod "$1" --wait=false >/dev/null
}
probe np-as-worker "app.kubernetes.io/name=agentbot,app.kubernetes.io/instance=$release,app.kubernetes.io/component=worker" | tee "$work/np-worker"
probe np-other "app=other" | tee "$work/np-other"
grep -q "$orch:8081/livez 200" "$work/np-worker" || fail "a worker cannot reach the orchestrator"
grep -q "$web:8080/healthz blocked" "$work/np-worker" || fail "a worker can reach web"
grep -q "$dns_ip:8181/ready blocked" "$work/np-worker" || fail "a worker can reach another pod's address (CoreDNS :8181)"
grep -qE "registry.npmjs.org/-/ping [0-9]+" "$work/np-worker" || fail "a worker cannot reach the npm registry"
grep -qE "$dns_ip:8181/ready [0-9]+" "$work/np-other" || fail "the cluster-address check is void: an unrestricted pod cannot reach CoreDNS :8181 either"
grep -q "$orch:8081/livez blocked" "$work/np-other" || fail "an unlabelled pod can reach the orchestrator"
grep -q "$web:8080/healthz blocked" "$work/np-other" || fail "an unlabelled pod can reach web"

echo "== helm upgrade (web.vscode=false) keeps the generated secrets"
# The web pod is replaced by the upgrade, which ends the port-forward anyway.
kill "$forward_pid" 2>/dev/null || true
wait "$forward_pid" 2>/dev/null || true
forward_pid=""
"$helm" --kube-context "$ctx" upgrade "$release" "$chart" -n "$ns" -f "$work/values.yaml" --set web.vscode=false --wait --timeout 5m >/dev/null || fail "helm upgrade failed"
$k get deploy "$web" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AGENTBOT_WEB_VSCODE")].value}' | grep -qx off || fail "the upgrade did not apply web.vscode=false"
secret_after=$($k get secret "$full" -o jsonpath='{.data}' | shasum -a 256 | cut -c1-16)
scale_after=$($k get secret "$full" -o jsonpath='{.data.scale-token}')
echo "  revision $("$helm" --kube-context "$ctx" -n "$ns" status "$release" -o json | bun -e 'process.stdout.write(String((await Bun.stdin.json()).version))')"
echo "  secret data sha256 before $secret_before, after $secret_after"
echo "  scale-token before ${scale_before:0:12}..., after ${scale_after:0:12}..."
[ "$secret_before" = "$secret_after" ] || fail "helm upgrade changed the generated secrets"
in_pod "$orch" 8081 /readyz | sed 's/^/  /'

echo "== timings"
echo "  helm install to orchestrator + web Ready: $(secs $install_ms)"
echo "  Test connection to result: $(secs $done_ms); to no worker pod left: $(secs $gone_ms)"
echo "PASS"
