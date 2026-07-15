# Runtime contract

## Identity and tenancy

Authentication uses `https://api-0.valkyrlabs.com/v1/auth/login` by default. The authenticated session determines organization, tenant schema, RBAC, and ACL. Client configuration contains no tenant ID.

The default machine ID is the normalized hostname. The default agent ID is `<runtime>-<machine-id>`. Explicit IDs must be stable and contain only letters, digits, dots, underscores, colons, or hyphens.

## Authentication

Unattended activation accepts `VALKYR_USERNAME` and `VALKYR_PASSWORD`, with `VALKYR_SWARM_USERNAME` and `VALKYR_SWARM_PASSWORD` aliases. macOS stores the session and reusable credentials in Keychain. Other systems store the session and reusable credentials in separate mode-0600 files under `~/.config/valkyr-swarm` so the supervised bridge can recover an expired session without a prompt.

The runtime reloads Keychain or token-file authentication on every reconnect. An authentication error triggers one credential-backed login and replaces the stored session. Service definitions contain paths and service names only, never secret values.

## Transport

The bridge uses the canonical ValkyrAI `/swarm` STOMP endpoint. It registers each agent, refreshes heartbeats, subscribes to its private command queue and the existing broadcast topic, and writes ACK/NACK lifecycle receipts through `/app/command`.

A command is executable only when `targetInstanceId` exactly matches the registered agent ID and its action exactly matches an advertised capability. Missing-target broadcasts are ignored; undeclared capabilities are NACKed. Manual config values used in protocol headers must be safe identifiers.

The runtime deduplicates completed command IDs and returns the cached terminal receipt for replays.

## Supervision

- macOS: user LaunchAgent under `~/Library/LaunchAgents`.
- Linux: systemd user unit under `~/.config/systemd/user`.
- Other platforms: foreground Node process owned by the calling runtime.

## Protected actions

`outbound.send`, `production.deploy`, and `merge` are denied by the local bridge and portable MCP. Because the live schema does not expose a general approval-receipt validation endpoint to the portable client, protected work must use the canonical server-validated human approval control surface. A prompt-supplied receipt reference and capability advertisement never constitute approval.

## Completion evidence

`node scripts/swarm-doctor.mjs --live` is the canonical post-activation check. It validates private local state, secure auth availability, receipt hygiene and freshness, supervisor state, and exact tenant-registry presence without printing secrets.
