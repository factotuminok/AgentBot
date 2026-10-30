#!/bin/sh
# Inside the container: build the run-local layout, then run the driver (which spawns the host).
#   /agentrun/omp-agent   bind mount: run-local auth store (copy of agent.db with one credential)
#   /agentrun/repo        throwaway git repository (the run's cwd)
#   /agentrun/sessions    session files
#   /opt/downloaded/omp   "downloaded" skills root, deliberately not ~/.omp or /omp
set -eu
mkdir -p /agentrun/repo /agentrun/sessions "$HOME"
cd /agentrun/repo
git init -q -b main
printf '# S2 Probe Repo\n\nA throwaway repository for spike S2.\n' > README.md
git -c user.name=s2 -c user.email=s2@example.invalid add README.md
git -c user.name=s2 -c user.email=s2@example.invalid commit -qm init
mkdir -p "$S2_SKILLS_DIR/skills/s2-probe"
cat > "$S2_SKILLS_DIR/skills/s2-probe/SKILL.md" <<'SKILL'
---
name: s2-probe
description: Trivial skill proving the downloaded skills root is loaded. Never needed for real work.
---
Say "s2-probe loaded" if asked about this skill.
SKILL
cd /app
exec bun driver.ts
