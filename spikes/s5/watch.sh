#!/usr/bin/env bash
# Prints one line every ~2 s: fake-orchestrator state and worker pod phases.
# Needs: kubectl port-forward -n agentbot-s5 svc/orchestrator 18081:8081
set -u
CTX=${CTX:-kind-agentbot-spike-s5}
DURATION=${1:-120}
end=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$end" ]; do
	st=$(curl -s localhost:18081/admin/state | jq -c '{p:.pending,r:.running,claims,empty:.emptyClaims,unauth:.unauthorized}')
	pods=$(kubectl --context "$CTX" -n agentbot-s5 get pods -l app=worker --no-headers 2>/dev/null | awk '{print $3}' | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}')
	jobs=$(kubectl --context "$CTX" -n agentbot-s5 get jobs --no-headers 2>/dev/null | wc -l | tr -d ' ')
	echo "$(date +%H:%M:%S) $st jobs=$jobs pods: ${pods:-none}"
	sleep 2
done
