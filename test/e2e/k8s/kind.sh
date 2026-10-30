#!/usr/bin/env bash
# The shared kind cluster for the Kubernetes e2e tests (architecture §7.3, spike S5).
#   test/e2e/k8s/kind.sh up [image ...]   create cluster agentbot-e2e if missing, install KEDA and wait, load the images
#   test/e2e/k8s/kind.sh load image ...   load images from the rootful Podman engine into the cluster's node
#   test/e2e/k8s/kind.sh down             delete the cluster
# Every command is idempotent. kind runs on Podman (KIND_EXPERIMENTAL_PROVIDER=podman) through the rootful connection,
# so images must be built there (`podman --connection podman-machine-default-root build ...`; on a Linux host
# `sudo podman build ...`). kubectl's context is kind-agentbot-e2e afterwards.
# Env: KIND (default .tools/kind), KUBECTL (default kubectl), CLUSTER (default agentbot-e2e), KEDA_VERSION (default
# 2.21.0), KIND_NODE_IMAGE (default kind's own), CONTAINER_CONNECTION (default podman-machine-default-root when that
# connection exists; empty = the local podman), PODMAN (default podman).
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
kind="${KIND:-$root/.tools/kind}"
kubectl="${KUBECTL:-kubectl}"
cluster="${CLUSTER:-agentbot-e2e}"
keda_version="${KEDA_VERSION:-2.21.0}"
podman="${PODMAN:-podman}"
export KIND_EXPERIMENTAL_PROVIDER=podman
if [ -z "${CONTAINER_CONNECTION+x}" ] && $podman system connection ls --format '{{.Name}}' 2>/dev/null | grep -qx podman-machine-default-root; then
	export CONTAINER_CONNECTION=podman-machine-default-root
fi
[ -n "${CONTAINER_CONNECTION:-}" ] || unset CONTAINER_CONNECTION
ctx="kind-$cluster"

usage() {
	sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

say() { echo "kind.sh: $*" >&2; }

# `kind get clusters` fails on Podman 6 (`index .Labels` on a slice), so look for the cluster's nodes instead.
exists() { "$kind" get nodes --name "$cluster" 2>/dev/null | grep -q .; }

up() {
	[ -x "$kind" ] || { say "kind not found at $kind (download kind v0.30.0 there or set KIND)"; exit 1; }
	if exists; then
		say "cluster $cluster exists"
	else
		say "creating cluster $cluster"
		"$kind" create cluster --name "$cluster" ${KIND_NODE_IMAGE:+--image "$KIND_NODE_IMAGE"} --wait 120s >&2
	fi
	"$kind" export kubeconfig --name "$cluster" >/dev/null 2>&1
	say "installing KEDA $keda_version"
	"$kubectl" --context "$ctx" apply --server-side --force-conflicts \
		-f "https://github.com/kedacore/keda/releases/download/v$keda_version/keda-$keda_version.yaml" >/dev/null
	# The admission webhook validates ScaledJobs, so a chart install right after `up` needs it too.
	for deploy in keda-operator keda-metrics-apiserver keda-admission; do
		"$kubectl" --context "$ctx" -n keda rollout status "deploy/$deploy" --timeout 300s >&2
	done
	"$kubectl" --context "$ctx" wait --for condition=Established crd/scaledjobs.keda.sh --timeout 60s >/dev/null
	[ $# = 0 ] || load "$@"
	say "ready: kubectl --context $ctx"
}

# `podman save` from the rootful engine into a temporary archive, then into the node's containerd.
load() {
	[ $# -gt 0 ] || usage
	exists || { say "cluster $cluster does not exist (run: $0 up)"; exit 1; }
	local tmp
	tmp="$(mktemp -d)"
	for image in "$@"; do
		say "loading $image"
		$podman save -o "$tmp/image.tar" "$image" >/dev/null || { rm -rf "$tmp"; exit 1; }
		"$kind" load image-archive "$tmp/image.tar" --name "$cluster" >&2 || { rm -rf "$tmp"; exit 1; }
		rm -f "$tmp/image.tar"
	done
	rm -rf "$tmp"
}

down() {
	if exists; then
		"$kind" delete cluster --name "$cluster" >&2
	else
		say "cluster $cluster does not exist"
	fi
}

cmd="${1:-}"
[ $# = 0 ] || shift
case "$cmd" in
up) up "$@" ;;
load) load "$@" ;;
down) down ;;
*) usage ;;
esac
