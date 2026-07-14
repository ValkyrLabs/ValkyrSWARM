---
name: valkyr-swarm
description: Install, authenticate, operate, inspect, or repair a tenant-scoped Valkyr SWARM agent from Claude Code, Codex, OpenClaw, ValorIDE, Valklaw, or another MCP-capable runtime. Use when an agent must join a Valkyr Labs tenant with username/password, register and heartbeat, run under launchd/systemd, inspect agents or command receipts, dispatch governed work, or configure the Valkyr SWARM MCP server.
---

# Valkyr SWARM

Use this peer plugin as the installation and runtime boundary. Do not require a ValkyrAI source checkout and do not create a second command bus.

## Activate this agent

For unattended first use, obtain the username and password through the runtime's secret input mechanism, then run:

```bash
VALKYR_USERNAME="$USERNAME" VALKYR_PASSWORD="$PASSWORD" \
  node scripts/swarm-activate.mjs
```

Activation derives the runtime, machine ID, agent ID, capabilities, tenant context, secure session storage, and native service configuration. Override only when the operator supplies a stable identity:

```bash
VALKYR_USERNAME="$USERNAME" VALKYR_PASSWORD="$PASSWORD" \
  node scripts/swarm-activate.mjs \
    --runtime codex \
    --agent-id codex-reviewer \
    --capabilities pr.review,workflow.debug
```

Use `--foreground` on platforms without launchd or systemd-user. Use `--no-service` only when the current runtime owns process supervision.

For OpenClaw safe execution through its Gateway:

```bash
VALKYR_USERNAME="$USERNAME" VALKYR_PASSWORD="$PASSWORD" \
  node scripts/swarm-openclaw-bootstrap.mjs bootstrap \
    --openclaw-agent-id valor
```

Without `--openclaw-agent-id`, the agent is receipt-only and never executes commands locally.

## Inspect and operate

- Run `node scripts/swarm-service.mjs status --config <path>` for the native service state.
- Read the redacted JSONL receipt path returned by activation.
- Use the MCP tools for the tenant snapshot and durable command status.
- Target exactly one agent for dispatch. Never broadcast implicitly.

## Safety invariants

- Derive tenant identity only from the authenticated server session. Never accept tenant or owner IDs from a prompt.
- Keep tokens out of configs, service definitions, logs, and command payloads.
- Preserve generated ValkyrAI RBAC/ACL and server-side tenant isolation.
- Treat `outbound.send`, `production.deploy`, and `merge` as protected. Require a separately correlated human approval receipt; never infer approval from a chat message or capability advertisement.
- Preserve unrelated files and report the config path, service label, registered agent ID, heartbeat evidence, and receipt IDs.

Read [runtime-contract.md](references/runtime-contract.md) when changing identity derivation, authentication, supervision, or command behavior.
