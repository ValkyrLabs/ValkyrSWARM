import assert from "node:assert/strict";
import test from "node:test";

import { buildConfig } from "../scripts/swarm-activate.mjs";
import { commandDisposition } from "../scripts/swarm-agent.mjs";

function agent(runtime) {
  const target = buildConfig({
    runtime,
    machineId: `ceo-${runtime}-contract`,
    receiptOnly: true,
    noWorkflowRuntime: true,
  });
  return target.config.agents[0];
}

function capabilities(runtime) {
  return new Set(agent(runtime).capabilities);
}

test("productized OpenClaw activation advertises every exact autonomous CEO business action", () => {
  const openclaw = agent("openclaw");
  const advertised = new Set(openclaw.capabilities);

  for (const action of [
    "content.research",
    "product.research",
    "content.draft",
    "social.draft",
    "support.research",
    "outreach.draft",
    "inbound.triage",
    "ticket.create",
    "crm.upsert",
    "cms.upsert",
    "website.experiment.propose",
    "workflow.remediate",
  ]) {
    assert.equal(advertised.has(action), true, `${action} must be advertised`);
    assert.equal(
      commandDisposition({
        targetInstanceId: openclaw.agentId,
        action,
        command: {},
      }, openclaw).disposition,
      "accept",
      `${action} must pass the exact productized bridge contract`,
    );
  }
  assert.equal(advertised.has("outbound.send"), true);
});

test("engineering runtimes advertise the exact CEO remediation action", () => {
  for (const runtime of ["codex", "claude-code", "valoride", "valklaw"]) {
    assert.equal(
      capabilities(runtime).has("workflow.remediate"),
      true,
      `${runtime} must advertise workflow.remediate`,
    );
  }
});

test("productized runtimes support the governed CEO engineering chain", () => {
  const valklaw = agent("valklaw");
  const codex = agent("codex");
  const valoride = agent("valoride");
  const approvalRef = `gm_approval_${"a".repeat(64)}`;

  assert.equal(
    commandDisposition({
      targetInstanceId: valklaw.agentId,
      action: "code.execute",
      command: {},
    }, valklaw).disposition,
    "accept",
  );
  assert.equal(
    commandDisposition({
      targetInstanceId: codex.agentId,
      action: "pr.review",
      command: {},
    }, codex).disposition,
    "accept",
  );

  for (const [runtimeAgent, action] of [
    [codex, "merge"],
    [valoride, "production.deploy"],
  ]) {
    assert.equal(
      commandDisposition({
        targetInstanceId: runtimeAgent.agentId,
        action,
        command: {},
      }, runtimeAgent).reason,
      "protected_action_requires_canonical_human_approval",
    );
    assert.equal(
      commandDisposition({
        targetInstanceId: runtimeAgent.agentId,
        action,
        command: {
          requiresApproval: true,
          approvalRef,
        },
      }, runtimeAgent).disposition,
      "accept",
    );
  }
});
