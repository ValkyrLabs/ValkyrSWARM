import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  commandReceiptText,
  persistCommandReceipt,
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
