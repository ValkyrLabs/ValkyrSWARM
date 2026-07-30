import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WORKFLOW_ENGINE_ACTION,
  WORKFLOW_ENGINE_APPROVAL_DENIAL_ACTION,
  WORKFLOW_ENGINE_KILL_ACTION,
  WORKFLOW_RUNNER_ACTION,
  executeWorkflowRuntimeCommand,
  probeWorkflowRuntime,
  workflowRunnerMetadata,
} from "../scripts/swarm-workflow-runtime.mjs";
const artifact = process.env.VALKYR_WORKFLOW_ENGINE_E2E_ARTIFACT;
const runnerArtifact = process.env.VALKYR_WORKFLOW_RUNNER_E2E_ARTIFACT;
const openClawGtmPack = process.env.VALKYR_WORKFLOW_OPENCLAW_GTM_E2E_PACK;
const workflowServiceScript = fileURLToPath(new URL("../scripts/swarm-workflow-service.mjs", import.meta.url));

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeRuntimeConfig({
  agentId,
  artifactPath,
  capabilityPacks = [],
  capabilities = ["graymatter.context"],
  configPath,
  endpoint,
  root,
  tier,
}) {
  const engine = tier === "engine";
  const healthEndpoint = new URL(engine
    ? "/v1/swarm/workflow-engine/health"
    : "/v1/swarm/workflow-runs/health", endpoint).toString();
  const agent = {
    agentId,
    capabilities,
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
        capabilityPacks,
        runtimeDataPath: path.join(root, "journal", "workflow"),
        runtimeWorkingDirectory: path.join(root, "work"),
        engineKeyPath: path.join(root, "engine.key"),
      },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify({ agents: [agent] }, null, 2)}\n`, { mode: 0o600 });
  return agent;
}

function startProductizedRuntime(configPath, agentId, environment = {}) {
  return spawn(process.execPath, [
    workflowServiceScript,
    "foreground",
    "--config", configPath,
    "--agent", agentId,
  ], {
    env: { ...process.env, ...environment },
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

async function withRuntimeDiagnostics(operation, readRuntimeLog) {
  try {
    return await operation();
  } catch (error) {
    const sanitizedLog = String(readRuntimeLog?.() ?? "")
      .replace(
        /(password|passwd|secret|token|credential|authorization|api[-_.]?key|bearer)(\s*[=:]\s*)([^\s,;]+)/gi,
        "$1$2[REDACTED]",
      )
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
    const diagnosticLog = sanitizedLog.length <= 12_000
      ? sanitizedLog
      : `${sanitizedLog.slice(0, 6_000)}\n... log middle omitted ...\n${sanitizedLog.slice(-6_000)}`;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}`
        + (diagnosticLog ? `\nWorkflow runtime diagnostic log:\n${diagnosticLog}` : ""),
      { cause: error },
    );
  }
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
  const result = await withRuntimeDiagnostics(() => executeWorkflowRuntimeCommand({
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
  }), () => runtimeLog);
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
  assert.equal(
    metadata.supportedTools.includes(
      WORKFLOW_ENGINE_APPROVAL_DENIAL_ACTION),
    true,
  );
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
  const result = await withRuntimeDiagnostics(() => executeWorkflowRuntimeCommand({
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
  }), () => runtimeLog);
  assert.equal(result.executed, true);
  assert.equal(completion.terminalState, "SUCCESS");
  assert.equal(completion.finalState.answer, 42);
  assert.equal(completion.finalState.productized, true);
  const events = await fetch(`http://127.0.0.1:${port}/v1/swarm/workflow-engine/events?after=0&limit=100`)
    .then((response) => response.json());
  assert.equal(events.events.some((event) => event.eventType === "SUCCESS"), true);
  assert.doesNotMatch(runtimeLog, /STARTING VALKYRAI APPLICATION|entityManagerFactory|OrganizationContextResolver|Transactional email readiness|Java heap space|valkyrai-startup-spinner/);
});

test("productized durable engine suspends an outbound pack and resumes only with mothership approval", {
  skip: !artifact || !openClawGtmPack,
  timeout: 90_000,
}, async (context) => {
  const resolvedArtifact = path.resolve(artifact);
  const resolvedPack = path.resolve(openClawGtmPack);
  assert.equal(fs.existsSync(resolvedArtifact) && fs.statSync(resolvedArtifact).isFile(), true,
    `Missing engine artifact: ${resolvedArtifact}`);
  assert.equal(fs.existsSync(resolvedPack) && fs.statSync(resolvedPack).isFile(), true,
    `Missing OpenClaw GTM pack: ${resolvedPack}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-engine-approval-e2e-"));
  const agentId = "codex-engine-approval-e2e";
  const port = await availablePort();
  const configPath = path.join(root, "agent.json");
  const packSha = sha256File(resolvedPack);
  const capabilityPack = {
    id: "openclaw-gtm",
    version: "2.0.0",
    artifactUrl: "https://downloads.example.test/openclaw-gtm.jar",
    sha256: packSha,
    requiredNodeCapabilities: ["openclaw.skill.execute", "outbound.send"],
  };
  const packInstallPath = path.join(
    root,
    ".local",
    "share",
    "valkyr-swarm",
    "workflow-runtimes",
    `${agentId}-packs`,
    `openclaw-gtm-${packSha}.jar`,
  );
  fs.mkdirSync(path.dirname(packInstallPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(resolvedPack, packInstallPath);
  fs.chmodSync(packInstallPath, 0o600);

  const agent = writeRuntimeConfig({
    agentId,
    artifactPath: resolvedArtifact,
    capabilityPacks: [capabilityPack],
    capabilities: ["graymatter.context", "openclaw.skill.execute", "outbound.send"],
    configPath,
    endpoint: new URL(`http://127.0.0.1:${port}/v1/swarm/workflow-engine/execute`),
    root,
    tier: "engine",
  });

  const openClawRequests = [];
  const openClawServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    openClawRequests.push({
      method: request.method,
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      result: "loopback acceptance only",
      receiptRef: "acceptance:openclaw-gtm:1",
    }));
  });
  await new Promise((resolve, reject) => {
    openClawServer.once("error", reject);
    openClawServer.listen(0, "127.0.0.1", resolve);
  });
  const openClawAddress = openClawServer.address();
  const openClawEndpoint =
    `http://127.0.0.1:${openClawAddress.port}/api/skills/execute`;

  const child = startProductizedRuntime(configPath, agent.agentId, { HOME: root });
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
    await new Promise((resolve) => openClawServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const healthUrl = `http://127.0.0.1:${port}/v1/swarm/workflow-engine/health`;
  const health = await waitForHealth(healthUrl, child);
  const moduleClass =
    "com.valkyrlabs.workflow.modules.openclaw.OpenClawOutboundGtmModule";
  const moduleHash = health.moduleAbiHashes?.[moduleClass];
  assert.match(moduleHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    health.capabilityPacks?.some((pack) => pack.id === "openclaw-gtm"),
    true,
  );

  const workflowVersionId = "1b92dcfb-48ef-4dc4-9583-86f851900ad1";
  const workflowExecutionId = "2b92dcfb-48ef-4dc4-9583-86f851900ad2";
  const workflowRunnerId = "3b92dcfb-48ef-4dc4-9583-86f851900ad3";
  const moduleId = "4b92dcfb-48ef-4dc4-9583-86f851900ad4";
  const graph = {
    workflow: { id: "5b92dcfb-48ef-4dc4-9583-86f851900ad5", name: "Approval E2E" },
    nodes: [
      { nodeId: "start", type: "start", label: "Start" },
      {
        nodeId: "outbound",
        taskId: "6b92dcfb-48ef-4dc4-9583-86f851900ad6",
        type: "task",
        label: "Outbound acceptance",
      },
      { nodeId: "end", type: "end", label: "End" },
    ],
    edges: [
      { edgeId: "start-outbound", source: "start", target: "outbound" },
      { edgeId: "outbound-end", source: "outbound", target: "end" },
    ],
    modules: [{
      moduleId,
      nodeId: "outbound",
      className: moduleClass,
      name: "Outbound acceptance",
      execModuleConfig: {
        payloadConfig: {
          parameters: JSON.stringify({
            operation: "outreach.send",
            endpointUrl: openClawEndpoint,
            timeoutMs: 5_000,
          }),
        },
      },
    }],
  };
  const definitionSnapshot = JSON.stringify({ schemaVersion: 1, submittedGraph: graph });
  const definitionSnapshotHash = crypto.createHash("sha256").update(definitionSnapshot).digest("hex");
  const logicalIdempotencyKey = `swarm-engine-approval-e2e:${definitionSnapshotHash}`;
  const callbacks = {
    heartbeat: `/v1/vaiworkflow/engine/executions/${workflowExecutionId}/heartbeat/${workflowRunnerId}/7`,
    materialize: `/v1/vaiworkflow/engine/executions/${workflowExecutionId}/materialize/${workflowRunnerId}/7`,
    complete: "/v1/vaiworkflow/engine/executions/complete",
  };
  const materialization = {
    protocol: "valkyr-workflow-engine/v1",
    workflowExecutionId,
    workflowRunnerId,
    leaseFence: 7,
    logicalIdempotencyKey,
    workflowVersionId,
    definitionSnapshotHash,
    abiHash: "d".repeat(64),
    definitionSnapshot,
    initialState: {
      input: { audience: "acceptance-only" },
      context: { source: "bounded-productized-e2e" },
      idempotencyKey: "bounded-productized-e2e",
    },
    moduleAbiHashes: { [moduleClass]: moduleHash },
    approvals: {},
  };
  const completions = [];
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
      completions.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(url, options);
  };
  const execute = (commandId) => withRuntimeDiagnostics(() => executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "private-test-session",
    fetchImpl,
    wire: {
      action: WORKFLOW_ENGINE_ACTION,
      commandId,
      trace: { traceId: commandId },
      command: {
        scope: {},
        payload: {
          workflowExecutionId,
          workflowRunnerId,
          leaseFence: 7,
          logicalIdempotencyKey,
          workflowVersionId,
          definitionSnapshotHash,
          callbacks,
        },
      },
    },
  }), () => runtimeLog);

  const waiting = await execute("engine-approval-waiting-e2e");
  assert.equal(waiting.executed, true);
  assert.equal(completions.at(-1).terminalState, "WAITING_APPROVAL");
  assert.match(
    completions.at(-1).checkpointRef,
    new RegExp(`:approval:${moduleId}$`),
  );
  assert.equal(openClawRequests.length, 0);

  materialization.approvals = {
    [moduleId]: {
      approvalRef: "workflow-approval:7b92dcfb-48ef-4dc4-9583-86f851900ad7",
      approved: true,
    },
  };
  const resumed = await execute("engine-approval-resume-e2e");
  assert.equal(resumed.executed, true);
  assert.equal(completions.at(-1).terminalState, "SUCCESS");
  assert.equal(openClawRequests.length, 1);
  assert.deepEqual(openClawRequests[0], {
    method: "POST",
    path: "/api/skills/execute",
    body: {
      skill: "outreach-send",
      operation: "outreach.send",
      input: { audience: "acceptance-only" },
      context: { source: "bounded-productized-e2e" },
      idempotencyKey: "bounded-productized-e2e",
    },
  });
  assert.doesNotMatch(runtimeLog, /STARTING VALKYRAI APPLICATION|entityManagerFactory|OrganizationContextResolver|Transactional email readiness|Java heap space|valkyrai-startup-spinner/);
});

test("productized durable engine exits a stopped Looper through the immutable End control target", {
  skip: !artifact,
  timeout: 90_000,
}, async (context) => {
  const resolvedArtifact = path.resolve(artifact);
  assert.equal(fs.existsSync(resolvedArtifact) && fs.statSync(resolvedArtifact).isFile(), true,
    `Missing engine artifact: ${resolvedArtifact}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-engine-terminal-e2e-"));
  const port = await availablePort();
  const configPath = path.join(root, "agent.json");
  const agent = writeRuntimeConfig({
    agentId: "codex-engine-terminal-e2e",
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
  const looperClass = "com.valkyrlabs.workflow.modules.control.LooperModule";
  const bodyClass = "com.valkyrlabs.workflow.modules.basic.MapInjectModule";
  const looperHash = health.moduleAbiHashes?.[looperClass];
  const bodyHash = health.moduleAbiHashes?.[bodyClass];
  assert.match(looperHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(bodyHash ?? "", /^[a-f0-9]{64}$/);

  const workflowVersionId = "1c92dcfb-48ef-4dc4-9583-86f851900ad1";
  const workflowExecutionId = "2c92dcfb-48ef-4dc4-9583-86f851900ad2";
  const workflowRunnerId = "3c92dcfb-48ef-4dc4-9583-86f851900ad3";
  const graph = {
    workflow: {
      id: "4c92dcfb-48ef-4dc4-9583-86f851900ad4",
      name: "Stopped Looper terminal E2E",
    },
    nodes: [
      { nodeId: "start", type: "start", label: "Start" },
      {
        nodeId: "loop",
        taskId: "5c92dcfb-48ef-4dc4-9583-86f851900ad5",
        type: "looper",
        label: "Looper while running == true",
      },
      {
        nodeId: "body",
        taskId: "6c92dcfb-48ef-4dc4-9583-86f851900ad6",
        type: "task",
        label: "Body must not execute",
      },
      { nodeId: "end", type: "end", label: "End" },
    ],
    edges: [
      { edgeId: "start-loop", source: "start", target: "loop" },
      { edgeId: "loop-body", source: "loop", target: "body" },
      { edgeId: "body-loop", source: "body", target: "loop" },
      { edgeId: "loop-end", source: "loop", target: "end" },
    ],
    modules: [
      {
        moduleId: "7c92dcfb-48ef-4dc4-9583-86f851900ad7",
        nodeId: "loop",
        className: looperClass,
        name: "Stopped Looper",
        execModuleConfig: {
          payloadConfig: {
            parameters: JSON.stringify({
              loopType: "WHILE",
              condition: "running == true",
              bodyNodeId: "body",
              exitNodeId: "end",
              loopStateKey: "business.cycles",
              maxIterations: 10,
            }),
          },
        },
      },
      {
        moduleId: "8c92dcfb-48ef-4dc4-9583-86f851900ad8",
        nodeId: "body",
        className: bodyClass,
        name: "Body must not execute",
        execModuleConfig: {
          payloadConfig: {
            parameters: JSON.stringify({ bodyExecuted: true }),
          },
        },
      },
    ],
  };
  const definitionSnapshot = JSON.stringify({ schemaVersion: 1, submittedGraph: graph });
  const definitionSnapshotHash =
    crypto.createHash("sha256").update(definitionSnapshot).digest("hex");
  const logicalIdempotencyKey = `swarm-engine-terminal-e2e:${definitionSnapshotHash}`;
  const callbacks = {
    heartbeat:
      `/v1/vaiworkflow/engine/executions/${workflowExecutionId}/heartbeat/${workflowRunnerId}/11`,
    materialize:
      `/v1/vaiworkflow/engine/executions/${workflowExecutionId}/materialize/${workflowRunnerId}/11`,
    complete: "/v1/vaiworkflow/engine/executions/complete",
  };
  const materialization = {
    protocol: "valkyr-workflow-engine/v1",
    workflowExecutionId,
    workflowRunnerId,
    leaseFence: 11,
    logicalIdempotencyKey,
    workflowVersionId,
    definitionSnapshotHash,
    abiHash: "e".repeat(64),
    definitionSnapshot,
    initialState: { running: false, acceptance: true },
    moduleAbiHashes: {
      [looperClass]: looperHash,
      [bodyClass]: bodyHash,
    },
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

  const result = await withRuntimeDiagnostics(() => executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "private-test-session",
    fetchImpl,
    wire: {
      action: WORKFLOW_ENGINE_ACTION,
      commandId: "engine-terminal-control-e2e",
      trace: { traceId: "workflow-engine-terminal-control-e2e" },
      command: {
        scope: {},
        payload: {
          workflowExecutionId,
          workflowRunnerId,
          leaseFence: 11,
          logicalIdempotencyKey,
          workflowVersionId,
          definitionSnapshotHash,
          callbacks,
        },
      },
    },
  }), () => runtimeLog);

  assert.equal(result.executed, true);
  assert.equal(completion.terminalState, "SUCCESS");
  assert.equal(completion.finalState.running, false);
  assert.equal(completion.finalState.loopCompleted, true);
  assert.equal(completion.finalState.bodyExecuted, undefined);
  assert.equal(
    Object.values(completion.finalState)
      .some((value) => String(value).startsWith("workflow-terminal:")),
    false,
  );
  assert.doesNotMatch(runtimeLog, /Maximum workflow task executions exceeded/);
  assert.doesNotMatch(runtimeLog, /STARTING VALKYRAI APPLICATION|entityManagerFactory|OrganizationContextResolver|Transactional email readiness|Java heap space|valkyrai-startup-spinner/);
});
