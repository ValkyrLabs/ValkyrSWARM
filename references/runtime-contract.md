# Valkyr SWARM runtime contract

## Identity and tenancy

- The authenticated Valkyr session is the only source of tenant, organization, owner, RBAC, and ACL context.
- Agent configuration contains stable machine/runtime identifiers and private credential-file references, never caller-supplied tenant identity.
- Every command targets one exact registered instance and one advertised capability or supported tool.

## Advertised Workflow capability tiers

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

Capability is not authorization. Outbound sends, production deployments, merges, and financial, legal, personnel, destructive, irreversible, security-sensitive, or material-spend effects continue through ValkyrAI's canonical correlated human-approval control plane.
