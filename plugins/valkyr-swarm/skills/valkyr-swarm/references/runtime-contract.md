# Runtime contract

## Identity and tenancy

Authentication uses `https://api-0.valkyrlabs.com/v1/auth/login` by default. The authenticated session determines organization, tenant schema, RBAC, and ACL. Client configuration contains no tenant ID.

The default machine ID is the normalized hostname. The default agent ID is `<runtime>-<machine-id>`. Explicit IDs must be stable and contain only letters, digits, dots, underscores, colons, or hyphens.

## Authentication

Unattended activation accepts `VALKYR_USERNAME` and `VALKYR_PASSWORD`, with `VALKYR_SWARM_USERNAME` and `VALKYR_SWARM_PASSWORD` aliases. macOS stores the session and reusable credentials in Keychain. Other systems store the session and reusable credentials in separate mode-0600 files under `~/.config/valkyr-swarm` so the supervised bridge can recover an expired session without a prompt.

The runtime reloads Keychain or token-file authentication on every reconnect. An authentication error triggers one credential-backed login and replaces the stored session. Service definitions contain paths and service names only, never secret values.

## Transport

The bridge uses the canonical ValkyrAI `/swarm` STOMP endpoint. It registers each agent, refreshes heartbeats, subscribes only to its exact-target private command queue, and writes ACK/NACK lifecycle receipts through `/app/command`. The operator-only broadcast topic is deliberately excluded from product agent subscriptions.

A command is executable only when `targetInstanceId` exactly matches the registered agent ID and its action exactly matches an advertised capability. Missing-target broadcasts are ignored; undeclared capabilities are NACKed. Manual config values used in protocol headers must be safe identifiers.

The runtime deduplicates completed command IDs and returns the cached terminal receipt for replays.

Executable runtime adapters are productized for Codex, Claude Code, OpenClaw, and ValorIDE/Valor. They stream bounded, redacted progress frames before one terminal ACK/NACK. Terminal rejection text is bounded for generated persistence, and each terminal outcome is written to GrayMatter under `valkyr-swarm:receipts`. Credit-gated or temporarily unavailable writes enter a secret-free mode-0600 replay queue under `~/.config/valkyr-swarm/graymatter-replay`; supervised agents retry with fresh authentication and remove each replay record only after GrayMatter confirms persistence. The websocket terminal outcome reports `queued` or `degraded` honestly and is never changed into a false success.

Repeated activation on one physical machine merges stable agent IDs into one private machine config and one supervised bridge. Normal durable activation accepts only production `https://api-0.valkyrlabs.com/v1`; non-production endpoints require explicit test mode.

## Supervision

- macOS: user LaunchAgent under `~/Library/LaunchAgents`.
- Linux: systemd user unit under `~/.config/systemd/user`.
- Other platforms: foreground Node process owned by the calling runtime.

## Protected actions

`outbound.send`, `production.deploy`, and `merge` are denied by the portable MCP and by the local bridge unless the authenticated mothership sends an exact-target command containing the server-injected, content-bound `gm_approval_...` reference produced by the canonical human approval control surface. The node must also explicitly advertise the protected capability. A prompt-supplied receipt reference, chat approval, or capability advertisement alone never constitutes approval.

## Completion evidence

`node scripts/swarm-doctor.mjs --live` is the canonical post-activation check. It validates private local state, secure auth availability, receipt hygiene and freshness, supervisor state, and exact tenant-registry presence without printing secrets.
