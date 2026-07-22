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
7. auto-discovers the local Codex, Claude Code, OpenClaw, or ValorIDE CLI and enables its productized execution adapter;
8. registers every configured node against production api-0, heartbeats, receives commands, streams progress, and emits terminal ACK/NACK receipts;
9. stores terminal command receipts and shared handoffs in GrayMatter. Credit-gated or temporarily unavailable terminal writes enter a secret-free mode-0600 replay queue under `~/.config/valkyr-swarm/graymatter-replay` and retry automatically.

Activation never accepts tenant, organization, or owner identity from the caller. Those values come only from the authenticated server session.

Repeated activation on one machine merges stable runtime nodes into the same private config and supervised bridge. Normal activation rejects non-production endpoints; `--test-mode` is limited to isolated test fixtures. Use `--receipt-only` only when the operator intentionally wants a node that cannot execute.

Use `--foreground` for a runtime-owned process or a platform without launchd/systemd-user. Use `--dry-run` to inspect the non-secret activation plan.

## Optional remote Workflow runtimes

SWARM advertises two independent Workflow capability tiers, and neither is inferred merely because a node can execute agent commands:

- `workflow.runner.execute-module` is the very small stateless worker for one fenced, remote-safe ExecModule invocation.
- `workflow.engine.execute-workflow` is the durable mini-ValkyrAI engine for a complete immutable Workflow version snapshot.

Each tool is advertised only after its own loopback runtime passes a live protocol and inventory probe. Heartbeats derive compact `execmodule-abi:<sha256>` and `workflow-pack:<id>:<version>` capabilities plus the pack-manifest hash, so ValkyrAI leases work only to a node with the exact module and pack contracts. An unhealthy runtime immediately withdraws only its own tier and ABI capabilities.

Activation installs either checksum-pinned runtime beside the MCP/SWARM bridge:

```bash
VALKYR_USERNAME="$USERNAME" VALKYR_PASSWORD="$PASSWORD" \
node scripts/swarm-activate.mjs --workflow-runtime

# Or install the durable full-graph engine tier on a capable node:
VALKYR_USERNAME="$USERNAME" VALKYR_PASSWORD="$PASSWORD" \
node scripts/swarm-activate.mjs --workflow-engine
```

After login, activation retrieves the tier-specific approved release descriptor from ValkyrAI's authenticated `/v1/swarm/workflow-runtime/release` endpoint (`?tier=engine` for the durable engine). ValkyrAI supplies the runtime protocol, version, credential-free HTTPS artifact URL, exact SHA-256, minimum Java version, and—for the engine only—a bounded catalog of approved capability-pack artifacts. Each pack has its own ID, version, credential-free URL, and digest. Nodes cannot select arbitrary releases or add packs to a runner. Explicit runtime artifact URL and digest overrides remain available together for isolated testing only and do not authorize packs.

The installer verifies Java and every checksum, stores runtime and digest-addressed pack JARs privately, binds the runtime to `127.0.0.1`, and creates a separate LaunchAgent or systemd-user service. The service loads only the exact approved pack paths and enables only their exact IDs; the engine then independently validates the ServiceLoader ABI manifest before becoming healthy. The runner remains stateless. The engine receives a private mode-0600 node-key file reference and uses a narrow AES-encrypted H2 journal for immutable snapshots, execution state, step idempotency, leases/fences, approval references, sanitized outputs, and receipt replay. SecureField values are never copied into that journal; installed modules resolve authorized node-local credential references through the node credential broker. Neither service definition contains credentials, tokens, tenant identity, nor inline encryption keys.

Pack installation is capability-qualified. The mothership release declares each pack's required node capabilities, activation selects only compatible packs and records skipped requirements, the local service rejects incompatible manual configuration, and the engine revalidates the advertised capability set before loading any pack. `openclaw-gtm` requires both `openclaw.skill.execute` and `outbound.send`; its provider call remains human-approval suspended at the outbound effect boundary. `file-project-read` requires `workspace.files.read` and can inspect only node-authorized workspace roots. `engineering-project` requires both `code.execute` and `engineering.project.execute`; it runs only immutable, shell-free Git inspection and Maven/Gradle/npm/Python/Go/Rust test/build profiles inside those roots. Engineering subprocesses receive a private engine-owned HOME and a small allowlist of non-secret environment variables. The `deployment` pack requires both `production.deploy` and a separately configured, live-probed `deployment.runner.execute` loopback service. It accepts immutable artifact references and digests, never arbitrary hosts or commands, and remains suspended until canonical human approval. Merge remains a separate protected action.

The engine is the canonical ValkyrAI graph evaluator packaged without the public ValkyrAI API, organization/user administration, CRM/CMS schemas, billing/signup, central RBAC persistence, production seeders, Stripe/AWS/Salesforce, OpenAPI generation, or unrelated application initializers. It supports Looper, Wait/Cycle Delay, parameterization, branching, bounded retry/backoff, timeouts, kill switch, durable approval suspension, restart recovery, and delayed-cycle scheduling. Capability packs contribute only their exact ExecModule/model/dependency closure and ABI manifest.

Operate either installed tier directly when needed:

```bash
node scripts/swarm-workflow-service.mjs status \
  --config ~/.config/valkyr-swarm/agent-$(hostname).json \
  --agent <agent-id>
```

Remote module commands use ValkyrAI's existing fenced `Run` contract; remote engine commands use immutable Workflow version snapshots and existing WorkflowExecution lease/fence/idempotency conventions. The bridge validates the exact target and advertised tool, renews leases only through same-origin callbacks, streams bounded progress over the SWARM websocket, replays engine completion/failure events after local restart, and persists terminal GrayMatter receipts and handoffs. A stale fence cannot mutate current execution state. OpenClaw research/drafting is installed as an internal-output capability separate from outbound GTM. Runtime capability remains separate from authority: the node can suspend and resume an approved action, but it can never approve its own request; outbound sends, production deployments, and merges remain human-gated.

To enable the deployment pack on a capable ValorIDE node, activate the durable engine with `--deployment-runner-endpoint http://127.0.0.1:3002/api/deployments/execute` and, when needed, `--deployment-credential-ref keychain:SERVICE:ACCOUNT`. The deployment capability is withdrawn from heartbeats whenever the engine or the runner's `valkyr-deployment-runner/v1` health probe is not healthy. The endpoint and credential reference are node configuration; workflow state cannot replace either value.

Registration and heartbeat control frames use the dedicated `/app/swarm/control` application destination. ValkyrAI replies only to the originating authenticated session on `/user/queue/swarm-control`; the bridge correlates every ACK/NACK to the exact outbound message before doctor treats server presence as healthy. Capability-bearing workflow heartbeats are also projected durably with the same authenticated principal, never with caller-supplied tenant identity.

Verify the completed installation with one secret-safe command:

```bash
node scripts/swarm-doctor.mjs --live
```

The doctor checks Node compatibility, private config permissions, secure reusable authentication, receipt redaction and freshness, native supervision, and exact agent presence in the authenticated tenant registry. It prints JSON and never returns credentials or tokens.

## Runtime-specific entry points

### Codex and ValorIDE

Install the `valkyr-swarm` Codex plugin from this repository's marketplace, or run activation directly. Codex activation discovers `codex exec`; ValorIDE activation discovers the shipped `valor` CLI. Both execute exact advertised non-protected capabilities and stream bounded progress over SWARM.

### Claude Code

After activation, run:

```bash
scripts/swarm-claude-install
```

### OpenClaw

Activation auto-discovers OpenClaw. Supply a stable local Gateway agent identity only when it cannot be derived from the runtime environment:

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
- `swarm_handoff_write`
- `swarm_invariants_query`
- `swarm_receipts_query`

Tenant IDs are not MCP arguments. Every tool uses the authenticated session's server-resolved tenant context. Dispatch targets exactly one agent and executable agents reject actions they did not advertise as capabilities.

## Approval boundary

Outbound sends, production deployments, and merges remain human-gated. The portable bridge and MCP fail closed because api-0 does not expose a general approval-receipt validation endpoint to this client. Run protected work only through the canonical human-approval control surface; a prompt-supplied receipt reference and capability advertisement are never approval.

## Evidence and supervision

- macOS uses a user LaunchAgent under `~/Library/LaunchAgents`.
- Linux uses a systemd user unit under `~/.config/systemd/user`.
- Other platforms run in the foreground under the calling runtime.
- Config and non-Keychain auth files are mode `0600`.
- JSONL receipts are redacted, mode `0600`, and include connection, heartbeat, realtime progress, terminal command lifecycle, trace, GrayMatter receipt state, and execution state.

## Development

```bash
npm test
npm run package
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/valkyr-swarm
```

The root files are the development source. `scripts/sync-plugin.mjs` creates the distributable plugin mirror at `plugins/valkyr-swarm`, and `scripts/verify-distribution.mjs` proves exact content/mode parity. `scripts/package-valkyr-swarm` normalizes all timestamps and archive ordering so consecutive builds are byte-identical. GitHub Actions validates Node 22 and 24 on Linux and macOS.
