#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildOpenClawAgentArgs,
  buildOpenClawPrompt,
  executeRuntimeCommand,
  validateRuntimeAdapter,
} from "./swarm-runtime-adapters.mjs";
import {
  CommandOutcomeJournal,
  RUNTIME_OUTCOME_SCHEMA,
  commandBinding,
} from "./swarm-command-journal.mjs";
import {
  credentialsFromSecureStorage,
  expandPath,
  keychainRead,
  loginWithCredentials,
  persistAuthentication,
  readTokenFile,
} from "./swarm-auth.mjs";
import {
  hydrateRuntimeGrayMatterContext,
  persistCommandReceipt,
  persistWorkflowHandoff,
  replayQueuedReceipts,
} from "./swarm-graymatter.mjs";
import {
  executeWorkflowRuntimeCommand,
  forwardWorkflowEngineEventsOnce,
  probeWorkflowRuntime,
  supportsWorkflowRuntimeAction,
  validateWorkflowRuntime,
  workflowRunnerMetadata,
} from "./swarm-workflow-runtime.mjs";
import {
  DEFAULT_RECOVERY_ROOT,
  SERVICE_RESTART_ACTION,
  SERVICE_STATUS_ACTION,
  buildServiceLifecycleState,
  executeServiceLifecycleCommand,
  readPendingRecoveries,
  removePendingRecovery,
  serviceLifecycleAdvertisement,
} from "./swarm-service-lifecycle.mjs";
import {
  constrainNodeAdvertisement,
  modelOnlyActionAllowed,
  nodeClass,
  validateNodeContract,
} from "./swarm-node-contract.mjs";
import { probeLocalInferenceProvider } from "./swarm-local-inference-provider.mjs";

const PROTECTED_ACTIONS = new Set([
  "outbound.send",
  "production.deploy",
  "merge",
  SERVICE_RESTART_ACTION,
]);
const DEFAULT_DURATION_SECONDS = 72 * 60 * 60;
const PACKAGE_VERSION = "0.4.3";
const MAX_COMMAND_BODY_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 160;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const CANONICAL_APPROVAL_REF = /^gm_approval_[0-9a-f]{64}$/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const TERMINAL_OUTCOME_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "WAITING_APPROVAL",
  "OUTCOME_UNCERTAIN",
]);

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-agent.mjs --config <json> [options]

Runs the approval-safe SWARM runtime bridge for one tenant agent host.

Options:
  --config <path>              Machine/agent registry JSON (required)
  --token <jwt>                JWT; prefer VALKYR_AUTH_TOKEN or API0_JWT_SESSION
  --url <ws-url>               Override config.serverUrl
  --duration-seconds <n>       Default 259200 (72 hours)
  --continuous                 Run until SIGINT/SIGTERM; used by OS supervision
  --heartbeat-seconds <n>      Override config heartbeat interval
  --receipt-log <path>         Append redacted JSONL SWARM evidence
  --keychain-service <name>    macOS token service (default VALKYR_AUTH)
  --token-file <path>          Non-macOS mode-0600 session file
  --credential-file <path>     Mode-0600 credentials for session refresh
  --self-test                  Run protocol/guardrail checks without a server
  -h, --help                   Show this help

Agents execute through productized Codex, Claude Code, OpenClaw, or ValorIDE
runtime adapters and stream progress plus terminal receipts over SWARM. Explicit
receipt-only agents never execute. outbound.send, production.deploy, merge, and supervised service restart
are accepted only with an exact content-bound human approval reference from the
authenticated mothership and an explicitly advertised capability.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (arg === "--continuous") {
      options.continuous = true;
      continue;
    }
    if (!["--config", "--token", "--url", "--duration-seconds", "--heartbeat-seconds", "--receipt-log", "--keychain-service", "--token-file", "--credential-file"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    i += 1;
  }
  return options;
}

function readKeychainToken(service) {
  // Authentication is persisted under the deterministic `default` account.
  // Selecting by service alone is ambiguous when an older username-scoped
  // item exists and can reconnect the daemon as the wrong tenant principal.
  return keychainRead(service, "default");
}

function createTokenProvider(
  {
    apiBase,
    configuredToken,
    credentialFile,
    keychainService,
    tokenFile,
  },
  {
    credentialReader = credentialsFromSecureStorage,
    fileReader = readTokenFile,
    keychainReader = readKeychainToken,
    login = loginWithCredentials,
    persist = persistAuthentication,
  } = {},
) {
  let initialToken = configuredToken;
  return async ({ forceRefresh = false } = {}) => {
    if (!forceRefresh) {
      if (initialToken) return initialToken;
      const storedToken = keychainReader(keychainService) ?? fileReader(tokenFile);
      if (storedToken) return storedToken;
    }
    const credentials = credentialReader({ keychainService, credentialFile });
    if (!credentials?.username || !credentials?.password) {
      if (forceRefresh) throw new Error("Authentication expired and no reusable username/password is available");
      return null;
    }
    const token = await login({ ...credentials, apiBase });
    persist({ token, ...credentials, keychainService, tokenFile, credentialFile });
    initialToken = null;
    return token;
  };
}

function redactedText(value, limit = 2_000) {
  return String(value ?? "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(
      /(password|secret|token|authorization|api.?key)(\s*[=:]\s*)([^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .slice(0, limit);
}

function commandDestinations(agentId) {
  return [{
    destination: `/queue/agents/${agentId}/commands`,
    id: `private-${agentId}`,
  }];
}

function controlReplyDestination(agentId) {
  return {
    destination: "/user/queue/swarm-control",
    id: `server-control-${safeIdentifier(agentId, "agentId")}`,
  };
}

function parseServerControlReply(body) {
  try {
    const outer = JSON.parse(String(body ?? ""));
    const envelope = typeof outer?.payload === "string"
      ? JSON.parse(outer.payload)
      : outer?.payload;
    if (!envelope || !["ack", "nack"].includes(String(envelope.topic ?? "").toLowerCase())) return null;
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const ackId = String(payload.ackId ?? payload.commandId ?? "").trim();
    if (!ackId || ackId.length > MAX_IDENTIFIER_LENGTH || !SAFE_IDENTIFIER.test(ackId)) return null;
    return {
      topic: String(envelope.topic).toLowerCase(),
      ackId,
      status: String(payload.status ?? "").toLowerCase(),
      data: payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? payload.data : {},
      code: payload.code ? redactedText(payload.code, 120) : null,
      error: payload.error || payload.reason ? redactedText(payload.error ?? payload.reason, 240) : null,
    };
  } catch {
    return null;
  }
}

function redactedError(error) {
  // SwarmCommandResponse.rejectionCode is generated as varchar(255).
  return redactedText(error instanceof Error ? error.message : String(error), 240);
}

function normalizeWebSocketUrl(value) {
  if (!value) throw new Error("Missing serverUrl/--url");
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`Unsupported SWARM URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SWARM URL must not contain credentials, query parameters, or fragments");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  if (!path.endsWith("/swarm")) path = `${path}/swarm`;
  url.pathname = path.replace(/\/+/g, "/");
  return url.toString();
}

function safeIdentifier(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH || !SAFE_IDENTIFIER.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function stompFrame(command, headers = {}, body = "") {
  const encodedBody = String(body);
  const lines = [command];
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      lines.push(`${key}:${String(value).replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(":", "\\c")}`);
    }
  }
  if (encodedBody) lines.push(`content-length:${Buffer.byteLength(encodedBody, "utf8")}`);
  return `${lines.join("\n")}\n\n${encodedBody}\0`;
}

function parseStompFrame(raw) {
  const frame = String(raw).replace(/^\n+/, "");
  const separator = frame.indexOf("\n\n");
  const head = separator >= 0 ? frame.slice(0, separator) : frame;
  const body = separator >= 0 ? frame.slice(separator + 2).replace(/\0$/, "") : "";
  const lines = head.split("\n");
  const command = lines.shift() ?? "";
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return { command, headers, body };
}

function parseWireCommand(body) {
  const outer = JSON.parse(body);
  const payload = typeof outer.payload === "string" ? JSON.parse(outer.payload) : outer.payload ?? outer;
  const command = payload.command ?? payload.message ?? payload;
  return {
    action: command.action ?? command.payload?.action ?? command.type ?? "unknown",
    command,
    commandId: payload.commandId ?? command.commandId ?? command.id,
    targetInstanceId: payload.targetInstanceId ?? command.targetInstanceId ?? command.to?.instanceId,
    trace: payload.trace ?? command.trace ?? {},
  };
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("SWARM config must be an object");
  safeIdentifier(config.machineId, "machineId");
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("SWARM config requires at least one agent");
  }
  const seen = new Set();
  for (const agent of config.agents) {
    if (!agent.agentId || !agent.runtime) throw new Error("Each pilot agent requires agentId and runtime");
    safeIdentifier(agent.agentId, "agentId");
    safeIdentifier(agent.runtime, "runtime");
    if (seen.has(agent.agentId)) throw new Error(`Duplicate pilot agentId: ${agent.agentId}`);
    seen.add(agent.agentId);
    if (!Array.isArray(agent.capabilities) || agent.capabilities.length === 0) {
      throw new Error(`SWARM agent ${agent.agentId} requires capabilities`);
    }
    for (const capability of agent.capabilities) safeIdentifier(capability, `capability for ${agent.agentId}`);
    validateNodeContract(agent);
    validateRuntimeAdapter(agent);
    validateWorkflowRuntime(agent);
    const capacity = Number(agent.capacity ?? 1);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) {
      throw new Error(`SWARM agent ${agent.agentId} capacity must be an integer from 1 to 100`);
    }
  }
}

function commandDisposition(wire, agent, workflowRuntimeState = agent?.workflowRuntimeState) {
  if (!wire.targetInstanceId) return { disposition: "ignore", reason: "missing_target_instance_id" };
  if (wire.targetInstanceId !== agent.agentId) return { disposition: "ignore", reason: "target_mismatch" };
  const action = String(wire.action ?? "").trim();
  if (nodeClass(agent) === "model-only" && !modelOnlyActionAllowed(action)) {
    return { disposition: "reject", protectedAction: false, reason: "model_only_action_not_allowed" };
  }
  if (PROTECTED_ACTIONS.has(action.toLowerCase())) {
    const approvalRef = String(wire.command?.approvalRef ?? "").trim();
    if (!CANONICAL_APPROVAL_REF.test(approvalRef) || wire.command?.requiresApproval !== true) {
      return { disposition: "reject", protectedAction: true, reason: "protected_action_requires_canonical_human_approval" };
    }
  }
  const advertised = constrainNodeAdvertisement(
    agent,
    workflowRunnerMetadata(agent, workflowRuntimeState),
  );
  const lifecycle = serviceLifecycleAdvertisement(agent, agent?.serviceLifecycleState);
  const supported = new Set([
    ...(advertised.capabilities ?? []),
    ...(advertised.supportedTools ?? []),
    ...(lifecycle.capabilities ?? []),
  ]);
  if (!supported.has(action)) {
    return { disposition: "reject", protectedAction: false, reason: "action_not_advertised_by_agent" };
  }
  return {
    disposition: "accept",
    protectedAction: PROTECTED_ACTIONS.has(action.toLowerCase()),
    approvalRef: wire.command?.approvalRef ?? null,
  };
}

function workflowEngineLifecycleResponse(event, context = {}) {
  const eventType = String(event?.eventType ?? "UNKNOWN").toUpperCase();
  const terminal = ["SUCCESS", "FAILED", "CANCELLED"].includes(eventType);
  const failed = ["FAILED", "CANCELLED"].includes(eventType);
  const checkpoint = eventType === "CHECKPOINT";
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const executionState = String(payload.terminalState ?? payload.state ?? eventType).toUpperCase();
  return {
    type: failed ? "NACK" : "ACK",
    status: terminal ? (failed ? "failed" : "completed") : "progress",
    reason: failed ? redactedText(payload.errorMessage ?? executionState) : null,
    result: {
      adapter: "workflow-engine-event-replay",
      executed: terminal,
      receiptOnly: false,
      sequence: Number(event?.id ?? 0),
      stream: "workflow",
      eventType,
      executionState,
      checkpoint,
      workflowExecutionId: String(event?.executionId ?? context.executionId ?? ""),
      workflowRunnerId: event?.workflowRunnerId ?? context.workflowRunnerId ?? null,
      leaseFence: event?.leaseFence ?? context.leaseFence ?? null,
      checkpointRef: payload.checkpointRef ?? null,
      artifact: payload,
    },
  };
}

function runtimeTerminalResponse(result, wire = null) {
  let boundedResult = result && typeof result === "object" ? result : {};
  if (wire) {
    const binding = commandBinding(wire);
    const candidate = boundedResult.outcome;
    const status = String(candidate?.status ?? "");
    const hasSuccessEvidence = status !== "SUCCEEDED"
      || (Array.isArray(candidate?.evidenceRefs)
        && candidate.evidenceRefs.some((item) => typeof item === "string" && item.trim()))
      || (Array.isArray(candidate?.evidence) && candidate.evidence.length > 0)
      || (typeof candidate?.outcomeHash === "string"
        && /^(?:sha256:)?[0-9a-f]{64}$/i.test(candidate.outcomeHash));
    const bindingMatches = candidate?.schemaVersion === RUNTIME_OUTCOME_SCHEMA
      && TERMINAL_OUTCOME_STATUSES.has(status)
      && hasSuccessEvidence
      && candidate?.commandId === binding.commandId
      && candidate?.actionDigest === binding.actionDigest
      && (candidate?.targetInstanceId ?? null) === binding.targetInstanceId
      && candidate?.scopeDigest === binding.scopeDigest
      && (!candidate?.approvalRef || candidate.approvalRef === binding.approvalRef);
    if (!bindingMatches) {
      const outcome = governedOutcome(wire, {
        status: "OUTCOME_UNCERTAIN",
        summary: "The runtime result was missing or mismatched the dispatched terminal outcome binding",
        source: "runtime-envelope",
        confidence: "UNRESOLVED",
        retryable: false,
      });
      boundedResult = {
        ...boundedResult,
        executed: false,
        actionDigest: outcome.actionDigest,
        scopeDigest: outcome.scopeDigest,
        outcome,
      };
    }
  }
  const outcomeStatus = String(boundedResult?.outcome?.status ?? "OUTCOME_UNCERTAIN").toUpperCase();
  const resultWithCheckpoint = outcomeStatus === "WAITING_APPROVAL"
    ? {
        ...boundedResult,
        executed: false,
        checkpoint: true,
        executionState: "WAITING_APPROVAL",
      }
    : boundedResult;
  if (outcomeStatus === "SUCCEEDED") {
    return { type: "ACK", status: "completed", result: resultWithCheckpoint };
  }
  if (outcomeStatus === "WAITING_APPROVAL") {
    return { type: "ACK", status: "progress", result: resultWithCheckpoint };
  }
  if (outcomeStatus === "BLOCKED") {
    return {
      type: "NACK",
      status: "blocked",
      reason: redactedText(result?.outcome?.summary ?? "Runtime reported a blocked outcome"),
      result: resultWithCheckpoint,
    };
  }
  return {
    type: "NACK",
    status: "failed",
    reason: redactedText(result?.outcome?.summary ?? "Runtime outcome could not be proven"),
    result: resultWithCheckpoint,
  };
}

function journalTerminalState(response) {
  const outcomeStatus = String(response?.result?.outcome?.status ?? "").toUpperCase();
  if (outcomeStatus === "WAITING_APPROVAL") return "CHECKPOINTED";
  if (outcomeStatus === "OUTCOME_UNCERTAIN") return "OUTCOME_UNCERTAIN";
  return "TERMINAL";
}

function governedOutcome(wire, {
  status,
  summary,
  source,
  confidence = "EXPLICIT",
  retryable = false,
}) {
  const binding = commandBinding(wire);
  return {
    schemaVersion: RUNTIME_OUTCOME_SCHEMA,
    status,
    commandId: binding.commandId,
    actionDigest: binding.actionDigest,
    targetInstanceId: binding.targetInstanceId,
    scopeDigest: binding.scopeDigest,
    summary: redactedText(summary),
    evidenceRefs: [],
    source,
    confidence,
    ...(binding.approvalRef ? { approvalRef: binding.approvalRef } : {}),
    retryable,
  };
}

function serviceRecoveryOutcome(wire, {
  status,
  summary,
  retryable = false,
}) {
  const outcome = governedOutcome(wire, {
    status,
    summary,
    // Keep the cross-runtime wire vocabulary canonical for api-0. The more
    // specific native proof provenance remains explicit in metadata and the
    // lifecycle result's fresh-heartbeat proof object.
    source: "runtime-envelope",
    confidence: "EXPLICIT",
    retryable,
  });
  return {
    ...outcome,
    evidenceRefs: [`swarm-service-recovery:${wire.commandId}`],
    metadata: {
      proofSource: "native-service-lifecycle",
      proofConfidence: "VERIFIED",
    },
  };
}

function journalQuarantineResponse(wire, adapter) {
  const outcome = governedOutcome(wire, {
    status: "OUTCOME_UNCERTAIN",
    summary: "A prior protected or non-idempotent execution started without durable terminal proof; the command was quarantined instead of respawned",
    source: "journal-quarantine",
    confidence: "UNRESOLVED",
    retryable: false,
  });
  return {
    type: "NACK",
    status: "failed",
    reason: "ambiguous_started_effect_quarantined",
    result: {
      adapter,
      attempted: true,
      executed: false,
      receiptOnly: false,
      actionDigest: outcome.actionDigest,
      scopeDigest: outcome.scopeDigest,
      outcome,
      journalState: "OUTCOME_UNCERTAIN",
      quarantined: true,
    },
  };
}

function adapterErrorResponse(wire, adapter, error) {
  const reason = redactedError(error);
  const outcome = governedOutcome(wire, {
    status: "FAILED",
    summary: reason,
    source: "adapter-error",
    retryable: true,
  });
  return {
    type: "NACK",
    status: "failed",
    reason,
    result: {
      adapter,
      attempted: true,
      executed: false,
      receiptOnly: false,
      actionDigest: outcome.actionDigest,
      scopeDigest: outcome.scopeDigest,
      outcome,
    },
  };
}

class EvidenceLog {
  constructor(receiptPath) {
    this.path = receiptPath ? expandPath(receiptPath) : null;
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
      if (fs.existsSync(this.path)) fs.chmodSync(this.path, 0o600);
    }
  }

  record(event, details = {}) {
    const row = { timestamp: new Date().toISOString(), event, ...details };
    const line = `${JSON.stringify(row)}\n`;
    process.stdout.write(line);
    if (this.path) fs.appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
  }
}

class SwarmAgent {
  constructor({
    agent,
    apiBase,
    machineId,
    tokenProvider,
    url,
    heartbeatSeconds,
    evidence,
    recoveryRoot = DEFAULT_RECOVERY_ROOT,
    commandJournal,
    commandJournalRoot,
    runtimeExecutor = executeRuntimeCommand,
  }) {
    this.agent = agent;
    this.apiBase = apiBase;
    this.machineId = machineId;
    this.tokenProvider = tokenProvider;
    this.url = url;
    this.heartbeatSeconds = heartbeatSeconds;
    this.evidence = evidence;
    this.websocket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = false;
    this.sequence = 0;
    this.inFlightCommands = new Map();
    this.completedCommands = new Map();
    this.pendingControlMessages = new Map();
    this.forceAuthRefresh = false;
    this.grayMatterReplayActive = false;
    this.workflowRuntimeState = { configured: Boolean(agent.workflowRuntime), healthy: false, status: "unchecked" };
    this.agent.workflowRuntimeState = this.workflowRuntimeState;
    this.workflowEngineEventCursor = 0;
    this.workflowEngineActiveExecutions = new Map();
    this.workflowEngineReplayActive = false;
    this.lastGrayMatterReplayAt = 0;
    this.recoveryRoot = recoveryRoot;
    this.runtimeExecutor = runtimeExecutor;
    this.commandJournal = commandJournal ?? (agent.execution
      ? new CommandOutcomeJournal({
          agentId: agent.agentId,
          ...(commandJournalRoot ? { root: commandJournalRoot } : {}),
        })
      : null);
    this.serviceLifecycleState = buildServiceLifecycleState({
      agent: this.agent,
      machineId: this.machineId,
    });
    this.agent.serviceLifecycleState = this.serviceLifecycleState;
  }

  async connect() {
    if (this.stopped) return;
    let token;
    try {
      token = await this.tokenProvider({ forceRefresh: this.forceAuthRefresh });
      this.forceAuthRefresh = false;
    } catch (error) {
      this.evidence.record("auth_unavailable", {
        agentId: this.agent.agentId,
        error: redactedError(error),
      });
      this.scheduleReconnect();
      return;
    }
    if (!token) {
      this.evidence.record("auth_unavailable", {
        agentId: this.agent.agentId,
        error: "No JWT is available from environment or Keychain",
      });
      this.scheduleReconnect();
      return;
    }
    const websocket = new WebSocket(this.url, ["v12.stomp"]);
    this.websocket = websocket;
    websocket.addEventListener("open", () => {
      websocket.send(stompFrame("CONNECT", {
        "accept-version": "1.2",
        host: new URL(this.url).host,
        Authorization: `Bearer ${token}`,
        "X-Agent-Instance-Id": this.agent.agentId,
        "X-Agent-Version": this.agent.version ?? `${this.agent.runtime}-valkyr-swarm`,
        "X-Agent-Capabilities": this.agent.capabilities.join(","),
        "heart-beat": "10000,10000",
      }));
    });
    websocket.addEventListener("message", (event) => this.onData(event.data));
    websocket.addEventListener("error", () => {
      if (!this.stopped) {
        this.evidence.record("socket_error", { agentId: this.agent.agentId });
      }
    });
    websocket.addEventListener("close", (event) => this.onClose(event));
  }

  onData(raw) {
    for (const rawFrame of String(raw).split("\0")) {
      if (!rawFrame.trim()) continue;
      const frame = parseStompFrame(`${rawFrame}\0`);
      if (frame.command === "CONNECTED") {
        this.onConnected();
      } else if (frame.command === "MESSAGE") {
        if (frame.headers.subscription === controlReplyDestination(this.agent.agentId).id) {
          this.onServerControlReply(frame.body);
        } else {
          this.onMessage(frame.body);
        }
      } else if (frame.command === "ERROR") {
        this.evidence.record("stomp_error", {
          agentId: this.agent.agentId,
          message: redactedError(frame.headers.message ?? "STOMP error"),
        });
        this.forceAuthRefresh = true;
        this.websocket?.close(4003, "stomp error; refresh authentication");
      }
    }
  }

  onConnected() {
    this.reconnectAttempt = 0;
    for (const { destination, id } of commandDestinations(this.agent.agentId)) {
      this.subscribe(destination, id);
    }
    const controlReply = controlReplyDestination(this.agent.agentId);
    this.subscribe(controlReply.destination, controlReply.id);
    void this.refreshWorkflowRuntime().then(() => {
      this.refreshServiceLifecycle();
      this.sendRegistration();
      this.startHeartbeat();
      void this.reconcilePendingServiceRecoveries();
      void this.replayWorkflowEngineEvents();
    });
    void this.replayGrayMatterReceipts(true);
    this.evidence.record("connected", {
      agentId: this.agent.agentId,
      machineId: this.machineId,
      runtime: this.agent.runtime,
    });
  }

  subscribe(destination, id) {
    this.websocket.send(stompFrame("SUBSCRIBE", {
      id,
      destination,
      ack: "auto",
      "X-Agent-Instance-Id": this.agent.agentId,
    }));
  }

  publish(destination, value) {
    if (this.websocket?.readyState !== WebSocket.OPEN) return;
    this.websocket.send(stompFrame("SEND", {
      destination,
      // Existing @MessageMapping endpoints intentionally accept raw strings
      // and parse them with the shared controller ObjectMapper.
      "content-type": "text/plain;charset=UTF-8",
      "X-Agent-Instance-Id": this.agent.agentId,
    }, JSON.stringify(value)));
  }

  swarmMessage(action, data) {
    return {
      id: crypto.randomUUID(),
      type: "event",
      from: { instanceId: this.agent.agentId, type: "agent" },
      to: { instanceId: "api-0", type: "server" },
      timestamp: new Date().toISOString(),
      payload: { action, data },
      ttl: 120000,
      priority: action === "register" ? "high" : "normal",
    };
  }

  sendAppTopic(topic, payload) {
    const envelope = {
      topic,
      payload,
      senderId: this.agent.agentId,
      messageId: crypto.randomUUID(),
      sequence: ++this.sequence,
      timestamp: Date.now(),
    };
    this.publish(topic === "swarm" ? "/app/swarm/control" : "/app/chat", {
      id: crypto.randomUUID(),
      type: "broadcast",
      payload: JSON.stringify(envelope),
      time: new Date().toISOString(),
    });
  }

  workspaceAdvertisement() {
    const workspace = String(this.agent.execution?.workingDirectory ?? "").trim();
    const workspaceFolders = workspace ? [workspace] : [];
    return {
      workspaceFolders,
      workspaceSummary: {
        folderCount: workspaceFolders.length,
        folders: workspaceFolders,
      },
    };
  }

  sendRegistration() {
    const runner = constrainNodeAdvertisement(
      this.agent,
      workflowRunnerMetadata(this.agent, this.workflowRuntimeState),
    );
    const lifecycle = serviceLifecycleAdvertisement(
      { ...this.agent, capabilities: runner.capabilities },
      this.serviceLifecycleState,
    );
    const workflowRuntimeReady = (runner.supportedTools ?? []).some((tool) =>
      tool === "workflow.runner.execute-module" || tool === "workflow.engine.execute-workflow");
    this.sendControlMessage("register", {
      announcement: {
        agentId: this.agent.agentId,
        runtime: this.agent.runtime,
        machineId: this.machineId,
        status: "healthy",
        capacity: Number(this.agent.capacity ?? 1),
        ...runner,
        capabilities: lifecycle.capabilities,
        serviceLifecycle: lifecycle.serviceLifecycle,
        approvalPolicy: "human-approval-required",
        executionAdapter: workflowRuntimeReady ? "workflow-runtime-http" : (this.agent.execution?.adapter ?? "receipt-only"),
        receiptOnly: !this.agent.execution && !workflowRuntimeReady,
        ...this.workspaceAdvertisement(),
        version: this.agent.version ?? `valkyr-swarm/${PACKAGE_VERSION}`,
      },
    });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat()
        .then(() => this.reconcilePendingServiceRecoveries());
    }, this.heartbeatSeconds * 1000);
  }

  async refreshWorkflowRuntime() {
    this.workflowRuntimeState = await probeWorkflowRuntime(this.agent);
    if (nodeClass(this.agent) === "model-only") {
      const providerState = await probeLocalInferenceProvider(
        this.agent.nodeContract.localInferenceProvider,
      );
      this.agent.localInferenceProviderState = providerState;
      if (!providerState.healthy) {
        this.workflowRuntimeState = {
          ...this.workflowRuntimeState,
          healthy: false,
          status: `local_inference_${providerState.status}`,
          capabilities: [],
          supportedTools: [],
        };
      }
      this.evidence.record("local_inference_provider_probe", {
        agentId: this.agent.agentId,
        kind: this.agent.nodeContract.localInferenceProvider.kind,
        model: this.agent.nodeContract.localInferenceProvider.model,
        healthy: providerState.healthy,
        status: providerState.status,
      });
    }
    this.agent.workflowRuntimeState = this.workflowRuntimeState;
    this.evidence.record("workflow_runtime_probe", {
      agentId: this.agent.agentId,
      configured: this.workflowRuntimeState.configured,
      healthy: this.workflowRuntimeState.healthy,
      status: this.workflowRuntimeState.status,
      version: this.workflowRuntimeState.version ?? null,
    });
  }

  refreshServiceLifecycle() {
    this.serviceLifecycleState = buildServiceLifecycleState({
      agent: this.agent,
      machineId: this.machineId,
    });
    this.agent.serviceLifecycleState = this.serviceLifecycleState;
    this.evidence.record("service_lifecycle_probe", {
      agentId: this.agent.agentId,
      handles: this.serviceLifecycleState.metadata.services
        .filter((service) => service.installed)
        .map((service) => service.handle),
      restartableHandles: this.serviceLifecycleState.metadata.services
        .filter((service) => service.restartable)
        .map((service) => service.handle),
    });
    return this.serviceLifecycleState;
  }

  async sendHeartbeat({ awaitAck = false } = {}) {
    await this.refreshWorkflowRuntime();
    this.refreshServiceLifecycle();
    const runner = constrainNodeAdvertisement(
      this.agent,
      workflowRunnerMetadata(this.agent, this.workflowRuntimeState),
    );
    const lifecycle = serviceLifecycleAdvertisement(
      { ...this.agent, capabilities: runner.capabilities },
      this.serviceLifecycleState,
    );
    const workflowRuntimeReady = (runner.supportedTools ?? []).some((tool) =>
      tool === "workflow.runner.execute-module" || tool === "workflow.engine.execute-workflow");
    const heartbeat = this.sendControlMessage("heartbeat", {
      instanceId: this.agent.agentId,
      agentId: this.agent.agentId,
      runtime: this.agent.runtime,
      machineId: this.machineId,
      status: "healthy",
      capacity: Number(this.agent.capacity ?? 1),
      activeTasks: this.inFlightCommands.size,
      ...runner,
      capabilities: lifecycle.capabilities,
      serviceLifecycle: lifecycle.serviceLifecycle,
      executionAdapter: workflowRuntimeReady ? "workflow-runtime-http" : (this.agent.execution?.adapter ?? "receipt-only"),
      receiptOnly: !this.agent.execution && !workflowRuntimeReady,
      ...this.workspaceAdvertisement(),
    }, { awaitAck });
    this.evidence.record("heartbeat_sent", { agentId: this.agent.agentId, machineId: this.machineId });
    void this.replayGrayMatterReceipts(false);
    void this.replayWorkflowEngineEvents();
    return heartbeat;
  }

  async replayWorkflowEngineEvents() {
    if (this.workflowEngineReplayActive
        || this.workflowRuntimeState?.healthy !== true
        || this.workflowRuntimeState?.supportedTools?.includes("workflow.engine.execute-workflow") !== true) {
      return;
    }
    this.workflowEngineReplayActive = true;
    try {
      const replay = await forwardWorkflowEngineEventsOnce({
        agent: this.agent,
        apiBase: this.apiBase,
        tokenProvider: this.tokenProvider,
        after: this.workflowEngineEventCursor,
        activeExecutions: this.workflowEngineActiveExecutions,
        onProgress: (progress) => this.evidence.record("workflow_engine_event_replayed", {
          agentId: this.agent.agentId,
          detail: redactedText(progress.text),
        }),
        onDiscarded: ({ event, context, error }) =>
          this.evidence.record("workflow_engine_event_fenced", {
            agentId: this.agent.agentId,
            executionId: String(
              event?.executionId ?? context?.executionId ?? "unknown"),
            eventId: Number(event?.id ?? 0),
            code: error?.code ?? "WORKFLOW_ENGINE_CALLBACK_FENCED",
          }),
        onLocalOnly: ({ event }) =>
          this.evidence.record("workflow_engine_event_local_only", {
            agentId: this.agent.agentId,
            executionId: String(event?.executionId ?? "unknown"),
            eventId: Number(event?.id ?? 0),
            eventType: String(event?.eventType ?? "UNKNOWN").toUpperCase(),
          }),
        onEvent: async ({ event, context, terminal, checkpoint }) => {
          const eventType = String(event?.eventType ?? "UNKNOWN").toUpperCase();
          const executionId = String(event?.executionId ?? "unknown");
          const eventId = Number(event?.id ?? 0);
          const correlatedCommandId = typeof context?.commandId === "string"
              && SAFE_IDENTIFIER.test(context.commandId)
              && context.commandId.length <= MAX_IDENTIFIER_LENGTH
            ? context.commandId
            : `workflow-engine-${executionId}-${eventId}`.slice(0, MAX_IDENTIFIER_LENGTH);
          const wire = {
            action: "workflow.engine.execute-workflow",
            commandId: correlatedCommandId,
            trace: { traceId: context?.traceId ?? `workflow-execution:${executionId}` },
            command: {
              payload: {
                workflowExecutionId: executionId,
                workflowRunnerId: event?.workflowRunnerId ?? this.agent.agentId,
                leaseFence: event?.leaseFence ?? null,
              },
            },
          };
          const lifecycle = workflowEngineLifecycleResponse(event, context);
          const prior = this.completedCommands.get(correlatedCommandId);
          const duplicateTerminal = terminal && prior?.status === lifecycle.status;
          if (terminal || checkpoint) {
            const handoff = await persistWorkflowHandoff({
              agent: this.agent,
              apiBase: this.apiBase,
              tokenProvider: this.tokenProvider,
              wire,
              response: lifecycle,
            });
            lifecycle.result.grayMatterHandoffRef = handoff?.id ? `MemoryEntry:${handoff.id}` : null;
            lifecycle.result.grayMatterHandoffStatus = handoff?.queued ? "queued" : "persisted";
          }
          if (!duplicateTerminal) {
            if (terminal || checkpoint) {
              const memoryReceipt = await this.persistTerminalReceipt(wire, lifecycle);
              lifecycle.result.grayMatterReceiptRef = memoryReceipt.id
                ? `MemoryEntry:${memoryReceipt.id}` : null;
              lifecycle.result.grayMatterReceiptStatus = memoryReceipt.status;
            }
            this.rememberCompleted(correlatedCommandId, lifecycle);
            this.sendCommandResponse(wire, lifecycle);
          }
          this.evidence.record("workflow_engine_lifecycle_forwarded", {
            agentId: this.agent.agentId,
            commandId: correlatedCommandId,
            executionId,
            eventId,
            eventType,
            status: lifecycle.status,
            duplicateTerminal,
          });
        },
      });
      this.workflowEngineEventCursor = replay.next;
      this.workflowEngineActiveExecutions = replay.activeExecutions;
    } catch (error) {
      this.evidence.record("workflow_engine_event_replay_deferred", {
        agentId: this.agent.agentId,
        after: this.workflowEngineEventCursor,
        error: redactedError(error),
      });
    } finally {
      this.workflowEngineReplayActive = false;
    }
  }

  sendControlMessage(action, data, { awaitAck = false, timeoutMs = 15_000 } = {}) {
    const message = this.swarmMessage(action, data);
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, pending] of this.pendingControlMessages) {
      if (pending.sentAt < cutoff) {
        clearTimeout(pending.timer);
        pending.reject?.(new Error(`SWARM ${pending.action} acknowledgement timed out`));
        this.pendingControlMessages.delete(id);
      }
    }
    if (!awaitAck) {
      this.pendingControlMessages.set(message.id, { action, sentAt: Date.now() });
      this.sendAppTopic("swarm", message);
      return message.id;
    }
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControlMessages.delete(message.id);
        reject(new Error(`SWARM ${action} acknowledgement timed out`));
      }, timeoutMs);
      this.pendingControlMessages.set(message.id, {
        action,
        reject,
        resolve,
        sentAt: Date.now(),
        timer,
      });
    });
    this.sendAppTopic("swarm", message);
    return promise;
  }

  onServerControlReply(body) {
    const reply = parseServerControlReply(body);
    if (!reply) return;
    const pending = this.pendingControlMessages.get(reply.ackId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControlMessages.delete(reply.ackId);
    const accepted = reply.topic === "ack" && reply.status !== "rejected";
    this.evidence.record(`${pending.action}_${accepted ? "ack" : "nack"}`, {
      agentId: this.agent.agentId,
      messageId: reply.ackId,
      status: reply.status || (accepted ? "ok" : "rejected"),
      instanceId: reply.data.instanceId ?? null,
      lastSeen: reply.data.lastSeen ?? null,
      code: reply.code,
      error: reply.error,
    });
    if (accepted) pending.resolve?.(reply);
    else pending.reject?.(new Error(reply.error ?? reply.code ?? `${pending.action} rejected`));
  }

  async replayGrayMatterReceipts(force) {
    const now = Date.now();
    if (this.grayMatterReplayActive || (!force && now - this.lastGrayMatterReplayAt < 5 * 60 * 1000)) return;
    this.grayMatterReplayActive = true;
    this.lastGrayMatterReplayAt = now;
    try {
      const results = await replayQueuedReceipts({
        agentId: this.agent.agentId,
        apiBase: this.apiBase,
        tokenProvider: this.tokenProvider,
      });
      for (const result of results) {
        this.evidence.record(
          result.status === "persisted" ? "graymatter_receipt_replayed" : "graymatter_receipt_replay_deferred",
          {
            agentId: this.agent.agentId,
            memoryEntryId: result.id ?? null,
            error: result.error ? redactedError(result.error) : null,
          },
        );
      }
    } catch (error) {
      this.evidence.record("graymatter_receipt_replay_deferred", {
        agentId: this.agent.agentId,
        error: redactedError(error),
      });
    } finally {
      this.grayMatterReplayActive = false;
    }
  }

  sendCommandResponse(wire, { type, status, reason, result }) {
    const response = {
      type,
      ackId: wire.commandId,
      commandId: wire.commandId,
      workerId: this.agent.agentId,
      instanceId: this.agent.agentId,
      status,
      reason,
      trace: wire.trace,
      result,
    };
    this.publish("/app/command", {
      id: crypto.randomUUID(),
      type: "command",
      payload: JSON.stringify(response),
      time: new Date().toISOString(),
    });
    return response;
  }

  async persistTerminalReceipt(wire, response) {
    try {
      const memory = await persistCommandReceipt({
        agent: this.agent,
        apiBase: this.apiBase,
        tokenProvider: this.tokenProvider,
        wire,
        response,
      });
      const status = memory?.queued ? "queued" : "persisted";
      this.evidence.record(memory?.queued ? "graymatter_receipt_queued" : "graymatter_receipt_persisted", {
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        memoryEntryId: memory?.id ?? null,
        error: memory?.error ? redactedError(memory.error) : null,
        status: response.status,
      });
      return { id: memory?.id ?? null, status };
    } catch (error) {
      this.evidence.record("graymatter_receipt_degraded", {
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        error: redactedError(error),
        status: response.status,
      });
      return { id: null, status: "degraded" };
    }
  }

  async verifyServiceRecovery(binding, notBefore = Date.now()) {
    const deadline = Date.now() + 60_000;
    let publicService = null;
    while (Date.now() < deadline) {
      this.refreshServiceLifecycle();
      publicService = this.serviceLifecycleState.services
        .find(({ binding: candidate }) => candidate.handle === binding.handle)?.public ?? null;
      if (binding.handle === "workflow-engine" || binding.handle === "workflow-runner") {
        await this.refreshWorkflowRuntime();
        if (publicService?.running && this.workflowRuntimeState?.healthy === true) break;
      } else if (publicService?.running
          && this.websocket?.readyState === WebSocket.OPEN) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const runtimeHealthy = binding.handle === "workflow-engine" || binding.handle === "workflow-runner"
      ? this.workflowRuntimeState?.healthy === true
      : this.websocket?.readyState === WebSocket.OPEN;
    if (!publicService?.running || !runtimeHealthy) {
      throw new Error(`Service ${binding.handle} did not become healthy after restart`);
    }
    const heartbeatAck = await this.sendHeartbeat({ awaitAck: true });
    const heartbeatAt = Date.parse(String(heartbeatAck?.data?.lastSeen ?? ""));
    const heartbeatFresh = Number.isFinite(heartbeatAt) && heartbeatAt >= notBefore - 5_000;
    if (!heartbeatFresh) {
      throw new Error(`Service ${binding.handle} heartbeat was not fresh after restart`);
    }
    const runner = workflowRunnerMetadata(this.agent, this.workflowRuntimeState);
    const lifecycle = serviceLifecycleAdvertisement(
      { ...this.agent, capabilities: runner.capabilities },
      this.serviceLifecycleState,
    );
    return {
      capabilities: lifecycle.capabilities,
      expectedAgentId: binding.agentId,
      handle: binding.handle,
      healthy: true,
      heartbeatAt: new Date(heartbeatAt).toISOString(),
      heartbeatFresh: true,
      supervisorRunning: true,
      version: binding.handle === "workflow-engine" || binding.handle === "workflow-runner"
        ? this.workflowRuntimeState?.version ?? null
        : this.agent.version ?? `valkyr-swarm/${PACKAGE_VERSION}`,
    };
  }

  async reconcilePendingServiceRecoveries() {
    const pending = readPendingRecoveries({
      agentId: this.agent.agentId,
      recoveryRoot: this.recoveryRoot,
    });
    for (const item of pending) {
      const createdAt = Date.parse(item.record.createdAt);
      const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
      const resolved = this.serviceLifecycleState.bindings
        .find((candidate) => candidate.handle === item.record.serviceHandle);
      const wire = {
        action: SERVICE_RESTART_ACTION,
        command: {
          action: SERVICE_RESTART_ACTION,
          approvalRef: item.record.approvalRef,
          payload: {
            expectedMachineId: item.record.expectedMachineId,
            serviceHandle: item.record.serviceHandle,
          },
          requiresApproval: true,
        },
        commandId: item.record.commandId,
        targetInstanceId: item.record.targetInstanceId,
        trace: item.record.traceId ? { traceId: item.record.traceId } : {},
      };
      try {
        if (!resolved) {
          throw new Error(`Service ${item.record.serviceHandle} is no longer configured`);
        }
        const proof = await this.verifyServiceRecovery(
          resolved,
          Number.isFinite(createdAt) ? createdAt : Date.now(),
        );
        const completed = {
          type: "ACK",
          status: "completed",
          result: {
            adapter: "native-service-lifecycle",
            executed: true,
            pendingRecovery: false,
            receiptOnly: false,
            serviceHandle: resolved.handle,
            supervisor: resolved.supervisor,
            proof,
            outcome: serviceRecoveryOutcome(wire, {
              status: "SUCCEEDED",
              summary: `Supervised ${resolved.handle} restart completed with fresh heartbeat proof`,
            }),
          },
        };
        const memoryReceipt = await this.persistTerminalReceipt(wire, completed);
        completed.result.grayMatterReceiptRef = memoryReceipt.id
          ? `MemoryEntry:${memoryReceipt.id}` : null;
        completed.result.grayMatterReceiptStatus = memoryReceipt.status;
        this.rememberCompleted(wire.commandId, completed);
        this.sendCommandResponse(wire, completed);
        removePendingRecovery(item.path, this.recoveryRoot);
        this.evidence.record("service_recovery_reconciled", {
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          serviceHandle: resolved.handle,
          heartbeatAt: proof.heartbeatAt,
        });
      } catch (error) {
        if (ageMs < 120_000) {
          this.evidence.record("service_recovery_pending", {
            agentId: this.agent.agentId,
            commandId: wire.commandId,
            error: redactedError(error),
            serviceHandle: item.record.serviceHandle,
          });
          continue;
        }
        const failed = {
          type: "NACK",
          status: "failed",
          reason: redactedError(error),
          result: {
            adapter: "native-service-lifecycle",
            executed: false,
            pendingRecovery: false,
            receiptOnly: false,
            serviceHandle: item.record.serviceHandle,
            outcome: serviceRecoveryOutcome(wire, {
              status: "FAILED",
              summary: redactedError(error),
              retryable: true,
            }),
          },
        };
        const memoryReceipt = await this.persistTerminalReceipt(wire, failed);
        failed.result.grayMatterReceiptRef = memoryReceipt.id
          ? `MemoryEntry:${memoryReceipt.id}` : null;
        failed.result.grayMatterReceiptStatus = memoryReceipt.status;
        this.rememberCompleted(wire.commandId, failed);
        this.sendCommandResponse(wire, failed);
        removePendingRecovery(item.path, this.recoveryRoot);
        this.evidence.record("service_recovery_failed", {
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          error: redactedError(error),
          serviceHandle: item.record.serviceHandle,
        });
      }
    }
  }

  onMessage(body) {
    if (Buffer.byteLength(String(body), "utf8") > MAX_COMMAND_BODY_BYTES) {
      this.evidence.record("command_ignored", { agentId: this.agent.agentId, reason: "command_payload_too_large" });
      return;
    }
    let wire;
    try {
      wire = parseWireCommand(body);
    } catch (error) {
      this.evidence.record("command_parse_error", {
        agentId: this.agent.agentId,
        error: redactedError(error),
      });
      return;
    }
    if (typeof wire.commandId !== "string" || !SAFE_IDENTIFIER.test(wire.commandId) || wire.commandId.length > MAX_IDENTIFIER_LENGTH) {
      this.evidence.record("command_ignored", { agentId: this.agent.agentId, reason: "invalid_command_id" });
      return;
    }

    const route = commandDisposition(wire, this.agent, this.workflowRuntimeState);
    if (route.disposition === "ignore") {
      this.evidence.record("command_ignored", {
        action: wire.action,
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        reason: route.reason,
        targetInstanceId: wire.targetInstanceId ?? null,
      });
      return;
    }

    if (route.disposition === "reject") {
      const rejected = {
        type: "NACK",
        status: "rejected",
        reason: route.reason,
        result: { executed: false, receiptOnly: true },
      };
      this.rememberCompleted(wire.commandId, rejected);
      this.sendCommandResponse(wire, rejected);
      void this.persistTerminalReceipt(wire, rejected);
      this.evidence.record("command_nacked", {
        action: wire.action,
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        executed: false,
        protectedAction: route.protectedAction,
        reason: route.reason,
        traceId: wire.trace?.traceId,
      });
      return;
    }

    const serviceLifecycle = [SERVICE_STATUS_ACTION, SERVICE_RESTART_ACTION]
      .includes(wire.action);
    const workflowRuntime = supportsWorkflowRuntimeAction(
      this.agent, this.workflowRuntimeState, wire.action);
    const ordinaryRuntime = Boolean(this.agent.execution) && !workflowRuntime && !serviceLifecycle;
    const adapter = serviceLifecycle
      ? "native-service-lifecycle"
      : workflowRuntime ? "workflow-runtime-http" : this.agent.execution?.adapter;

    if (!ordinaryRuntime) {
      const prior = this.completedCommands.get(wire.commandId);
      if (prior) {
        this.sendCommandResponse(wire, prior);
        this.evidence.record("command_replayed", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          status: prior.status,
        });
        return;
      }
      if (this.inFlightCommands.has(wire.commandId)) {
        this.sendCommandResponse(wire, {
          type: "ACK",
          status: "started",
          result: { executed: false, receiptOnly: false, reused: true },
        });
        return;
      }
    }

    if (!this.agent.execution && !workflowRuntime && !serviceLifecycle) {
      const received = {
        type: "ACK",
        status: "pilot_received",
        result: { executed: false, receiptOnly: true },
      };
      this.rememberCompleted(wire.commandId, received);
      this.sendCommandResponse(wire, received);
      void this.persistTerminalReceipt(wire, received);
      this.evidence.record("command_acked", {
        action: wire.action,
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        executed: false,
        protectedAction: false,
        traceId: wire.trace?.traceId,
      });
      return;
    }

    if (ordinaryRuntime) {
      let journalInspection;
      try {
        journalInspection = this.commandJournal.inspect(wire, {
          protectedAction: route.protectedAction,
        });
      } catch (error) {
        const failed = adapterErrorResponse(wire, adapter, error);
        failed.reason = "command_journal_unavailable";
        failed.result.outcome = governedOutcome(wire, {
          status: "FAILED",
          summary: "The node-local command journal was unavailable before execution; no runtime was spawned",
          source: "journal-quarantine",
          retryable: true,
        });
        this.sendCommandResponse(wire, failed);
        void this.persistTerminalReceipt(wire, failed);
        this.evidence.record("command_journal_failed_closed", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          error: redactedError(error),
          phase: "inspect",
        });
        return;
      }
      if (journalInspection.decision === "DIGEST_MISMATCH") {
        const rejected = {
          type: "NACK",
          status: "rejected",
          reason: "command_id_action_digest_mismatch",
          result: {
            adapter,
            executed: false,
            receiptOnly: true,
            actionDigest: journalInspection.binding.actionDigest,
            scopeDigest: journalInspection.binding.scopeDigest,
          },
        };
        this.sendCommandResponse(wire, rejected);
        void this.persistTerminalReceipt(wire, rejected);
        this.evidence.record("command_digest_mismatch_rejected", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          targetInstanceId: wire.targetInstanceId,
        });
        return;
      }
      if (this.inFlightCommands.has(wire.commandId)) {
        this.sendCommandResponse(wire, {
          type: "ACK",
          status: "started",
          result: {
            adapter,
            executed: false,
            receiptOnly: false,
            reused: true,
            actionDigest: journalInspection.binding.actionDigest,
            scopeDigest: journalInspection.binding.scopeDigest,
          },
        });
        return;
      }
      if (journalInspection.decision === "REPLAY_TERMINAL") {
        const replay = {
          ...journalInspection.response,
          result: {
            ...journalInspection.response.result,
            replayed: true,
            journalState: journalInspection.record.state,
          },
        };
        this.rememberCompleted(wire.commandId, replay);
        this.sendCommandResponse(wire, replay);
        this.evidence.record("command_journal_replayed", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          journalState: journalInspection.record.state,
          status: replay.status,
        });
        return;
      }
      if (journalInspection.decision === "QUARANTINE_UNCERTAIN") {
        const quarantined = journalQuarantineResponse(wire, adapter);
        try {
          this.commandJournal.markTerminal(wire, quarantined, {
            state: "OUTCOME_UNCERTAIN",
            protectedAction: route.protectedAction,
          });
        } catch (error) {
          quarantined.result.journalPersisted = false;
          quarantined.result.journalError = redactedError(error);
        }
        const projection = this.persistTerminalReceipt(wire, quarantined).then((memoryReceipt) => {
          quarantined.result.grayMatterReceiptRef = memoryReceipt.id
            ? `MemoryEntry:${memoryReceipt.id}` : null;
          quarantined.result.grayMatterReceiptStatus = memoryReceipt.status;
          this.rememberCompleted(wire.commandId, quarantined);
          this.sendCommandResponse(wire, quarantined);
        });
        this.inFlightCommands.set(wire.commandId, projection.finally(
          () => this.inFlightCommands.delete(wire.commandId),
        ));
        this.evidence.record("command_effect_quarantined", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          protectedAction: route.protectedAction,
        });
        return;
      }
      try {
        const started = this.commandJournal.markStarted(wire, {
          protectedAction: route.protectedAction,
        });
        if (!["NEW", "RESUME_SAFE"].includes(started.decision)) {
          throw new Error(`Unexpected command journal decision ${started.decision}`);
        }
      } catch (error) {
        const failed = adapterErrorResponse(wire, adapter, error);
        failed.reason = "command_journal_start_failed";
        failed.result.outcome = governedOutcome(wire, {
          status: "FAILED",
          summary: "The node-local command start proof could not be persisted; no runtime was spawned",
          source: "journal-quarantine",
          retryable: true,
        });
        this.sendCommandResponse(wire, failed);
        void this.persistTerminalReceipt(wire, failed);
        this.evidence.record("command_journal_failed_closed", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          error: redactedError(error),
          phase: "mark_started",
        });
        return;
      }
    }

    this.sendCommandResponse(wire, {
      type: "ACK",
      status: "started",
      result: {
        adapter,
        executed: false,
        receiptOnly: false,
        ...(ordinaryRuntime ? {
          actionDigest: commandBinding(wire).actionDigest,
          scopeDigest: commandBinding(wire).scopeDigest,
          journalState: "STARTED",
        } : {}),
      },
    });
    this.evidence.record("command_started", {
      action: wire.action,
      adapter,
      agentId: this.agent.agentId,
      commandId: wire.commandId,
      traceId: wire.trace?.traceId,
    });
    let progressSequence = 0;
    const onProgress = (progress) => {
        const response = {
          type: "ACK",
          status: "progress",
          result: {
            adapter,
            executed: false,
            receiptOnly: false,
            sequence: ++progressSequence,
            stream: progress.stream,
            text: redactedText(progress.text),
          },
        };
        this.sendCommandResponse(wire, response);
        this.evidence.record("command_progress", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          sequence: progressSequence,
          stream: progress.stream,
          traceId: wire.trace?.traceId,
        });
      };
    const execution = Promise.resolve()
      .then(async () => {
        if (serviceLifecycle) return executeServiceLifecycleCommand({
          agent: this.agent,
          machineId: this.machineId,
          onProgress,
          recoveryRoot: this.recoveryRoot,
          state: this.serviceLifecycleState,
          verifyRecovery: (binding) => this.verifyServiceRecovery(binding),
          wire,
        });
        if (workflowRuntime) return executeWorkflowRuntimeCommand({
          agent: this.agent,
          wire,
          apiBase: this.apiBase,
          tokenProvider: this.tokenProvider,
          onProgress,
        });
        const authorizedGrayMatterContext = await hydrateRuntimeGrayMatterContext({
          apiBase: this.apiBase,
          tokenProvider: this.tokenProvider,
          wire,
        });
        return this.runtimeExecutor({
          agent: this.agent,
          wire: authorizedGrayMatterContext
            ? { ...wire, authorizedGrayMatterContext }
            : wire,
          onProgress,
        });
      })
      .then(async (result) => {
        if (result?.pendingRecovery === true) {
          const pending = {
            type: "ACK",
            status: "progress",
            result,
          };
          this.sendCommandResponse(wire, pending);
          this.evidence.record("service_recovery_checkpointed", {
            action: wire.action,
            agentId: this.agent.agentId,
            commandId: wire.commandId,
            serviceHandle: result.serviceHandle,
            traceId: wire.trace?.traceId,
          });
          return;
        }
        const engineState = wire.action === "workflow.engine.execute-workflow"
          ? String(result?.terminalState ?? "SUCCESS").toUpperCase()
          : "SUCCESS";
        if (!["SUCCESS", "FAILED", "CANCELLED", "TIMEOUT"].includes(engineState)) {
          const suspended = {
            type: "ACK",
            status: "progress",
            result: {
              ...result,
              executed: false,
              executionState: engineState,
              checkpoint: true,
            },
          };
          this.rememberCompleted(wire.commandId, suspended);
          this.sendCommandResponse(wire, suspended);
          this.evidence.record("command_checkpointed", {
            action: wire.action,
            agentId: this.agent.agentId,
            commandId: wire.commandId,
            executionState: engineState,
            traceId: wire.trace?.traceId,
          });
          return;
        }
        let terminal = ordinaryRuntime
          ? runtimeTerminalResponse(result, wire)
          : { type: "ACK", status: "completed", result };
        let journalProofPersisted = false;
        if (ordinaryRuntime) {
          try {
            this.commandJournal.markTerminal(wire, terminal, {
              state: journalTerminalState(terminal),
              protectedAction: route.protectedAction,
            });
            journalProofPersisted = true;
          } catch (error) {
            terminal = journalQuarantineResponse(wire, adapter);
            terminal.reason = "terminal_proof_persistence_failed";
            terminal.result.journalPersisted = false;
            terminal.result.journalError = redactedError(error);
            this.evidence.record("command_journal_failed_closed", {
              action: wire.action,
              agentId: this.agent.agentId,
              commandId: wire.commandId,
              error: redactedError(error),
              phase: "mark_terminal",
            });
          }
        }
        const memoryReceipt = await this.persistTerminalReceipt(wire, terminal);
        terminal.result = {
          ...terminal.result,
          grayMatterReceiptRef: memoryReceipt.id ? `MemoryEntry:${memoryReceipt.id}` : null,
          grayMatterReceiptStatus: memoryReceipt.status,
        };
        if (ordinaryRuntime && journalProofPersisted) {
          try {
            this.commandJournal.markTerminal(wire, terminal, {
              state: journalTerminalState(terminal),
              protectedAction: route.protectedAction,
            });
          } catch (error) {
            this.evidence.record("command_journal_projection_update_deferred", {
              agentId: this.agent.agentId,
              commandId: wire.commandId,
              error: redactedError(error),
            });
          }
        }
        this.rememberCompleted(wire.commandId, terminal);
        this.sendCommandResponse(wire, terminal);
        this.evidence.record(terminal.status === "completed"
          ? "command_completed"
          : terminal.result?.outcome?.status === "WAITING_APPROVAL"
            ? "command_checkpointed" : "command_not_completed", {
          action: wire.action,
          adapter: result.adapter,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          executed: terminal.result?.executed === true,
          outcomeStatus: terminal.result?.outcome?.status ?? null,
          status: terminal.status,
          traceId: wire.trace?.traceId,
        });
      })
      .catch(async (error) => {
        const failed = ordinaryRuntime
          ? adapterErrorResponse(wire, adapter, error)
          : {
              type: "NACK",
              status: "failed",
              reason: redactedError(error),
              result: {
                adapter,
                executed: false,
                receiptOnly: false,
              },
            };
        if (ordinaryRuntime) {
          try {
            this.commandJournal.markTerminal(wire, failed, {
              state: "TERMINAL",
              protectedAction: route.protectedAction,
            });
          } catch (journalError) {
            failed.result.journalPersisted = false;
            failed.result.journalError = redactedError(journalError);
          }
        }
        const memoryReceipt = await this.persistTerminalReceipt(wire, failed);
        failed.result.grayMatterReceiptRef = memoryReceipt.id ? `MemoryEntry:${memoryReceipt.id}` : null;
        failed.result.grayMatterReceiptStatus = memoryReceipt.status;
        if (ordinaryRuntime && failed.result.journalPersisted !== false) {
          try {
            this.commandJournal.markTerminal(wire, failed, {
              state: "TERMINAL",
              protectedAction: route.protectedAction,
            });
          } catch (journalError) {
            this.evidence.record("command_journal_projection_update_deferred", {
              agentId: this.agent.agentId,
              commandId: wire.commandId,
              error: redactedError(journalError),
            });
          }
        }
        this.rememberCompleted(wire.commandId, failed);
        this.sendCommandResponse(wire, failed);
        this.evidence.record("command_failed", {
          action: wire.action,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          error: redactedError(error),
          traceId: wire.trace?.traceId,
        });
      })
      .finally(() => this.inFlightCommands.delete(wire.commandId));
    this.inFlightCommands.set(wire.commandId, execution);
  }

  rememberCompleted(commandId, response) {
    this.completedCommands.set(commandId, response);
    while (this.completedCommands.size > 200) {
      this.completedCommands.delete(this.completedCommands.keys().next().value);
    }
  }

  onClose(event) {
    clearInterval(this.heartbeatTimer);
    for (const [id, pending] of this.pendingControlMessages) {
      clearTimeout(pending.timer);
      pending.reject?.(new Error(`SWARM ${pending.action} disconnected before acknowledgement`));
      this.pendingControlMessages.delete(id);
    }
    if (this.stopped) return;
    this.evidence.record("disconnected", {
      agentId: this.agent.agentId,
      code: event.code,
    });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(this.reconnectAttempt, 5)));
    this.reconnectAttempt += 1;
    this.evidence.record("reconnect_scheduled", {
      agentId: this.agent.agentId,
      reconnectInMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(stompFrame("DISCONNECT", { receipt: `stop-${this.agent.agentId}` }));
      this.websocket.close(1000, "swarm agent complete");
    }
  }
}

async function selfTest() {
  if (!parseArgs(["--continuous"]).continuous) {
    throw new Error("Continuous mode argument parsing failed");
  }
  let tokenReadCount = 0;
  let loginCount = 0;
  let persistCount = 0;
  const tokenProvider = createTokenProvider({
    apiBase: "https://api-0.valkyrlabs.com/v1",
    configuredToken: null,
    credentialFile: "/tmp/nonexistent-valkyr-swarm-credentials",
    keychainService: "VALKYR_AUTH",
    tokenFile: "/tmp/nonexistent-valkyr-swarm-token",
  }, {
    keychainReader: () => {
      tokenReadCount += 1;
      return `token-${tokenReadCount}`;
    },
    fileReader: () => null,
    credentialReader: () => ({ username: "user", password: "pass" }),
    login: async () => {
      loginCount += 1;
      return "refreshed-token";
    },
    persist: () => {
      persistCount += 1;
    },
  });
  if (await tokenProvider() !== "token-1" || await tokenProvider() !== "token-2" || tokenReadCount !== 2) {
    throw new Error("Keychain token provider must reload authentication on every connection");
  }
  if (await tokenProvider({ forceRefresh: true }) !== "refreshed-token" || loginCount !== 1 || persistCount !== 1) {
    throw new Error("Expired authentication must re-login from reusable credentials");
  }
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-evidence-"));
  const evidencePath = path.join(evidenceRoot, "nested", "receipt.jsonl");
  new EvidenceLog(evidencePath);
  if (!fs.existsSync(path.dirname(evidencePath))) {
    throw new Error("Evidence log parent directory was not created");
  }
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  const fakeJwt = ["eyJabcdefgh", "ijklmnop", "qrstuvwx"].join(".");
  const secretError = redactedError(
    `Authorization: Bearer ${fakeJwt} token=super-secret`,
  );
  if (secretError.includes("eyJabcdefgh") || secretError.includes("super-secret")) {
    throw new Error("SWARM evidence error redaction failed");
  }
  const frame = stompFrame("SEND", { destination: "/app/command" }, '{"ok":true}');
  const parsed = parseStompFrame(frame);
  if (parsed.command !== "SEND" || parsed.headers.destination !== "/app/command" || parsed.body !== '{"ok":true}') {
    throw new Error("STOMP frame round-trip failed");
  }
  const wire = parseWireCommand(JSON.stringify({
    type: "agent",
    payload: JSON.stringify({
      commandId: "cmd-1",
      targetInstanceId: "agent-1",
      trace: { traceId: "ceo:d:t" },
      command: { action: "content.research" },
    }),
  }));
  if (wire.commandId !== "cmd-1" || wire.action !== "content.research" || wire.trace.traceId !== "ceo:d:t") {
    throw new Error("SWARM wire command parsing failed");
  }
  for (const action of ["outbound.send", "production.deploy", "merge", "service.lifecycle.restart"]) {
    if (!PROTECTED_ACTIONS.has(action)) throw new Error(`Missing protected action: ${action}`);
  }
  const routingAgent = { agentId: "agent-1", capabilities: ["content.research"] };
  if (commandDisposition(wire, routingAgent).disposition !== "accept") {
    throw new Error("Explicit target and advertised capability must be accepted");
  }
  if (commandDisposition({ ...wire, targetInstanceId: null }, routingAgent).reason !== "missing_target_instance_id") {
    throw new Error("Missing-target broadcast commands must fail closed");
  }
  if (commandDisposition({ ...wire, action: "workflow.debug" }, routingAgent).reason !== "action_not_advertised_by_agent") {
    throw new Error("Undeclared actions must fail closed");
  }
  if (commandDisposition({ ...wire, action: "merge" }, routingAgent).protectedAction !== true) {
    throw new Error("Protected actions must fail closed");
  }
  if (commandDisposition({ ...wire, commandId: "x".repeat(MAX_IDENTIFIER_LENGTH + 1) }, routingAgent).disposition !== "accept") {
    throw new Error("Command disposition must remain independent from command ID validation");
  }
  const workspaceAgent = Object.create(SwarmAgent.prototype);
  workspaceAgent.agent = { execution: { workingDirectory: "/workspace/chronicle" } };
  const workspace = workspaceAgent.workspaceAdvertisement();
  if (workspace.workspaceSummary.folderCount !== 1
      || workspace.workspaceFolders[0] !== "/workspace/chronicle") {
    throw new Error("SWARM workspace advertisement contract failed");
  }
  for (const unsafeUrl of [
    "wss://operator:secret@api-0.valkyrlabs.com/swarm",
    "wss://api-0.valkyrlabs.com/swarm?token=secret",
  ]) {
    try {
      normalizeWebSocketUrl(unsafeUrl);
      throw new Error(`Unsafe SWARM URL was accepted: ${unsafeUrl}`);
    } catch (error) {
      if (String(error?.message ?? error).startsWith("Unsafe SWARM URL was accepted:")) throw error;
    }
  }
  const runtimeAgent = {
    agentId: "valklaw-builder",
    execution: {
      adapter: "openclaw-agent",
      agentId: "valor",
      executable: "openclaw",
      timeoutSeconds: 600,
    },
  };
  validateRuntimeAdapter(runtimeAgent);
  const prompt = buildOpenClawPrompt(wire, runtimeAgent);
  const invocation = buildOpenClawAgentArgs(
    {
      agentId: "valor",
      executable: "openclaw",
      requireGateway: true,
      sessionKeyPrefix: "valkyr-swarm",
      timeoutSeconds: 600,
    },
    wire,
    prompt,
  );
  if (
    !invocation.args.includes("--json") ||
    !invocation.args.includes("valor") ||
    !prompt.includes("Protected actions remain prohibited")
  ) {
    throw new Error("OpenClaw runtime adapter contract failed");
  }
  process.stdout.write("Valkyr SWARM agent self-test passed\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (!options.config) usage(2);

  const configPath = expandPath(options.config);
  const configStat = fs.statSync(configPath);
  if (process.platform !== "win32" && (configStat.mode & 0o077) !== 0) {
    throw new Error(`SWARM config permissions must be 0600: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  validateConfig(config);
  const configuredToken = options.token
    ?? process.env.VALKYR_AUTH_TOKEN
    ?? process.env.API0_JWT_SESSION
    ?? process.env.VALKYR_JWT_SESSION;
  const keychainService = options.keychainService
    ?? config.authKeychainService
    ?? process.env.VALKYR_KEYCHAIN_SERVICE
    ?? "VALKYR_AUTH";
  const tokenFile = expandPath(
    options.tokenFile
      ?? config.authTokenFile
      ?? process.env.VALKYR_SWARM_TOKEN_FILE
      ?? "~/.config/valkyr-swarm/auth-token",
  );
  const credentialFile = expandPath(
    options.credentialFile
      ?? config.authCredentialFile
      ?? process.env.VALKYR_SWARM_CREDENTIAL_FILE
      ?? "~/.config/valkyr-swarm/credentials.json",
  );
  const apiBase = options.url ?? config.serverUrl;
  const tokenProvider = createTokenProvider({
    apiBase,
    configuredToken,
    credentialFile,
    keychainService,
    tokenFile,
  });
  if (!await tokenProvider()) {
    throw new Error(
      `Missing JWT; set VALKYR_AUTH_TOKEN/API0_JWT_SESSION, store it in Keychain service ${keychainService}, or activate ${tokenFile}`,
    );
  }
  const url = normalizeWebSocketUrl(apiBase);
  const heartbeatSeconds = Number(options.heartbeatSeconds ?? config.heartbeatSeconds ?? 30);
  const durationSeconds = options.continuous
    ? null
    : Number(options.durationSeconds ?? config.durationSeconds ?? DEFAULT_DURATION_SECONDS);
  if (!Number.isFinite(heartbeatSeconds) || heartbeatSeconds < 5) {
    throw new Error("heartbeatSeconds must be at least 5");
  }
  if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 1)) {
    throw new Error("durationSeconds must be positive");
  }

  const evidence = new EvidenceLog(options.receiptLog);
  const agents = config.agents.map((agent) => new SwarmAgent({
    agent,
    apiBase,
    machineId: config.machineId,
    tokenProvider,
    url,
    heartbeatSeconds,
    evidence,
  }));
  evidence.record("swarm_agent_started", {
    agentCount: agents.length,
    durationSeconds,
    continuous: options.continuous === true,
    machineId: config.machineId,
    executionEnabledCount: config.agents.filter((agent) => agent.execution).length,
    receiptOnlyCount: config.agents.filter((agent) => !agent.execution).length,
    url: new URL(url).origin + new URL(url).pathname,
  });
  agents.forEach((agent) => agent.connect());

  const stop = () => {
    agents.forEach((agent) => agent.stop());
    evidence.record("swarm_agent_stopped", { machineId: config.machineId });
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (durationSeconds !== null) setTimeout(stop, durationSeconds * 1000).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Valkyr SWARM agent failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export {
  SwarmAgent,
  adapterErrorResponse,
  commandDestinations,
  commandDisposition,
  controlReplyDestination,
  createTokenProvider,
  normalizeWebSocketUrl,
  parseStompFrame,
  parseServerControlReply,
  parseWireCommand,
  readKeychainToken,
  redactedError,
  runtimeTerminalResponse,
  serviceRecoveryOutcome,
  stompFrame,
  validateConfig,
  workflowEngineLifecycleResponse,
};
