# PRD: Portable Local-LLM SWARM Workflow Node

Status: Approved milestone definition  
Owner: Valkyr SWARM  
Integrations: ValkyrAI, ValorIDE, GrayMatter  
Initial providers: LM Studio and Ollama

## Outcome

A user installs the Valkyr SWARM executable skill and MCP on a machine running LM Studio or Ollama, authenticates once, and registers that machine as a tenant-scoped SWARM node. ValkyrAI can then deliver a signed, immutable workflow bundle to exactly that node. The local workflow engine executes the workflow using the selected local model, survives interruption, and returns auditable checkpoints, artifacts, and terminal receipts.

The same workflow bundle must execute through LM Studio and Ollama without changing its workflow definition.

## Primary demonstration

An authorized user says: “Have the model running in LM Studio execute the marketing workflow.”

1. The voice-capable agent resolves the requested workflow and target node.
2. ValkyrAI selects, materializes, validates, and signs one exact immutable workflow version.
3. SWARM verifies the caller’s authority and leases the execution to one exact compatible LM Studio node.
4. The node verifies the bundle, lease, fence, provider, and installed capability packs.
5. Its local workflow engine executes the graph using the local LM Studio model.
6. The node reports bounded progress, checkpoints, artifacts, and a terminal receipt.
7. GrayMatter durably relates the request, workflow release, node, execution, artifacts, approvals, and receipt.

The same demonstration must pass against an Ollama node.

## Node classes

### Agentic nodes

ValorIDE, OpenClaw, Codex, Valklaw, and similar runtimes may execute only the native SWARM capabilities they explicitly advertise and successfully probe. Their own agentic runtime may fulfill those capabilities, subject to tenant policy, approvals, leases, fences, and receipts.

### Model-only nodes

An LM Studio or Ollama API is an inference provider, not a general-purpose agent or command runner. A model-only node may execute only a server-signed, immutable ValkyrAI workflow bundle through the installed local workflow engine. It receives no arbitrary shell, browser, filesystem, deployment, messaging, or agent-command authority merely because a local model endpoint is reachable.

## Architectural decisions

1. The deployment unit is a signed workflow bundle, not an agent framework.
2. ValkyrAI owns workflow definition, validation, immutable materialization, signing, compatibility, dispatch authorization, leases, fences, cancellation, and approval binding.
3. Valkyr SWARM is the only command bus. It performs exact-target routing, node registration, capability advertisement, lifecycle transport, and receipts.
4. LM Studio and Ollama implement one provider-neutral local inference contract. Provider adapters normalize model discovery, messages, structured output, streaming, cancellation, context limits, and usage.
5. Models produce inference and bounded proposals. Deterministic workflow modules and checksum-pinned capability packs perform effects.
6. GrayMatter is the exclusive primary durable memory and object-graph coordination layer. A narrow encrypted local journal supports restart recovery; it is not a competing durable memory system.
7. ValorIDE is an operator and agentic execution surface, not a second scheduler or command bus.
8. Request origin and execution authority are separate. A workflow request may originate at the mothership or any authorized SWARM agent, including a voice interface, but only ValkyrAI may materialize and authorize the exact executable workflow version.
9. Provider endpoints are loopback-only by default. Remote provider URLs are outside v1.
10. Missing identity, ACL, signature, capability, compatibility, lease, fence, provider health, or required approval fails closed.

## Bidirectional Valkyr SWARM ExecModule

ValkyrAI will provide one canonical `ValkyrSwarmExecModule` as the workflow-native boundary to SWARM. Existing services already provide the transport and control-plane behavior (`SwarmCommandService`, `WorkflowRemoteExecutionService`, workflow-engine dispatch, leases, checkpoints, and receipts); this milestone exposes those capabilities as a typed, governed ExecModule rather than duplicating them.

The module supports two directions:

- **Workflow to SWARM:** discover ACL-visible compatible nodes, dispatch a declared capability or signed workflow intent to one exact node, query execution status, suspend/cancel, and await a terminal receipt.
- **SWARM to workflow:** correlate progress, approval waits, artifacts, failures, cancellation, and terminal receipts back into the originating workflow execution through durable callbacks and idempotent resume events.

The module accepts semantic intent and constraints, never an arbitrary executable payload. For model-only targets it may request only `workflow.engine.execute-workflow`; ValkyrAI resolves and signs the exact workflow version before SWARM dispatch. For agentic targets it may request only a capability the target advertised and live-probed.

The CEO workflow is the primary workflow caller. Its governed planning/execution path may use `ValkyrSwarmExecModule` to launch remote workflows, monitor them, receive outcomes, and continue the CEO graph. The CEO workflow receives no approval bypass: protected effects still suspend at their canonical content-bound human approval checkpoints.

## Workflow bundle contract

The content-addressed bundle contains canonical JSON and pinned assets:

- format, bundle, workflow, and workflow-version identifiers;
- content digest, signing key identifier, and signature;
- immutable graph/state-machine snapshot and entry point;
- typed input, output, artifact, and receipt schemas;
- required engine protocol and minimum compatible version;
- provider-neutral inference requirements, including context floor, modalities, structured-output requirements, and model constraints;
- exact capability-pack IDs, versions, ABI identifiers, and digests;
- step retry, timeout, compensation, and idempotency policies;
- approval checkpoints and protected-effect declarations;
- node-local secret references, never secret values;
- runtime, token, heap, disk, and concurrency ceilings;
- expiry and kill-switch policy.

The dispatch command carries only the bundle reference and digest, execution and command IDs, lease and fence tokens, idempotency key, approved same-origin callbacks, and server-injected approval references.

## MCP installation and activation

1. Install the Valkyr SWARM executable skill/MCP and GrayMatter MCP.
2. Authenticate through the normal secure flow. Tenant and owner context come only from the authenticated session.
3. Discover loopback LM Studio and Ollama endpoints.
4. If several providers or models are valid, require explicit operator selection; do not silently switch providers during an execution.
5. Retrieve the approved workflow-engine and capability-pack release descriptors from ValkyrAI.
6. Verify signatures, checksums, protocol, runtime requirements, provider compatibility, and pack ABI.
7. Install artifacts at digest-addressed paths and start the native supervised services.
8. Probe provider streaming, cancellation, context, and structured-output behavior.
9. Run an end-to-end self-test and durable GrayMatter receipt readback.
10. Register and advertise `workflow.engine.execute-workflow` only after every required live probe passes.

## Product responsibilities

### Valkyr SWARM

- Own the installable skill/MCP, activation, supervision, local provider adapters, workflow-engine installation, exact-target transport, leases, fences, progress frames, and receipt replay.
- Advertise compact provider, engine, ABI, and pack compatibility without exposing prompts, secrets, or unnecessary model inventory.
- Provide actionable error categories and preserve the underlying cause behind execution references.

### ValkyrAI

- Own workflow CRUD, validation, immutable snapshots, signing, release descriptors, scheduling, authorization, callbacks, approvals, cancellation, and execution status.
- Preserve generated ThorAPI RBAC/ACL and schema-first, ACL-second routing.
- Expose workflow bundles and execution objects only through authenticated, ACL-filtered generated paths.

### ValorIDE

- Provide install and activation UX, provider/model selection, readiness, compatibility, execution timeline, approvals, artifacts, retry, cancellation, and rollback.
- Use existing SWARM and ValkyrAI APIs. Do not introduce client-side scheduling or an alternate command bus.
- Clearly distinguish accepted, started, waiting for approval, retrying, completed, failed, cancelled, and receipt-pending states.

### GrayMatter

- Store durable node activation evidence, workflow releases, execution and artifact receipts, failure summaries, and recovery handoffs.
- Preserve graph relationships among tenant, caller, agent, node, workflow release, execution, approval, artifact, and receipt.
- Let execution recover from the encrypted local journal when temporarily unavailable, while reporting receipt state honestly as durable, queued, or degraded and replaying on recovery.

## Security invariants

- Generated ValkyrAI RBAC/ACL is authoritative.
- Schema routing occurs before ACL evaluation; missing tenant context fails closed.
- Exact target plus an advertised, live-probed capability is required.
- Bundles must pass tenant authorization, signature, digest, expiry, engine ABI, pack ABI, lease, fence, and idempotency validation before work begins.
- `outbound.send`, `production.deploy`, `merge`, and `service.lifecycle.restart` require exact server-injected, content-bound human approval.
- Prompt text, caller-supplied approval strings, model output, and capability advertisement never constitute approval.
- Secrets remain node-local brokered references and never enter bundles, journals, heartbeats, logs, or receipts.
- Logs and progress frames are bounded and redacted.

## Milestones

### M0 — Contract freeze

- Canonical bundle schema and signature rules.
- Provider-neutral inference ABI.
- Two node-class registration and capability contract.
- Lifecycle frames, error taxonomy, compatibility matrix, golden fixtures, and threat model.

### M1 — Reference vertical slice

- Extend the existing SWARM workflow engine; do not create another runner.
- Execute one signed deterministic workflow with encrypted journal, restart recovery, exact receipts, and one safe capability pack.
- Activation and live doctor support.

### M2 — LM Studio adapter

- Discovery, explicit model selection, streaming, cancellation, structured output, context validation, and normalized failures.
- Run the golden workflow and return an artifact plus durable receipt.

### M3 — Ollama adapter

- Pass the same provider conformance suite and golden workflow.
- Prove equivalent workflow transitions, checkpoint schema, artifact schema, and receipt schema.

### M4 — Cross-product integration

- ValkyrAI signing, release, dispatch, approval, and cancellation paths.
- ValorIDE operator lifecycle UX.
- GrayMatter durable graph receipts and degraded replay.
- Voice-originated mothership and peer-agent dispatch demonstrations.

### M5 — Production hardening

- Canary rollout, key rotation, resource exhaustion, offline/reconnect, lease loss, stale fence, malicious bundle, approval, compensation, upgrade, rollback, and kill-switch testing.

## Acceptance criteria

1. A clean macOS or Linux machine can install and activate without a ValkyrAI source checkout.
2. Healthy LM Studio and Ollama loopback providers are detected; activation fails closed when neither is valid.
3. The same signed golden bundle executes on both providers with equivalent typed outputs and lifecycle schemas.
4. A model-only node rejects native agent commands and undeclared tools even when its model proposes them.
5. An agentic node executes only a capability it advertised and successfully probed.
6. Modified, unsigned, expired, wrong-tenant, incompatible-engine, and undeclared-pack bundles are rejected before execution.
7. Restart during execution resumes without duplicating a committed side effect.
8. Replaying a command and idempotency key returns the existing terminal receipt.
9. Lease loss or stale fence prevents further effects.
10. Protected steps suspend until the exact approval is injected by the server; chat text and forged references cannot resume them.
11. GrayMatter outage produces an honest queued/degraded state, followed by successful replay and ID readback after recovery.
12. Cancellation interrupts active provider inference and emits a terminal receipt.
13. Token, duration, heap, disk, and concurrency ceilings produce bounded failures.
14. A voice request dispatches the marketing workflow from an authorized mothership or peer agent to one exact LM Studio node and returns its artifacts and receipts.
15. The same voice scenario succeeds against one exact Ollama node.
16. The CEO workflow invokes `ValkyrSwarmExecModule` to launch the signed marketing workflow on one exact compatible model-only node, waits durably, consumes its terminal artifact/receipt, and resumes exactly once.
17. A SWARM progress or terminal event delivered more than once produces one workflow transition and no duplicated downstream effect.

## Non-goals

- Replacing ValkyrAI Workflow, SWARM transport, GrayMatter, or generated ACL.
- Making LM Studio or Ollama a general-purpose agent or arbitrary command runner.
- Shipping all of ValkyrAI to an edge node.
- Peer-to-peer scheduling, implicit broadcast, arbitrary shell access, arbitrary capability-pack installation, local-model training, provider-specific workflow definitions, or remote exposure of local provider APIs.

## Rollout and rollback

Release engines, adapters, packs, and bundles independently by signed digest. Start with internal nodes, then one canary tenant, opt-in tenants, and general availability. Retain the current and previous two verified sets. Rollback withdraws the new capability manifest, drains new leases, activates the prior pinned set, and requires fresh heartbeat, live doctor, workflow proof, and GrayMatter receipt readback. Never mutate an execution journal in place.

## Ownership and execution plan

One accountable implementation owner in Valkyr SWARM owns the bundle contract, provider ABI, acceptance matrix, and release gate. Cross-product changes are bounded integration lanes:

- Valkyr SWARM: runtime, adapters, install, supervision, protocol, receipts.
- ValkyrAI: materialization, signing, authorization, dispatch, lifecycle APIs.
- ValorIDE: operator and agentic-node UX.
- GrayMatter: durable graph memory, receipts, replay evidence.

Implementation starts with M0 and M1 in Valkyr SWARM while active dirty work in ValkyrAI and ValorIDE remains untouched until their owners accept the integration contracts.
