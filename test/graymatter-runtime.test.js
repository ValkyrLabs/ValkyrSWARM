import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandReceiptText,
  persistCommandReceipt,
  persistWorkflowHandoff,
  queryMemory,
  replayQueuedReceipts,
  writeMemory,
} from "../scripts/swarm-graymatter.mjs";

test("runtime persists a bounded tenant-derived GrayMatter terminal receipt", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: "memory-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const memory = await persistCommandReceipt({
    agent: { agentId: "codex-host", runtime: "codex" },
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "test-token",
    wire: {
      action: "workflow.debug",
      commandId: "cmd-1",
      trace: { traceId: "trace-1" },
    },
    response: {
      type: "ACK",
      status: "completed",
      result: { executed: true },
    },
    fetchImpl,
  });
  assert.equal(memory.id, "memory-1");
  assert.equal(captured.url, "https://api-0.valkyrlabs.com/v1/MemoryEntry/write");
  assert.equal(captured.body.sourceChannel, "valkyr-swarm:receipts");
  assert.equal(captured.body.sourceMessageId, "swarm-command:cmd-1:completed");
  assert.equal(JSON.parse(captured.body.text).protectedAction, false);
  assert.match(captured.headers.Authorization, /^Bearer /);
});

test("durable workflow lifecycle synchronizes a bounded shared GrayMatter handoff", async () => {
  let captured;
  const memory = await persistWorkflowHandoff({
    agent: { agentId: "valor-engine", runtime: "valoride" },
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "test-token",
    wire: {
      action: "workflow.engine.execute-workflow",
      commandId: "cmd-engine-1",
      trace: { traceId: "workflow-execution:execution-1" },
    },
    response: {
      type: "ACK",
      status: "progress",
      result: {
        sequence: 9,
        eventType: "CHECKPOINT",
        executionState: "WAITING_APPROVAL",
        workflowExecutionId: "execution-1",
        workflowRunnerId: "runner-1",
        leaseFence: 4,
        checkpointRef: "engine-checkpoint:execution-1:approval:module-1",
        artifact: { credentials: { token: "must-not-survive" } },
      },
    },
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ id: "handoff-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(memory.id, "handoff-1");
  assert.equal(captured.body.sourceChannel, "valkyr-swarm:handoff");
  assert.equal(captured.body.sourceMessageId,
    "swarm-workflow:execution-1:9:waiting_approval");
  const handoff = JSON.parse(captured.body.text);
  assert.equal(handoff.executionState, "WAITING_APPROVAL");
  assert.equal(handoff.checkpointRef, "engine-checkpoint:execution-1:approval:module-1");
  assert.equal(captured.body.text.includes("must-not-survive"), false);
});

test("shared handoff writes and invariant queries stay scoped to GrayMatter APIs", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await writeMemory({
    apiBase: "https://api-0.valkyrlabs.com/v1",
    token: "token",
    type: "context",
    text: "Shared handoff",
    sourceChannel: "valkyr-swarm:handoff",
    fetchImpl,
  });
  await queryMemory({
    apiBase: "https://api-0.valkyrlabs.com/v1",
    token: "token",
    query: "binding invariant",
    type: "decision",
    limit: 5,
    fetchImpl,
  });
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/v1/MemoryEntry/write",
    "/v1/MemoryEntry/query",
  ]);
  assert.equal(requests[0].body.sourceChannel, "valkyr-swarm:handoff");
  assert.equal(requests[1].body.type, "decision");
});

test("command receipt text is deterministic in shape and bounded", () => {
  const text = commandReceiptText({
    agent: { agentId: "agent-1", runtime: "openclaw" },
    wire: { commandId: "cmd-1", action: "task.write", trace: {} },
    response: { type: "NACK", status: "failed", reason: "bounded" },
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, "valkyr-swarm-command-receipt/0.1");
  assert.equal(parsed.status, "failed");
});

test("protected command receipts retain the canonical approval binding", () => {
  const approvalRef = `gm_approval_${"c".repeat(64)}`;
  const text = commandReceiptText({
    agent: { agentId: "codex-host", runtime: "codex" },
    wire: {
      commandId: "cmd-approved-merge",
      action: "merge",
      command: { requiresApproval: true, approvalRef },
      trace: { traceId: "trace-approved-merge" },
    },
    response: { type: "ACK", status: "completed", result: { executed: true } },
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.protectedAction, true);
  assert.equal(parsed.approvalRef, approvalRef);
});

test("durable receipts summarize verbose runtime event streams", () => {
  const output = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Verified rc-7 is dirty." } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(20_000) } }),
  ].join("\n");
  const text = commandReceiptText({
    agent: { agentId: "agent-1", runtime: "codex" },
    wire: { commandId: "cmd-compact", action: "workflow.debug", trace: {} },
    response: {
      type: "ACK",
      status: "completed",
      result: { adapter: "codex-cli", executed: true, artifact: { output, eventCount: 2 } },
    },
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.result.artifact.terminalMessage, "Verified rc-7 is dirty.");
  assert.equal(parsed.result.artifact.eventCount, 2);
  assert.equal(text.includes("x".repeat(1_000)), false);
  assert.ok(text.length < 4_000);
});

test("remote workflow receipts retain bounded redacted structured outputs", () => {
  const text = commandReceiptText({
    agent: { agentId: "workflow-host", runtime: "valoride" },
    wire: {
      commandId: "cmd-workflow",
      action: "workflow.runner.execute-module",
      trace: { traceId: "trace-workflow" },
    },
    response: {
      type: "ACK",
      status: "completed",
      result: {
        adapter: "workflow-runtime-http",
        executed: true,
        workflowRunId: "run-1",
        workflowRunnerId: "runner-1",
        leaseFence: 7,
        artifact: {
          executiveSummary: "Completed the bounded analysis",
          metrics: { conversionRate: 0.42 },
          credentials: { apiToken: "must-not-survive" },
          note: "Authorization=must-not-survive-either",
        },
      },
    },
  });

  const parsed = JSON.parse(text);
  assert.equal(parsed.result.workflowRunId, "run-1");
  assert.equal(parsed.result.leaseFence, 7);
  const structured = JSON.parse(parsed.result.artifact.structuredSummary);
  assert.equal(structured.executiveSummary, "Completed the bounded analysis");
  assert.equal(structured.metrics.conversionRate, 0.42);
  assert.equal(structured.credentials, "[REDACTED]");
  assert.equal(structured.note, "Authorization=[REDACTED]");
  assert.equal(text.includes("must-not-survive"), false);
  assert.ok(text.length < 12_000);
});

test("credit-gated receipts enter a private replay queue and later persist", async () => {
  const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-graymatter-replay-"));
  try {
    const queued = await persistCommandReceipt({
      agent: { agentId: "codex-host", runtime: "codex" },
      apiBase: "https://api-0.valkyrlabs.com/v1",
      tokenProvider: async () => "test-token",
      wire: { action: "workflow.debug", commandId: "cmd-credit", trace: { traceId: "trace-credit" } },
      response: { type: "ACK", status: "completed", result: { executed: true } },
      replayDir,
      fetchImpl: async () => new Response(JSON.stringify({ code: "INSUFFICIENT_FUNDS" }), { status: 402 }),
    });
    assert.equal(queued.queued, true);
    assert.equal(fs.statSync(queued.queuePath).mode & 0o077, 0);
    assert.equal(fs.readFileSync(queued.queuePath, "utf8").includes("test-token"), false);

    const replayed = await replayQueuedReceipts({
      agentId: "codex-host",
      apiBase: "https://api-0.valkyrlabs.com/v1",
      tokenProvider: async () => "fresh-token",
      replayDir,
      fetchImpl: async () => new Response(JSON.stringify({ id: "memory-replayed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    assert.deepEqual(replayed.map(({ id, status }) => ({ id, status })), [
      { id: "memory-replayed", status: "persisted" },
    ]);
    assert.deepEqual(fs.readdirSync(replayDir), []);
  } finally {
    fs.rmSync(replayDir, { recursive: true, force: true });
  }
});
