# Recover a stale SWARM agent session

Goal: a configured agent resumes canonical registration and heartbeat after another authorized client refreshes the shared secure session, without disturbing healthy peers or requiring another password entry.

Live evidence on 8 September 2026: ValorIDE is missing from the registry and repeatedly emits `auth_unavailable`; Codex and local-model peers have fresh server heartbeat acknowledgements. The canonical Keychain session is unexpired and was issued after the last recorded ValorIDE STOMP error. Forced refresh currently skips that stored session and fails when reusable credentials are absent.

1. Add failing tests for externally refreshed Keychain and token-file sessions; unchanged rejected sessions; absent credentials; concurrent credential refresh; and connection-specific recovery with healthy peers.
2. Extend the shared token provider to accept the exact rejected connection token in process memory. Reuse a different current secure-store session first; otherwise retain credential-backed login and fail closed. Coalesce simultaneous logins. Never expose tokens in config, receipts or errors.
3. Carry the rejected token from the affected socket only. Ignore late events from replaced sockets, so a delayed error cannot invalidate a replacement connection. Preserve exact-target subscriptions, command authorization and existing reconnect backoff.
4. Run focused and existing runtime/MCP tests and source/plugin mirror checks. Preserve concurrent workflow-engine transport work.
5. Prepare the canonical runtime artifact and reviewable lifecycle request. Installation/restart remains subject to the existing exact-target approval protocol. Completion requires a healthy exact ValorIDE registry match and fresh heartbeat/version/capability evidence plus canonical receipt; source tests alone are not live recovery.

## Validated source and remaining activation work

The seven recovery cases pass. A separate staged-artifact boot test found that the service's fixed dependency list omitted `swarm-workflow-trust.mjs`; the concurrent workflow runtime also needs `swarm-workflow-transport.mjs`. Both dependencies are now included in canonical service staging. The isolated candidate includes only the committed trust dependency and this recovery change, preserving the in-progress transport work outside that candidate.

The current live `swarm-bridge` handle belongs to `codex-macbook-pro-2.local` on `macbook-pro-2.local` and is shared by four configured agents. Its canonical restart API restarts the installed content-addressed artifact; it does not install this update. No native service definition, installed runtime, or approval receipt was changed. Activation must bind the tested artifact update and the shared-service effect before supervisor and heartbeat acceptance can be claimed.

Evidence and the checksum-pinned scoped package are recorded in `ValkyrAI/work/stack-perfection-20260908/swarm-recovery/acceptance.json`.
