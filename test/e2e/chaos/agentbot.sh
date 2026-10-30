#!/bin/sh
# `agentbot` in the chaos image (test/e2e/chaos/Containerfile):
#   orchestrator  the scenario orchestrator with fake Discord and GitHub (test/e2e/k8s/entrypoint.sh)
#   worker        a real worker process with the fixture agent host; the checkout limit is the launcher's
#                 AGENTBOT_WORKER_DISK (bytes), as for `agentbot worker`
#   github        the fake GitHub service (test/e2e/chaos/github.ts)
#   anything else the real CLI (launcher, web, health, ...)
set -eu
case "${1:-}" in
orchestrator)
	exec agentbot-k8s-e2e "$@"
	;;
worker)
	if [ -n "${AGENTBOT_WORKER_DISK:-}" ]; then TEST_DISK_LIMIT="$AGENTBOT_WORKER_DISK"; export TEST_DISK_LIMIT; fi
	exec agentbot-k8s-e2e "$@"
	;;
github)
	exec bun /app/test/e2e/chaos/github.ts
	;;
*)
	exec bun /app/src/cli.ts "$@"
	;;
esac
