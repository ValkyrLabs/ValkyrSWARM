import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwarmAgent } from "../scripts/swarm-agent.mjs";
import { executeWorkflowRuntimeCommand } from "../scripts/swarm-workflow-runtime.mjs";

// Explicit HTTP transport fixtures. No model or business orchestration is supplied.
test("an interrupted engine materialization can retry the same command and native journal identity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-dispatch-recovery-"));
  fs.chmodSync(directory, 0o700);
  const key = path.join(directory, "engine.key");
  fs.writeFileSync(key, "identified-transport-fixture-key-0123456789", { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = { workflowExecutionId: "execution-recovery", workflowRunnerId: "runner-recovery", leaseFence: 2,
    workflowVersionId: "version-recovery", definitionSnapshotHash: "b".repeat(64), logicalIdempotencyKey: "same-approved-invocation",
    callbacks: { heartbeat: "/v1/vaiworkflow/engine/executions/execution-recovery/heartbeat/runner-recovery/2",
      materialize: "/v1/vaiworkflow/engine/executions/execution-recovery/materialize/runner-recovery/2",
      complete: "/v1/vaiworkflow/engine/executions/complete" } };
  const wire = { commandId: "interrupted-command", action: "workflow.engine.execute-workflow", targetInstanceId: "recovery-node",
    command: { action: "workflow.engine.execute-workflow", payload } };
  const runtime = new SwarmAgent({ agent: { agentId: "recovery-node", runtime: "valkyrai-workflow", capabilities: [wire.action],
    workflowRuntime: { tier: "engine", endpoint: "http://127.0.0.1:19431/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:19431/v1/swarm/workflow-engine/health", install: { engineKeyPath: key } } },
    apiBase: "https://api-0.valkyrlabs.com/v1", url: "wss://api-0.valkyrlabs.com/ws", machineId: "recovery-host",
    heartbeatSeconds: 30, tokenProvider: async () => "identified-auth-fixture", evidence: { record() {} } });
  runtime.workflowRuntimeState = { healthy: true, protocol: "valkyr-workflow-engine/v1", supportedTools: [wire.action] };
  const responses = [], materializations = [], nativeRequests = [];
  runtime.sendCommandResponse = (_wire, response) => responses.push(structuredClone(response));
  runtime.persistTerminalReceipt = async () => ({ id: null, status: "queued" });
  const originalFetch = globalThis.fetch;
  let interrupted = true;
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.includes("/materialize/")) {
      materializations.push(address);
      if (interrupted) throw new TypeError("fetch failed");
      return Response.json({ protocol: "valkyr-workflow-engine/v1", ...payload });
    }
    if (address.startsWith("http://127.0.0.1:19431/")) {
      nativeRequests.push(JSON.parse(options.body));
      return Response.json({ success: true, terminalState: "WAITING_AUTHORIZATION", finalState: {} });
    }
    return Response.json({ accepted: true });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const receive = async () => {
    runtime.onMessage(JSON.stringify({ type: "agent", payload: JSON.stringify(wire) }));
    await Promise.all([...runtime.inFlightCommands.values()]);
  };
  await receive();
  assert.equal(materializations.length, 1);
  assert.equal(nativeRequests.length, 0);
  assert.equal(responses.at(-1).status, "failed");
  assert.equal(responses.at(-1).result.retryable, true);
  assert.equal(runtime.completedCommands.has(wire.commandId), false, "Transport uncertainty is not native terminal proof");
  interrupted = false;
  await receive();
  assert.equal(materializations.length, 2);
  assert.equal(nativeRequests.length, 1);
  assert.deepEqual(nativeRequests[0].payload, payload, "Execution/version/fence/logical invocation are preserved");
  assert.equal(responses.at(-1).status, "progress");
  await receive();
  assert.equal(nativeRequests.length, 1, "An already admitted command replays its checkpoint receipt");
});

test("unknown native transport outcome never manufactures a failed execution callback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-native-uncertain-"));
  fs.chmodSync(directory, 0o700);
  const key = path.join(directory, "engine.key");
  fs.writeFileSync(key, "identified-transport-fixture-key-0123456789", { mode: 0o600 });
  const payload = { workflowExecutionId: "execution-uncertain", workflowRunnerId: "runner-uncertain", leaseFence: 3,
    workflowVersionId: "version-uncertain", definitionSnapshotHash: "c".repeat(64), logicalIdempotencyKey: "same-invocation",
    callbacks: { heartbeat: "/v1/vaiworkflow/engine/executions/execution-uncertain/heartbeat/runner-uncertain/3",
      materialize: "/v1/vaiworkflow/engine/executions/execution-uncertain/materialize/runner-uncertain/3",
      complete: "/v1/vaiworkflow/engine/executions/complete" } };
  const completions = [];
  try {
    await assert.rejects(executeWorkflowRuntimeCommand({ agent: { agentId: "uncertain-node", workflowRuntime: { tier: "engine",
      endpoint: "http://127.0.0.1:19431/v1/swarm/workflow-engine/execute", install: { engineKeyPath: key } } },
      apiBase: "https://api-0.valkyrlabs.com/v1", tokenProvider: async () => "identified-auth-fixture",
      wire: { commandId: "uncertain-command", action: "workflow.engine.execute-workflow", command: { payload } },
      fetchImpl: async (url) => {
        const address = String(url);
        if (address.includes("/materialize/")) return Response.json({ protocol: "valkyr-workflow-engine/v1", ...payload });
        if (address.startsWith("http://127.0.0.1:19431/")) throw new TypeError("fetch failed");
        if (address.endsWith("/complete")) completions.push(address);
        return Response.json({ accepted: true });
      } }), (error) => error.code === "WORKFLOW_ENGINE_TRANSPORT_INCOMPLETE");
    assert.deepEqual(completions, [], "Only a privately persisted native result can terminalize the engine execution");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("engine completion receipt remains bounded and references its persisted Core result", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-bounded-completion-"));
  fs.chmodSync(directory, 0o700);
  const key = path.join(directory, "engine.key");
  fs.writeFileSync(key, "identified-transport-fixture-key-0123456789", { mode: 0o600 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = { workflowExecutionId: "execution-bounded", workflowRunnerId: "runner-bounded", leaseFence: 3,
    workflowVersionId: "version-bounded", definitionSnapshotHash: "c".repeat(64), logicalIdempotencyKey: "same-invocation",
    callbacks: { heartbeat: "/v1/vaiworkflow/engine/executions/execution-bounded/heartbeat/runner-bounded/3",
      materialize: "/v1/vaiworkflow/engine/executions/execution-bounded/materialize/runner-bounded/3",
      complete: "/v1/vaiworkflow/engine/executions/complete" } };
  const result = await executeWorkflowRuntimeCommand({ agent: { agentId: "bounded-node", workflowRuntime: { tier: "engine",
    endpoint: "http://127.0.0.1:19431/v1/swarm/workflow-engine/execute", install: { engineKeyPath: key } } },
    apiBase: "https://api-0.valkyrlabs.com/v1", tokenProvider: async () => "identified-auth-fixture",
    wire: { commandId: "bounded-command", action: "workflow.engine.execute-workflow", command: { payload } },
    fetchImpl: async (url) => {
      const address = String(url);
      if (address.includes("/materialize/")) return Response.json({ protocol: "valkyr-workflow-engine/v1", ...payload });
      if (address.startsWith("http://127.0.0.1:19431/")) return Response.json({ success: true,
        terminalState: "SUCCESS", finalState: { content: "Actual native fixture result" } });
      if (address.endsWith("/complete")) return Response.json({ id: payload.workflowExecutionId, state: "SUCCESS",
        contextData: "authorized-private-input-".repeat(20000) });
      return Response.json({ accepted: true });
    } });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32768, "Full Core context is not echoed into a STOMP receipt");
  assert.doesNotMatch(JSON.stringify(result), /authorized-private-input/);
  assert.equal(result.completion.workflowExecutionId, payload.workflowExecutionId);
  assert.equal(result.completion.state, "SUCCESS");
});

test("invalid engine URL is a configuration refusal and is not labeled a transport retry", async () => {
  await assert.rejects(executeWorkflowRuntimeCommand({ agent: { agentId: "invalid-node", workflowRuntime: {
    tier: "engine", endpoint: "invalid endpoint" } }, wire: { action: "workflow.engine.execute-workflow" },
    apiBase: "https://api-0.valkyrlabs.com/v1", tokenProvider: async () => "unused",
    fetchImpl: () => assert.fail("No transport is allowed for invalid configuration") }),
  error => error instanceof TypeError && error.code !== "WORKFLOW_ENGINE_TRANSPORT_INCOMPLETE");
});
