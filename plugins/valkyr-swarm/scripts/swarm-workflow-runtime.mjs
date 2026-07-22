const WORKFLOW_RUNNER_ACTION = "workflow.runner.execute-module";
const WORKFLOW_ENGINE_ACTION = "workflow.engine.execute-workflow";
const WORKFLOW_ENGINE_KILL_ACTION = "workflow.engine.kill-execution";
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_RUNTIME_RESPONSE_BYTES = 2 * 1024 * 1024;
const WORKFLOW_RUNNER_PROTOCOL = "valkyr-workflow-runner/v1";
const WORKFLOW_ENGINE_PROTOCOL = "valkyr-workflow-engine/v1";
const DEPLOYMENT_RUNNER_CAPABILITY = "deployment.runner.execute";
const DEPLOYMENT_RUNNER_PROTOCOL = "valkyr-deployment-runner/v1";
const WORKFLOW_ACTIONS = new Set([
  WORKFLOW_RUNNER_ACTION,
  WORKFLOW_ENGINE_ACTION,
  WORKFLOW_ENGINE_KILL_ACTION,
]);

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))]
    : [];
}

function moduleAbiHashes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([moduleClass, hash]) => /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(moduleClass)
      && /^[a-f0-9]{64}$/i.test(String(hash ?? "")))
    .map(([moduleClass, hash]) => [moduleClass, String(hash).toLowerCase()]));
}

function moduleAbiCapabilities(value) {
  return [...new Set(Object.values(moduleAbiHashes(value))
    .map((hash) => `execmodule-abi:${hash}`))];
}

function capabilityPackSummaries(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const summaries = [];
  for (const pack of value.slice(0, 32)) {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) continue;
    const id = String(pack.id ?? "").trim().toLowerCase();
    const version = String(pack.version ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)
        || !version
        || version.length > 64
        || !/^[A-Za-z0-9._-]+$/.test(version)
        || ids.has(id)) continue;
    ids.add(id);
    summaries.push({ id, version });
  }
  return summaries;
}

function capabilityPackCapabilities(value) {
  return capabilityPackSummaries(value).map((pack) => `workflow-pack:${pack.id}:${pack.version}`);
}

function loopbackUrl(value, label) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "http:") throw new Error(`${label} must use loopback HTTP`);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${label} must be loopback-only`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or fragments`);
  }
  return url;
}

function workflowRuntimeConfig(agent) {
  const value = agent?.workflowRuntime;
  if (!value || value.enabled === false) return null;
  const endpoint = loopbackUrl(value.endpoint, "workflowRuntime.endpoint");
  const healthEndpoint = loopbackUrl(
    value.healthEndpoint ?? new URL("/v1/swarm/workflow-runs/health", endpoint).toString(),
    "workflowRuntime.healthEndpoint",
  );
  const tier = value.tier === "engine" ? "engine" : "runner";
  const eventsEndpoint = tier === "engine"
    ? loopbackUrl(
      value.eventsEndpoint ?? new URL("/v1/swarm/workflow-engine/events", endpoint).toString(),
      "workflowRuntime.eventsEndpoint",
    )
    : null;
  const timeoutSeconds = Number(value.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error("workflowRuntime.timeoutSeconds must be between 1 and 3600");
  }
  let deploymentRunner = null;
  if (value.deploymentRunner != null) {
    if (tier !== "engine" || !value.deploymentRunner
        || typeof value.deploymentRunner !== "object"
        || Array.isArray(value.deploymentRunner)) {
      throw new Error("workflowRuntime.deploymentRunner requires the durable engine tier");
    }
    const deploymentEndpoint = loopbackUrl(
      value.deploymentRunner.endpoint, "workflowRuntime.deploymentRunner.endpoint");
    const deploymentHealthEndpoint = loopbackUrl(
      value.deploymentRunner.healthEndpoint,
      "workflowRuntime.deploymentRunner.healthEndpoint");
    if (deploymentEndpoint.pathname !== "/api/deployments/execute"
        || deploymentHealthEndpoint.pathname !== "/api/deployments/health"
        || String(value.deploymentRunner.protocol ?? "") !== DEPLOYMENT_RUNNER_PROTOCOL) {
      throw new Error("workflowRuntime.deploymentRunner has an invalid endpoint or protocol");
    }
    deploymentRunner = {
      endpoint: deploymentEndpoint.toString(),
      healthEndpoint: deploymentHealthEndpoint.toString(),
      protocol: DEPLOYMENT_RUNNER_PROTOCOL,
    };
  }
  return {
    endpoint: endpoint.toString(),
    healthEndpoint: healthEndpoint.toString(),
    eventsEndpoint: eventsEndpoint?.toString() ?? null,
    tier,
    timeoutSeconds,
    capabilities: stringList(value.capabilities),
    supportedModels: stringList(value.supportedModels),
    supportedTools: stringList(value.supportedTools),
    networkZones: stringList(value.networkZones ?? ["loopback"]),
    regions: stringList(value.regions),
    integrationTypes: stringList(value.integrationTypes),
    integrationAccounts: stringList(value.integrationAccounts),
    allowedDataClassifications: stringList(value.allowedDataClassifications ?? ["internal"]),
    privacyZones: stringList(value.privacyZones ?? ["internal"]),
    allowedEnvironments: stringList(value.allowedEnvironments ?? ["sandbox"]),
    maxConcurrency: Number(value.maxConcurrency ?? agent.capacity ?? 1),
    estimatedCost: Number(value.estimatedCost ?? 0),
    estimatedLatencyMs: Number(value.estimatedLatencyMs ?? 0),
    trustScore: Number(value.trustScore ?? 0),
    localExecution: value.localExecution !== false,
    leaseDurationSeconds: Number(value.leaseDurationSeconds ?? 120),
    deploymentRunner,
  };
}

async function probeDeploymentRunner(config, fetchImpl) {
  if (!config.deploymentRunner) return null;
  try {
    const response = await fetchImpl(config.deploymentRunner.healthEndpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { healthy: false, status: `http_${response.status}` };
    const body = await response.json();
    const status = String(body?.status ?? body?.state ?? "unknown").toLowerCase();
    const protocol = String(body?.protocol ?? "");
    const healthy = ["up", "healthy", "ready", "ok"].includes(status)
      && protocol === DEPLOYMENT_RUNNER_PROTOCOL;
    return { healthy, status: healthy ? "healthy" : "protocol_mismatch", protocol };
  } catch (error) {
    return { healthy: false, status: "unreachable", error: error?.message ?? String(error) };
  }
}

async function forwardWorkflowEngineEventsOnce({
  agent,
  apiBase,
  tokenProvider,
  after = 0,
  activeExecutions = new Map(),
  fetchImpl = fetch,
  onProgress,
  onEvent,
}) {
  const config = workflowRuntimeConfig(agent);
  if (!config || config.tier !== "engine" || !config.eventsEndpoint) {
    return { next: Math.max(0, Number(after) || 0), activeExecutions };
  }
  const eventsUrl = new URL(config.eventsEndpoint);
  eventsUrl.searchParams.set("after", String(Math.max(0, Number(after) || 0)));
  eventsUrl.searchParams.set("limit", "100");
  const response = await fetchImpl(eventsUrl, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Local Workflow engine event replay failed with HTTP ${response.status}`);
  const body = await response.json();
  const events = Array.isArray(body?.events) ? body.events : [];
  const acknowledged = Math.max(0, Number(body?.acknowledged) || 0);
  let next = Math.max(0, Number(after) || 0, acknowledged);
  const active = new Map(activeExecutions);
  for (const event of events) {
    const eventId = Number(event?.id);
    if (!Number.isSafeInteger(eventId) || eventId <= next) continue;
    const executionId = String(event?.executionId ?? "");
    const eventType = String(event?.eventType ?? "").toUpperCase();
    const callbacks = event?.callbacks && typeof event.callbacks === "object" ? event.callbacks : {};
    if (!executionId) throw new Error("Local Workflow engine event omitted executionId");
    const context = {
      executionId,
      commandId: String(callbacks.swarmCommandId ?? ""),
      traceId: String(callbacks.swarmTraceId ?? `workflow-execution:${executionId}`),
      workflowRunnerId: String(event?.workflowRunnerId ?? ""),
      workflowVersionId: String(event?.workflowVersionId ?? ""),
      definitionSnapshotHash: String(event?.definitionSnapshotHash ?? ""),
      leaseFence: Number(event?.leaseFence),
      callbacks,
    };
    const terminal = ["SUCCESS", "FAILED", "CANCELLED"].includes(eventType);
    const checkpoint = eventType === "CHECKPOINT";
    if (terminal || checkpoint) {
      const completeUrl = callbackUrl(apiBase, callbacks.complete);
      const checkpointState = String(event?.payload?.state ?? event?.payload?.terminalState ?? eventType);
      const successful = !["FAILED", "CANCELLED"].includes(checkpointState);
      await authorizedJson(completeUrl, {
        workflowExecutionId: executionId,
        workflowRunnerId: context.workflowRunnerId,
        workflowVersionId: context.workflowVersionId,
        definitionSnapshotHash: context.definitionSnapshotHash,
        leaseFence: context.leaseFence,
        success: successful,
        terminalState: checkpointState,
        finalState: event?.payload?.finalState ?? {},
        checkpointRef: event?.payload?.checkpointRef ?? null,
        approvalRef: event?.payload?.approvalRef ?? null,
        waitingUntil: event?.payload?.waitingUntil ?? null,
        errorMessage: successful ? null : String(event?.payload?.errorMessage ?? checkpointState),
        errorType: successful ? null : "PERMANENT",
        swarmReceiptRef: `swarm-engine-event:${eventId}`,
      }, tokenProvider, fetchImpl);
    } else if (callbacks.progress) {
      await authorizedJson(callbackUrl(apiBase, callbacks.progress), {
        workflowExecutionId: executionId,
        workflowRunnerId: context.workflowRunnerId,
        leaseFence: context.leaseFence,
        eventId,
        eventType,
        payload: event?.payload ?? {},
        createdAt: event?.createdAt ?? null,
      }, tokenProvider, fetchImpl);
    }
    if (terminal) active.delete(executionId);
    else active.set(executionId, context);
    await onEvent?.({ event, context, terminal, checkpoint });
    next = eventId;
    onProgress?.({ stream: "workflow", text: `Workflow engine event ${eventType} (${eventId})` });
  }
  for (const context of active.values()) {
    if (context.callbacks?.heartbeat) {
      await authorizedJson(callbackUrl(apiBase, context.callbacks.heartbeat), undefined, tokenProvider, fetchImpl);
    }
  }
  if (next > acknowledged) {
    const acknowledgeUrl = new URL(config.eventsEndpoint);
    acknowledgeUrl.search = "";
    acknowledgeUrl.pathname = `${acknowledgeUrl.pathname.replace(/\/$/, "")}/ack`;
    const acknowledgement = await fetchImpl(acknowledgeUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ through: next }),
    });
    if (!acknowledgement.ok) {
      throw new Error(`Local Workflow engine event acknowledgement failed with HTTP ${acknowledgement.status}`);
    }
    const acknowledgedBody = await acknowledgement.json();
    if (Number(acknowledgedBody?.acknowledged) < next) {
      throw new Error("Local Workflow engine did not durably acknowledge the replay cursor");
    }
  }
  return { next, activeExecutions: active };
}

function validateWorkflowRuntime(agent) {
  const config = workflowRuntimeConfig(agent);
  if (!config) return;
  for (const [name, value, minimum, maximum] of [
    ["maxConcurrency", config.maxConcurrency, 1, 100],
    ["estimatedCost", config.estimatedCost, 0, Number.MAX_SAFE_INTEGER],
    ["estimatedLatencyMs", config.estimatedLatencyMs, 0, Number.MAX_SAFE_INTEGER],
    ["trustScore", config.trustScore, 0, 1],
    ["leaseDurationSeconds", config.leaseDurationSeconds, 5, 3600],
  ]) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`workflowRuntime.${name} must be between ${minimum} and ${maximum}`);
    }
  }
}

async function probeWorkflowRuntime(agent, { fetchImpl = fetch } = {}) {
  const config = workflowRuntimeConfig(agent);
  if (!config) return { configured: false, healthy: false, status: "unsupported" };
  try {
    const response = await fetchImpl(config.healthEndpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { configured: true, healthy: false, status: `http_${response.status}` };
    let body = {};
    try { body = await response.json(); } catch { /* a successful empty health response is valid */ }
    const state = String(body?.status ?? body?.state ?? "unknown").toLowerCase();
    const reportedTools = stringList(body?.supportedTools).filter((tool) => WORKFLOW_ACTIONS.has(tool));
    const supportedTools = reportedTools.filter((tool) => config.tier === "engine"
      ? tool === WORKFLOW_ENGINE_ACTION || tool === WORKFLOW_ENGINE_KILL_ACTION
      : tool === WORKFLOW_RUNNER_ACTION);
    const protocol = String(body?.protocol ?? "");
    const protocols = stringList(body?.protocols ?? [protocol]);
    const runnerReady = supportedTools.includes(WORKFLOW_RUNNER_ACTION)
      && protocols.includes(WORKFLOW_RUNNER_PROTOCOL);
    const engineReady = supportedTools.includes(WORKFLOW_ENGINE_ACTION)
      && protocols.includes(WORKFLOW_ENGINE_PROTOCOL);
    const tierReady = config.tier === "engine" ? engineReady : runnerReady;
    const healthy = ["up", "healthy", "ready", "ok"].includes(state)
      && tierReady;
    const deploymentRunner = healthy
      ? await probeDeploymentRunner(config, fetchImpl) : null;
    return {
      configured: true,
      healthy,
      status: healthy ? "healthy" : (tierReady ? state : "protocol_mismatch"),
      version: body?.version ?? body?.build?.version ?? null,
      protocol,
      protocols,
      capabilities: stringList(body?.capabilities),
      supportedTools,
      moduleAbiHashes: moduleAbiHashes(body?.moduleAbiHashes),
      capabilityPackManifestHash: /^[a-f0-9]{64}$/i.test(String(body?.capabilityPackManifestHash ?? ""))
        ? String(body.capabilityPackManifestHash).toLowerCase() : null,
      capabilityPacks: capabilityPackSummaries(body?.capabilityPacks),
      localCapabilityHealth: config.deploymentRunner ? {
        [DEPLOYMENT_RUNNER_CAPABILITY]: deploymentRunner?.healthy === true,
      } : {},
      deploymentRunner,
    };
  } catch (error) {
    return { configured: true, healthy: false, status: "unreachable", error: error?.message ?? String(error) };
  }
}

function workflowRunnerMetadata(agent, state = {}) {
  const config = workflowRuntimeConfig(agent);
  const locallyProbedCapabilities = new Set(
    config?.deploymentRunner ? [DEPLOYMENT_RUNNER_CAPABILITY] : [],
  );
  const baseCapabilities = stringList(agent?.capabilities)
    .filter((capability) => !WORKFLOW_ACTIONS.has(capability))
    .filter((capability) => !locallyProbedCapabilities.has(capability)
      || (state.healthy && state.localCapabilityHealth?.[capability] === true));
  const baseTools = stringList(agent?.supportedTools)
    .filter((tool) => !WORKFLOW_ACTIONS.has(tool));
  if (!config || !state.healthy) {
    return {
      capabilities: baseCapabilities,
      supportedTools: baseTools,
      workflowRuntime: config ? { installed: true, healthy: false, status: state.status ?? "unavailable" }
        : { installed: false, healthy: false, status: "unsupported" },
    };
  }
  return {
    capabilities: [...new Set([
      ...baseCapabilities,
      ...config.capabilities,
      ...stringList(state.capabilities),
      ...moduleAbiCapabilities(state.moduleAbiHashes),
      ...capabilityPackCapabilities(state.capabilityPacks),
    ])],
    supportedModels: config.supportedModels,
    supportedTools: [...new Set([...baseTools, ...stringList(state.supportedTools)])],
    networkZones: config.networkZones,
    regions: config.regions,
    integrationTypes: config.integrationTypes,
    integrationAccounts: config.integrationAccounts,
    allowedDataClassifications: config.allowedDataClassifications,
    privacyZones: config.privacyZones,
    allowedEnvironments: config.allowedEnvironments,
    maxConcurrency: config.maxConcurrency,
    estimatedCost: config.estimatedCost,
    estimatedLatencyMs: config.estimatedLatencyMs,
    trustScore: config.trustScore,
    localExecution: config.localExecution,
    leaseDurationSeconds: config.leaseDurationSeconds,
    workflowRuntime: {
      installed: true,
      healthy: true,
      status: state.status ?? "healthy",
      version: state.version ?? null,
      protocol: state.protocol,
      protocols: state.protocols,
      // Exact ABI hashes are already advertised as execmodule-abi:* capabilities.
      // Repeating the full class-to-hash catalog here can push the nested STOMP
      // heartbeat over conservative websocket frame limits and makes an otherwise
      // healthy runner disconnect with close code 1009. The sidecar remains the
      // authoritative catalog and re-validates the materialized module ABI before
      // execution; the mothership only needs the compact capability set for routing.
      moduleAbiCount: Object.keys(moduleAbiHashes(state.moduleAbiHashes)).length,
      capabilityPackCount: capabilityPackSummaries(state.capabilityPacks).length,
      capabilityPackManifestHash: state.capabilityPackManifestHash ?? null,
      ...(config.deploymentRunner ? {
        deploymentRunner: {
          healthy: state.localCapabilityHealth?.[DEPLOYMENT_RUNNER_CAPABILITY] === true,
          status: state.deploymentRunner?.status ?? "unavailable",
          protocol: state.deploymentRunner?.protocol ?? null,
        },
      } : {}),
    },
  };
}

function supportsWorkflowRuntimeAction(agent, state, action) {
  return WORKFLOW_ACTIONS.has(action)
    && workflowRunnerMetadata(agent, state).supportedTools?.includes(action) === true;
}

function callbackUrl(apiBase, callback) {
  const allowed = ["/v1/vaiworkflow/runners/", "/v1/vaiworkflow/engine/"];
  if (typeof callback !== "string" || !allowed.some((prefix) => callback.startsWith(prefix))) {
    throw new Error("Remote workflow command contains an invalid callback path");
  }
  const base = new URL(apiBase);
  const result = new URL(callback, `${base.protocol}//${base.host}`);
  if (result.origin !== base.origin) throw new Error("Remote workflow callback origin mismatch");
  return result;
}

async function authorizedJson(url, body, tokenProvider, fetchImpl) {
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);
  const send = async (forceRefresh = false) => {
    const token = await tokenProvider({ forceRefresh });
    if (!token) throw new Error("Remote workflow callback requires an authenticated SWARM session");
    return fetchImpl(url, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: encodedBody,
    });
  };
  let response = await send(false);
  if (response.status === 401 || response.status === 403) response = await send(true);
  const text = await response.text();
  if (!response.ok) throw new Error(`Remote workflow callback failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { text: text.slice(0, 8_000) }; }
}

async function readRuntimeResponse(response, onProgress) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local Workflow runtime failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  const contentType = String(response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("ndjson") || !response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RUNTIME_RESPONSE_BYTES) throw new Error("Local Workflow runtime response exceeded the safety limit");
    return text ? JSON.parse(text) : {};
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let terminal = null;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (["result", "completed", "failed"].includes(String(event.type ?? "").toLowerCase())) terminal = event;
    else onProgress?.({ stream: "workflow", text: String(event.text ?? event.message ?? JSON.stringify(event)) });
  };
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RUNTIME_RESPONSE_BYTES) throw new Error("Local Workflow runtime stream exceeded the safety limit");
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(consume);
  }
  buffer += decoder.decode();
  consume(buffer);
  if (!terminal) throw new Error("Local Workflow runtime stream omitted a terminal result");
  return terminal;
}

async function executeWorkflowRuntimeCommand({ agent, wire, apiBase, tokenProvider, fetchImpl = fetch, onProgress }) {
  const config = workflowRuntimeConfig(agent);
  if (!config) throw new Error("This SWARM node has no local Workflow runtime");
  if (!WORKFLOW_ACTIONS.has(wire.action)) throw new Error(`Unsupported Workflow runtime action: ${wire.action}`);
  const payload = wire.command?.payload;
  if (wire.action === WORKFLOW_ENGINE_KILL_ACTION) {
    if (config.tier !== "engine" || !payload?.workflowExecutionId
        || !payload?.workflowRunnerId || !Number.isSafeInteger(Number(payload?.leaseFence))) {
      throw new Error("Remote Workflow engine kill command is incomplete");
    }
    const killUrl = new URL(
      `/v1/swarm/workflow-engine/executions/${encodeURIComponent(payload.workflowExecutionId)}/kill`,
      config.endpoint,
    );
    const response = await fetchImpl(killUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/json",
        "X-Valkyr-Swarm-Command-Id": wire.commandId,
      },
    });
    const result = await readRuntimeResponse(response, onProgress);
    if (result?.accepted !== true) throw new Error("Local Workflow engine rejected the kill switch request");
    return {
      adapter: "workflow-runtime-http",
      executed: true,
      receiptOnly: false,
      status: "kill_requested",
      workflowExecutionId: payload.workflowExecutionId,
      workflowRunnerId: payload.workflowRunnerId,
      leaseFence: Number(payload.leaseFence),
      artifact: result,
    };
  }
  const callbacks = payload?.callbacks;
  const engineExecution = wire.action === WORKFLOW_ENGINE_ACTION;
  const identityField = engineExecution ? "workflowExecutionId" : "runId";
  const requiredFields = engineExecution
    ? [identityField, "workflowRunnerId", "leaseFence", "logicalIdempotencyKey", "workflowVersionId", "definitionSnapshotHash"]
    : [identityField, "workflowRunnerId", "leaseFence", "logicalIdempotencyKey", "inputArtifactRef"];
  for (const field of requiredFields) {
    if (payload?.[field] === undefined || payload?.[field] === null || payload?.[field] === "") {
      throw new Error(`Remote workflow command omitted ${field}`);
    }
  }
  const heartbeatUrl = callbackUrl(apiBase, callbacks?.heartbeat);
  const materializeUrl = callbackUrl(apiBase, callbacks?.materialize);
  const completionUrl = callbackUrl(apiBase, callbacks?.complete);
  await authorizedJson(heartbeatUrl, undefined, tokenProvider, fetchImpl);
  onProgress?.({ stream: "workflow", text: "Remote workflow lease established" });
  const materialization = await authorizedJson(materializeUrl, undefined, tokenProvider, fetchImpl);
  const expectedProtocol = engineExecution ? WORKFLOW_ENGINE_PROTOCOL : WORKFLOW_RUNNER_PROTOCOL;
  if (materialization?.protocol !== expectedProtocol
      || materialization?.[identityField] !== payload[identityField]
      || materialization?.workflowRunnerId !== payload.workflowRunnerId
      || Number(materialization?.leaseFence) !== Number(payload.leaseFence)
      || materialization?.logicalIdempotencyKey !== payload.logicalIdempotencyKey
      || (engineExecution && materialization?.workflowVersionId !== payload.workflowVersionId)
      || (engineExecution && materialization?.definitionSnapshotHash !== payload.definitionSnapshotHash)) {
    throw new Error("Remote workflow materialization does not match the fenced command");
  }
  onProgress?.({ stream: "workflow", text: "Immutable workflow materialization authorized" });
  let heartbeatActive = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatActive) return;
    heartbeatActive = true;
    authorizedJson(heartbeatUrl, undefined, tokenProvider, fetchImpl)
      .catch((error) => onProgress?.({ stream: "workflow", text: `Lease heartbeat failed: ${error.message}` }))
      .finally(() => { heartbeatActive = false; });
  }, Math.max(2_000, Math.min(30_000, config.leaseDurationSeconds * 1000 / 3)));
  const startedAt = Date.now();
  let result;
  try {
    onProgress?.({ stream: "workflow", text: "Workflow engine execution started" });
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, application/x-ndjson",
        "X-Valkyr-Swarm-Command-Id": wire.commandId,
      },
      body: JSON.stringify({
        protocol: expectedProtocol,
        commandId: wire.commandId,
        action: wire.action,
        trace: wire.trace ?? {},
        scope: wire.command?.scope ?? {},
        payload,
        materialization,
      }),
    });
    result = await readRuntimeResponse(response, onProgress);
  } catch (error) {
    result = {
      type: "failed",
      success: false,
      outputs: {},
      errorMessage: "Local Workflow runtime transport failed",
      errorType: "TRANSIENT",
    };
  } finally {
    clearInterval(heartbeatTimer);
  }
  const success = result?.success !== false && String(result?.type ?? "").toLowerCase() !== "failed";
  const completion = {
    [identityField]: payload[identityField],
    workflowRunnerId: payload.workflowRunnerId,
    leaseFence: Number(payload.leaseFence),
    success,
    outputs: success ? (result?.outputs ?? result?.result ?? {}) : {},
    durationMs: Number(result?.durationMs ?? Date.now() - startedAt),
    costTokens: Number(result?.costTokens ?? 0),
    errorMessage: success ? null : String(result?.errorMessage ?? result?.message ?? "Local Workflow runtime failed"),
    errorType: success ? null : String(result?.errorType ?? "PERMANENT"),
    swarmReceiptRef: `swarm-run:${wire.commandId}`,
  };
  if (engineExecution) {
    completion.workflowVersionId = payload.workflowVersionId;
    completion.definitionSnapshotHash = payload.definitionSnapshotHash;
    completion.finalState = success ? (result?.finalState ?? result?.outputs ?? result?.result ?? {}) : {};
    completion.checkpointRef = result?.checkpointRef ?? null;
    completion.approvalRef = result?.approvalRef ?? null;
    completion.terminalState = String(result?.terminalState ?? (success ? "SUCCESS" : "FAILED"));
  }
  const completedRun = await authorizedJson(completionUrl, completion, tokenProvider, fetchImpl);
  onProgress?.({
    stream: "workflow",
    text: engineExecution
      ? `Workflow engine state ${completion.terminalState}`
      : `Workflow runner ${success ? "completed" : "failed"}`,
  });
  if (!success) throw new Error(completion.errorMessage);
  return {
    adapter: "workflow-runtime-http",
    executed: true,
    receiptOnly: false,
    status: "completed",
    workflowRunId: payload.runId ?? null,
    workflowExecutionId: payload.workflowExecutionId ?? null,
    workflowRunnerId: payload.workflowRunnerId,
    leaseFence: Number(payload.leaseFence),
    terminalState: engineExecution ? completion.terminalState : "SUCCESS",
    checkpointRef: engineExecution ? completion.checkpointRef : null,
    approvalRef: engineExecution ? completion.approvalRef : null,
    waitingUntil: engineExecution ? completion.waitingUntil : null,
    artifact: result?.outputs ?? result?.result ?? {},
    completion: completedRun,
  };
}

export {
  WORKFLOW_ENGINE_ACTION,
  WORKFLOW_ENGINE_KILL_ACTION,
  WORKFLOW_ENGINE_PROTOCOL,
  WORKFLOW_RUNNER_ACTION,
  WORKFLOW_RUNNER_PROTOCOL,
  executeWorkflowRuntimeCommand,
  forwardWorkflowEngineEventsOnce,
  loopbackUrl,
  probeWorkflowRuntime,
  supportsWorkflowRuntimeAction,
  validateWorkflowRuntime,
  workflowRunnerMetadata,
  workflowRuntimeConfig,
};
