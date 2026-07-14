#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildOpenClawAgentArgs,
  buildOpenClawPrompt,
  executeRuntimeCommand,
  validateRuntimeAdapter,
} from "./swarm-runtime-adapters.mjs";
import {
  credentialsFromSecureStorage,
  expandPath,
  loginWithCredentials,
  persistAuthentication,
  readTokenFile,
} from "./swarm-auth.mjs";

const PROTECTED_ACTIONS = new Set(["outbound.send", "production.deploy", "merge"]);
const DEFAULT_DURATION_SECONDS = 72 * 60 * 60;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

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

Agents without an execution adapter acknowledge receipt only. Agents configured
with the openclaw-agent adapter execute safe commands through the canonical
OpenClaw Gateway CLI. outbound.send, production.deploy, and merge are always NACKed.
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
  if (process.platform !== "darwin") return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(service)) {
    throw new Error("Invalid keychain service name");
  }
  try {
    const token = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return token || null;
  } catch {
    return null;
  }
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

function redactedError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(
      /(password|secret|token|authorization|api.?key)(\s*[=:]\s*)([^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .slice(0, 500);
}

function normalizeWebSocketUrl(value) {
  if (!value) throw new Error("Missing serverUrl/--url");
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`Unsupported SWARM URL protocol: ${url.protocol}`);
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  if (!path.endsWith("/swarm")) path = `${path}/swarm`;
  url.pathname = path.replace(/\/+/g, "/");
  return url.toString();
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
  if (!config || typeof config !== "object") throw new Error("Pilot config must be an object");
  if (!config.machineId) throw new Error("Pilot config requires machineId");
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("Pilot config requires at least one agent");
  }
  const seen = new Set();
  for (const agent of config.agents) {
    if (!agent.agentId || !agent.runtime) throw new Error("Each pilot agent requires agentId and runtime");
    if (seen.has(agent.agentId)) throw new Error(`Duplicate pilot agentId: ${agent.agentId}`);
    seen.add(agent.agentId);
    if (!Array.isArray(agent.capabilities) || agent.capabilities.length === 0) {
      throw new Error(`Pilot agent ${agent.agentId} requires capabilities`);
    }
    validateRuntimeAdapter(agent);
    const capacity = Number(agent.capacity ?? 1);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Pilot agent ${agent.agentId} capacity must be a positive integer`);
    }
  }
}

class EvidenceLog {
  constructor(receiptPath) {
    this.path = receiptPath ? expandPath(receiptPath) : null;
    if (this.path) fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
  }

  record(event, details = {}) {
    const row = { timestamp: new Date().toISOString(), event, ...details };
    const line = `${JSON.stringify(row)}\n`;
    process.stdout.write(line);
    if (this.path) fs.appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
  }
}

class PilotAgent {
  constructor({ agent, machineId, tokenProvider, url, heartbeatSeconds, evidence }) {
    this.agent = agent;
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
    this.forceAuthRefresh = false;
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
        this.onMessage(frame.body);
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
    this.subscribe(`/queue/agents/${this.agent.agentId}/commands`, `private-${this.agent.agentId}`);
    this.subscribe("/topic/agent-commands", `broadcast-${this.agent.agentId}`);
    this.sendRegistration();
    this.startHeartbeat();
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
    this.publish("/app/chat", {
      id: crypto.randomUUID(),
      type: "broadcast",
      payload: JSON.stringify(envelope),
      time: new Date().toISOString(),
    });
  }

  sendRegistration() {
    this.sendAppTopic("swarm", this.swarmMessage("register", {
      announcement: {
        agentId: this.agent.agentId,
        runtime: this.agent.runtime,
        machineId: this.machineId,
        status: "healthy",
        capacity: Number(this.agent.capacity ?? 1),
        capabilities: this.agent.capabilities,
        approvalPolicy: "human-approval-required",
        executionAdapter: this.agent.execution?.adapter ?? "receipt-only",
        receiptOnly: !this.agent.execution,
        testMode: !this.agent.execution,
        version: this.agent.version ?? "valkyr-swarm/0.1",
      },
    }));
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatSeconds * 1000);
  }

  sendHeartbeat() {
    this.sendAppTopic("swarm", this.swarmMessage("heartbeat", {
      instanceId: this.agent.agentId,
      agentId: this.agent.agentId,
      runtime: this.agent.runtime,
      machineId: this.machineId,
      status: "healthy",
      capacity: Number(this.agent.capacity ?? 1),
      activeTasks: this.inFlightCommands.size,
      executionAdapter: this.agent.execution?.adapter ?? "receipt-only",
      receiptOnly: !this.agent.execution,
      testMode: !this.agent.execution,
    }));
    this.evidence.record("heartbeat_sent", { agentId: this.agent.agentId, machineId: this.machineId });
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

  onMessage(body) {
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
    if (wire.targetInstanceId && wire.targetInstanceId !== this.agent.agentId) return;
    if (!wire.commandId) {
      this.evidence.record("command_ignored", { agentId: this.agent.agentId, reason: "missing_command_id" });
      return;
    }

    const protectedAction = PROTECTED_ACTIONS.has(String(wire.action).toLowerCase());
    if (protectedAction) {
      this.sendCommandResponse(wire, {
        type: "NACK",
        status: "rejected",
        reason: "protected_action_requires_human_approval",
        result: { executed: false, receiptOnly: true },
      });
      this.evidence.record("command_nacked", {
        action: wire.action,
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        executed: false,
        protectedAction: true,
        traceId: wire.trace?.traceId,
      });
      return;
    }

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

    if (!this.agent.execution) {
      this.sendCommandResponse(wire, {
        type: "ACK",
        status: "pilot_received",
        result: { executed: false, testMode: true, receiptOnly: true },
      });
      this.evidence.record("command_acked", {
        action: wire.action,
        agentId: this.agent.agentId,
        commandId: wire.commandId,
        executed: false,
        protectedAction: false,
        testMode: true,
        traceId: wire.trace?.traceId,
      });
      return;
    }

    this.sendCommandResponse(wire, {
      type: "ACK",
      status: "started",
      result: {
        adapter: this.agent.execution.adapter,
        executed: false,
        receiptOnly: false,
      },
    });
    this.evidence.record("command_started", {
      action: wire.action,
      adapter: this.agent.execution.adapter,
      agentId: this.agent.agentId,
      commandId: wire.commandId,
      traceId: wire.trace?.traceId,
    });
    const execution = executeRuntimeCommand({ agent: this.agent, wire })
      .then((result) => {
        const completed = { type: "ACK", status: "completed", result };
        this.rememberCompleted(wire.commandId, completed);
        this.sendCommandResponse(wire, completed);
        this.evidence.record("command_completed", {
          action: wire.action,
          adapter: result.adapter,
          agentId: this.agent.agentId,
          commandId: wire.commandId,
          executed: true,
          traceId: wire.trace?.traceId,
        });
      })
      .catch((error) => {
        const failed = {
          type: "NACK",
          status: "failed",
          reason: redactedError(error),
          result: {
            adapter: this.agent.execution.adapter,
            executed: false,
            receiptOnly: false,
          },
        };
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
    throw new Error("Pilot evidence error redaction failed");
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
  for (const action of ["outbound.send", "production.deploy", "merge"]) {
    if (!PROTECTED_ACTIONS.has(action)) throw new Error(`Missing protected action: ${action}`);
  }
  const runtimeAgent = {
    agentId: "valklaw-builder",
    execution: {
      adapter: "openclaw-agent",
      agentId: "valor",
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

  const config = JSON.parse(fs.readFileSync(options.config, "utf8"));
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
  const agents = config.agents.map((agent) => new PilotAgent({
    agent,
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
    testMode: config.agents.every((agent) => !agent.execution),
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

main().catch((error) => {
  process.stderr.write(`Valkyr SWARM agent failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

export {
  createTokenProvider,
  normalizeWebSocketUrl,
  parseStompFrame,
  parseWireCommand,
  readKeychainToken,
  redactedError,
  stompFrame,
  validateConfig,
};
