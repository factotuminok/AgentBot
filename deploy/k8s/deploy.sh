#!/usr/bin/env bash
# Deploys AgentBot <version> to Kubernetes with the Helm chart (architecture §7.3, requirements OPS-05).
#   deploy/k8s/deploy.sh <version> [helm upgrade arguments...]
# `helm upgrade --install` sets image.tag=<version>; extra arguments go to helm as they are (e.g. `-f values.yaml`, which
# must hold the release's whole configuration: values are not reused from the previous release). Then waits up to
# TIMEOUT seconds for both Deployments to roll out and for the orchestrator's /readyz and web's /healthz to report
# `version == <version>` (read inside the pods with `bun -e fetch`: the image has no curl). Prints diagnostics and exits 1
# otherwise. Rollback: run it again with the previous version. Run by the `kubernetes` job of .github/workflows/cd.yml.
# Env: NAMESPACE (default agentbot), RELEASE (default agentbot), IMAGE (image repository; default the chart's,
# ghcr.io/factotuminok/agentbot), KUBE_CONTEXT (default kubectl's current context), HELM (default helm), KUBECTL (default
# kubectl), TIMEOUT (default 120).
set -euo pipefail

version="${1:-}"
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "usage: $0 <version> [helm upgrade arguments...]   (for example 0.1.42)" >&2
	exit 2
fi
shift
root="$(cd "$(dirname "$0")/../.." && pwd)"
ns="${NAMESPACE:-agentbot}"
release="${RELEASE:-agentbot}"
helm="${HELM:-helm}"
timeout="${TIMEOUT:-120}"
k=("${KUBECTL:-kubectl}" ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} -n "$ns")
h=("$helm" ${KUBE_CONTEXT:+--kube-context "$KUBE_CONTEXT"} -n "$ns")

say() { echo "deploy: $*" >&2; }

# The Deployment of one component, found by the chart's labels (names depend on the release and fullnameOverride).
deployment() {
	"${k[@]}" get deploy -l "app.kubernetes.io/instance=$release,app.kubernetes.io/component=$1" -o name 2>/dev/null
}

diagnostics() {
	say "diagnostics for release $release in namespace $ns"
	"${h[@]}" history "$release" --max 3 >&2 || true
	"${k[@]}" get deploy,pods -l "app.kubernetes.io/instance=$release" -o wide >&2 || true
	for c in orchestrator web; do
		d=$(deployment "$c" || true)
		[ -n "$d" ] || continue
		echo "== $d: describe (tail)" >&2
		"${k[@]}" describe "$d" 2>&1 | tail -15 >&2 || true
		echo "== $d: log (last 40 lines)" >&2
		"${k[@]}" logs "$d" --tail 40 >&2 || true
	done
	echo "== events (last 20)" >&2
	"${k[@]}" get events --sort-by .lastTimestamp 2>/dev/null | tail -20 >&2 || true
}

fail() {
	say "FAILED: $*"
	diagnostics
	exit 1
}

# `<status> <version>` of GET http://127.0.0.1:<port><path> inside a Deployment's pod, or nothing.
health() {
	"${k[@]}" exec "$1" -- bun -e "
		const r = await fetch('http://127.0.0.1:$2$3', { signal: AbortSignal.timeout(3000) });
		console.log(r.status, (await r.json()).version ?? '')" 2>/dev/null || true
}

previous=$("${k[@]}" get deploy -l "app.kubernetes.io/instance=$release,app.kubernetes.io/component=orchestrator" \
	-o jsonpath='{.items[0].spec.template.spec.containers[0].image}' 2>/dev/null || true)
previous="${previous##*:}"
say "deploying $version (release $release, namespace $ns, previous ${previous:-none})"

args=(upgrade --install "$release" "$root/deploy/helm/agentbot" --create-namespace --set "image.tag=$version")
[ -z "${IMAGE:-}" ] || args+=(--set "image.repository=$IMAGE")
"${h[@]}" "${args[@]}" "$@" >/dev/null || fail "helm upgrade failed"
start=$SECONDS
deadline=$((start + timeout))

orch=$(deployment orchestrator)
web=$(deployment web)
[ -n "$orch" ] && [ -n "$web" ] || fail "the release has no orchestrator or web Deployment"
for d in "$orch" "$web"; do
	left=$((deadline - SECONDS))
	[ "$left" -gt 0 ] || fail "$timeout s passed before $d rolled out"
	"${k[@]}" rollout status "$d" --timeout "${left}s" >/dev/null || fail "$d did not roll out within $timeout s"
done

orch_health=""
web_health=""
while :; do
	orch_health=$(health "$orch" 8081 /readyz)
	web_health=$(health "$web" 8080 /healthz)
	[ "$orch_health" = "200 $version" ] && [ "$web_health" = "200 $version" ] && break
	[ "$SECONDS" -lt "$deadline" ] || fail "no version $version in health within $timeout s: orchestrator /readyz '${orch_health:-no answer}', web /healthz '${web_health:-no answer}'"
	sleep 2
done
say "$version is live after $((SECONDS - start)) s: orchestrator /readyz and web /healthz report it (rollback: $0 ${previous:-<previous version>})"
