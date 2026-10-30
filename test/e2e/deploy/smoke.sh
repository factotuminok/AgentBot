#!/usr/bin/env bash
# Deploy scripts end-to-end check (requirements OPS-05): deploy, upgrade and roll back with deploy/k8s/deploy.sh on the
# shared kind cluster and with deploy/podman/deploy.sh on rootless Podman, each time waiting for the version in health.
#   test/e2e/deploy/smoke.sh [k8s|podman|all]   (default all)
# 1. Builds two images on the rootless engine that differ only in AGENTBOT_VERSION (V1, V2; BUILD=0 reuses them).
# 2. k8s: test/e2e/k8s/kind.sh up and loads both; deploy.sh V1, V2, V1 into namespace agentbot-deploy (small resources,
#    pullPolicy Never). A version without an image must fail within TIMEOUT=30 with diagnostics, and V1 must deploy
#    again after it. Uninstalls and deletes the namespace (the cluster stays: kind.sh down removes it).
# 3. podman: a throwaway registry container with a password on the rootless engine (127.0.0.1:REGISTRY_PORT inside the
#    Podman host, marked insecure in a registries.conf.d drop-in for the run) receives both images, because the deploy
#    runs `podman compose pull`; the stack user logs in on the host like CD does. deploy.sh V1, V2, V1 into a temporary
#    deploy directory whose .env gives the stack its own project, network, web port and worker secret. A version missing
#    from the registry must fail and leave the stack on V1 and .env pinning V1. Removes the stack, its volumes and
#    secret, the registry, the login and the drop-in.
# Prints the time each deploy took until both health endpoints reported the version.
# Env: V1 (default 0.1.900), V2 (default 0.1.901), BAD (default 0.1.999, a version with no image), BUILD (default 1),
# ROOTLESS_CONNECTION (default podman-machine-default; empty = the local podman), REGISTRY_PORT (default 5055), HELM
# (default .tools/helm), KEEP=1 leaves the release / stack running.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
targets="${1:-all}"
v1="${V1:-0.1.900}"
v2="${V2:-0.1.901}"
bad="${BAD:-0.1.999}"
rootless_conn="${ROOTLESS_CONNECTION-podman-machine-default}"
P="podman${rootless_conn:+ --connection $rootless_conn}"
reg_port="${REGISTRY_PORT:-5055}"
registry="localhost:$reg_port"
project=agentbot-e2e-deploy
work="$(mktemp -d)"
forward_pid=""
timings=()
# shellcheck source=../compose/rootless-socket.sh
. "$root/test/e2e/compose/rootless-socket.sh"

case "$targets" in k8s | podman | all) ;; *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac

# Runs one deploy and records how long it took.
timed() {
	local label="$1" start=$SECONDS
	shift
	echo "== $label"
	"$@" 2>&1 | sed 's/^/  /'
	timings+=("$label: $((SECONDS - start)) s")
}

# Runs one deploy that must fail and prints its failure lines.
expect_fail() {
	local label="$1"
	shift
	echo "== $label: must fail"
	if "$@" >"$work/fail.log" 2>&1; then
		sed 's/^/  /' "$work/fail.log"
		echo "FAIL: $label succeeded" >&2
		exit 1
	fi
	grep -E '^deploy: |rror' "$work/fail.log" | head -8 | sed 's/^/  /'
}

k8s_teardown() { :; }
podman_teardown() { :; }
cleanup() {
	code=$?
	if [ "${KEEP:-0}" = 1 ]; then
		echo "KEEP=1: left running (deploy directory $work/deploy, registry container agentbot-e2e-registry)"
	else
		k8s_teardown
		podman_teardown
		rm -rf "$work"
	fi
	[ -z "$forward_pid" ] || kill "$forward_pid" 2>/dev/null || true
	exit $code
}
trap cleanup EXIT

if [ "${BUILD:-1}" = 1 ]; then
	for v in "$v1" "$v2"; do
		echo "== build localhost/agentbot:$v (rootless, AGENTBOT_VERSION=$v)"
		$P build -q -t "localhost/agentbot:$v" --build-arg "AGENTBOT_VERSION=$v" "$root" | sed 's/^/  /'
	done
fi

if [ "$targets" != podman ]; then
	ns=agentbot-deploy
	ctx=kind-agentbot-e2e
	helm="${HELM:-$root/.tools/helm}"
	k8s_teardown() {
		"$helm" --kube-context "$ctx" -n "$ns" uninstall agentbot --wait >/dev/null 2>&1 || true
		kubectl --context "$ctx" delete namespace "$ns" --ignore-not-found --wait=true >/dev/null 2>&1 || true
	}
	echo "== kind cluster with both images (kind.sh up; the images come from the rootless engine)"
	PODMAN="$P" "$root/test/e2e/k8s/kind.sh" up "localhost/agentbot:$v1" "localhost/agentbot:$v2" 2>&1 | grep '^kind.sh:' | sed 's/^/  /'
	k8s_teardown
	cat >"$work/values.yaml" <<-EOF
		image: { pullPolicy: Never }
		orchestrator: { resources: { requests: { cpu: 100m, memory: 256Mi }, limits: { memory: 1Gi } }, persistence: { size: 1Gi } }
		web: { resources: { requests: { cpu: 50m, memory: 128Mi }, limits: { memory: 1Gi } }, persistence: { size: 1Gi } }
		worker: { maxReplicas: 2, diskLimit: 1Gi, resources: { requests: { cpu: 100m, memory: 256Mi, ephemeral-storage: 100Mi }, limits: { memory: 1Gi } } }
	EOF
	k8s() { NAMESPACE="$ns" KUBE_CONTEXT="$ctx" HELM="$helm" IMAGE=localhost/agentbot "$root/deploy/k8s/deploy.sh" "$1" -f "$work/values.yaml"; }
	timed "k8s: deploy $v1 (install)" k8s "$v1"
	timed "k8s: upgrade to $v2" k8s "$v2"
	timed "k8s: roll back to $v1" k8s "$v1"
	TIMEOUT=30 expect_fail "k8s: deploy $bad (no such image; TIMEOUT=30)" k8s "$bad"
	timed "k8s: roll back to $v1 after the failed deploy" k8s "$v1"
	"$helm" --kube-context "$ctx" -n "$ns" history agentbot | sed 's/^/  /'
	k8s_teardown
fi

if [ "$targets" != k8s ]; then
	dropin=.config/containers/registries.conf.d/agentbot-e2e-deploy.conf
	deploy_dir="$work/deploy"
	forward_rootless_socket "$rootless_conn" "$work"
	compose() { (cd "$deploy_dir" && PODMAN_COMPOSE_WARNING_LOGS=false podman compose "$@"); }
	podman_teardown() {
		[ -d "$deploy_dir" ] && compose down -v >/dev/null 2>&1 || true
		$P secret rm agentbot_e2e_deploy_worker_token >/dev/null 2>&1 || true
		$P rm -f agentbot-e2e-registry >/dev/null 2>&1 || true
		on_podman_host "$rootless_conn" "rm -f ~/$dropin; podman logout $registry >/dev/null 2>&1" || true
		for v in "$v1" "$v2" 0.1.1; do $P rmi "$registry/agentbot:$v" >/dev/null 2>&1 || true; done
	}
	podman_teardown
	echo "== registry $registry on the rootless engine (htpasswd auth, user e2e)"
	on_podman_host "$rootless_conn" "mkdir -p ~/${dropin%/*} && printf '[[registry]]\nlocation = \"$registry\"\ninsecure = true\n' >~/$dropin"
	# A running API service keeps the registries configuration it started with: stop it (socket activation restarts it).
	$P info --format '{{.Registries}}' | grep -q "$registry" || on_podman_host "$rootless_conn" "systemctl --user stop podman.service 2>/dev/null"
	reg_password="e2e-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
	$P run -d --name agentbot-e2e-registry -p "127.0.0.1:$reg_port:5000" -e "HTPASSWD=$(htpasswd -Bbn e2e "$reg_password")" \
		-e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=e2e -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
		--entrypoint sh docker.io/library/registry:2 \
		-c 'mkdir -p /auth && printf "%s\n" "$HTPASSWD" >/auth/htpasswd && exec registry serve /etc/docker/registry/config.yml' >/dev/null
	for _ in $(seq 1 50); do $P logs agentbot-e2e-registry 2>&1 | grep -q 'listening on' && break; sleep 0.2; done
	for v in "$v1" "$v2"; do
		$P tag "localhost/agentbot:$v" "$registry/agentbot:$v"
		$P push -q --creds "e2e:$reg_password" "$registry/agentbot:$v"
		$P rmi "$registry/agentbot:$v" >/dev/null # so `podman compose pull` really pulls it
	done
	! $P pull -q "$registry/agentbot:$v1" >/dev/null 2>&1 || { echo "FAIL: the registry serves images without a login" >&2; exit 1; }
	# Like CD's login step: the stack user logs in on the host, where the Podman socket's pulls find the credentials.
	echo "== podman login $registry as the stack user on the Podman host"
	on_podman_host "$rootless_conn" "printf %s '$reg_password' | podman login -u e2e --password-stdin $registry" | sed 's/^/  /'
	mkdir -p "$deploy_dir"
	cat >"$deploy_dir/.env" <<-EOF
		COMPOSE_PROJECT_NAME=$project
		AGENTBOT_NETWORK=$project
		AGENTBOT_WORKER_SECRET=agentbot_e2e_deploy_worker_token
		AGENTBOT_WEB_HOST_PORT=18081
		AGENTBOT_WORKER_CAPACITY=2
		AGENTBOT_HOST_PODMAN_SOCKET=$host_sock
	EOF
	podman_deploy() { AGENTBOT_DEPLOY_DIR="$deploy_dir" IMAGE="$registry/agentbot" "$root/deploy/podman/deploy.sh" "$1"; }
	timed "podman: deploy $v1 (first start)" podman_deploy "$v1"
	timed "podman: upgrade to $v2" podman_deploy "$v2"
	# An older version on the host: the rollback keeps v1 (current) and v2 (previous) and removes it.
	$P tag "localhost/agentbot:$v1" "$registry/agentbot:0.1.1"
	timed "podman: roll back to $v1" podman_deploy "$v1"
	! $P image exists "$registry/agentbot:0.1.1" || { echo "FAIL: the deploy kept $registry/agentbot:0.1.1" >&2; exit 1; }
	$P image exists "$registry/agentbot:$v2" || { echo "FAIL: the deploy removed the previous version $v2" >&2; exit 1; }
	expect_fail "podman: deploy $bad (not in the registry)" podman_deploy "$bad"
	grep -qx "AGENTBOT_IMAGE=$registry/agentbot:$v1" "$deploy_dir/.env" || { echo "FAIL: the failed deploy changed .env" >&2; exit 1; }
	running=$(compose exec -T orchestrator bun -e 'console.log((await (await fetch("http://127.0.0.1:8081/readyz")).json()).version)')
	[ "$running" = "$v1" ] || { echo "FAIL: the stack runs '$running' after the failed deploy, expected $v1" >&2; exit 1; }
	echo "  the stack still runs $v1 and .env still pins it"
	echo "== deploy directory .env and stack"
	sed 's/^/  /' "$deploy_dir/.env"
	$P ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}  {{.Image}}  {{.Status}}' | sed 's/^/  /'
	$P images --format '{{.Repository}}:{{.Tag}}' | grep "^$registry/agentbot:" | sed 's/^/  image left: /'
fi

echo "== timings (deploy start to both health endpoints reporting the version)"
printf '  %s\n' "${timings[@]}"
echo "PASS"
