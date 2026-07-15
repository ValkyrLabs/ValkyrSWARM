#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

node "$ROOT/scripts/swarm-auth.mjs" --self-test
node "$ROOT/scripts/swarm-login.mjs" --self-test
node "$ROOT/scripts/swarm-agent.mjs" --self-test
node "$ROOT/scripts/swarm-activate.mjs" --self-test
node "$ROOT/scripts/swarm-doctor.mjs" --self-test
node "$ROOT/scripts/swarm-openclaw-bootstrap.mjs" bootstrap --self-test
node "$ROOT/scripts/swarm-service.mjs" self-test

dry_run="$(VALKYR_SWARM_RUNTIME=codex node "$ROOT/scripts/swarm-activate.mjs" --machine-id 'Test Host' --dry-run)"
jq -e '
  .dryRun == true
  and .apiBase == "https://api-0.valkyrlabs.com/v1"
  and .machineId == "test-host"
  and .agent.agentId == "codex-test-host"
  and .agent.runtime == "codex"
' <<<"$dry_run" >/dev/null

service="$(node "$ROOT/scripts/swarm-service.mjs" print-service --config "$ROOT/config/agent.example.json")"
grep -q -- '--token-file' <<<"$service"
grep -q -- '--continuous' <<<"$service"
if grep -Eq 'Bearer |VALKYR_PASSWORD|VALKYR_AUTH_TOKEN|eyJ[A-Za-z0-9_-]+\.' <<<"$service"; then
  echo "Service definition contains secret material" >&2
  exit 1
fi

node "$ROOT/scripts/sync-plugin.mjs"
node "$ROOT/scripts/verify-distribution.mjs"

echo "Valkyr SWARM runtime tests passed"
