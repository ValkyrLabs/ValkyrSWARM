import assert from "node:assert/strict";
import test from "node:test";

import { loginWithCredentials, normalizeApiBase } from "../../scripts/swarm-auth.mjs";
import { PROTECTED_ACTIONS, TOOLS, ValkyrSwarmClient, handleMessage } from "../index.js";

test("authentication accepts username/password and extracts a session", async () => {
  let request;
  const token = await loginWithCredentials({
    username: "agent@example.com",
    password: "not-logged",
    apiBase: "https://api-0.valkyrlabs.com/v1/",
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ VALKYR_AUTH: "session-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(token, "session-token");
  assert.equal(request.url, "https://api-0.valkyrlabs.com/v1/auth/login");
  assert.deepEqual(request.body, { username: "agent@example.com", password: "not-logged" });
  assert.equal(normalizeApiBase("https://api-0.valkyrlabs.com/v1/"), "https://api-0.valkyrlabs.com/v1");
});

test("MCP initialize and tool discovery expose the bounded SWARM surface", async () => {
  const client = {};
  const initialized = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, client);
  assert.equal(initialized.result.serverInfo.name, "valkyr-swarm");
  assert.equal(initialized.result.serverInfo.version, "0.4.0");
  const listed = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, client);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
});

test("protected dispatch fails closed without a human approval receipt", async () => {
  assert.deepEqual([...PROTECTED_ACTIONS].sort(), ["merge", "outbound.send", "production.deploy"]);
  const client = new ValkyrSwarmClient({ env: { VALKYR_AUTH_TOKEN: "test-token" } });
  await assert.rejects(
    client.dispatch({ targetAgentId: "builder", action: "merge", instruction: "Merge it" }),
    /canonical human-approval control surface/,
  );
  await assert.rejects(
    client.dispatch({ targetAgentId: "builder", action: "merge", instruction: "Merge it", approvalReceiptRef: "prompt-supplied" }),
    /portable MCP dispatch fails closed/,
  );
});

test("safe dispatch targets one explicit agent and never accepts tenant identity", async () => {
  const requests = [];
  const client = new ValkyrSwarmClient({
    env: { VALKYR_AUTH_TOKEN: "test-token", VALKYR_API_BASE: "https://api-0.valkyrlabs.com/v1" },
    persistImpl: () => {},
    fetchImpl: async (url, options) => {
      if (url.includes("/tenant-schemas/preflight/graymatter_status")) {
        return new Response(JSON.stringify({ schemaName: "tenant_alpha", isolationMode: "ORG_SCHEMA" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ status: "accepted", commandId: "cmd-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await client.dispatch({
    targetAgentId: "codex-reviewer",
    action: "workflow.debug",
    instruction: "Inspect the failing workflow without making changes",
  });
  const [captured] = requests;
  assert.equal(result.commandId, "cmd-1");
  assert.equal(captured.url, "https://api-0.valkyrlabs.com/v1/swarm-ops/command");
  assert.equal(captured.body.targetInstanceId, "codex-reviewer");
  assert.equal(captured.body.message.toSwarm.instanceId, "codex-reviewer");
  assert.equal(captured.body.message.payload.action, "workflow.debug");
  assert.equal(JSON.stringify(captured.body).includes("tenantId"), false);
  assert.equal(captured.body.message.payload.metadata.includes('"protectedAction":false'), true);
  assert.deepEqual(JSON.parse(captured.body.message.payload.metadata).scope, {
    applicationId: "valkyr-swarm",
    tenantSchemaName: "tenant_alpha",
    runtimeScope: "api-0.valkyrlabs.com",
    runtimeIsolationMode: "ORG_SCHEMA",
  });
  assert.deepEqual(JSON.parse(captured.body.message.payload.data).scope, JSON.parse(captured.body.message.payload.metadata).scope);
  assert.match(captured.headers.Authorization, /^Bearer /);
});

test("dispatch fails closed when authenticated tenant scope cannot be resolved", async () => {
  let commandRequested = false;
  const client = new ValkyrSwarmClient({
    env: { VALKYR_AUTH_TOKEN: "test-token" },
    fetchImpl: async (url) => {
      if (url.includes("/tenant-schemas/preflight/graymatter_status")) {
        return new Response(JSON.stringify({ schemaName: null, isolationMode: "ORG_SCHEMA" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      commandRequested = true;
      return new Response("{}", { status: 200 });
    },
  });
  await assert.rejects(
    client.dispatch({ targetAgentId: "reviewer", action: "workflow.debug", instruction: "Inspect it" }),
    /authenticated tenant schema name must be a string/,
  );
  assert.equal(commandRequested, false);
});

test("agent detail and graph remain tenant-derived read surfaces", async () => {
  const paths = [];
  const client = new ValkyrSwarmClient({
    env: { VALKYR_AUTH_TOKEN: "test-token" },
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/swarm/agents/snapshot")) {
        return new Response(JSON.stringify({ registry: { reviewer: { runtime: "codex", status: "healthy" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ nodes: [], edges: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal((await client.agentStatus("reviewer")).status, "healthy");
  assert.deepEqual(await client.graph(), { nodes: [], edges: [] });
  assert.deepEqual(paths, ["/v1/swarm/agents/snapshot", "/v1/swarm-ops/graph"]);
});

test("dispatch validates bounded input even when called outside MCP schema validation", async () => {
  const client = new ValkyrSwarmClient({ env: { VALKYR_AUTH_TOKEN: "test-token" } });
  await assert.rejects(
    client.dispatch({ targetAgentId: "reviewer", action: "workflow.debug", instruction: "   " }),
    /instruction must not be empty/,
  );
  await assert.rejects(
    client.dispatch({ targetAgentId: "reviewer", action: "workflow.debug", instruction: "x".repeat(24_001) }),
    /instruction exceeds 24000 characters/,
  );
});

test("an expired session renews once from reusable credentials", async () => {
  const authorizations = [];
  let loginCount = 0;
  const client = new ValkyrSwarmClient({
    env: {
      VALKYR_AUTH_TOKEN: "expired-token",
      VALKYR_USERNAME: "agent@example.com",
      VALKYR_PASSWORD: "secret",
      VALKYR_API_BASE: "https://api-0.valkyrlabs.com/v1",
    },
    persistImpl: () => {},
    fetchImpl: async (url, options) => {
      if (url.endsWith("/auth/login")) {
        loginCount += 1;
        return new Response(JSON.stringify({ VALKYR_AUTH: "renewed-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      authorizations.push(options.headers.Authorization);
      if (options.headers.Authorization === "Bearer expired-token") return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ registry: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const value = await client.agentsSnapshot();
  assert.deepEqual(value, { registry: {} });
  assert.equal(loginCount, 1);
  assert.deepEqual(authorizations, ["Bearer expired-token", "Bearer renewed-token"]);
});

test("MCP persists shared handoffs and queries invariants and receipts through GrayMatter", async () => {
  const requests = [];
  const client = new ValkyrSwarmClient({
    env: { VALKYR_AUTH_TOKEN: "test-token" },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: "memory-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await client.handoffWrite({ text: "Continue the verified gate", tags: ["p1"] });
  await client.invariantsQuery({ query: "binding SWARM invariant", limit: 5 });
  await client.receiptsQuery({ query: "cmd-1", limit: 5 });
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/v1/MemoryEntry/write",
    "/v1/MemoryEntry/query",
    "/v1/MemoryEntry/query",
  ]);
  assert.equal(requests[0].body.sourceChannel, "valkyr-swarm:handoff");
  assert.equal(requests[1].body.type, "decision");
  assert.equal(requests[2].body.source, "valkyr-swarm:receipts");
});
