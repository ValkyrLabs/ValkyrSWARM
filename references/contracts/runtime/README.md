# Governed runtime outcome contract

## Versioned node-class boundary

`valkyr-swarm-node.v1.schema.json` distinguishes an `agentic-runtime` from a
`model-only` node. Existing nodes without the descriptor remain agentic during
the rolling transition; new local-model nodes must send the v1 descriptor.

An agentic runtime may execute only its explicitly advertised and live-probed
native capabilities. A model-only node has no native execution adapter and may
advertise only `workflow.engine.execute-workflow`, its workflow cancellation or
approval-denial controls, and the bounded discovered service lifecycle controls.
It cannot advertise shell, browser, filesystem, messaging, deployment, merge,
or arbitrary agent commands. The engine still validates signed immutable
workflow bundles and installed capability packs before performing any effect.

`valkyr-local-inference-provider.v1.schema.json` is the provider-neutral
descriptor used by both LM Studio and Ollama. It names one explicit model and a
credential-free loopback HTTP endpoint, and advertises only normalized model
listing, chat, streaming, cancellation, and structured-output operations.

The future ValkyrAI `ValkyrSwarmExecModule` consumes this contract rather than a
provider-specific payload. Workflow-to-SWARM requests select one exact node and
semantic action; SWARM-to-workflow events return correlated progress,
checkpoints, approval waits, artifacts, cancellation, and terminal receipts.
The schemas here define node eligibility only: ValkyrAI remains the canonical
owner of workflow materialization, signing, authorization, and idempotent resume.

An adapter process exit code is transport evidence only. A non-Workflow SWARM
command advances as completed only when its normalized `result.outcome` matches
`valkyr-swarm-runtime-outcome/v1` and is bound to the dispatched command.

The canonical digests are lowercase SHA-256 hex prefixed by `sha256:`. Hash the
UTF-8 bytes of compact JSON after recursively sorting object keys, preserving
array order, omitting undefined values, and recursively omitting these volatile
keys:

`actionDigest`, `scopeDigest`, `commandId`, `createdAt`, `deliveredAt`,
`dispatchedAt`, `heartbeatAt`, `receiptRef`, `retryCount`, `sentAt`, `timestamp`,
`trace`, `traceId`, `updatedAt`.

`scopeDigest` hashes the resolved scope:

`command.scope ?? command.payload.metadata.scope ?? command.metadata.scope ?? null`

`actionDigest` hashes this object (the canonicalizer determines byte key order):

```json
{
  "action": "<wire.action>",
  "approvalRef": "<trimmed command.approvalRef or null>",
  "payload": "<command.payload.data ?? command.data ?? command.payload ?? command>",
  "requiresApproval": "<command.requiresApproval === true>",
  "scope": "<resolved scope>",
  "targetInstanceId": "<trimmed wire.targetInstanceId or null>"
}
```

The control plane should stamp `command.actionDigest` and `command.scopeDigest`.
The node always recomputes and rejects a supplied mismatch; missing stamps are
derived only for rolling compatibility. Runtime envelopes must echo the exact
command ID, action digest, target, and scope digest.

`SUCCEEDED` also requires at least one nonempty `evidenceRefs` entry, bounded
`evidence` item, or valid `outcomeHash`. For conservatively recognized legacy
success prose, SWARM supplies a content hash reference in the form
`runtime-transcript:sha256:<hex>`.

Wire status mapping is deliberately fail-closed:

| Outcome | Command response |
| --- | --- |
| `SUCCEEDED` | `ACK / completed` |
| `FAILED` | `NACK / failed` |
| `BLOCKED` | `NACK / blocked` |
| `WAITING_APPROVAL` | `ACK / progress`, checkpointed as `WAITING_APPROVAL` |
| `OUTCOME_UNCERTAIN` | `NACK / failed`, with the exact nested outcome status |

The node-local journal is authoritative for non-Workflow adapter replay.
GrayMatter receives the bounded evidence projection. The Workflow engine and
supervised service lifecycle retain their existing independent recovery logs.
