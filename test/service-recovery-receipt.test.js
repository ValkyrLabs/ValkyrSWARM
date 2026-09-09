import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SwarmAgent } from "../scripts/swarm-agent.mjs";
import { commandReceiptFingerprint, commandReceiptText, queueReceiptReplay, replayQueuedReceipts } from "../scripts/swarm-graymatter.mjs";
import { resolveServiceBindings, writePendingRecovery, readPendingRecoveries } from "../scripts/swarm-service-lifecycle.mjs";

const receiptId = "12345678-1234-4234-8234-123456789abc";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-recovery-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = { agentId: "codex-receipt-host", runtime: "codex" };
  const machineId = "receipt-host";
  const bindings = resolveServiceBindings({ agent, machineId, homedir: root, platform: "darwin" });
  const wire = { action: "service.lifecycle.restart", commandId: "receipt-command", targetInstanceId: agent.agentId,
    command: { action: "service.lifecycle.restart", requiresApproval: true, approvalRef: `gm_approval_${"a".repeat(64)}`,
      payload: { serviceHandle: "swarm-bridge", expectedMachineId: machineId } } };
  const recoveryRoot = path.join(root, "recovery");
  const pending = writePendingRecovery({ agent, binding: bindings.find((b) => b.handle === "swarm-bridge"), wire, recoveryRoot });
  const sent = [], evidence = [], receipts = [];
  let healthCalls = 0;
  const createRuntime = () => Object.assign(Object.create(SwarmAgent.prototype), {
    agent, machineId, recoveryRoot, serviceLifecycleState: { bindings }, completedCommands: new Map(),
    evidence: { record: (kind, data) => evidence.push({ kind, ...data }) },
    sendCommandResponse: (request, response) => sent.push({ request, response }),
    verifyServiceRecovery: async () => { healthCalls++; return { healthy: true, heartbeatFresh: true,
      supervisorRunning: true, expectedAgentId: agent.agentId, handle: "swarm-bridge", heartbeatAt: new Date().toISOString(),
      capabilities: ["service.lifecycle.restart"], version: "valkyr-swarm/test" }; },
    persistTerminalReceipt: async (request, response) => { receipts.push({ request, response }); return { id: receiptId, status: "persisted" }; },
  });
  const replay = (runtime) => {
    const terminal = JSON.parse(fs.readFileSync(pending.path)).terminal;
    runtime.recordReplayedServiceReceipt({ status: "persisted", id: receiptId,
      sourceMessageId: `swarm-command:${wire.commandId}:${terminal.status}`,
      bodyFingerprint: commandReceiptFingerprint({ agent, wire: { ...wire, trace: {} }, response: terminal }) });
  };
  return { root, agent, machineId, pending, sent, evidence, receipts, createRuntime, replay, wire,
    healthCalls: () => healthCalls, read: () => readPendingRecoveries({ agentId: agent.agentId, recoveryRoot }) };
}

for (const outcome of [
  { status: "queued", id: null }, { status: "degraded", id: null },
  { status: "persisted", id: null }, { status: "persisted", id: "not-a-memory-id" },
]) {
  test(`${outcome.status} receipt with ${outcome.id ?? "no id"} keeps recovery and emits no terminal completion`, async (t) => {
    const fx = fixture(t), runtime = fx.createRuntime();
    runtime.persistTerminalReceipt = async () => outcome;
    await runtime.reconcilePendingServiceRecoveries();
    assert.equal(fx.sent.length, 0);
    assert.equal(runtime.completedCommands.size, 0);
    assert.equal(fx.read().length, 1);
    assert.equal(fx.read()[0].record.terminal.status, "completed");
    const deferred = fx.evidence.find((event) => event.kind === "service_recovery_receipt_pending");
    assert.equal(deferred.receiptStatus, outcome.status);
    assert.equal(deferred.receiptIdentityValid, false);
  });
}

test("persisted terminal identity completes recovery and removes only its checkpoint", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.sent[0].response.status, "completed");
  assert.equal(fx.sent[0].response.result.grayMatterReceiptRef, `MemoryEntry:${receiptId}`);
  assert.equal(fx.read().length, 0);
  assert.equal(runtime.completedCommands.size, 1);
});

test("a new bridge instance resumes the exact observed success without repeating health or changing its receipt", async (t) => {
  const fx = fixture(t), first = fx.createRuntime();
  first.persistTerminalReceipt = async () => ({ status: "queued", id: null });
  await first.reconcilePendingServiceRecoveries();
  const observed = fx.read()[0].record.terminal;
  const next = fx.createRuntime();
  next.verifyServiceRecovery = async () => { throw new Error("unrelated later health change"); };
  fx.replay(next);
  await next.reconcilePendingServiceRecoveries();
  assert.equal(fx.healthCalls(), 1);
  assert.equal(fx.receipts.length, 0, "reconciliation must not post a second receipt");
  assert.deepEqual(fx.sent[0].response.result.outcome, observed.result.outcome);
  assert.deepEqual(fx.sent[0].response.result.proof, observed.result.proof);
  assert.equal(fx.sent[0].response.status, "completed");
  assert.equal(fx.read().length, 0);
});

test("an observed terminal failure also waits for its receipt and cannot flip to success during retry", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  const record = JSON.parse(fs.readFileSync(fx.pending.path));
  record.createdAt = new Date(Date.now() - 180_000).toISOString();
  fs.writeFileSync(fx.pending.path, JSON.stringify(record));
  runtime.verifyServiceRecovery = async () => { throw new Error("fixture native recovery failed"); };
  runtime.persistTerminalReceipt = async () => ({ status: "degraded", id: null });
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.sent.length, 0);
  assert.equal(fx.read()[0].record.terminal.status, "failed");
  const next = fx.createRuntime(); fx.replay(next);
  await next.reconcilePendingServiceRecoveries();
  assert.equal(fx.healthCalls(), 0);
  assert.equal(fx.sent[0].response.status, "failed");
  assert.equal(fx.sent[0].response.result.grayMatterReceiptRef, `MemoryEntry:${receiptId}`);
});

test("receipt transport exceptions retain the successful observation and release the retry guard", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  runtime.persistTerminalReceipt = async () => { throw new Error("fixture transport unavailable"); };
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.sent.length, 0);
  assert.equal(fx.read()[0].record.terminal.status, "completed");
  runtime.persistTerminalReceipt = async () => ({ status: "persisted", id: receiptId });
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.sent.length, 0, "uncertain submission cannot be blindly repeated");
  fx.replay(runtime);
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.healthCalls(), 1);
});

test("queued recovery uses the existing receipt replay and never creates a heartbeat submission loop", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  let submissions = 0;
  runtime.persistTerminalReceipt = async () => { submissions++; return { status: "queued", id: null }; };
  await runtime.reconcilePendingServiceRecoveries();
  await runtime.reconcilePendingServiceRecoveries();
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(submissions, 1);
  const terminal = fx.read()[0].record.terminal;
  const replayDir = path.join(fx.root, "receipts");
  queueReceiptReplay({ agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    body: { sourceChannel: "valkyr-swarm:receipts", sourceMessageId: `swarm-command:${fx.wire.commandId}:completed`,
      text: commandReceiptText({ agent: fx.agent, wire: fx.wire, response: terminal }) } });
  const results = await replayQueuedReceipts({ agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1",
    replayDir, tokenProvider: async () => "fixture-token", fetchImpl: async () => new Response(JSON.stringify({ id: receiptId })),
    onPersisted: (result) => runtime.recordReplayedServiceReceipt(result) });
  assert.equal(results[0].status, "persisted");
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(submissions, 1);
  assert.equal(fx.sent.length, 1);
  assert.equal(fx.read().length, 0);
});

test("replay bookkeeping failure retains the server receipt id and does not submit another paid write", async (t) => {
  const fx = fixture(t), replayDir = path.join(fx.root, "receipts");
  queueReceiptReplay({ agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    body: { sourceChannel: "test", sourceMessageId: "receipt-test", text: "fixture" } });
  let posts = 0;
  const input = { agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    tokenProvider: async () => "fixture-token", fetchImpl: async () => { posts++; return new Response(JSON.stringify({ id: receiptId })); } };
  const deferred = await replayQueuedReceipts({ ...input, onPersisted: async () => { throw new Error("fixture bookkeeping failure"); } });
  assert.equal(deferred[0].status, "persisted_pending_delivery");
  assert.equal(deferred[0].id, receiptId);
  assert.equal(fs.readdirSync(replayDir).length, 1);
  const result = await replayQueuedReceipts(input);
  assert.equal(posts, 1);
  assert.equal(result[0].id, receiptId);
  assert.equal(fs.readdirSync(replayDir).length, 0);
});

test("a successful replay response without a receipt id is held without automatic resubmission", async (t) => {
  const fx = fixture(t), replayDir = path.join(fx.root, "receipts");
  queueReceiptReplay({ agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    body: { sourceChannel: "test", sourceMessageId: "receipt-test", text: "fixture" } });
  let posts = 0;
  const input = { agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    tokenProvider: async () => "fixture-token", fetchImpl: async () => { posts++; return new Response("{}"); } };
  assert.equal((await replayQueuedReceipts(input))[0].status, "persisted_without_valid_id");
  assert.equal((await replayQueuedReceipts(input))[0].status, "persisted_without_valid_id");
  assert.equal(posts, 1);
  assert.equal(fs.readdirSync(replayDir).length, 1);
});

test("a replayed receipt with different body evidence cannot complete the saved restart", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  runtime.persistTerminalReceipt = async () => ({ status: "queued", id: null });
  await runtime.reconcilePendingServiceRecoveries();
  assert.throws(() => runtime.recordReplayedServiceReceipt({ status: "persisted", id: receiptId,
    sourceMessageId: `swarm-command:${fx.wire.commandId}:completed`, bodyFingerprint: "b".repeat(64) }), /does not match/);
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.sent.length, 0);
});

test("overlapping heartbeat reconciliation performs one receipt attempt", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  let release, calls = 0;
  const paused = new Promise((resolve) => { release = resolve; });
  runtime.persistTerminalReceipt = async () => { calls++; await paused; return { status: "persisted", id: receiptId }; };
  const first = runtime.reconcilePendingServiceRecoveries();
  await new Promise((resolve) => setImmediate(resolve));
  const second = runtime.reconcilePendingServiceRecoveries();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(fx.sent.length, 1);
});

test("failure to persist the observed outcome prevents its external receipt and keeps restart recovery", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === fx.pending.path) throw new Error("fixture disk failure");
    return original(from, to);
  });
  await runtime.reconcilePendingServiceRecoveries();
  assert.equal(fx.receipts.length, 0);
  assert.equal(fx.sent.length, 0);
  assert.equal(fx.read().length, 1);
});

for (const field of ["expectedMachineId", "targetInstanceId"]) {
  test(`a recovery for a different ${field} cannot publish completion`, async (t) => {
    const fx = fixture(t), runtime = fx.createRuntime();
    const record = JSON.parse(fs.readFileSync(fx.pending.path)); record[field] = "another-target";
    fs.writeFileSync(fx.pending.path, JSON.stringify(record));
    await runtime.reconcilePendingServiceRecoveries();
    assert.equal(fx.healthCalls(), 0);
    assert.equal(fx.receipts.length, 0);
    assert.equal(fx.sent.length, 0);
    assert.equal(fs.existsSync(fx.pending.path), true);
  });
}

test("a changed cached outcome binding is retained for inspection without creating a receipt", async (t) => {
  const fx = fixture(t), runtime = fx.createRuntime();
  runtime.persistTerminalReceipt = async () => ({ status: "queued", id: null });
  await runtime.reconcilePendingServiceRecoveries();
  const record = JSON.parse(fs.readFileSync(fx.pending.path));
  record.terminal.result.outcome.commandId = "different-command";
  fs.writeFileSync(fx.pending.path, JSON.stringify(record));
  await fx.createRuntime().reconcilePendingServiceRecoveries();
  assert.equal(fx.receipts.length, 0);
  assert.equal(fx.sent.length, 0);
  assert.equal(fs.existsSync(fx.pending.path), true);
});

test("private recovery inspection ignores symlinks, hard links, oversized files and named pipes", async (t) => {
  const fx = fixture(t), original = fs.readFileSync(fx.pending.path);
  const elsewhere = path.join(fx.root, "outside.json");
  fs.writeFileSync(elsewhere, original, { mode: 0o600 });
  fs.unlinkSync(fx.pending.path);
  fs.symlinkSync(elsewhere, fx.pending.path);
  assert.deepEqual(fx.read(), []);
  fs.unlinkSync(fx.pending.path);
  fs.linkSync(elsewhere, fx.pending.path);
  assert.deepEqual(fx.read(), []);
  fs.unlinkSync(fx.pending.path);
  fs.writeFileSync(fx.pending.path, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 });
  assert.deepEqual(fx.read(), []);
  fs.unlinkSync(fx.pending.path);
  const pipe = spawnSync("mkfifo", [fx.pending.path], { encoding: "utf8", timeout: 1000 });
  assert.equal(pipe.status, 0);
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {readPendingRecoveries} from ${JSON.stringify(new URL("../scripts/swarm-service-lifecycle.mjs", import.meta.url).href)}; console.log(readPendingRecoveries(${JSON.stringify({agentId:fx.agent.agentId,recoveryRoot:path.dirname(fx.pending.path)})}));`,
  ], { encoding: "utf8", timeout: 1000 });
  assert.equal(probe.error, undefined, "Recovery inspection cannot block on a pipe");
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout.trim(), "[]");
});

test("a crash during receipt submission leaves an explicit uncertain phase without a second submission", async (t) => {
  const fx = fixture(t), old = fx.createRuntime();
  let release;
  old.persistTerminalReceipt = async () => { await new Promise((resolve) => { release = resolve; }); return { status: "degraded", id: null }; };
  const running = old.reconcilePendingServiceRecoveries();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.read()[0].record.receipt.status, "submission_started");
  await fx.createRuntime().reconcilePendingServiceRecoveries();
  assert.equal(fx.receipts.length, 0);
  assert.equal(fx.sent.length, 0);
  release(); await running;
});

test("a failed local write after server persistence leaves the replay submission fenced", async (t) => {
  const fx = fixture(t), replayDir = path.join(fx.root, "receipts");
  const queuePath = queueReceiptReplay({ agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    body: { sourceChannel: "test", sourceMessageId: "receipt-test", text: "fixture" } });
  const rename = fs.renameSync;
  let publications = 0, posts = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === queuePath && ++publications === 2) throw new Error("fixture disk failure after server commit");
    return rename(from, to);
  });
  const input = { agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    tokenProvider: async () => "fixture-token", fetchImpl: async () => { posts++; return new Response(JSON.stringify({ id: receiptId })); } };
  await replayQueuedReceipts(input);
  assert.equal((await replayQueuedReceipts(input))[0].status, "outcome_uncertain");
  assert.equal(posts, 1);
});

test("definitive funding rejection can retry through the queue while transport uncertainty cannot", async (t) => {
  const fx = fixture(t), replayDir = path.join(fx.root, "receipts");
  queueReceiptReplay({ agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    body: { sourceChannel: "test", sourceMessageId: "receipt-test", text: "fixture" } });
  const input = { agentId: fx.agent.agentId, apiBase: "https://api-0.valkyrlabs.com/v1", replayDir,
    tokenProvider: async () => "fixture-token" };
  assert.equal((await replayQueuedReceipts({ ...input, fetchImpl: async () => new Response("{}", { status: 402 }) }))[0].status, "queued");
  let posts = 0;
  const uncertain = { ...input, fetchImpl: async () => { posts++; throw new Error("fixture transport timeout"); } };
  assert.equal((await replayQueuedReceipts(uncertain))[0].status, "outcome_uncertain");
  assert.equal((await replayQueuedReceipts(uncertain))[0].status, "outcome_uncertain");
  assert.equal(posts, 1);
});
