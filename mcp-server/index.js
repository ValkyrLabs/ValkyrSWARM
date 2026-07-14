#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_BASE,
  DEFAULT_CREDENTIAL_FILE,
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_TOKEN_FILE,
  credentialsFromEnvironment,
  credentialsFromSecureStorage,
  loadStoredToken,
  loginWithCredentials,
  normalizeApiBase,
  persistAuthentication,
} from "../scripts/swarm-auth.mjs";

const PROTECTED_ACTIONS = new Set(["outbound.send", "production.deploy", "merge"]);
const SERVER_INFO = { name: "valkyr-swarm", version: "0.1.0" };

const TOOLS = [
  {
    name: "swarm_status",
    description: "Check authenticated tenant-schema readiness and summarize the caller's tenant SWARM.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "swarm_agents_snapshot",
    description: "List registered agents visible in the authenticated tenant SWARM with heartbeat and capability metadata.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "swarm_command_status",
    description: "Read the latest durable receipt for a server-issued SWARM command ID.",
    inputSchema: {
      type: "object",
      properties: { commandId: { type: "string", minLength: 1 } },
      required: ["commandId"],
      additionalProperties: false,
    },
  },
  {
    name: "swarm_dispatch",
    description: "Dispatch a governed command to one explicit tenant SWARM agent. Protected actions require a separately correlated human approval receipt.",
    inputSchema: {
      type: "object",
      properties: {
        targetAgentId: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1, maxLength: 24000 },
        approvalReceiptRef: { type: "string", minLength: 1 },
        contextPageRef: { type: "string" },
      },
      required: ["targetAgentId", "action", "instruction"],
      additionalProperties: false,
    },
  },
];

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function safeIdentifier(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new Error(`${name} contains unsupported characters`);
  return normalized;
}

class ValkyrSwarmClient {
  constructor({ env = process.env, fetchImpl = fetch, persistImpl = persistAuthentication } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.persistImpl = persistImpl;
    this.apiBase = normalizeApiBase(env.VALKYR_API_BASE ?? DEFAULT_API_BASE);
    this.keychainService = env.VALKYR_KEYCHAIN_SERVICE ?? DEFAULT_KEYCHAIN_SERVICE;
    this.tokenFile = env.VALKYR_SWARM_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
    this.credentialFile = env.VALKYR_SWARM_CREDENTIAL_FILE ?? DEFAULT_CREDENTIAL_FILE;
    this.cachedToken = null;
  }

  async token(forceRefresh = false) {
    if (this.cachedToken && !forceRefresh) return this.cachedToken;
    if (!forceRefresh) {
      this.cachedToken = loadStoredToken({
        env: this.env,
        keychainService: this.keychainService,
        tokenFile: this.tokenFile,
      });
      if (this.cachedToken) return this.cachedToken;
    }
    const environment = credentialsFromEnvironment(this.env);
    const credentials = environment.username && environment.password
      ? environment
      : credentialsFromSecureStorage({
          env: this.env,
          keychainService: this.keychainService,
          credentialFile: this.credentialFile,
        });
    this.cachedToken = await loginWithCredentials({ ...credentials, apiBase: this.apiBase, fetchImpl: this.fetchImpl });
    this.persistImpl({
      token: this.cachedToken,
      ...credentials,
      keychainService: this.keychainService,
      tokenFile: this.tokenFile,
      credentialFile: this.credentialFile,
    });
    return this.cachedToken;
  }

  async request(pathname, options = {}) {
    const send = async (forceRefresh = false) => this.fetchImpl(`${this.apiBase}${pathname}`, {
        ...options,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${await this.token(forceRefresh)}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 500) };
      }
    }
    if (!response.ok) throw new Error(`${options.method ?? "GET"} ${pathname} returned HTTP ${response.status}`);
    return body;
  }

  async status() {
    const [tenant, agents] = await Promise.all([
      this.request("/tenant-schemas/preflight/graymatter_status?operation=memory.write"),
      this.request("/swarm/agents/snapshot"),
    ]);
    const registry = agents?.registry && typeof agents.registry === "object" ? agents.registry : {};
    return {
      ready: tenant?.ready === true,
      tenantSchemaContext: tenant?.tenantSchemaContext,
      schemaName: tenant?.schemaName,
      isolationMode: tenant?.isolationMode,
      agentCount: Object.keys(registry).length,
      agents: Object.entries(registry).map(([agentId, value]) => ({
        agentId,
        machineId: value?.machineId,
        runtime: value?.runtime,
        status: value?.status,
        lastSeen: value?.lastSeen ?? value?.lastHeartbeat,
      })),
    };
  }

  agentsSnapshot() {
    return this.request("/swarm/agents/snapshot");
  }

  commandStatus(commandId) {
    return this.request(`/swarm-ops/commands/${encodeURIComponent(safeIdentifier(commandId, "commandId"))}/status`);
  }

  async dispatch(args) {
    const targetAgentId = safeIdentifier(args.targetAgentId, "targetAgentId");
    const action = safeIdentifier(args.action, "action");
    const protectedAction = PROTECTED_ACTIONS.has(action.toLowerCase());
    if (protectedAction && !args.approvalReceiptRef) {
      throw new Error(`${action} requires a separately correlated human approval receipt`);
    }
    const timestamp = new Date().toISOString();
    const sourceId = this.env.VALKYR_SWARM_MCP_INSTANCE_ID ?? "valkyr-swarm-mcp";
    const data = {
      instruction: String(args.instruction),
      source: "valkyr-swarm-mcp",
      humanInitiated: Boolean(args.approvalReceiptRef),
      requiresApproval: protectedAction,
      approvalReceiptRef: args.approvalReceiptRef ?? null,
      contextPageRef: args.contextPageRef ?? null,
    };
    const metadata = {
      source: "valkyr-swarm-mcp",
      controlSurface: "mcp",
      protectedAction,
      approvalReceiptRef: args.approvalReceiptRef ?? null,
    };
    return this.request("/swarm-ops/command", {
      method: "POST",
      body: JSON.stringify({
        targetInstanceId: targetAgentId,
        message: {
          type: "COMMAND",
          timestamp,
          fromSwarm: { instanceId: sourceId, swarmType: "USER", username: "mcp" },
          toSwarm: { instanceId: targetAgentId, swarmType: "AGENT" },
          ttl: 600000,
          priority: "NORMAL",
          payload: {
            action,
            data: JSON.stringify(data),
            metadata: JSON.stringify(metadata),
          },
        },
      }),
    });
  }
}

async function callTool(client, name, args = {}) {
  if (name === "swarm_status") return client.status();
  if (name === "swarm_agents_snapshot") return client.agentsSnapshot();
  if (name === "swarm_command_status") return client.commandStatus(args.commandId);
  if (name === "swarm_dispatch") return client.dispatch(args);
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMessage(message, client) {
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) return null;
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
  }
  if (message.method === "tools/call") {
    try {
      const value = await callTool(client, message.params?.name, message.params?.arguments ?? {});
      return { jsonrpc: "2.0", id: message.id, result: textResult(value) };
    } catch (error) {
      return { jsonrpc: "2.0", id: message.id, result: textResult(error instanceof Error ? error.message : String(error), true) };
    }
  }
  return {
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  };
}

function runStdio(client = new ValkyrSwarmClient()) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      Promise.resolve()
        .then(() => handleMessage(JSON.parse(line), client))
        .then((response) => {
          if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
        })
        .catch((error) => {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(error?.message ?? error) } })}\n`);
        });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runStdio();

export { PROTECTED_ACTIONS, TOOLS, ValkyrSwarmClient, callTool, handleMessage, safeIdentifier, textResult };
