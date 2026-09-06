import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { executeWorkflowRuntimeCommand, WORKFLOW_ENGINE_ACTION } from "../scripts/swarm-workflow-runtime.mjs";
import { bootstrapWorkflowGrantTrust, persistGrantTrust, validateGrantTrust } from "../scripts/swarm-workflow-trust.mjs";

function thor_fixture(thor_context) {
  const thor_root = fs.mkdtempSync(path.join(os.tmpdir(), "thor-workflow-trust-"));
  thor_context.after(() => fs.rmSync(thor_root, { recursive: true, force: true }));
  const thor_agent = { agentId: "test-node", workflowRuntime: { install: { grantTrustPath: path.join(thor_root, "node", "trust.json") } } };
  const thor_body = { protocol: "valkyr-workflow-capability-grant/v1", tenantId: crypto.randomUUID(), swarmInstanceId: "test-node",
    issuer: { keyId: "server", publicKeyX509Base64: crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") } };
  return { thor_root, thor_agent, thor_body, thor_base: "https://api.example.test/v1" };
}

test("trust bootstrap refreshes the bridge session once without retaining credentials", async (thor_t) => {
  const { thor_agent, thor_body, thor_base } = thor_fixture(thor_t);
  const thor_refreshes = []; let thor_calls = 0;
  const thor_result = await bootstrapWorkflowGrantTrust({ agent: thor_agent, apiBase: thor_base, runnerId: crypto.randomUUID(),
    tokenProvider: async ({ forceRefresh }) => { thor_refreshes.push(forceRefresh); return forceRefresh ? "new-private-canary" : "old-private-canary"; },
    fetchImpl: async (thor_url, thor_options) => {
      assert.equal(thor_options.redirect, "error"); thor_calls++;
      if (thor_calls === 1) return new Response("untrusted error body", { status: 401 });
      assert.equal(thor_options.headers.Authorization, "Bearer new-private-canary");
      return Response.json(thor_body);
    } });
  assert.deepEqual(thor_refreshes, [false, true]);
  assert.ok(!fs.readFileSync(thor_result.path, "utf8").includes("private-canary"));
});

test("missing sessions and repeated authentication rejection fail without a trust file", async (thor_t) => {
  const { thor_agent, thor_base } = thor_fixture(thor_t);
  let thor_calls = 0;
  const thor_options = { agent: thor_agent, apiBase: thor_base, runnerId: crypto.randomUUID(),
    fetchImpl: async () => { thor_calls++; return new Response("private-error-canary", { status: 403 }); } };
  await assert.rejects(bootstrapWorkflowGrantTrust({ ...thor_options, tokenProvider: async () => null }), /authenticated/);
  assert.equal(thor_calls, 0);
  await assert.rejects(bootstrapWorkflowGrantTrust({ ...thor_options, tokenProvider: async () => "private-canary" }), (thor_error) => {
    assert.match(thor_error.message, /HTTP 403/); assert.ok(!thor_error.message.includes("canary")); return true;
  });
  assert.equal(thor_calls, 2);
  assert.equal(fs.existsSync(thor_agent.workflowRuntime.install.grantTrustPath), false);
});

test("node, schema, public key and transport mismatches are rejected", (thor_t) => {
  const { thor_agent, thor_body, thor_base } = thor_fixture(thor_t);
  for (const thor_changed of [ { ...thor_body, swarmInstanceId: "foreign" }, { ...thor_body, tenantId: "invalid" },
    { ...thor_body, extra: true }, { ...thor_body, issuer: { ...thor_body.issuer, privateKey: "private-canary" } },
    { ...thor_body, issuer: { ...thor_body.issuer, keyId: "bad key" } },
    { ...thor_body, issuer: { ...thor_body.issuer, publicKeyX509Base64: thor_body.issuer.publicKeyX509Base64 + "\n" } },
    { ...thor_body, issuer: { ...thor_body.issuer, publicKeyX509Base64: crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64") } } ]) {
    assert.throws(() => validateGrantTrust(thor_changed, thor_agent, thor_base));
  }
  for (const thor_origin of ["http://api.example.test/v1", "https://user:password@api.example.test/v1", "https://api.example.test/v1?key=secret", "file:///tmp/trust"]) {
    assert.throws(() => validateGrantTrust(thor_body, thor_agent, thor_origin));
  }
  assert.equal(validateGrantTrust(thor_body, thor_agent, "http://127.0.0.1:1234/v1").apiOrigin, "http://127.0.0.1:1234");
});

test("existing public trust is immutable across issuer, tenant, node and origin changes", (thor_t) => {
  const { thor_agent, thor_body, thor_base } = thor_fixture(thor_t);
  const thor_trust = validateGrantTrust(thor_body, thor_agent, thor_base);
  const thor_path = persistGrantTrust(thor_agent, thor_trust);
  assert.equal(persistGrantTrust(thor_agent, { ...thor_trust }), thor_path);
  for (const thor_changed of [{ ...thor_trust, tenantId: crypto.randomUUID() }, { ...thor_trust, swarmInstanceId: "foreign" },
    { ...thor_trust, apiOrigin: "https://foreign.example.test" }, { ...thor_trust, issuers: { other: thor_body.issuer.publicKeyX509Base64 } }]) {
    assert.throws(() => persistGrantTrust(thor_agent, thor_changed), /reconcile/);
    assert.deepEqual(JSON.parse(fs.readFileSync(thor_path, "utf8")), thor_trust);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(thor_path)), ["trust.json"]);
});

test("private trust storage refuses links, loose permissions and oversized saved files", (thor_t) => {
  const { thor_root, thor_agent, thor_body, thor_base } = thor_fixture(thor_t);
  const thor_trust = validateGrantTrust(thor_body, thor_agent, thor_base), thor_path = persistGrantTrust(thor_agent, thor_trust);
  fs.chmodSync(thor_path, 0o640); assert.throws(() => persistGrantTrust(thor_agent, thor_trust), /private/);
  fs.chmodSync(thor_path, 0o600); fs.chmodSync(path.dirname(thor_path), 0o750);
  assert.throws(() => persistGrantTrust(thor_agent, thor_trust), /private/);
  fs.chmodSync(path.dirname(thor_path), 0o700); fs.writeFileSync(thor_path, " ".repeat(16_385));
  assert.throws(() => persistGrantTrust(thor_agent, thor_trust), /bounded/);
  const thor_other = path.join(thor_root, "other.json"); fs.writeFileSync(thor_other, JSON.stringify(thor_trust), { mode: 0o600 });
  fs.unlinkSync(thor_path); fs.symlinkSync(thor_other, thor_path);
  assert.throws(() => persistGrantTrust(thor_agent, thor_trust), /private/);
  fs.unlinkSync(thor_path); fs.rmdirSync(path.dirname(thor_path));
  const thor_otherDir = path.join(thor_root, "other"); fs.mkdirSync(thor_otherDir, { mode: 0o700 });
  fs.symlinkSync(thor_otherDir, path.dirname(thor_path));
  assert.throws(() => persistGrantTrust(thor_agent, thor_trust), /private/);
});

test("streamed trust discovery is bounded and rejects trailing JSON", async (thor_t) => {
  const { thor_agent, thor_body, thor_base } = thor_fixture(thor_t);
  for (const thor_payload of [" ".repeat(16_385), JSON.stringify(thor_body) + " {}",
    JSON.stringify(thor_body).replace("{", '{"protocol":"ambiguous",'),
    JSON.stringify(thor_body).replace("{", '{"pro\\u0074ocol":"ambiguous",')] ) {
    await assert.rejects(bootstrapWorkflowGrantTrust({ agent: thor_agent, apiBase: thor_base, runnerId: crypto.randomUUID(),
      tokenProvider: async () => "private-canary", fetchImpl: async () => new Response(thor_payload) }), /bounded|malformed/);
  }
  assert.equal(fs.existsSync(thor_agent.workflowRuntime.install.grantTrustPath), false);
});

test("signed server materialization bootstraps public trust independently before reaching the engine", async () => {
  const thor_root = fs.mkdtempSync(path.join(os.tmpdir(), "thor-workflow-trust-"));
  try {
    const thor_runner = crypto.randomUUID(), thor_execution = crypto.randomUUID(), thor_tenant = crypto.randomUUID();
    const thor_keys = crypto.generateKeyPairSync("ed25519");
    const thor_public = thor_keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const thor_trustPath = path.join(thor_root, "trust", "issuer.json");
    const thor_agent = { agentId: "trust-node", workflowRuntime: { enabled: true, tier: "engine",
      endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute", install: { grantTrustPath: thor_trustPath } } };
    const thor_binding = { protocol: "valkyr-workflow-engine/v1", workflowExecutionId: thor_execution,
      workflowRunnerId: thor_runner, leaseFence: 7, logicalIdempotencyKey: "trust-test", workflowVersionId: crypto.randomUUID(),
      definitionSnapshotHash: "a".repeat(64), initialState: {}, moduleAbiHashes: {}, approvals: {},
      materializationProof: { payload: "verified-by-engine", signature: "verified-by-engine", issuerKeyId: "server-key" } };
    let thor_trustSeen = false, thor_trustedBeforeEngine = false;
    const thor_wire = { action: WORKFLOW_ENGINE_ACTION, commandId: "trust-command", command: { payload: {
      ...thor_binding, callbacks: { heartbeat: `/v1/vaiworkflow/engine/executions/${thor_execution}/heartbeat/${thor_runner}/7`,
        materialize: `/v1/vaiworkflow/engine/executions/${thor_execution}/materialize/${thor_runner}/7`,
        complete: `/v1/vaiworkflow/engine/executions/${thor_execution}/complete` } } } };
    await executeWorkflowRuntimeCommand({ agent: thor_agent, wire: thor_wire, apiBase: "https://api.example.test/v1",
      tokenProvider: async () => "private-test-session", fetchImpl: async (thor_url, thor_options) => {
        const thor_path = new URL(thor_url).pathname;
        if (thor_path.includes("/grant-trust/")) {
          assert.equal(thor_options.method, "GET");
          assert.equal(thor_options.redirect, "error");
          assert.equal(thor_options.headers.Authorization, "Bearer private-test-session");
          thor_trustSeen = true;
          return Response.json({ protocol: "valkyr-workflow-capability-grant/v1", tenantId: thor_tenant,
            swarmInstanceId: "trust-node", issuer: { keyId: "server-key", publicKeyX509Base64: thor_public } });
        }
        if (thor_path.includes("/heartbeat/")) return new Response(null, { status: 204 });
        if (thor_path.includes("/materialize/")) return Response.json(thor_binding);
        if (thor_path.endsWith("/execute")) {
          thor_trustedBeforeEngine = thor_trustSeen && fs.existsSync(thor_trustPath);
          assert.equal(thor_options.headers.Authorization, undefined);
          assert.ok(!thor_options.body.includes("private-test-session"));
          return Response.json({ success: true, terminalState: "SUCCESS", finalState: {} });
        }
        if (thor_path.endsWith("/complete")) return Response.json({ state: "SUCCESS" });
        throw new Error("Unexpected fixture request");
      } });
    assert.equal(thor_trustedBeforeEngine, true);
    const thor_saved = JSON.parse(fs.readFileSync(thor_trustPath, "utf8"));
    assert.equal(thor_saved.issuers["server-key"], thor_public);
    assert.equal(thor_saved.tenantId, thor_tenant);
    assert.equal(thor_saved.apiOrigin, "https://api.example.test");
    assert.equal(fs.statSync(thor_trustPath).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(thor_saved).includes("private-test-session"));
  } finally { fs.rmSync(thor_root, { recursive: true, force: true }); }
});
