# Valkyr SWARM

Valkyr SWARM is the standalone Skill, Codex Plugin, and MCP project for joining Claude Code, Codex, OpenClaw, ValorIDE, Valklaw, and other agents to a tenant-isolated Valkyr Labs SWARM.

It is a peer of GrayMatter and ValkyrAI. ValkyrAI owns the authenticated SWARM API and generated authorization boundary; this repository owns portable installation, authentication, agent-side transport, native supervision, receipts, runtime adapters, skills, and MCP tools. No ValkyrAI source checkout is required.

## Install the Codex plugin

The repository is a self-contained marketplace. An agent with Git and Codex available can install it without a private ValkyrAI checkout:

```bash
git clone https://github.com/ValkyrLabs/ValkyrSWARM.git
codex plugin marketplace add "$PWD/ValkyrSWARM"
codex plugin add valkyr-swarm@valkyr-swarm
```

Claude Code, OpenClaw, and other runtimes can use the same checkout directly. Node 22 or newer is the only runtime dependency.

## Unattended activation

Provide a valid Valkyr Labs username and password through the agent's secret environment:

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

Activation never accepts tenant, organization, or owner identity from the caller. Those values come only from the authenticated server session.

Use `--foreground` for a runtime-owned process or a platform without launchd/systemd-user. Use `--dry-run` to inspect the non-secret activation plan.

Verify the completed installation with one secret-safe command:

```bash
node scripts/swarm-doctor.mjs --live
```

The doctor checks Node compatibility, private config permissions, secure reusable authentication, receipt redaction and freshness, native supervision, and exact agent presence in the authenticated tenant registry. It prints JSON and never returns credentials or tokens.

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
- `swarm_agent_status`
- `swarm_graph`
- `swarm_command_status`
- `swarm_dispatch`

Tenant IDs are not MCP arguments. Every tool uses the authenticated session's server-resolved tenant context. Dispatch targets exactly one agent and executable agents reject actions they did not advertise as capabilities.

## Approval boundary

Outbound sends, production deployments, and merges remain human-gated. The portable bridge and MCP fail closed because api-0 does not expose a general approval-receipt validation endpoint to this client. Run protected work only through the canonical human-approval control surface; a prompt-supplied receipt reference and capability advertisement are never approval.

## Evidence and supervision

- macOS uses a user LaunchAgent under `~/Library/LaunchAgents`.
- Linux uses a systemd user unit under `~/.config/systemd/user`.
- Other platforms run in the foreground under the calling runtime.
- Config and non-Keychain auth files are mode `0600`.
- JSONL receipts are redacted, mode `0600`, and include connection, heartbeat, command lifecycle, trace, and execution state.

## Development

```bash
npm test
npm run package
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/valkyr-swarm
```

The root files are the development source. `scripts/sync-plugin.mjs` creates the distributable plugin mirror at `plugins/valkyr-swarm`, and `scripts/verify-distribution.mjs` proves exact content/mode parity. `scripts/package-valkyr-swarm` normalizes all timestamps and archive ordering so consecutive builds are byte-identical. GitHub Actions validates Node 22 and 24 on Linux and macOS.
