# Valkyr SWARM

Valkyr SWARM is the standalone Skill, Codex Plugin, and MCP project for joining Claude Code, Codex, OpenClaw, ValorIDE, Valklaw, and other agents to a tenant-isolated Valkyr Labs SWARM.

It is a peer of GrayMatter and ValkyrAI. ValkyrAI owns the authenticated SWARM API and generated authorization boundary; this repository owns portable installation, authentication, agent-side transport, native supervision, receipts, runtime adapters, skills, and MCP tools. No ValkyrAI source checkout is required.

## Unattended activation

Node 22 or newer is the only runtime dependency. Provide a valid Valkyr Labs username and password through the agent's secret environment:

```bash
VALKYR_USERNAME='user@example.com' \
VALKYR_PASSWORD='secret' \
node scripts/swarm-activate.mjs
```

The command:

1. authenticates against `https://api-0.valkyrlabs.com/v1`;
2. lets the server resolve tenant, organization, RBAC, and ACL from the session;
3. derives a stable runtime, machine ID, agent ID, and capability set;
4. stores the session and reusable login securely in macOS Keychain or separate mode-0600 files;
5. writes a private mode-0600 agent config without tenant or secret fields;
6. installs a user LaunchAgent on macOS or systemd-user service on Linux;
7. registers, heartbeats, receives commands, and emits durable ACK/NACK receipts.

Use `--foreground` for a runtime-owned process or a platform without launchd/systemd-user. Use `--dry-run` to inspect the non-secret activation plan.

## Runtime-specific entry points

### Codex and ValorIDE

Install the `valkyr-swarm` Codex plugin from this repository's marketplace, or run activation directly. The bundled `.mcp.json` exposes the local MCP server.

### Claude Code

After activation, run:

```bash
scripts/swarm-claude-install
```

### OpenClaw

Receipt-only registration needs no OpenClaw-specific option. To enable governed safe execution through an existing OpenClaw Gateway agent:

```bash
VALKYR_USERNAME='user@example.com' VALKYR_PASSWORD='secret' \
node scripts/swarm-openclaw-bootstrap.mjs bootstrap \
  --openclaw-agent-id valor
```

## MCP tools

- `swarm_status`
- `swarm_agents_snapshot`
- `swarm_command_status`
- `swarm_dispatch`

Tenant IDs are not MCP arguments. Every tool uses the authenticated session's server-resolved tenant context.

## Approval boundary

Outbound sends, production deployments, and merges remain human-gated. The local bridge denies these actions, and MCP dispatch rejects them without a separately correlated approval receipt. Advertising a capability never grants approval.

## Development

```bash
tests/test-runtime.sh
node --test mcp-server/test/*.test.js
scripts/sync-plugin.mjs
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/valkyr-swarm
```

The root files are the development source. `scripts/sync-plugin.mjs` creates the distributable plugin mirror at `plugins/valkyr-swarm`, matching the GrayMatter repository model.
