import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CommandOutcomeJournal,
  RUNTIME_OUTCOME_SCHEMA,
  commandBinding,
} from "../scripts/swarm-command-journal.mjs";
import {
  SwarmAgent,
  runtimeTerminalResponse,
} from "../scripts/swarm-agent.mjs";

function stampedWire({
  action = "market.research",
  commandId = "cmd-journal-1",
  targetInstanceId = "runtime-node",
  data = { objective: "Research the bounded market" },
  scope = { tenantId: "tenant-1", campaignId: "campaign-1" },
  approvalRef,
  requiresApproval = false,
} = {}) {
  const wire = {
    action,
    commandId,
    targetInstanceId,
    command: {
      action,
      data,
      scope,
      ...(approvalRef ? { approvalRef } : {}),
      ...(requiresApproval ? { requiresApproval: true } : {}),
    },
    trace: { traceId: `trace-${commandId}` },
  };
  const binding = commandBinding(wire);
  wire.command.actionDigest = binding.actionDigest;
  wire.command.scopeDigest = binding.scopeDigest;
  return wire;
}

function wireBody(wire) {
  return JSON.stringify({
    type: "agent",
    payload: JSON.stringify({
      commandId: wire.commandId,
      targetInstanceId: wire.targetInstanceId,
      trace: wire.trace,
      command: wire.command,
    }),
  });
}

function successfulRuntimeResult(wire, adapter = "codex-cli") {
  const binding = commandBinding(wire);
  return {
    adapter,
    attempted: true,
    executed: true,
    receiptOnly: false,
    status: "completed",
    actionDigest: binding.actionDigest,
    scopeDigest: binding.scopeDigest,
    outcome: {
      schemaVersion: RUNTIME_OUTCOME_SCHEMA,
      status: "SUCCEEDED",
      commandId: binding.commandId,
      actionDigest: binding.actionDigest,
      targetInstanceId: binding.targetInstanceId,
      scopeDigest: binding.scopeDigest,
      summary: "Bounded task completed and verified",
      evidenceRefs: ["test:focused:green"],
      source: "runtime-envelope",
      confidence: "EXPLICIT",
    },
    artifact: { terminalText: "Bounded task completed and verified" },
  };
}

function buildAgent({
  journalRoot,
  runtimeExecutor,
  capabilities = ["market.research"],
  persist = async () => ({ id: null, status: "queued" }),
} = {}) {
  const responses = [];
  const instance = new SwarmAgent({
    agent: {
      agentId: "runtime-node",
      runtime: "codex",
      capabilities,
      execution: {
        adapter: "codex-cli",
        agentId: "runtime-node",
        executable: "/bin/codex",
        timeoutSeconds: 30,
        workingDirectory: "/tmp",
      },
    },
    apiBase: "https://api-0.valkyrlabs.com/v1",
    machineId: "test-host",
    tokenProvider: async () => "test-token",
    url: "wss://api-0.valkyrlabs.com/ws",
    heartbeatSeconds: 30,
    evidence: { record() {} },
    commandJournalRoot: journalRoot,
    runtimeExecutor,
  });
  instance.sendCommandResponse = (_wire, response) => {
    responses.push(structuredClone(response));
    return response;
  };
  instance.persistTerminalReceipt = persist;
  return { instance, responses };
}

async function drainAgent(instance) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inFlight = [...instance.inFlightCommands.values()];
    if (inFlight.length === 0) return;
    await Promise.all(inFlight);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("SWARM test agent did not drain its command");
}

test("canonical command binding matches the cross-runtime digest vector", () => {
  const wire = {
    action: "market.research",
    commandId: "cmd-binding-vector-1",
    targetInstanceId: "openclaw-marketing",
    command: {
      action: "market.research",
      data: {
        objective: "Rank two segments",
        segments: ["bank-kyc", "fintech-kyb"],
        limit: 2,
      },
      scope: { tenantId: "tenant-alpha", campaignId: "campaign-42" },
      requiresApproval: false,
    },
    trace: { traceId: "trace-ignored" },
  };
  const binding = commandBinding(wire);
  assert.equal(binding.scopeDigest,
    "sha256:917df8e504284cfd36997d29cd11684eaeef829728f82077e67e5d75cfb2178a");
  assert.equal(binding.actionDigest,
    "sha256:91a435e9400796a533ee0e404befc8f70c8ef5832bd81e77bfa68291e481cec0");
});

test("terminal journal proof replays across restart without respawning and survives GrayMatter outage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-command-journal-"));
  try {
    const wire = stampedWire();
    let spawnCount = 0;
    const runtimeExecutor = async ({ wire: executedWire }) => {
      spawnCount += 1;
      return successfulRuntimeResult(executedWire);
    };
    const first = buildAgent({ journalRoot: root, runtimeExecutor });
    first.instance.onMessage(wireBody(wire));
    await drainAgent(first.instance);

    assert.equal(spawnCount, 1);
    assert.equal(first.responses.at(-1).status, "completed");
    assert.equal(first.responses.at(-1).result.grayMatterReceiptStatus, "queued");
    const firstJournal = new CommandOutcomeJournal({ agentId: "runtime-node", root });
    assert.equal(firstJournal.inspect(wire).decision, "REPLAY_TERMINAL");

    const restarted = buildAgent({ journalRoot: root, runtimeExecutor });
    restarted.instance.onMessage(wireBody(wire));
    await drainAgent(restarted.instance);

    assert.equal(spawnCount, 1);
    assert.equal(restarted.responses.length, 1);
    assert.equal(restarted.responses[0].status, "completed");
    assert.equal(restarted.responses[0].result.replayed, true);
    assert.equal(restarted.responses[0].result.outcome.status, "SUCCEEDED");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a duplicate command ID with a changed canonical action digest is rejected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-command-digest-"));
  try {
    const original = stampedWire({ commandId: "cmd-stable-id" });
    let spawnCount = 0;
    const runtimeExecutor = async ({ wire }) => {
      spawnCount += 1;
      return successfulRuntimeResult(wire);
    };
    const first = buildAgent({ journalRoot: root, runtimeExecutor });
    first.instance.onMessage(wireBody(original));
    await drainAgent(first.instance);

    const changed = stampedWire({
      commandId: original.commandId,
      data: { objective: "A materially different task" },
    });
    const restarted = buildAgent({ journalRoot: root, runtimeExecutor });
    restarted.instance.onMessage(wireBody(changed));
    await drainAgent(restarted.instance);

    assert.equal(spawnCount, 1);
    assert.equal(restarted.responses.at(-1).type, "NACK");
    assert.equal(restarted.responses.at(-1).status, "rejected");
    assert.equal(restarted.responses.at(-1).reason, "command_id_action_digest_mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous started protected work is quarantined as OUTCOME_UNCERTAIN", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-command-protected-"));
  try {
    const approvalRef = `gm_approval_${"a".repeat(64)}`;
    const wire = stampedWire({
      action: "outbound.send",
      commandId: "cmd-approved-send",
      data: { recipient: "customer@example.test", template: "follow-up-v1" },
      approvalRef,
      requiresApproval: true,
    });
    const journal = new CommandOutcomeJournal({ agentId: "runtime-node", root });
    assert.equal(journal.markStarted(wire, { protectedAction: true }).decision, "NEW");
    let spawnCount = 0;
    const restarted = buildAgent({
      journalRoot: root,
      capabilities: ["outbound.send"],
      runtimeExecutor: async () => {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    });
    restarted.instance.onMessage(wireBody(wire));
    await drainAgent(restarted.instance);

    assert.equal(spawnCount, 0);
    const terminal = restarted.responses.at(-1);
    assert.equal(terminal.type, "NACK");
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.reason, "ambiguous_started_effect_quarantined");
    assert.equal(terminal.result.quarantined, true);
    assert.equal(terminal.result.outcome.status, "OUTCOME_UNCERTAIN");
    assert.equal(terminal.result.outcome.source, "journal-quarantine");
    assert.equal(journal.inspect(wire, { protectedAction: true }).decision, "REPLAY_TERMINAL");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal conservatively distinguishes replay-safe and non-idempotent started work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-command-idempotency-"));
  try {
    const journal = new CommandOutcomeJournal({ agentId: "runtime-node", root });
    const safe = stampedWire({ action: "market.research", commandId: "cmd-safe" });
    journal.markStarted(safe);
    assert.equal(journal.inspect(safe).decision, "RESUME_SAFE");

    const unsafe = stampedWire({ action: "crm.write", commandId: "cmd-unsafe" });
    journal.markStarted(unsafe);
    assert.equal(journal.inspect(unsafe).decision, "QUARANTINE_UNCERTAIN");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("journal records are private, bounded, redacted, and do not retain command payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-command-private-"));
  try {
    const journal = new CommandOutcomeJournal({
      agentId: "runtime-node",
      root,
      maxEntries: 2,
    });
    for (let index = 0; index < 3; index += 1) {
      const wire = stampedWire({
        commandId: `cmd-private-${index}`,
        data: { objective: `private objective ${index}`, secretToken: "top-secret-value" },
      });
      journal.markStarted(wire);
      journal.markTerminal(wire, runtimeTerminalResponse(successfulRuntimeResult(wire)));
    }
    const files = fs.readdirSync(path.join(root, "runtime-node"));
    assert.equal(files.length, 2);
    for (const file of files) {
      const filePath = path.join(root, "runtime-node", file);
      const text = fs.readFileSync(filePath, "utf8");
      assert.equal(fs.statSync(filePath).mode & 0o077, 0);
      assert.equal(text.includes("top-secret-value"), false);
      assert.equal(text.includes("private objective"), false);
      assert.match(text, /"actionDigest": "sha256:[0-9a-f]{64}"/);
      assert.match(text, /"scopeDigest": "sha256:[0-9a-f]{64}"/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime status mapping never ACKs failed, blocked, or uncertain outcomes as completed", () => {
  const wire = stampedWire();
  for (const [status, expected] of [
    ["SUCCEEDED", ["ACK", "completed"]],
    ["FAILED", ["NACK", "failed"]],
    ["BLOCKED", ["NACK", "blocked"]],
    ["WAITING_APPROVAL", ["ACK", "progress"]],
    ["OUTCOME_UNCERTAIN", ["NACK", "failed"]],
  ]) {
    const result = successfulRuntimeResult(wire);
    result.outcome.status = status;
    result.executed = status === "SUCCEEDED";
    const response = runtimeTerminalResponse(result);
    assert.deepEqual([response.type, response.status], expected);
    if (status === "WAITING_APPROVAL") {
      assert.equal(response.result.checkpoint, true);
      assert.equal(response.result.executionState, "WAITING_APPROVAL");
    }
  }
});
