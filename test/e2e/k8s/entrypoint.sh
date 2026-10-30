#!/bin/sh
# Entry point of the Kubernetes scenario image (test/e2e/k8s/Containerfile). The chart passes the role as the container
# argument, as for the release image:
#   orchestrator  the scenario orchestrator (test/e2e/k8s/orchestrator.ts): real internals, fake Discord and GitHub
#   worker        a real worker process running the fixture agent host (test/fixtures/worker-process.ts), with the
#                 chart's worker token file, pod name and run-local dir, so `agentbot health [--claimed]` works as usual
#   anything else the release entry point, `agentbot <args>` (web, health, ...)
set -eu
case "${1:-}" in
orchestrator)
	shift
	exec bun /app/test/e2e/k8s/orchestrator.ts "$@"
	;;
worker)
	shift
	TEST_WORKER_TOKEN="$(cat "${AGENTBOT_WORKER_TOKEN_FILE:?AGENTBOT_WORKER_TOKEN_FILE must be set}")"
	# One claim per worker id, ever: the pod name, like `agentbot worker`.
	TEST_WORKER_ID="${HOSTNAME:?}"
	TEST_CLAIM_TIMEOUT_MS="${TEST_CLAIM_TIMEOUT_MS:-15000}"
	export TEST_WORKER_TOKEN TEST_WORKER_ID TEST_CLAIM_TIMEOUT_MS
	exec bun /app/test/fixtures/worker-process.ts "$@"
	;;
*)
	exec agentbot "$@"
	;;
esac
