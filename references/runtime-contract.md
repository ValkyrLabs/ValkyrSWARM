# Valkyr SWARM runtime contract

## Identity and tenancy

- The authenticated Valkyr session is the only source of tenant, organization, owner, RBAC, and ACL context.
- Agent configuration contains stable machine/runtime identifiers and private credential-file references, never caller-supplied tenant identity.
- Every command targets one exact registered instance and one advertised capability or supported tool.

## Shared secure-session recovery

- Each reconnect rereads the canonical secure session. On forced refresh, a peer may reuse a different session from the deterministic Keychain account or configured private token file before requiring reusable credentials. An unchanged rejected session never counts as recovery.
- The comparison belongs to the failing socket. A healthy peer reading the new shared session must not prevent another peer from recovering. Rejected tokens remain private in-process state and never enter evidence, configuration or command receipts.
- Concurrent credential refreshes share one login and persistence operation; a failed login permits a later retry. Events from replaced sockets cannot invalidate their replacements or schedule recovery for them.
- Source or package validation does not establish installed health. Governed activation must still prove the exact registered agent, fresh server heartbeat, advertised capabilities and terminal receipt.

## Governed native service lifecycle

- `service.lifecycle.status` is bounded, read-only inspection. `service.lifecycle.restart` is protected and requires the mothership-injected content-bound `gm_approval_...` reference for the exact target agent, expected machine, and semantic service handle.
- A node advertises status only when it discovers at least one installed canonical launchd or user-systemd binding. It advertises restart only when at least one discovered binding is restartable. Configuration text, chat instructions, or a caller-supplied label never create either capability.
- The only semantic handles are `codex`, `openclaw`, `valoride`, `swarm-bridge`, `workflow-runner`, `workflow-engine`, and `claude-code`. Handles resolve locally to deterministic node-owned definitions; the wire contract accepts no process, executable, supervisor label, filesystem path, shell, argument, environment, or sudo material.
- A `valoride` handle controls only a canonically supervised ValorIDE SWARM bridge/runner. It does not imply desktop application UI health and must never kill or relaunch an arbitrary GUI process.
- Ordinary Claude Code CLI sessions are interactive bounded sessions, not services. `claude-code` is advertised only when an explicit canonical supervised Claude Code bridge definition exists; otherwise launch a new bounded task through the existing runtime adapter.
- Status and restart reject missing targets, host mismatches, missing services, undeclared capabilities, unsupported supervisors, and malformed or injected payload fields. Native supervisor execution uses fixed argument arrays without shell interpolation or privilege escalation.
- Accepted delivery is not completion. The runtime emits started/progress and terminal completed/failed frames; completion requires supervisor health plus a fresh expected agent heartbeat, version, capabilities, and terminal GrayMatter receipt.
- Restarting the shared SWARM bridge, including its supervised Codex, OpenClaw, or ValorIDE projection, writes a private durable pending-recovery record before invoking the native supervisor. The reconnected bridge reconciles that record and emits terminal proof. A separately supervised Workflow runner or engine is verified synchronously by its healthy peer bridge.

## Advertised Workflow capability tiers

Every executable node registration and heartbeat advertises its canonical
`workspaceFolders` and `workspaceSummary`. Dispatchers must treat that metadata
as a routing constraint: an online agent rooted in another workspace is not a
valid substitute for the requested workspace.

### Versioned node classes

- `valkyr-swarm-node/v1` defines `agentic-runtime` and `model-only`. Nodes that omit the descriptor are treated as agentic only for rolling compatibility; every newly activated local-model node must send it.
- Agentic runtimes may execute only their explicitly advertised and live-probed native capabilities.
- Model-only nodes have no native agent execution adapter. They execute only `workflow.engine.execute-workflow` through the durable local engine, plus bounded engine cancellation/approval-denial and discovered service status/protected-restart controls. They fail closed on every arbitrary native capability, including shell, browser, filesystem, messaging, deployment, merge, and agent commands.
- `valkyr-local-inference-provider/v1` normalizes LM Studio and Ollama behind one explicit loopback endpoint, selected model, and bounded operation set. Provider reachability never grants a capability.
- ValkyrAI's canonical `ValkyrSwarmExecModule` is the bidirectional workflow boundary: semantic exact-target requests flow to SWARM, while correlated progress, approval waits, artifacts, failures, cancellation, and terminal receipts resume the originating workflow idempotently. It never carries arbitrary executable payloads and does not duplicate the SWARM command bus.

- `workflow.runner.execute-module` is the constrained stateless tier for one remote-safe ExecModule invocation.
- `workflow.engine.execute-workflow` is the durable tier for one complete immutable Workflow snapshot.
- The configured tier, release descriptor protocol, loopback health protocol, advertised tool, and capability-pack ABI must agree exactly. A health response from one tier can never promote a node configured for the other tier.
- Either tool is advertised only while its own loopback runtime is healthy. Losing health withdraws only that runtime tool and its ABI capabilities.

## Stateless remote Workflow runner

- The canonical wire action is `workflow.runner.execute-module`.
- A node advertises that tool only when an enabled loopback Workflow runtime passes its health probe.
- Registration and every heartbeat publish the runtime's capability, model, tool, environment, privacy, data-classification, integration, cost, latency, trust, concurrency, and lease metadata.
- Losing health withdraws the tool; the ValkyrAI mothership marks the durable WorkflowRunner projection offline.
- The remote command retains the mothership-issued `runId`, `workflowRunnerId`, `leaseFence`, `logicalIdempotencyKey`, secured `inputArtifactRef`, trace refs, and callback paths.
- Before contacting the sidecar, the bridge calls the authenticated `materialize` callback. ValkyrAI verifies the selected runner principal and current lease fence, resolves the secured input under the execution owner, redacts secret-bearing fields, and returns the exact registered module class, grouped config, inputs, and ABI hash.
- Callback paths must remain relative to `/v1/vaiworkflow/runners/` and resolve to the authenticated api-0 origin.
- The bridge renews the lease, streams bounded progress, and submits exactly one fenced terminal completion. The mothership remains authoritative for Run state and rejects stale fences.

## Durable remote Workflow engine

- The canonical wire actions are `workflow.engine.execute-workflow` and `workflow.engine.kill-execution` using `valkyr-workflow-engine/v1`.
- The engine executes the mothership-materialized immutable workflow version and validates its snapshot hash, workflow ABI, module ABI hashes, execution/runner identity, logical idempotency key, and current lease fence before starting or resuming.
- It contains the real deterministic graph/state-machine evaluator: Looper, Wait/Cycle Delay, Parameterization, branching, bounded retries/backoff, compensation, timeouts, kill switch, and approval suspension/resumption.
- A narrow node-key-encrypted H2 journal stores only immutable snapshots, workflow execution and step state, leases/fences, idempotency, approval references, sanitized outputs, callbacks, and receipt replay state. Restart recovery and delayed-cycle scheduling operate from this journal.
- SecureField values are never copied into the journal. Installed modules receive authorized secret references and resolve node-local credentials through Keychain or another credential broker.
- The bridge streams progress and replays durable checkpoint, completion, and failure callbacks over the authenticated WebSocket/HTTP control plane. The node can suspend for approval but has no authority to approve its own request.
- Capability packs are explicit ABI-manifested dependency closures: core transforms, Engineering/ValorIDE, OpenClaw research/drafting, protected OpenClaw outbound GTM, File/project operations, Deployment, and optional connectors. A connector SDK or model enters the engine only when its pack is deliberately installed.
- Every released pack declares the node capabilities it requires. Authenticated release discovery installs only packs whose requirements are a subset of the agent and workflow-runtime capabilities; the local service independently rejects incompatible or manually injected packs; and the engine fails startup if an enabled pack's requirements are absent from the validated capability advertisement passed by the service. `openclaw-research-drafting` requires `openclaw.skill.execute` plus `openclaw.research-draft.execute`; it accepts only immutable fixed research, triage, and drafting operations, emits sanitized internal outputs, and cannot send or publish. `openclaw-gtm` requires `openclaw.skill.execute` plus `outbound.send`; it accepts only immutable fixed outbound operations and its module ABI always invokes canonical human-approval suspension before execution. Both packs use only the exact loopback OpenClaw skill endpoint, node-local credential references, bounded payloads, and sanitized results. `file-project-read` requires `workspace.files.read` and receives only explicit node-local workspace roots. `engineering-project` requires `code.execute` plus `engineering.project.execute`; it exposes only fixed Git inspection and project test/build profiles, invokes no shell, accepts no arbitrary command or environment input, uses an isolated engine-owned HOME, bounds timeout/output, and routes failures through the durable retry state machine. Deployment and merge are not engineering pack profiles and remain protected actions.
- A healthy engine heartbeat publishes `workflow-pack:<id>:<version>` for each enabled pack plus its aggregate manifest hash and count. The full dependency/module manifest remains local to the sidecar and is revalidated at execution time.

## Local runtime packaging

- Both Workflow runtimes bind to `127.0.0.1`. The runner implements `valkyr-workflow-runner/v1`; the engine implements `valkyr-workflow-engine/v1`.
- The sidecar accepts only loopback callers, registered `MapIOModule` implementations, matching ABI hashes, and materializations whose run, runner, fence, and logical idempotency key match the original command.
- JSON responses return a terminal result. `application/x-ndjson` may emit progress records followed by one `completed`, `result`, or `failed` record.
- Requested installation first retrieves the tier-specific `valkyr-workflow-runtime-release/v1` descriptor from the authenticated mothership. The release must name the exact tier/runtime protocol, a version, a credential-free HTTPS artifact URL, an exact SHA-256, Java 17 or newer, and a bounded recommended heap. An engine release may include at most 32 unique capability packs, each with an exact ID/version, credential-free HTTPS artifact URL, and SHA-256. A runner release containing any pack is invalid. The node refuses incompatible metadata or a local Java runtime below the release minimum.
- The JAR and service definition are private and supervised independently of the SWARM bridge. Capability packs use node-owned digest-addressed paths, are downloaded and verified before the service swap, and are loaded only through the explicit engine loader path and enabled-pack list. Explicit runtime artifact overrides require both URL and digest and are reserved for isolated testing; normal activation uses the mothership-approved release and is the only product path that installs packs.
- The stateless runner creates only its private working directory. The durable engine additionally creates a mode-0600 node-key file reference and mode-0700 journal/working directories. Mandatory launch arguments pin the exact bootstrap class and profile plus loopback binding; inherited host settings cannot promote either runtime into a cloud or full-application boot. Optional arguments may not contain credential material. The service definition contains paths, never inline keys, and central database credentials are never required.
- Neither artifact may boot ValkyrAI's full application/JPA entity graph. The engine artifact contains the workflow evaluator and only the exact model/dependency closure contributed by installed capability packs. It excludes CRM/CMS schemas unless a pack needs them; Stripe, AWS, Salesforce, OpenAPI generation, email administration, organization/user management, billing, signup, public APIs, production seeders, application initializers, central RBAC persistence, and SnakeYAML-based configuration.
- Credentials, JWTs, SecureField values, tenant IDs, and inline GrayMatter bodies are never embedded in the runtime service definition or command receipt.

## Approval

Capability is not authorization. Outbound sends, production deployments, merges, supervised service restarts, and financial, legal, personnel, destructive, irreversible, security-sensitive, or material-spend effects continue through ValkyrAI's canonical correlated human-approval control plane.

## Durable engine local transport

Loopback binding is only network isolation. The engine permits read-only health without a credential; execution, control, cancellation, event replay and acknowledgement require `X-Valkyr-Engine-Authorization`. The bridge derives this value as lowercase hexadecimal HMAC-SHA256 of `valkyr-workflow-engine-transport/v1` using the existing node-owned journal key. The key and API JWT never enter the engine request, config, process arguments, logs or upstream callbacks. Requests carrying this header refuse redirects and remain on the configured engine origin. Transport access does not replace independently pinned materialization signatures, exact action grants or required human approvals.

The bridge and journal read the same configured `workflowRuntime.install.engineKeyPath`, or the canonical per-agent engine-key path. The key must be one owned mode-0600 regular file in an owned mode-0700 directory, containing 32–512 printable ASCII bytes and an optional final LF/CRLF. Reads are bounded, reject symbolic and hard links, and fail closed when the platform cannot establish private file ownership and permissions. Activation never changes an existing key's permissions or replaces a missing key for an existing encrypted journal. Restore the original key or deliberately reconcile storage before activation. The public issuer trust file remains separate and contains public material only.

Update and validate the portable bridge together with an authenticated-transport engine release before activation. A successful public health response does not make a bridge with missing private credentials eligible to advertise engine capabilities. The stateless runner keeps its separate runtime tier and cannot carry durable engine commands.

### Private mapped-action authorization

An engine advertising `workflow.private-authorization:v1` suspends signed admitted actions as `WAITING_AUTHORIZATION`. Its encrypted journal atomically stores the frozen mapped request, exact checkpoint, task-entry continuation and reference-only `AUTHORIZATION_REQUESTED` receipt. The public event envelope advertises `privateAuthorization: v1`; inputs and grant envelopes are available only through authenticated local `/authorizations` discovery and `/executions/{executionId}/authorization` read/delivery routes. Discovery is bounded to 25 pending executions and survives receipt acknowledgement and bridge restarts.

The bridge derives `/v1/vaiworkflow/engine/executions/{executionId}/capability-grant` from the private execution binding and uses only the API JWT there. `WAITING_APPROVAL` retains the canonical approval. Signed `ISSUED` results resume the exact frozen action; `RECONCILIATION_REQUIRED`, including denied/expired/consumed canonical approvals, pauses for review. These waits bypass legacy completion-based approval creation. Ordinary debugger continuation cannot replace private action authority; STOP remains available.

The engine claims its local execution slot before committing verified authority and resumption. Cancellation wins over delivery, completed responses are replay-safe, and consumed effects without a committed successful result pause before remapping or new issuance. Public callbacks and GrayMatter receive references only. Known execution leases are renewed before private replay work, and receipt acknowledgement follows durable private handling. The bounded batch handles its pending executions concurrently, each with its own lease renewal, so a slow or failing issuer or local delivery cannot hold up another execution. Any unresolved exchange still prevents acknowledgement.
