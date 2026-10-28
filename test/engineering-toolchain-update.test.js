import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPlan, buildPlan, patchAgentJava, rollbackPlan } from
  "../scripts/swarm-engineering-toolchain-update.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-engineering-toolchain-"));
  const configPath = path.join(root, "agents.json");
  const servicePath = path.join(root, "engineering.plist");
  const serviceScript = path.join(root, "workflow-service.mjs");
  const targetJava = path.join(root, "jdk17", "bin", "java");
  const priorJava = "/jdk26/bin/java";
  const agents = [
    { agentId: "codex-node", capabilities: ["engineering.project.execute"],
      workflowRuntime: { tier: "engine", capabilities: ["java:17"],
        healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
        install: { javaExecutable: priorJava, artifactUrl: "https://example.test/engine.jar" } } },
    { agentId: "qwen-node", capabilities: [], workflowRuntime: { install: { javaExecutable: priorJava } } },
    { agentId: "valoride-node", capabilities: [], workflowRuntime: { install: { javaExecutable: priorJava } } },
    { agentId: "review-node", capabilities: [], workflowRuntime: {} },
    { agentId: "gemma-node", capabilities: [], workflowRuntime: { install: { javaExecutable: priorJava } } },
  ];
  const config = ` {\n  "secretReference": "keychain:KEEP:THIS",\n  "agents" : ${JSON.stringify(agents, null, 2)}\n}\n`;
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  fs.writeFileSync(servicePath, `service ${priorJava}`, { mode: 0o600 });
  fs.writeFileSync(serviceScript, "// pinned local service installer\n", { mode: 0o600 });
  const inspectJava = () => ({ path: targetJava, sha256: digest("jdk17") });
  const plan = () => buildPlan({ configPath, agentId: "codex-node",
    javaExecutable: targetJava, servicePath, serviceScript, inspectJava });
  const runService = async (_command, expected) => {
    const configNow = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const javaNow = configNow.agents.find((agent) => agent.agentId === expected.agentId)
      .workflowRuntime.install.javaExecutable;
    fs.writeFileSync(servicePath, `service ${javaNow}`, { mode: 0o600 });
  };
  const probe = async (_plan, expectedJava) => {
    assert.equal(fs.readFileSync(servicePath, "utf8"), `service ${expectedJava}`);
    return { pid: 321, program: expectedJava, healthStatus: "UP" };
  };
  return { root, configPath, servicePath, serviceScript, targetJava,
    priorJava, config, agents, inspectJava, plan, runService, probe };
}

test("byte patch changes only the selected engineering agent Java path", () => {
  const f = fixture();
  try {
    const patched = patchAgentJava(f.config, "codex-node", f.targetJava);
    assert.equal(patched.priorJavaExecutable, f.priorJava);
    assert.equal(patched.updated.replace(JSON.stringify(f.targetJava), JSON.stringify(f.priorJava)), f.config);
    assert.equal(JSON.parse(patched.updated).agents.length, 5);
    assert.equal(JSON.parse(patched.updated).agents[1].workflowRuntime.install.javaExecutable, f.priorJava);
    assert.match(patched.updated, /keychain:KEEP:THIS/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("exact toolchain plan applies, attests and rolls back with private original bytes", async () => {
  const f = fixture();
  try {
    const plan = f.plan();
    assert.equal(plan.currentConfigSha256, digest(f.config));
    const receipt = await applyPlan(plan, { runService: f.runService,
      probe: f.probe, inspectJava: f.inspectJava });
    assert.equal(receipt.healthStatus, "UP");
    assert.equal(receipt.pid, 321);
    assert.equal(digest(fs.readFileSync(f.configPath)), plan.updatedConfigSha256);
    assert.equal(fs.statSync(path.join(receipt.rollbackDirectory, "config.original")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(receipt.rollbackDirectory, "config.original"), "utf8"), f.config);
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, "utf8")).agents.length, 5);
    const restored = await rollbackPlan(plan, { runService: f.runService, probe: f.probe });
    assert.equal(restored.restoredConfigSha256, plan.currentConfigSha256);
    assert.equal(fs.readFileSync(f.configPath, "utf8"), f.config);
    assert.equal(fs.readFileSync(f.servicePath, "utf8"), `service ${f.priorJava}`);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("changed config refuses an old plan before any service update", async () => {
  const f = fixture();
  try {
    const plan = f.plan();
    fs.appendFileSync(f.configPath, "\n");
    let invoked = false;
    await assert.rejects(applyPlan(plan, { inspectJava: f.inspectJava,
      runService: async () => { invoked = true; }, probe: f.probe }), /plan changed/i);
    assert.equal(invoked, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed attestation restores exact config and original service", async () => {
  const f = fixture();
  try {
    const plan = f.plan();
    await assert.rejects(applyPlan(plan, { inspectJava: f.inspectJava,
      runService: f.runService,
      probe: async (_plan, expectedJava) => {
        if (expectedJava === f.targetJava) throw new Error("engine health absent");
        return f.probe(_plan, expectedJava);
      } }), /engine health absent/);
    assert.equal(fs.readFileSync(f.configPath, "utf8"), f.config);
    assert.equal(fs.readFileSync(f.servicePath, "utf8"), `service ${f.priorJava}`);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("same-hash rollback refuses a concurrently changed sidecar definition", async () => {
  const f = fixture();
  try {
    const plan = f.plan();
    await applyPlan(plan, { runService: f.runService, probe: f.probe, inspectJava: f.inspectJava });
    fs.writeFileSync(f.servicePath, "unrelated operator change");
    await assert.rejects(rollbackPlan(plan, { runService: f.runService, probe: f.probe }),
      /changed since the pinned apply/);
    assert.equal(digest(fs.readFileSync(f.configPath)), plan.updatedConfigSha256);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
