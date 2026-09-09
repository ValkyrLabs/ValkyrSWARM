import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exchangeWorkflowEngineAuthorizationsOnce, forwardWorkflowEngineEventsOnce } from "../scripts/swarm-workflow-runtime.mjs";

const HEADER = "X-Valkyr-Engine-Authorization";
const KEY = "private-workflow-exchange-synthetic-node-key-0123456789";
const privateCanary = "private-mapped-action-canary";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-exchange-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = path.join(directory, "engine.key"); fs.writeFileSync(key, KEY, { mode: 0o600 });
  const agent = { agentId: "private-exchange", workflowRuntime: { tier: "engine",
    endpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute", install: { engineKeyPath: key } } };
  const executionId = crypto.randomUUID();
  const binding = { workflowExecutionId: executionId, workflowRunnerId: crypto.randomUUID(), authorizationRequestId: crypto.randomUUID(), leaseFence: 7 };
  const reference = { executionId, checkpointRef: `engine-checkpoint:${executionId}:authorization:${binding.authorizationRequestId}`, requestDigest: "a".repeat(64) };
  const pending = { checkpointRef: reference.checkpointRef, requestDigest: reference.requestDigest,
    request: { binding, effectiveInputs: { releaseRef: privateCanary } }, status: "PENDING" };
  const approvalRef = `workflow-approval:${crypto.randomUUID()}`;
  const calls = [];
  let status = "WAITING_APPROVAL", issuerCode, localFailure = false, pendingRead = pending;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, body });
    assert.equal(options.redirect, "error");
    if (parsed.origin === "http://127.0.0.1:8767") {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers[HEADER], crypto.createHmac("sha256", KEY).update("valkyr-workflow-engine-transport/v1").digest("hex"));
      if (parsed.pathname.endsWith("/authorizations")) return Response.json({ pending: [reference] });
      if (parsed.pathname.endsWith("/authorization") && options.method === "GET") return Response.json(pendingRead);
      if (parsed.pathname.endsWith("/authorization")) {
        if (localFailure) return Response.json({}, { status: 409 });
        assert.equal(body.checkpointRef, pending.checkpointRef); assert.equal(body.requestDigest, pending.requestDigest);
        assert.equal(body.result.authorizationRequestId, binding.authorizationRequestId);
        return Response.json({ terminalState: status === "ISSUED" ? "SUCCESS" : "WAITING_AUTHORIZATION" });
      }
      if (parsed.pathname.endsWith("/events/ack")) return Response.json({ acknowledged: body.through });
      if (parsed.pathname.endsWith("/events")) return Response.json({ privateAuthorization: "v1", acknowledged: 91, next: 92,
        events: [{ id: 92, executionId, eventType: "AUTHORIZATION_REQUESTED", payload: { authorizationRequestId: binding.authorizationRequestId },
          callbacks: { progress: `/v1/vaiworkflow/engine/executions/${executionId}/progress` } }] });
      assert.fail(`Unexpected local path ${parsed.pathname}`);
    }
    assert.equal(parsed.origin, "https://api-0.valkyrlabs.com");
    assert.equal(options.headers.Authorization, "Bearer synthetic-api-session");
    assert.equal(options.headers[HEADER], undefined);
    assert.ok(!JSON.stringify(options).includes(KEY));
    if (parsed.pathname.endsWith("/capability-grant")) {
      assert.deepEqual(body, pending.request);
      if (issuerCode) return Response.json({ message: privateCanary }, { status: issuerCode });
      return Response.json({ status, authorizationRequestId: binding.authorizationRequestId,
        envelope: status === "ISSUED" ? { payload: "signed-private-claims", signature: "test-signature", issuerKeyId: "test-key" } : null,
        approvalRef, receiptRef: `workflow-event:${crypto.randomUUID()}`, expiresAtEpochSeconds: 1000 },
      { status: status === "RECONCILIATION_REQUIRED" ? 409 : status === "WAITING_APPROVAL" ? 202 : 200 });
    }
    assert.ok(!JSON.stringify(body).includes(privateCanary));
    assert.ok(!parsed.pathname.endsWith("/complete"), "Private authorization must not create a legacy approval");
    return new Response(null, { status: 204 });
  };
  return { agent, pending, calls, fetchImpl, key, reference,
    status: value => { status = value; }, issuerCode: value => { issuerCode = value; },
    failLocal: () => { localFailure = true; }, changePending: value => { pendingRead = value; },
    options: () => ({ agent, apiBase: "https://api-0.valkyrlabs.com/v1", tokenProvider: async () => "synthetic-api-session", fetchImpl }) };
}

test("private pending discovery resumes across bridge restarts with one canonical approval path", async t => {
  const f = fixture(t);
  for (const status of ["WAITING_APPROVAL", "WAITING_APPROVAL", "ISSUED"]) {
    f.status(status);
    const result = await exchangeWorkflowEngineAuthorizationsOnce(f.options());
    assert.equal(result.handled, 1); assert.equal(result.outcomes[0].status, status);
    assert.ok(!JSON.stringify(result).includes(privateCanary));
    assert.ok(!JSON.stringify(result).includes("signed-private-claims"));
  }
  assert.equal(f.calls.filter(c => c.path.endsWith("/capability-grant")).length, 3);
  assert.equal(f.calls.filter(c => c.path.endsWith("/complete")).length, 0);
});

test("structured reconciliation is delivered privately instead of being discarded as a stale callback", async t => {
  const f = fixture(t); f.status("RECONCILIATION_REQUIRED");
  const result = await exchangeWorkflowEngineAuthorizationsOnce(f.options());
  assert.equal(result.outcomes[0].status, "RECONCILIATION_REQUIRED");
  assert.equal(f.calls.filter(c => c.body?.result?.status === "RECONCILIATION_REQUIRED").length, 1);
});

test("receipt acknowledgement follows durable private handling and exposes references only", async t => {
  const f = fixture(t), published = [];
  const result = await forwardWorkflowEngineEventsOnce({ ...f.options(), after: 91, onEvent: e => published.push(e) });
  assert.equal(result.next, 92);
  const delivery = f.calls.findIndex(c => c.body?.result?.status === "WAITING_APPROVAL");
  const ack = f.calls.findIndex(c => c.path.endsWith("/events/ack"));
  assert.ok(delivery >= 0 && ack > delivery);
  assert.ok(!JSON.stringify(published).includes(privateCanary));
});

for (const failure of ["issuer", "local-commit"]) test(`private ${failure} failure prevents receipt acknowledgement`, async t => {
  const f = fixture(t);
  if (failure === "issuer") f.issuerCode(503); else f.failLocal();
  await assert.rejects(forwardWorkflowEngineEventsOnce({ ...f.options(), after: 91 }), error => {
    assert.ok(!error.message.includes(privateCanary)); return true;
  });
  assert.equal(f.calls.filter(c => c.path.endsWith("/events/ack")).length, 0);
});

test("missing node credential stops private discovery before any request", async t => {
  const f = fixture(t); fs.unlinkSync(f.key);
  await assert.rejects(exchangeWorkflowEngineAuthorizationsOnce(f.options()), /[Kk]ey|private|transport/);
  assert.equal(f.calls.length, 0);
});

test("a changed checkpoint cannot send mapped inputs to the issuer", async t => {
  const f = fixture(t); f.changePending({ ...f.pending, requestDigest: "b".repeat(64) });
  await assert.rejects(exchangeWorkflowEngineAuthorizationsOnce(f.options()), /unresolved exchange/);
  assert.equal(f.calls.filter(c => c.path.endsWith("/capability-grant")).length, 0);
});

test("unstructured issuer conflict is retained for retry and never mistaken for reconciliation", async t => {
  const f = fixture(t); f.issuerCode(409);
  await assert.rejects(exchangeWorkflowEngineAuthorizationsOnce(f.options()));
  assert.equal(f.calls.filter(c => c.body?.result).length, 0);
});

test("one unavailable issuer request does not starve another pending execution", async t => {
  const first = fixture(t), second = fixture(t); first.issuerCode(503);
  const options = first.options();
  options.fetchImpl = async (url, request) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/authorizations")) return Response.json({ pending: [first.reference, second.reference] });
    return pathname.includes(second.reference.executionId) ? second.fetchImpl(url, request) : first.fetchImpl(url, request);
  };
  await assert.rejects(exchangeWorkflowEngineAuthorizationsOnce(options), /1 unresolved exchange/);
  assert.equal(second.calls.filter(c => c.path.includes("/heartbeat/")).length, 1);
  assert.equal(second.calls.filter(c => c.body?.result?.status === "WAITING_APPROVAL").length, 1);
});

test("a slow local grant delivery does not delay another pending execution lease or approval", async t => {
  const first = fixture(t), second = fixture(t);
  const options = first.options();
  let releaseFirst, secondDelivered, timeout;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const delivered = new Promise(resolve => { secondDelivered = resolve; });
  options.fetchImpl = async (url, request) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/authorizations")) return Response.json({ pending: [first.reference, second.reference] });
    const secondExecution = pathname.includes(second.reference.executionId);
    if (!secondExecution && pathname.endsWith("/authorization") && request.method === "POST") await held;
    const response = await (secondExecution ? second : first).fetchImpl(url, request);
    if (secondExecution && pathname.endsWith("/authorization") && request.method === "POST") secondDelivered();
    return response;
  };
  const exchange = exchangeWorkflowEngineAuthorizationsOnce(options);
  try {
    await Promise.race([delivered, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Second execution waited behind the first local delivery")), 1000);
    })]);
    assert.equal(second.calls.filter(c => c.path.includes("/heartbeat/")).length, 1);
    assert.equal(second.calls.filter(c => c.body?.result?.status === "WAITING_APPROVAL").length, 1);
  } finally {
    clearTimeout(timeout); releaseFirst(); await exchange;
  }
});

test("a short lease keeps renewing while the canonical issuer is still responding", async t => {
  const f = fixture(t); f.agent.workflowRuntime.leaseDurationSeconds = 6;
  const options = f.options();
  let releaseIssuer, renewed, timeout, heartbeats = 0;
  const held = new Promise(resolve => { releaseIssuer = resolve; });
  const renewal = new Promise(resolve => { renewed = resolve; });
  options.fetchImpl = async (url, request) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/capability-grant")) await held;
    const response = await f.fetchImpl(url, request);
    if (pathname.includes("/heartbeat/") && ++heartbeats === 2) renewed();
    return response;
  };
  const exchange = exchangeWorkflowEngineAuthorizationsOnce(options);
  try {
    await Promise.race([renewal, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Lease renewal waited for the issuer response")), 3000);
    })]);
    assert.equal(heartbeats, 2);
    assert.equal(f.calls.filter(c => c.body?.result).length, 0);
  } finally {
    clearTimeout(timeout); releaseIssuer(); await exchange;
  }
});

test("reconciliation receipt uses the existing PAUSED checkpoint without creating an approval", async t => {
  const f = fixture(t), completions = [];
  const options = f.options();
  options.fetchImpl = async (url, request) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/events")) return Response.json({ acknowledged: 0, events: [{ id: 1,
      executionId: f.reference.executionId, workflowRunnerId: f.pending.request.binding.workflowRunnerId, leaseFence: 7,
      eventType: "AUTHORIZATION_RECONCILIATION_REQUIRED", payload: { authorizationRequestId: f.pending.request.binding.authorizationRequestId,
        checkpointRef: f.reference.checkpointRef }, callbacks: { complete: "/v1/vaiworkflow/engine/executions/complete" } }] });
    if (pathname.endsWith("/complete")) { completions.push(JSON.parse(request.body)); return Response.json({ state: "PAUSED" }); }
    return f.fetchImpl(url, request);
  };
  await forwardWorkflowEngineEventsOnce(options);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].terminalState, "PAUSED");
  assert.deepEqual(completions[0].finalState, { _workflowAuthorizationRequestId: f.pending.request.binding.authorizationRequestId,
    _workflowAuthorizationStatus: "RECONCILIATION_REQUIRED" });
  assert.equal(f.calls.filter(c => c.path.endsWith("/capability-grant")).length, 0);
});
