import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKFLOW_ENGINE_ACTION,
  WORKFLOW_ENGINE_KILL_ACTION,
  WORKFLOW_RUNNER_ACTION,
  executeWorkflowRuntimeCommand,
  forwardWorkflowEngineEventsOnce,
  loopbackUrl,
  probeWorkflowRuntime,
  workflowRunnerMetadata,
} from "../scripts/swarm-workflow-runtime.mjs";

const agent = {
  agentId: "workflow-host",
  runtime: "valkyrai-workflow",
  capacity: 1,
  capabilities: ["graymatter.context"],
  workflowRuntime: {
    endpoint: "http://127.0.0.1:8765/v1/swarm/workflow-runs/execute",
    healthEndpoint: "http://127.0.0.1:8765/v1/swarm/workflow-runs/health",
    capabilities: ["java:17", "execmodule:map-inject"],
    allowedEnvironments: ["sandbox", "staging"],
    privacyZones: ["internal"],
    trustScore: 0.95,
  },
};

test("durable workflow engine capability is independently health-gated", async () => {
  const engineAgent = {
    ...agent,
    workflowRuntime: {
      ...agent.workflowRuntime,
      tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
    },
  };
  const state = await probeWorkflowRuntime(engineAgent, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "UP",
      protocol: "valkyr-workflow-engine/v1",
      protocols: ["valkyr-workflow-engine/v1"],
      version: "1.0.3-engine",
      capabilities: ["workflow.persistence:h2-encrypted", "workflow.recovery:v1"],
      supportedTools: [WORKFLOW_ENGINE_ACTION],
      moduleAbiHashes: { "com.valkyrlabs.workflow.modules.control.LooperModule": "b".repeat(64) },
      capabilityPackManifestHash: "c".repeat(64),
      capabilityPacks: [
        { id: "core-transforms", version: "1.0.0", dependencyClosure: { ignored: "in-heartbeat" } },
        { id: "research", version: "1.2.0", moduleAbiHashes: { ignored: "in-heartbeat" } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const metadata = workflowRunnerMetadata(engineAgent, state);
  assert.equal(state.healthy, true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_ENGINE_ACTION), true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_RUNNER_ACTION), false);
  assert.equal(metadata.capabilities.includes("workflow.persistence:h2-encrypted"), true);
  assert.equal(metadata.capabilities.includes("workflow-pack:core-transforms:1.0.0"), true);
  assert.equal(metadata.capabilities.includes("workflow-pack:research:1.2.0"), true);
  assert.equal(metadata.workflowRuntime.capabilityPackCount, 2);
  assert.equal(metadata.workflowRuntime.capabilityPackManifestHash, "c".repeat(64));
  assert.equal(metadata.workflowRuntime.capabilityPacks, undefined);
});

test("deployment runner capability is advertised only after its own live protocol probe", async () => {
  const engineAgent = {
    ...agent,
    capabilities: ["graymatter.context", "production.deploy", "deployment.runner.execute"],
    workflowRuntime: {
      ...agent.workflowRuntime,
      tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
      deploymentRunner: {
        endpoint: "http://127.0.0.1:3002/api/deployments/execute",
        healthEndpoint: "http://127.0.0.1:3002/api/deployments/health",
        protocol: "valkyr-deployment-runner/v1",
      },
    },
  };
  const engineHealth = {
    status: "UP",
    protocol: "valkyr-workflow-engine/v1",
    supportedTools: [WORKFLOW_ENGINE_ACTION],
  };
  const healthy = await probeWorkflowRuntime(engineAgent, {
    fetchImpl: async (url) => new Response(JSON.stringify(
      String(url).includes("deployments/health")
        ? { status: "UP", protocol: "valkyr-deployment-runner/v1" }
        : engineHealth), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(workflowRunnerMetadata(engineAgent, healthy).capabilities
    .includes("deployment.runner.execute"), true);

  const degraded = await probeWorkflowRuntime(engineAgent, {
    fetchImpl: async (url) => String(url).includes("deployments/health")
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify(engineHealth), {
        status: 200, headers: { "content-type": "application/json" },
      }),
  });
  const degradedMetadata = workflowRunnerMetadata(engineAgent, degraded);
  assert.equal(degradedMetadata.capabilities.includes("deployment.runner.execute"), false);
  assert.equal(degradedMetadata.capabilities.includes("production.deploy"), true);
  assert.equal(degradedMetadata.workflowRuntime.deploymentRunner.healthy, false);
});

test("workflow health cannot promote a node across its configured capability tier", async () => {
  const engineHealth = async () => new Response(JSON.stringify({
    status: "UP",
    protocol: "valkyr-workflow-engine/v1",
    supportedTools: [WORKFLOW_ENGINE_ACTION, WORKFLOW_ENGINE_KILL_ACTION],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const runnerState = await probeWorkflowRuntime(agent, { fetchImpl: engineHealth });
  assert.equal(runnerState.healthy, false);
  assert.equal(runnerState.status, "protocol_mismatch");
  assert.deepEqual(runnerState.supportedTools, []);
  assert.equal(workflowRunnerMetadata(agent, runnerState).supportedTools.includes(WORKFLOW_ENGINE_ACTION), false);

  const engineAgent = {
    ...agent,
    workflowRuntime: {
      ...agent.workflowRuntime,
      tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
    },
  };
  const runnerStateOnEngine = await probeWorkflowRuntime(engineAgent, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "UP",
      protocol: "valkyr-workflow-runner/v1",
      supportedTools: [WORKFLOW_RUNNER_ACTION],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(runnerStateOnEngine.healthy, false);
  assert.equal(runnerStateOnEngine.status, "protocol_mismatch");
  assert.deepEqual(runnerStateOnEngine.supportedTools, []);
});

test("durable workflow engine kill command reaches only the loopback kill switch", async () => {
  const engineAgent = {
    ...agent,
    workflowRuntime: {
      ...agent.workflowRuntime,
      tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
    },
  };
  const calls = [];
  const result = await executeWorkflowRuntimeCommand({
    agent: engineAgent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "unused",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ executionId: "execution-1", accepted: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
    wire: {
      action: WORKFLOW_ENGINE_KILL_ACTION,
      commandId: "kill-command-1",
      command: {
        payload: {
          workflowExecutionId: "execution-1",
          workflowRunnerId: "runner-1",
          leaseFence: 5,
        },
      },
    },
  });

  assert.equal(result.status, "kill_requested");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url,
    "http://127.0.0.1:8767/v1/swarm/workflow-engine/executions/execution-1/kill");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers["X-Valkyr-Swarm-Command-Id"], "kill-command-1");
});

test("durable engine replays local progress and terminal callbacks after the command request returns", async () => {
  const engineAgent = {
    ...agent,
    workflowRuntime: {
      ...agent.workflowRuntime,
      tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
      healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
    },
  };
  const calls = [];
  const replayedEvents = [];
  const callbacks = {
    heartbeat: "/v1/vaiworkflow/engine/executions/execution-9/heartbeat/runner-9/17",
    complete: "/v1/vaiworkflow/engine/executions/complete",
    progress: "/v1/vaiworkflow/engine/executions/execution-9/progress/runner-9/17",
  };
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.includes("127.0.0.1:8767/v1/swarm/workflow-engine/events")) {
      if (value.endsWith("/events/ack")) {
        return new Response(JSON.stringify({ acknowledged: JSON.parse(options.body).through }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        acknowledged: 0,
        next: 2,
        events: [
          {
            id: 1,
            executionId: "execution-9",
            eventType: "TASK_STARTED",
            workflowRunnerId: "runner-9",
            workflowVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            definitionSnapshotHash: "d".repeat(64),
            leaseFence: 17,
            callbacks,
            payload: { taskId: "task-1", taskVisit: 1 },
          },
          {
            id: 2,
            executionId: "execution-9",
            eventType: "SUCCESS",
            workflowRunnerId: "runner-9",
            workflowVersionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            definitionSnapshotHash: "d".repeat(64),
            leaseFence: 17,
            callbacks,
            payload: { terminalState: "SUCCESS", finalState: { answer: 42 } },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.includes("api-0.valkyrlabs.com")) {
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  const replay = await forwardWorkflowEngineEventsOnce({
    agent: engineAgent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "session-token",
    fetchImpl,
    onEvent: async (event) => replayedEvents.push(event),
  });

  assert.equal(replay.next, 2);
  assert.equal(replay.activeExecutions.size, 0);
  assert.equal(replayedEvents.length, 2);
  assert.equal(replayedEvents[1].terminal, true);
  const progress = calls.find((call) => call.url.includes("/progress/"));
  assert.equal(JSON.parse(progress.options.body).eventType, "TASK_STARTED");
  const completion = calls.find((call) => call.url.endsWith("/executions/complete"));
  const completionBody = JSON.parse(completion.options.body);
  assert.equal(completionBody.leaseFence, 17);
  assert.equal(completionBody.terminalState, "SUCCESS");
  assert.deepEqual(completionBody.finalState, { answer: 42 });
  assert.equal(completion.options.headers.Authorization, "Bearer session-token");
  const acknowledgement = calls.find((call) => call.url.endsWith("/events/ack"));
  assert.deepEqual(JSON.parse(acknowledgement.options.body), { through: 2 });
});

test("workflow runner capability is advertised only after a live loopback health check", async () => {
  assert.equal(workflowRunnerMetadata(agent, { healthy: false }).supportedTools.includes(WORKFLOW_RUNNER_ACTION), false);
  const state = await probeWorkflowRuntime(agent, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "UP",
      protocol: "valkyr-workflow-runner/v1",
      version: "1.0.3",
      capabilities: ["java:17", "execmodule:map-inject"],
      supportedTools: [WORKFLOW_RUNNER_ACTION],
      moduleAbiHashes: { "com.valkyrlabs.workflow.modules.basic.MapInjectModule": "a".repeat(64) },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const metadata = workflowRunnerMetadata(agent, state);
  assert.equal(state.healthy, true);
  assert.equal(metadata.supportedTools.includes(WORKFLOW_RUNNER_ACTION), true);
  assert.equal(metadata.capabilities.includes("java:17"), true);
  assert.equal(metadata.capabilities.includes(`execmodule-abi:${"a".repeat(64)}`), true);
  assert.equal(metadata.workflowRuntime.version, "1.0.3");
  assert.equal(metadata.workflowRuntime.moduleAbiCount, 1);
  assert.equal(metadata.workflowRuntime.moduleAbiHashes, undefined);
});

test("workflow runner heartbeat omits the redundant ABI catalog and stays frame-safe", () => {
  const hashes = Object.fromEntries(Array.from({ length: 107 }, (_, index) => [
    `com.valkyrlabs.workflow.modules.generated.Module${index}`,
    index.toString(16).padStart(64, "0"),
  ]));
  const metadata = workflowRunnerMetadata(agent, {
    healthy: true,
    status: "healthy",
    protocol: "valkyr-workflow-runner/v1",
    version: "1.0.3",
    capabilities: ["java:17"],
    supportedTools: [WORKFLOW_RUNNER_ACTION],
    moduleAbiHashes: hashes,
  });
  assert.equal(metadata.workflowRuntime.moduleAbiCount, 107);
  assert.equal(metadata.workflowRuntime.moduleAbiHashes, undefined);
  assert.equal(Buffer.byteLength(JSON.stringify(metadata), "utf8") < 16 * 1024, true);
});

test("workflow runner rejects a healthy-looking sidecar with the wrong protocol", async () => {
  const state = await probeWorkflowRuntime(agent, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "UP",
      protocol: "unknown/v1",
      supportedTools: [WORKFLOW_RUNNER_ACTION],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(state.healthy, false);
  assert.equal(state.status, "protocol_mismatch");
  assert.equal(workflowRunnerMetadata(agent, state).supportedTools.includes(WORKFLOW_RUNNER_ACTION), false);
});

test("workflow runtime endpoints are loopback-only and secret-free", () => {
  assert.equal(loopbackUrl("http://127.0.0.1:8765/health", "endpoint").hostname, "127.0.0.1");
  assert.throws(() => loopbackUrl("https://runner.example.com/execute", "endpoint"), /loopback HTTP/);
  assert.throws(() => loopbackUrl("http://10.0.0.8:8765/execute", "endpoint"), /loopback-only/);
  assert.throws(() => loopbackUrl("http://user:secret@127.0.0.1:8765/execute", "endpoint"), /credentials/);
});

test("remote workflow execution heartbeats, streams progress, and completes through fenced callbacks", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.endsWith("/heartbeat/runner-1/7")) return new Response(null, { status: 204 });
    if (value.endsWith("/materialize/runner-1/7")) {
      return new Response(JSON.stringify({
        protocol: "valkyr-workflow-runner/v1",
        runId: "run-1",
        workflowRunnerId: "runner-1",
        leaseFence: 7,
        logicalIdempotencyKey: "logical-1",
        moduleClass: "com.valkyrlabs.workflow.modules.operations.ValkyrLabsCeoPlannerModule",
        abiHash: "abi-1",
        config: {},
        inputs: { objective: "grow" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.endsWith("/runs/complete")) {
      return new Response(JSON.stringify({ id: "run-1", state: "SUCCESS", leaseFence: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.includes("127.0.0.1:8765")) {
      return new Response([
        JSON.stringify({ type: "progress", text: "loaded module" }),
        JSON.stringify({ type: "completed", success: true, outputs: { answer: 42 }, costTokens: 3 }),
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    throw new Error(`Unexpected request: ${value}`);
  };
  const progress = [];
  const result = await executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "session-token",
    fetchImpl,
    onProgress: (event) => progress.push(event),
    wire: {
      action: WORKFLOW_RUNNER_ACTION,
      commandId: "command-1",
      trace: { traceId: "workflow-run:run-1" },
      command: {
        scope: { organizationId: "tenant-from-session" },
        payload: {
          runId: "run-1",
          workflowRunnerId: "runner-1",
          leaseFence: 7,
          logicalIdempotencyKey: "logical-1",
          inputArtifactRef: "workflow-artifact:artifact-1",
          callbacks: {
            heartbeat: "/v1/vaiworkflow/runners/runs/run-1/heartbeat/runner-1/7",
            materialize: "/v1/vaiworkflow/runners/runs/run-1/materialize/runner-1/7",
            complete: "/v1/vaiworkflow/runners/runs/complete",
          },
        },
      },
    },
  });

  assert.equal(result.executed, true);
  assert.deepEqual(result.artifact, { answer: 42 });
  assert.equal(progress.some((event) => event.text === "loaded module"), true);
  assert.equal(progress.some((event) => event.text === "Remote workflow lease established"), true);
  const completion = calls.find((call) => call.url.endsWith("/runs/complete"));
  assert.equal(JSON.parse(completion.options.body).leaseFence, 7);
  assert.equal(JSON.parse(completion.options.body).outputs.answer, 42);
  assert.equal(completion.options.headers.Authorization, "Bearer session-token");
  const local = calls.find((call) => call.url.includes("127.0.0.1:8765"));
  assert.equal(local.options.headers.Authorization, undefined);
  assert.equal(JSON.parse(local.options.body).materialization.abiHash, "abi-1");
});

test("local runtime transport failures produce a fenced failure completion", async () => {
  let completionBody;
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/heartbeat/runner-1/9")) return new Response(null, { status: 204 });
    if (value.endsWith("/materialize/runner-1/9")) {
      return new Response(JSON.stringify({
        protocol: "valkyr-workflow-runner/v1",
        runId: "run-2",
        workflowRunnerId: "runner-1",
        leaseFence: 9,
        logicalIdempotencyKey: "logical-2",
        moduleClass: "example.Module",
        abiHash: "abi-2",
        config: {},
        inputs: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.endsWith("/runs/complete")) {
      completionBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "run-2", state: "FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.includes("127.0.0.1:8765")) throw new Error("sidecar unavailable");
    throw new Error(`Unexpected request: ${value}`);
  };

  await assert.rejects(executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "session-token",
    fetchImpl,
    wire: {
      action: WORKFLOW_RUNNER_ACTION,
      commandId: "command-2",
      command: {
        scope: {},
        payload: {
          runId: "run-2",
          workflowRunnerId: "runner-1",
          leaseFence: 9,
          logicalIdempotencyKey: "logical-2",
          inputArtifactRef: "workflow-artifact:artifact-2",
          callbacks: {
            heartbeat: "/v1/vaiworkflow/runners/runs/run-2/heartbeat/runner-1/9",
            materialize: "/v1/vaiworkflow/runners/runs/run-2/materialize/runner-1/9",
            complete: "/v1/vaiworkflow/runners/runs/complete",
          },
        },
      },
    },
  }), /Local Workflow runtime transport failed/);
  assert.equal(completionBody.success, false);
  assert.equal(completionBody.errorType, "TRANSIENT");
  assert.equal(completionBody.errorMessage, "Local Workflow runtime transport failed");
});

test("durable engine executes an immutable version snapshot and returns checkpoint state", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    if (value.endsWith("/heartbeat/runner-2/11")) return new Response(null, { status: 204 });
    if (value.endsWith("/materialize/runner-2/11")) {
      return new Response(JSON.stringify({
        protocol: "valkyr-workflow-engine/v1",
        workflowExecutionId: "execution-1",
        workflowRunnerId: "runner-2",
        leaseFence: 11,
        logicalIdempotencyKey: "execution-logical-1",
        workflowVersionId: "version-1",
        definitionSnapshotHash: "c".repeat(64),
        graph: { nodes: [], edges: [], modules: [] },
        initialState: { running: true },
        moduleAbiHashes: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (value.endsWith("/complete")) {
      return new Response(JSON.stringify({ state: "WAITING_UNTIL", recoveryFence: 11 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (value.includes("127.0.0.1:8765")) {
      return new Response([
        JSON.stringify({ type: "progress", text: "checkpointed delay" }),
        JSON.stringify({
          type: "completed",
          success: true,
          terminalState: "WAITING_UNTIL",
          finalState: { running: true, cycle: 1 },
          checkpointRef: "checkpoint:1",
        }),
      ].join("\n"), { status: 200, headers: { "content-type": "application/x-ndjson" } });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  const result = await executeWorkflowRuntimeCommand({
    agent,
    apiBase: "https://api-0.valkyrlabs.com/v1",
    tokenProvider: async () => "session-token",
    fetchImpl,
    wire: {
      action: WORKFLOW_ENGINE_ACTION,
      commandId: "engine-command-1",
      command: {
        scope: {},
        payload: {
          workflowExecutionId: "execution-1",
          workflowRunnerId: "runner-2",
          leaseFence: 11,
          logicalIdempotencyKey: "execution-logical-1",
          workflowVersionId: "version-1",
          definitionSnapshotHash: "c".repeat(64),
          callbacks: {
            heartbeat: "/v1/vaiworkflow/engine/executions/execution-1/heartbeat/runner-2/11",
            materialize: "/v1/vaiworkflow/engine/executions/execution-1/materialize/runner-2/11",
            complete: "/v1/vaiworkflow/engine/executions/complete",
          },
        },
      },
    },
  });

  assert.equal(result.workflowExecutionId, "execution-1");
  const completion = calls.find((call) => call.url.endsWith("/complete"));
  const body = JSON.parse(completion.options.body);
  assert.equal(body.workflowVersionId, "version-1");
  assert.equal(body.definitionSnapshotHash, "c".repeat(64));
  assert.equal(body.checkpointRef, "checkpoint:1");
  assert.deepEqual(body.finalState, { running: true, cycle: 1 });
  const local = calls.find((call) => call.url.includes("127.0.0.1:8765"));
  assert.equal(JSON.parse(local.options.body).protocol, "valkyr-workflow-engine/v1");
});
