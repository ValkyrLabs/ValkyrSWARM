import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandDestinations,
  commandDisposition,
  controlReplyDestination,
  normalizeWebSocketUrl,
  parseServerControlReply,
  validateConfig,
} from "../scripts/swarm-agent.mjs";
import { forbiddenConfigPaths, readReceiptEvidence } from "../scripts/swarm-doctor.mjs";

test("runtime accepts only exact targets and advertised capabilities", () => {
  const agent = { agentId: "codex-host", capabilities: ["workflow.debug"] };
  assert.equal(commandDisposition({ targetInstanceId: "codex-host", action: "workflow.debug" }, agent).disposition, "accept");
  assert.equal(commandDisposition({ action: "workflow.debug" }, agent).reason, "missing_target_instance_id");
  assert.equal(commandDisposition({ targetInstanceId: "other", action: "workflow.debug" }, agent).reason, "target_mismatch");
  assert.equal(commandDisposition({ targetInstanceId: "codex-host", action: "code.execute" }, agent).reason, "action_not_advertised_by_agent");
  assert.equal(commandDisposition({ targetInstanceId: "codex-host", action: "merge" }, agent).protectedAction, true);
});

test("runtime accepts only content-bound server-approved protected commands", () => {
  const agent = { agentId: "codex-host", capabilities: ["merge"] };
  const base = { targetInstanceId: "codex-host", action: "merge" };
  assert.equal(commandDisposition(base, agent).disposition, "reject");
  assert.equal(commandDisposition({
    ...base,
    command: { requiresApproval: true, approvalRef: "gm_approval_not-a-digest" },
  }, agent).disposition, "reject");
  const approvalRef = `gm_approval_${"a".repeat(64)}`;
  const approved = commandDisposition({
    ...base,
    command: { requiresApproval: true, approvalRef },
  }, agent);
  assert.equal(approved.disposition, "accept");
  assert.equal(approved.protectedAction, true);
  assert.equal(approved.approvalRef, approvalRef);
  assert.equal(commandDisposition({
    ...base,
    command: { requiresApproval: true, approvalRef },
  }, { ...agent, capabilities: ["pr.review"] }).reason, "action_not_advertised_by_agent");
});

test("remote workflow commands fail closed until the configured runtime is healthy", () => {
  const agent = {
    agentId: "workflow-host",
    runtime: "valkyrai-workflow",
    capabilities: ["graymatter.context"],
    workflowRuntime: {
      endpoint: "http://127.0.0.1:8765/v1/swarm/workflow-runs/execute",
      healthEndpoint: "http://127.0.0.1:8765/v1/swarm/workflow-runs/health",
    },
  };
  const wire = {
    targetInstanceId: "workflow-host",
    action: "workflow.runner.execute-module",
  };
  assert.equal(commandDisposition(wire, agent, { healthy: false }).reason, "action_not_advertised_by_agent");
  assert.equal(commandDisposition(wire, agent, {
    healthy: true,
    protocol: "valkyr-workflow-runner/v1",
    supportedTools: ["workflow.runner.execute-module"],
  }).disposition, "accept");
});

test("tenant runtimes subscribe only to their exact-target private queue", () => {
  assert.deepEqual(commandDestinations("codex-host"), [{
    destination: "/queue/agents/codex-host/commands",
    id: "private-codex-host",
  }]);
  assert.equal(
    commandDestinations("codex-host").some(({ destination }) => destination === "/topic/agent-commands"),
    false,
  );
});

test("server registration and heartbeat replies are correlated on the session control queue", () => {
  assert.deepEqual(controlReplyDestination("codex-host"), {
    destination: "/user/queue/swarm-control",
    id: "server-control-codex-host",
  });
  const reply = parseServerControlReply(JSON.stringify({
    type: "broadcast",
    payload: JSON.stringify({
      topic: "ack",
      payload: {
        ackId: "registration-1",
        status: "ok",
        data: { status: "heartbeat_recorded", instanceId: "codex-host" },
      },
    }),
  }));
  assert.equal(reply.ackId, "registration-1");
  assert.equal(reply.topic, "ack");
  assert.equal(reply.data.instanceId, "codex-host");
  assert.equal(parseServerControlReply("not-json"), null);
});

test("manual configs reject protocol-header injection and excessive capacity", () => {
  assert.throws(() => validateConfig({
    machineId: "host",
    agents: [{ agentId: "codex-host\ninjected", runtime: "codex", capabilities: ["workflow.debug"], capacity: 1 }],
  }), /unsupported characters/);
  assert.throws(() => validateConfig({
    machineId: "host",
    agents: [{ agentId: "codex-host", runtime: "codex", capabilities: ["workflow.debug"], capacity: 101 }],
  }), /integer from 1 to 100/);
  assert.throws(() => validateConfig({
    machineId: "host",
    agents: [{ agentId: "a".repeat(161), runtime: "codex", capabilities: ["workflow.debug"], capacity: 1 }],
  }), /unsupported characters/);
});

test("websocket normalization rejects credential and query injection", () => {
  assert.equal(normalizeWebSocketUrl("https://api-0.valkyrlabs.com/v1"), "wss://api-0.valkyrlabs.com/swarm");
  assert.throws(() => normalizeWebSocketUrl("wss://user:pass@api-0.valkyrlabs.com/swarm"), /must not contain credentials/);
  assert.throws(() => normalizeWebSocketUrl("wss://api-0.valkyrlabs.com/swarm?token=value"), /must not contain credentials/);
});

test("doctor detects forbidden identity fields and secret-bearing receipts", () => {
  assert.deepEqual(forbiddenConfigPaths({ authTokenFile: "/secure/path", tenantId: "prompt-value" }), ["tenantId"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-doctor-"));
  const receipt = path.join(root, "receipt.jsonl");
  fs.writeFileSync(receipt, `${JSON.stringify({ timestamp: new Date().toISOString(), event: "heartbeat_sent", agentId: "codex-host" })}\n`, { mode: 0o600 });
  assert.equal(readReceiptEvidence(receipt, ["codex-host"]).secretSafe, true);
  assert.equal(readReceiptEvidence(receipt, ["codex-host"]).serverAckAgeSeconds, null);
  fs.appendFileSync(receipt, `${JSON.stringify({ timestamp: new Date().toISOString(), event: "heartbeat_ack", agentId: "codex-host" })}\n`);
  assert.equal(readReceiptEvidence(receipt, ["codex-host"]).serverAckAgeSeconds, 0);
  fs.appendFileSync(receipt, `${JSON.stringify({ event: "bad", value: "Bearer eyJabcdefgh.ijklmnop.qrstuvwx" })}\n`);
  assert.equal(readReceiptEvidence(receipt, ["codex-host"]).secretSafe, false);
  fs.rmSync(root, { recursive: true, force: true });
});
