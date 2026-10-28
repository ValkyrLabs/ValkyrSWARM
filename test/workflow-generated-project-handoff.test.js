import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeWorkflowRuntimeCommand, WORKFLOW_ENGINE_ACTION } from "../scripts/swarm-workflow-runtime.mjs";

function scenario(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-project-handoff-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyPath = path.join(root, "engine.key");
  fs.writeFileSync(keyPath, "synthetic-project-handoff-node-key-0123456789", { mode: 0o600 });
  const trustPath = path.join(root, "trust", "issuer.json");
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKeyX509Base64 = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const applicationId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const executionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const runnerId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const versionId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const archive = Buffer.from("PK\u0003\u0004 bounded generated project fixture", "utf8");
  const checksum = crypto.createHash("sha256").update(archive).digest("hex");
  const definitionSnapshot = JSON.stringify({ submittedGraph: { workflow: {
    definitionKey: `workflow.tenant-mission-validation:${applicationId}` } } });
  const hash = crypto.createHash("sha256").update(definitionSnapshot).digest("hex");
  const materialization = {
    protocol: "valkyr-workflow-engine/v1",
    workflowExecutionId: executionId,
    workflowRunnerId: runnerId,
    workflowVersionId: versionId,
    leaseFence: 7,
    logicalIdempotencyKey: "one-approved-validation",
    definitionSnapshotHash: hash,
    definitionSnapshot,
    initialState: { applicationId, generationReceiptRef: "generation-receipt-1",
      projectArchiveSha256: checksum },
    materializationProof: { payload: "signed", signature: "signed", issuerKeyId: "issuer-1" },
  };
  const callbacks = {
    heartbeat: `/v1/vaiworkflow/engine/executions/${executionId}/heartbeat/${runnerId}/7`,
    materialize: `/v1/vaiworkflow/engine/executions/${executionId}/materialize/${runnerId}/7`,
    generatedProject: `/v1/vaiworkflow/engine/executions/${executionId}/generated-project/${runnerId}/7`,
    complete: "/v1/vaiworkflow/engine/executions/complete",
  };
  const agent = { agentId: "project-handoff-node", workflowRuntime: {
    enabled: true, tier: "engine",
    endpoint: "http://127.0.0.1:19432/v1/swarm/workflow-engine/execute",
    healthEndpoint: "http://127.0.0.1:19432/v1/swarm/workflow-engine/health",
    install: { engineKeyPath: keyPath, grantTrustPath: trustPath },
  } };
  const wire = { action: WORKFLOW_ENGINE_ACTION, commandId: "swarm-command-1",
    command: { payload: { workflowExecutionId: executionId, workflowRunnerId: runnerId,
      workflowVersionId: versionId, leaseFence: 7,
      logicalIdempotencyKey: materialization.logicalIdempotencyKey,
      definitionSnapshotHash: hash, callbacks } } };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    calls.push({ url: value, options });
    const requestPath = new URL(value).pathname;
    if (requestPath.includes("/grant-trust/")) {
      return Response.json({ protocol: "valkyr-workflow-capability-grant/v1",
        tenantId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        swarmInstanceId: agent.agentId,
        issuer: { keyId: "issuer-1", publicKeyX509Base64 } });
    }
    if (requestPath.endsWith(`/heartbeat/${runnerId}/7`)) return new Response(null, { status: 204 });
    if (requestPath.endsWith(`/materialize/${runnerId}/7`)) return Response.json(materialization);
    if (requestPath.endsWith(`/generated-project/${runnerId}/7`)) {
      if (overrides.handoffStatus) return new Response(null, { status: overrides.handoffStatus });
      return new Response(overrides.archive ?? archive, { status: 200, headers: {
        "content-type": "application/zip",
        "x-valkyr-project-sha256": overrides.headerChecksum ?? checksum,
        "x-valkyr-generation-receipt-ref": "generation-receipt-1",
        "x-valkyr-application-id": applicationId,
        ...(overrides.contentLength ? { "content-length": String(overrides.contentLength) } : {}),
      } });
    }
    if (requestPath.endsWith(`/generated-project`)) {
      assert.equal(options.headers.Authorization, undefined);
      assert.ok(options.headers["X-Valkyr-Engine-Authorization"]);
      assert.equal(options.headers["X-Valkyr-Swarm-Command-Id"], wire.commandId);
      const staged = JSON.parse(options.body);
      assert.deepEqual(staged.materialization, materialization);
      assert.equal(staged.archiveBase64, archive.toString("base64"));
      return Response.json({ staged: true, workflowExecutionId: executionId,
        workflowRunnerId: runnerId, leaseFence: 7,
        projectArchiveSha256: overrides.stagedChecksum ?? checksum,
        bytes: archive.length }, { status: 202 });
    }
    if (requestPath.endsWith("/execute")) {
      assert.ok(options.headers["X-Valkyr-Engine-Authorization"]);
      return Response.json({ success: true, terminalState: "SUCCESS", finalState: { validated: true } });
    }
    if (requestPath.endsWith("/complete")) return Response.json({ state: "SUCCESS" });
    throw new Error(`Unexpected request path: ${requestPath}`);
  };
  return { agent, wire, callbacks, materialization, archive, checksum, calls, fetchImpl };
}

test("signed tenant validation fetches and stages the exact ZIP before runner execution", async (t) => {
  const ctx = scenario(t);
  const result = await executeWorkflowRuntimeCommand({ agent: ctx.agent, wire: ctx.wire,
    apiBase: "https://api.example.test/v1", tokenProvider: async () => "private-session",
    fetchImpl: ctx.fetchImpl });
  assert.equal(result.terminalState, "SUCCESS");
  const handoffIndex = ctx.calls.findIndex(call => call.options.method === "GET"
    && call.url.includes("/generated-project/"));
  const stageIndex = ctx.calls.findIndex(call => call.options.method === "POST"
    && call.url.endsWith("/generated-project"));
  const executeIndex = ctx.calls.findIndex(call => call.url.endsWith("/execute"));
  assert.ok(handoffIndex >= 0 && handoffIndex < stageIndex && stageIndex < executeIndex);
  assert.equal(ctx.calls[handoffIndex].options.headers.Authorization, "Bearer private-session");
  assert.equal(ctx.calls[stageIndex].options.body.includes("private-session"), false);
});

for (const failure of ["missing-callback", "wrong-headers", "wrong-bytes", "oversize", "stage-receipt", "handoff-denied"]) {
  test(`generated project ${failure} stops before remote engine execute`, async (t) => {
    const overrides = failure === "wrong-headers" ? { headerChecksum: "0".repeat(64) }
      : failure === "wrong-bytes" ? { archive: Buffer.from("different bytes") }
      : failure === "oversize" ? { contentLength: 128 * 1024 * 1024 + 1 }
      : failure === "stage-receipt" ? { stagedChecksum: "0".repeat(64) }
      : failure === "handoff-denied" ? { handoffStatus: 403 } : {};
    const ctx = scenario(t, overrides);
    if (failure === "missing-callback") delete ctx.wire.command.payload.callbacks.generatedProject;
    await assert.rejects(executeWorkflowRuntimeCommand({ agent: ctx.agent, wire: ctx.wire,
      apiBase: "https://api.example.test/v1", tokenProvider: async () => "private-session",
      fetchImpl: ctx.fetchImpl }));
    assert.equal(ctx.calls.some(call => call.url.endsWith("/execute")), false);
  });
}
