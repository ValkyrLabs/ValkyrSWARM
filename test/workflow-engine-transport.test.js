import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { executeWorkflowRuntimeCommand, forwardWorkflowEngineEventsOnce, probeWorkflowRuntime, workflowRuntimeConfig } from "../scripts/swarm-workflow-runtime.mjs";
import { prepareWorkflowEngineKey, workflowEngineTransportHeaders } from "../scripts/swarm-workflow-transport.mjs";

const KEY = "synthetic-node-key-for-transport-tests-0123456789";
const HEADER = "X-Valkyr-Engine-Authorization";
const expected = crypto.createHmac("sha256", KEY).update("valkyr-workflow-engine-transport/v1").digest("hex");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-transport-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o700);
  const key = path.join(directory, "engine.key");
  fs.writeFileSync(key, KEY + "\n", { mode: 0o600 });
  return { directory, key, agent: { agentId: "transport-test", workflowRuntime: {
    tier: "engine", endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute",
    healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health", install: { engineKeyPath: key },
  } } };
}

function kill(agent, fetchImpl) {
  return executeWorkflowRuntimeCommand({ agent, wire: { action: "workflow.engine.kill-execution",
    commandId: "kill-test", command: { payload: { workflowExecutionId: "execution", workflowRunnerId: "runner", leaseFence: 1 } } },
    apiBase: "https://api-0.valkyrlabs.com/v1", tokenProvider: () => { throw new Error("JWT must not reach local transport"); }, fetchImpl });
}

test("engine transport derives a separate credential and refuses HTTP redirects", async (t) => {
  const { agent } = fixture(t);
  let calls = 0;
  const result = await kill(agent, async (url, options) => {
    calls++;
    assert.equal(new URL(url).origin, "http://127.0.0.1:8767");
    assert.equal(options.headers[HEADER], expected);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    assert.ok(!JSON.stringify(options).includes(KEY));
    return Response.json({ accepted: true });
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "kill_requested");
  assert.ok(!JSON.stringify(result).includes(expected));
});

test("engine replay authenticates both read and acknowledgement without leaking authority upstream", async (t) => {
  const { agent } = fixture(t);
  const calls = [];
  await forwardWorkflowEngineEventsOnce({ agent, apiBase: "https://api-0.valkyrlabs.com/v1", after: 0,
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      assert.equal(options.headers[HEADER], expected);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "error");
      return String(url).endsWith("/ack") ? Response.json({ acknowledged: 1 })
        : Response.json({ events: [{ id: 1, executionId: "execution", eventType: "LOCAL_PROOF", payload: {}, callbacks: {} }], acknowledged: 0 });
    } });
  assert.equal(calls.length, 2);
});

for (const kind of ["missing", "symlink", "hardlink", "shared-file", "shared-directory", "oversized", "invalid"]) {
  test(`engine rejects ${kind} key storage before any network request`, async (t) => {
    const { agent, key, directory } = fixture(t);
    if (kind === "missing") fs.unlinkSync(key);
    if (kind === "symlink") { fs.renameSync(key, key + ".real"); fs.symlinkSync(key + ".real", key); }
    if (kind === "hardlink") fs.linkSync(key, key + ".copy");
    if (kind === "shared-file") fs.chmodSync(key, 0o644);
    if (kind === "shared-directory") fs.chmodSync(directory, 0o755);
    if (kind === "oversized") fs.writeFileSync(key, "x".repeat(65536));
    if (kind === "invalid") fs.writeFileSync(key, "short");
    let calls = 0;
    await assert.rejects(kill(agent, async () => { calls++; return Response.json({ accepted: true }); }), /[Kk]ey|private|transport/);
    assert.equal(calls, 0);
  });
}

test("a public health response cannot advertise an engine whose private credential is missing", async (t) => {
  const { agent, key } = fixture(t); fs.unlinkSync(key);
  let calls = 0;
  const state = await probeWorkflowRuntime(agent, { fetchImpl: async () => { calls++; return Response.json({ status: "UP" }); } });
  assert.equal(state.healthy, false);
  assert.equal(calls, 0);
});

test("engine command cannot use a stateless runner to omit transport authentication", async (t) => {
  const { agent } = fixture(t); agent.workflowRuntime.tier = "runner";
  let calls = 0;
  await assert.rejects(kill(agent, async () => { calls++; return Response.json({ accepted: true }); }), /runtime tier/);
  assert.equal(calls, 0);
});

test("engine replay cannot send its credential to another configured loopback origin", (t) => {
  const { agent } = fixture(t);
  agent.workflowRuntime.eventsEndpoint = "http://127.0.0.1:9999/v1/swarm/workflow-engine/events";
  assert.throws(() => workflowRuntimeConfig(agent), /engine origin/);
});

test("installer retains a valid existing key and refuses to chmod a shared key", (t) => {
  const { agent, key } = fixture(t);
  prepareWorkflowEngineKey(key, true);
  assert.equal(fs.readFileSync(key, "utf8"), KEY + "\n");
  assert.equal(workflowEngineTransportHeaders(agent)[HEADER], expected);
  fs.chmodSync(key, 0o644);
  assert.throws(() => prepareWorkflowEngineKey(key, true), /private/);
  assert.equal(fs.statSync(key).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(key, "utf8"), KEY + "\n");
});
