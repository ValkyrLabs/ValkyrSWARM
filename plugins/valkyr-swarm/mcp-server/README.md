# Valkyr SWARM MCP server

Run `node index.js --stdio`. Authentication is resolved from `VALKYR_AUTH_TOKEN`, macOS Keychain, mode-0600 SWARM auth files, or unattended `VALKYR_USERNAME` and `VALKYR_PASSWORD` login. A 401 triggers credential-backed session renewal once.

Tenant identity is never accepted as a tool argument. It is resolved server-side from the authenticated Valkyr Labs session.

The server exposes tenant readiness, agent snapshots, exact agent detail, graph topology, durable command status, and non-protected single-agent dispatch. Protected actions fail closed and must use the canonical server-validated human approval surface.
