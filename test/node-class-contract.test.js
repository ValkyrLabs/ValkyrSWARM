import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { commandDisposition, validateConfig } from "../scripts/swarm-agent.mjs";
import {
  MODEL_ONLY_LIFECYCLE_ACTIONS,
  MODEL_ONLY_WORKFLOW_ACTIONS,
  constrainNodeAdvertisement,
  validateNodeContract,
  validateProviderDescriptor,
} from "../scripts/swarm-node-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function provider(kind = "lm-studio") {
  return {
    protocol: "valkyr-local-inference-provider/v1",
    kind,
    endpoint: kind === "ollama"
      ? "http://127.0.0.1:11434/api"
      : "http://127.0.0.1:1234/v1",
    model: kind === "ollama" ? "qwen3:8b" : "qwen3-8b-instruct",
    operations: [
      "models.list",
      "inference.chat",
      "inference.stream",
      "inference.cancel",
      "inference.structured-output",
    ],
  };
}

function modelOnlyAgent(kind = "lm-studio") {
  return {
    agentId: `${kind}-workflow-node`,
    runtime: "local-model",
    capacity: 1,
    capabilities: ["workflow.engine.execute-workflow"],
    nodeContract: {
      protocol: "valkyr-swarm-node/v1",
      nodeClass: "model-only",
      localInferenceProvider: provider(kind),
    },
    workflowRuntime: {
      enabled: true,
      tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
      supportedTools: ["workflow.engine.execute-workflow"],
      capabilities: ["java:17", "graymatter.context"],
    },
  };
}

test("v1 schemas freeze model-only and provider-neutral LM Studio/Ollama contracts", () => {
  for (const name of [
    "valkyr-swarm-node.v1.schema.json",
    "valkyr-local-inference-provider.v1.schema.json",
  ]) {
    const schema = JSON.parse(fs.readFileSync(
      path.join(ROOT, "references", "contracts", "runtime", name),
      "utf8",
    ));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
  }
  assert.equal(validateProviderDescriptor(provider("lm-studio")).kind, "lm-studio");
  assert.equal(validateProviderDescriptor(provider("ollama")).kind, "ollama");
});

test("model-only node accepts only a durable Workflow engine and no native adapter", () => {
  const agent = modelOnlyAgent();
  assert.equal(validateNodeContract(agent), "model-only");
  assert.doesNotThrow(() => validateConfig({ machineId: "test-host", agents: [agent] }));

  assert.throws(() => validateNodeContract({
    ...agent,
    execution: { adapter: "codex-cli", executable: "/bin/echo" },
  }), /cannot configure a native agent execution adapter/);

  assert.throws(() => validateNodeContract({
    ...agent,
    capabilities: ["workflow.engine.execute-workflow", "code.execute"],
  }), /cannot advertise native capability: code.execute/);

  assert.throws(() => validateNodeContract({
    ...agent,
    workflowRuntime: {
      ...agent.workflowRuntime,
      supportedTools: ["workflow.engine.execute-workflow", "outbound.send"],
    },
  }), /cannot support native action: outbound.send/);
});

test("model-only provider descriptors fail closed on remote endpoints and arbitrary operations", () => {
  assert.throws(() => validateProviderDescriptor({
    ...provider(),
    endpoint: "https://models.example.test/v1?token=secret",
  }), /credential-free loopback HTTP/);
  assert.throws(() => validateProviderDescriptor({
    ...provider("ollama"),
    operations: ["inference.chat", "shell.execute"],
  }), /operation is not allowed: shell.execute/);
});

test("model-only advertisement strips native, pack, and implementation capabilities", () => {
  const projected = constrainNodeAdvertisement(modelOnlyAgent(), {
    capabilities: [
      "workflow.engine.execute-workflow",
      "code.execute",
      "outbound.send",
      "java:17",
      "workflow-pack:engineering:1.0.0",
      ...MODEL_ONLY_LIFECYCLE_ACTIONS,
    ],
    supportedTools: [
      ...MODEL_ONLY_WORKFLOW_ACTIONS,
      "workflow.runner.execute-module",
      "shell.execute",
    ],
    supportedModels: ["raw-provider-inventory"],
  });
  assert.deepEqual(projected.capabilities, [
    "workflow.engine.execute-workflow",
    ...MODEL_ONLY_LIFECYCLE_ACTIONS,
  ]);
  assert.deepEqual(projected.supportedTools, MODEL_ONLY_WORKFLOW_ACTIONS);
  assert.equal(projected.supportedModels, undefined);
  assert.equal(projected.localInferenceProvider.endpoint, undefined);
  assert.equal(projected.localInferenceProvider.kind, "lm-studio");
});

test("model-only command routing rejects arbitrary native capabilities before dispatch", () => {
  const agent = modelOnlyAgent();
  const state = {
    healthy: true,
    status: "healthy",
    protocol: "valkyr-workflow-engine/v1",
    protocols: ["valkyr-workflow-engine/v1"],
    capabilities: ["code.execute", "outbound.send"],
    supportedTools: ["workflow.engine.execute-workflow"],
  };
  const wire = {
    targetInstanceId: agent.agentId,
    action: "code.execute",
    command: {},
  };
  assert.deepEqual(commandDisposition(wire, agent, state), {
    disposition: "reject",
    protectedAction: false,
    reason: "model_only_action_not_allowed",
  });
  assert.equal(commandDisposition({
    ...wire,
    action: "workflow.engine.execute-workflow",
  }, agent, state).disposition, "accept");
});
