import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WORKFLOW_ENGINE_ACTION,
  WORKFLOW_ENGINE_KILL_ACTION,
  WORKFLOW_RUNNER_ACTION,
  executeWorkflowRuntimeCommand,
  probeWorkflowRuntime,
  workflowRunnerMetadata,
} from "../scripts/swarm-workflow-runtime.mjs";
const artifact = process.env.VALKYR_WORKFLOW_ENGINE_E2E_ARTIFACT;
const runnerArtifact = process.env.VALKYR_WORKFLOW_RUNNER_E2E_ARTIFACT;
const workflowServiceScript = fileURLToPath(new URL("../scripts/swarm-workflow-service.mjs", import.meta.url));

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeRuntimeConfig({ agentId, artifactPath, configPath, endpoint, root, tier }) {
  const engine = tier === "engine";
  const healthEndpoint = new URL(engine
    ? "/v1/swarm/workflow-engine/health"
    : "/v1/swarm/workflow-runs/health", endpoint).toString();
  const agent = {
    agentId,
    capabilities: ["graymatter.context"],
    workflowRuntime: {
      enabled: true,
      tier,
      endpoint: endpoint.toString(),
      healthEndpoint,
      timeoutSeconds: 30,
      supportedTools: [engine ? WORKFLOW_ENGINE_ACTION : WORKFLOW_RUNNER_ACTION],
      networkZones: ["loopback"],
      install: {
        tier,
        artifactPath,
        artifactUrl: `https://downloads.example.test/${tier}.jar`,
        sha256: sha256File(artifactPath),
        javaExecutable: process.env.JAVA_HOME
          ? path.join(process.env.JAVA_HOME, "bin", "java") : "java",
        jvmArgs: ["-Xms64m", engine ? "-Xmx384m" : "-Xmx256m"],
        arguments: ["--logging.level.root=WARN"],
        runtimeDataPath: path.join(root, "journal", "workflow"),
        runtimeWorkingDirectory: path.join(root, "work"),
        engineKeyPath: path.join(root, "engine.key"),
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify({ agents: [agent] }, null, 2)}\n`, { mode: 0o600 });
  return agent;
}

function startProductizedRuntime(configPath, agentId) {
  return spawn(process.execPath, [
    workflowServiceScript,
    "foreground",
    "--config", configPath,
    "--agent", agentId,
  ], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Workflow engine exited with ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return await response.json();
    } catch {
      // The productized runtime is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Workflow engine did not become healthy");
}

test("productized service invocation boots, advertises, and executes the stateless runner artifact", {
  skip: !runnerArtifact,
  timeout: 90_000,
}, async (context) => {
  const resolvedArtifact = path.resolve(runnerArtifact);
  assert.equal(fs.existsSync(resolvedArtifact) && fs.statSync(resolvedArtifact).isFile(), true,
    `Missing runner artifact: ${resolvedArtifact}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-runner-e2e-"));
  const port = await availablePort();
  const configPath = path.join(root, "agent.json");
  const agent = writeRuntimeConfig({
    agentId: "codex-runner-e2e",
    artifactPath: resolvedArtifact,
    configPath,
    endpoint: new URL(`http://127.0.0.1:${port}/v1/swarm/workflow-runs/execute`),
    root,
    tier: "runner",
  });
  const child = startProductizedRuntime(configPath, agent.agentId);
  let runtimeLog = "";
  child.stdout.on("data", (chunk) => { runtimeLog += chunk.toString(); });
  child.stderr.on("data", (chunk) => { runtimeLog += chunk.toString(); });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const healthUrl = `http://127.0.0.1:${port}/v1/swarm/workflow-runs/health`;
  const health = await waitForHealth(healthUrl, child);
  agent.runtime = "codex";
  agent.capacity = 1;
  const state = await probeWorkflowRuntime(agent);
  const metadata = workflowRunnerMetadata(agent, state);
  assert.equal(state.healthy, true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_RUNNER_ACTION), true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_ENGINE_ACTION), false);

  const moduleClass = "com.valkyrlabs.workflow.modules.basic.MapInjectModule";
  const moduleHash = health.moduleAbiHashes?.[moduleClass];
  assert.match(moduleHash ?? "", /^[a-f0-9]{64}$/);
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const workflowRunnerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const callbacks = {
    heartbeat: `/v1/vaiworkflow/runners/runs/${runId}/heartbeat/${workflowRunnerId}/3`,
    materialize: `/v1/vaiworkflow/runners/runs/${runId}/materialize/${workflowRunnerId}/3`,
    complete: "/v1/vaiworkflow/runners/runs/complete",
  };
  const materialization = {
    protocol: "valkyr-workflow-runner/v1",
    runId,
    workflowRunnerId,
    leaseFence: 3,
    logicalIdempotencyKey: "swarm-runner-productized-e2e",
    execModuleId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    moduleClass,
    moduleName: "Productized runner E2E",
    abiHash: moduleHash,
    config: { payloadConfig: { parameters: JSON.stringify({ answer: 42, productized: true }) } },
    inputs: { acceptance: true },
  };
  let completion;
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith(callbacks.heartbeat)) return new Response(null, { status: 204 });
    if (value.endsWith(callbacks.materialize)) {
      return new Response(JSON.stringify(materialization), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.endsWith(callbacks.complete)) {
      completion = JSON.parse(options.body);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(url, options);
  };
  const result = await executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "private-test-session",
    fetchImpl,
    wire: {
      action: WORKFLOW_RUNNER_ACTION,
      commandId: "runner-productized-e2e",
      trace: { traceId: "workflow-runner-productized-e2e" },
      command: {
        scope: {},
        payload: {
          runId,
          workflowRunnerId,
          leaseFence: 3,
          logicalIdempotencyKey: materialization.logicalIdempotencyKey,
          inputArtifactRef: "workflow-artifact:runner-productized-e2e",
          callbacks,
        },
      },
    },
  });
  assert.equal(result.executed, true);
  assert.equal(completion.success, true);
  assert.equal(completion.outputs.answer, 42);
  assert.equal(completion.outputs.productized, true);
  assert.doesNotMatch(runtimeLog, /STARTING VALKYRAI APPLICATION|entityManagerFactory|OrganizationContextResolver|Transactional email readiness|Java heap space|valkyrai-startup-spinner/);
});

test("productized service invocation boots, advertises, and executes the durable engine artifact", {
  skip: !artifact,
  timeout: 90_000,
}, async (context) => {
  const resolvedArtifact = path.resolve(artifact);
  assert.equal(fs.existsSync(resolvedArtifact) && fs.statSync(resolvedArtifact).isFile(), true,
    `Missing engine artifact: ${resolvedArtifact}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-engine-e2e-"));
  const port = await availablePort();
  const configPath = path.join(root, "agent.json");
  const agent = writeRuntimeConfig({
    agentId: "codex-engine-e2e",
    artifactPath: resolvedArtifact,
    configPath,
    endpoint: new URL(`http://127.0.0.1:${port}/v1/swarm/workflow-engine/execute`),
    root,
    tier: "engine",
  });
  const child = startProductizedRuntime(configPath, agent.agentId);
  let runtimeLog = "";
  child.stdout.on("data", (chunk) => { runtimeLog += chunk.toString(); });
  child.stderr.on("data", (chunk) => { runtimeLog += chunk.toString(); });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const healthUrl = `http://127.0.0.1:${port}/v1/swarm/workflow-engine/health`;
  const health = await waitForHealth(healthUrl, child);
  agent.runtime = "codex";
  agent.capacity = 1;
  const state = await probeWorkflowRuntime(agent);
  const metadata = workflowRunnerMetadata(agent, state);
  assert.equal(state.healthy, true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_ENGINE_ACTION), true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_ENGINE_KILL_ACTION), true);

  const moduleClass = "com.valkyrlabs.workflow.modules.basic.MapInjectModule";
  const moduleHash = health.moduleAbiHashes?.[moduleClass];
  assert.match(moduleHash ?? "", /^[a-f0-9]{64}$/);
  const workflowVersionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const workflowExecutionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const workflowRunnerId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const graph = {
    workflow: { id: "33333333-3333-4333-8333-333333333333", name: "SWARM engine E2E" },
    nodes: [
      { nodeId: "start", type: "start", label: "Start" },
      { nodeId: "task", taskId: "11111111-1111-4111-8111-111111111111", type: "task", label: "Inject" },
      { nodeId: "end", type: "end", label: "End" },
    ],
    edges: [
      { edgeId: "start-task", source: "start", target: "task" },
      { edgeId: "task-end", source: "task", target: "end" },
    ],
    modules: [{
      moduleId: "22222222-2222-4222-8222-222222222222",
      nodeId: "task",
      className: moduleClass,
      name: "Inject",
      execModuleConfig: { payloadConfig: { parameters: JSON.stringify({ answer: 42, productized: true }) } },
    }],
  };
  const definitionSnapshot = JSON.stringify({ schemaVersion: 1, submittedGraph: graph });
  const definitionSnapshotHash = crypto.createHash("sha256").update(definitionSnapshot).digest("hex");
  const logicalIdempotencyKey = `swarm-engine-e2e:${definitionSnapshotHash}`;
  const callbacks = {
    heartbeat: `/v1/vaiworkflow/engine/executions/${workflowExecutionId}/heartbeat/${workflowRunnerId}/1`,
    materialize: `/v1/vaiworkflow/engine/executions/${workflowExecutionId}/materialize/${workflowRunnerId}/1`,
    complete: "/v1/vaiworkflow/engine/executions/complete",
  };
  const materialization = {
    protocol: "valkyr-workflow-engine/v1",
    workflowExecutionId,
    workflowRunnerId,
    leaseFence: 1,
    logicalIdempotencyKey,
    workflowVersionId,
    definitionSnapshotHash,
    abiHash: "c".repeat(64),
    definitionSnapshot,
    initialState: { acceptance: true },
    moduleAbiHashes: { [moduleClass]: moduleHash },
    approvals: {},
  };
  let completion;
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith(callbacks.heartbeat)) return new Response(null, { status: 204 });
    if (value.endsWith(callbacks.materialize)) {
      return new Response(JSON.stringify(materialization), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.endsWith(callbacks.complete)) {
      completion = JSON.parse(options.body);
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(url, options);
  };
  const result = await executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "private-test-session",
    fetchImpl,
    wire: {
      action: WORKFLOW_ENGINE_ACTION,
      commandId: "engine-productized-e2e",
      trace: { traceId: "workflow-engine-productized-e2e" },
      command: {
        scope: {},
        payload: {
          workflowExecutionId,
          workflowRunnerId,
          leaseFence: 1,
          logicalIdempotencyKey,
          workflowVersionId,
          definitionSnapshotHash,
          callbacks,
        },
      },
    },
  });
  assert.equal(result.executed, true);
  assert.equal(completion.terminalState, "SUCCESS");
  assert.equal(completion.finalState.answer, 42);
  assert.equal(completion.finalState.productized, true);
  const events = await fetch(`http://127.0.0.1:${port}/v1/swarm/workflow-engine/events?after=0&limit=100`)
    .then((response) => response.json());
  assert.equal(events.events.some((event) => event.eventType === "SUCCESS"), true);
  assert.doesNotMatch(runtimeLog, /STARTING VALKYRAI APPLICATION|entityManagerFactory|OrganizationContextResolver|Transactional email readiness|Java heap space|valkyrai-startup-spinner/);
});
