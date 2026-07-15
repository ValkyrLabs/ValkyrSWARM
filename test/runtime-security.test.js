import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commandDisposition, normalizeWebSocketUrl, validateConfig } from "../scripts/swarm-agent.mjs";
import { forbiddenConfigPaths, readReceiptEvidence } from "../scripts/swarm-doctor.mjs";

test("runtime accepts only exact targets and advertised capabilities", () => {
  const agent = { agentId: "codex-host", capabilities: ["workflow.debug"] };
  assert.equal(commandDisposition({ targetInstanceId: "codex-host", action: "workflow.debug" }, agent).disposition, "accept");
  assert.equal(commandDisposition({ action: "workflow.debug" }, agent).reason, "missing_target_instance_id");
  assert.equal(commandDisposition({ targetInstanceId: "other", action: "workflow.debug" }, agent).reason, "target_mismatch");
  assert.equal(commandDisposition({ targetInstanceId: "codex-host", action: "code.execute" }, agent).reason, "action_not_advertised_by_agent");
  assert.equal(commandDisposition({ targetInstanceId: "codex-host", action: "merge" }, agent).protectedAction, true);
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
  fs.appendFileSync(receipt, `${JSON.stringify({ event: "bad", value: "Bearer eyJabcdefgh.ijklmnop.qrstuvwx" })}\n`);
  assert.equal(readReceiptEvidence(receipt, ["codex-host"]).secretSafe, false);
  fs.rmSync(root, { recursive: true, force: true });
});
