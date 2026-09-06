import assert from "node:assert/strict";
import test from "node:test";

import { buildConfig } from "../scripts/swarm-activate.mjs";
import {
  probeLocalInferenceProvider,
  providerDescriptor,
} from "../scripts/swarm-local-inference-provider.mjs";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("model-only activation produces the exact signed-workflow-only node contract", () => {
  const agent = buildConfig({
    runtime: "local-model",
    machineId: "local-ai",
    workflowEngine: true,
    localModelProvider: "lm-studio",
    localModelId: "qwen3-8b",
  }).config.agents[0];

  assert.equal(agent.execution, undefined);
  assert.deepEqual(agent.capabilities, ["workflow.engine.execute-workflow"]);
  assert.equal(agent.nodeContract.protocol, "valkyr-swarm-node/v1");
  assert.equal(agent.nodeContract.nodeClass, "model-only");
  assert.equal(agent.nodeContract.localInferenceProvider.endpoint, "http://127.0.0.1:1234/v1");
  assert.equal(agent.workflowRuntime.tier, "engine");
});

test("model-only activation rejects missing engine, arbitrary providers, and remote endpoints", () => {
  assert.throws(() => buildConfig({
    runtime: "local-model",
    localModelProvider: "ollama",
    localModelId: "qwen3:8b",
  }), /requires --workflow-engine/);
  assert.throws(() => providerDescriptor("remote-openai", "model"), /lm-studio or ollama/);
  assert.throws(
    () => providerDescriptor("ollama", "qwen3:8b", "https://models.example.test"),
    /credential-free loopback HTTP/,
  );
});

test("LM Studio and Ollama probes normalize model inventory and fail closed", async () => {
  const lm = providerDescriptor("lm-studio", "qwen3-8b");
  assert.equal((await probeLocalInferenceProvider(lm, {
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:1234/v1/models");
      return response({ data: [{ id: "qwen3-8b" }] });
    },
  })).healthy, true);

  const notGenerative = await probeLocalInferenceProvider(lm, {
    validateGeneration: true,
    fetchImpl: async (url) => url.endsWith("/models")
      ? response({ data: [{ id: "qwen3-8b" }] })
      : response({ error: "model does not support chat" }, 400),
  });
  assert.equal(notGenerative.status, "selected_model_not_generative");

  const ollama = providerDescriptor("ollama", "qwen3:8b");
  assert.equal((await probeLocalInferenceProvider(ollama, {
    fetchImpl: async (url) => {
      assert.equal(url, "http://127.0.0.1:11434/api/tags");
      return response({ models: [{ name: "another-model" }] });
    },
  })).status, "selected_model_not_loaded");
});

test("generation validation has a separate bounded warm-up budget", async () => {
  const lm = providerDescriptor("lm-studio", "qwen3-8b");
  const calls = [];
  const result = await probeLocalInferenceProvider(lm, {
    timeoutMs: 1,
    generationTimeoutMs: 50,
    validateGeneration: true,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/models")) return response({ data: [{ id: "qwen3-8b" }] });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response({ choices: [{ message: { content: "OK" } }] });
    },
  });
  assert.equal(result.healthy, true);
  assert.equal(calls.length, 2);
});
