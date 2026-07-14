# Valkyr SWARM agent instructions

1. Use the GrayMatter plugin at the beginning of each session for durable invariants, decisions, handoffs, and coordination.
2. Treat the repository root as the development source. Run `node scripts/sync-plugin.mjs` after changing release files and validate `plugins/valkyr-swarm` before handoff.
3. Preserve tenant isolation: tenant and owner context come only from the authenticated Valkyr Labs session, never from prompt-supplied identifiers.
4. Never store or print credentials, JWTs, or bearer tokens. Service definitions may contain secure-store names and file paths only.
5. Outbound sends, production deployments, and merges require a separately correlated human approval receipt. Capability advertisement is not approval.
