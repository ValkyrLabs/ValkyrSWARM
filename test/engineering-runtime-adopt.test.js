import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyAdoption, planAdoption, rollbackAdoption,
  validateRelease, verifyHeartbeatSnapshot } from "../scripts/swarm-engineering-runtime-adopt.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-engineering-adopt-"));
  const configPath = path.join(root, "agents.json");
  const servicePath = path.join(root, "engineering.plist");
  const serviceScript = path.join(root, "workflow-service.mjs");
  const manifestPath = path.join(root, "manifest.json");
  const descriptorPath = path.join(root, "descriptor.json");
  const javaExecutable = path.join(root, "jdk17", "bin", "java");
  fs.mkdirSync(path.dirname(javaExecutable), { recursive: true });
  fs.writeFileSync(javaExecutable, "pinned Java 17 binary", { mode: 0o700 });
  const commit = "a".repeat(40);
  const releaseVersion = `1.0.3-SNAPSHOT-${commit.slice(0, 12)}`;
  const engineSha = digest("new-engine");
  const priorEngineSha = digest("prior-engine");
  const packs = [
    { id: "file-project-read", file: "file-project-read.jar", sha256: digest("file-pack"),
      version: "1.0.0", requiredNodeCapabilities: ["workspace.files.read"] },
    { id: "engineering-project", file: "engineering-project.jar", sha256: digest("engineering-pack"),
      version: "1.0.0", requiredNodeCapabilities: ["code.execute", "engineering.project.execute"] },
    { id: "local-inference", file: "local-inference.jar", sha256: digest("model-pack"),
      version: "1.0.0", requiredNodeCapabilities: ["llm.infer"] },
  ];
  const manifest = { schemaVersion: 1, sourceCommit: commit, releaseVersion,
    engine: { file: "workflow-engine.jar", sha256: engineSha }, packs };
  const artifactUrl = (item) => `https://downloads.example.test/${releaseVersion}/${item.file.slice(0, -4)}-${item.sha256.slice(0, 12)}.jar`;
  const descriptor = { protocol: "valkyr-workflow-runtime-release/v1", tier: "engine",
    runtimeProtocol: "valkyr-workflow-engine/v1", version: releaseVersion,
    artifactUrl: artifactUrl(manifest.engine), sha256: engineSha,
    capabilityPacks: packs.map((item) => ({ id: item.id, version: item.version,
      artifactUrl: artifactUrl(item), sha256: item.sha256,
      requiredNodeCapabilities: item.requiredNodeCapabilities })) };
  const priorPacks = [{ id: "file-project-read", version: "0.9.0", sha256: digest("prior-file") },
    { id: "engineering-project", version: "0.9.0", sha256: digest("prior-engineering") }];
  const agents = [
    { agentId: "codex-node", capabilities: ["code.execute", "engineering.project.execute", "workspace.files.read"],
      workflowRuntime: { tier: "engine", enabled: true,
        supportedTools: ["workflow.engine.execute-workflow"], capabilities: ["java:17"],
        healthEndpoint: "http://127.0.0.1:8767/v1/swarm/workflow-engine/health",
        install: { javaExecutable, artifactUrl: "https://downloads.example.test/prior-engine.jar",
          sha256: priorEngineSha, version: "prior", capabilityPacks: priorPacks,
          engineKeyPath: "keychain:KEEP-REFERENCE" } } },
    { agentId: "qwen-node", secretReference: "keychain:DO-NOT-ALTER", workflowRuntime: {} },
    { agentId: "valoride-node", workflowRuntime: {} },
    { agentId: "reviewer-node", workflowRuntime: {} },
    { agentId: "gemma-node", workflowRuntime: {} },
  ];
  const original = ` {\n  "machineId": "fixture-machine",\n  "serverUrl": "https://api-0.valkyrlabs.com/v1",\n  "agents" : ${JSON.stringify(agents, null, 2)}\n}\n`;
  fs.writeFileSync(configPath, original, { mode: 0o600 });
  fs.writeFileSync(servicePath, `service ${priorEngineSha}`, { mode: 0o600 });
  fs.writeFileSync(serviceScript, "// exact service installer\n", { mode: 0o600 });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  const plan = () => planAdoption({ configPath, agentId: "codex-node",
    manifestPath, descriptorPath, expectedConfigSha256: digest(original),
    servicePath, serviceScript, checkJava: () => ({ javaExecutable }),
    readPid: () => 777 });
  const install = async () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(servicePath, `service ${config.agents[0].workflowRuntime.install.sha256}`,
      { mode: 0o600 });
  };
  const probe = async (_plan, selected, engineSha) => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(config.agents[0].workflowRuntime.install.sha256, engineSha);
    assert.equal(selected.find((pack) => pack.id === "engineering-project")?.sha256,
      config.agents[0].workflowRuntime.install.capabilityPacks.find((pack) =>
        pack.id === "engineering-project")?.sha256);
    return { pid: 1234, javaExecutable,
      capabilityPackManifestHash: digest(JSON.stringify(selected)),
      heartbeat: { instanceId: "codex-node", lastSeen: new Date().toISOString() } };
  };
  return { root, configPath, servicePath, manifestPath, descriptorPath, serviceScript,
    javaExecutable, manifest, descriptor, priorEngineSha, engineSha, packs,
    original, plan, install, probe };
}

test("descriptor must match every artifact and pack of one source commit", () => {
  const f = fixture();
  try {
    validateRelease(f.manifest, f.descriptor);
    assert.throws(() => validateRelease(f.manifest,
      { ...f.descriptor, sha256: "f".repeat(64) }), /differs/);
    assert.throws(() => validateRelease(f.manifest,
      { ...f.descriptor, capabilityPacks: f.descriptor.capabilityPacks.slice(0, 2) }), /differs/);
    assert.throws(() => validateRelease({ ...f.manifest, sourceCommit: "b".repeat(40) },
      f.descriptor), /same-commit/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("plan selects engineering packs and keeps other agents and references byte-identical", () => {
  const f = fixture();
  try {
    const plan = f.plan();
    assert.deepEqual(plan.selectedPacks.map((pack) => pack.id),
      ["file-project-read", "engineering-project"]);
    assert.equal(plan.sourceCommit, f.manifest.sourceCommit);
    assert.equal(plan.currentConfigSha256, digest(f.original));
    assert.notEqual(plan.currentConfigSha256, plan.updatedConfigSha256);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("apply and rollback preserve private config while attesting selected engine and pack", async () => {
  const f = fixture();
  try {
    const plan = f.plan();
    const receipt = await applyAdoption(plan, { checkJava: () => ({ javaExecutable: f.javaExecutable }),
      readPid: () => 777,
      install: f.install, probe: f.probe });
    assert.equal(receipt.engineSha256, f.engineSha);
    assert.equal(receipt.pid, 1234);
    assert.equal(digest(fs.readFileSync(f.configPath)), plan.updatedConfigSha256);
    assert.equal(fs.readFileSync(path.join(receipt.rollbackDirectory, "config.original"), "utf8"), f.original);
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, "utf8")).agents[1].secretReference,
      "keychain:DO-NOT-ALTER");
    const restored = await rollbackAdoption(plan, { install: f.install, probe: f.probe });
    assert.equal(restored.status, "RESTORED_EXACT_PRIOR_ENGINEERING_RUNTIME");
    assert.equal(fs.readFileSync(f.configPath, "utf8"), f.original);
    assert.equal(fs.readFileSync(f.servicePath, "utf8"), `service ${f.priorEngineSha}`);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed attestation restores old engine and pack; stale plan refuses before write", async () => {
  const f = fixture();
  try {
    const plan = f.plan();
    await assert.rejects(applyAdoption(plan, { checkJava: () => ({ javaExecutable: f.javaExecutable }),
      readPid: () => 777,
      install: f.install,
      probe: async (_plan, packs, sha) => {
        if (sha === f.engineSha) throw new Error("new engine heartbeat absent");
        return f.probe(_plan, packs, sha);
      } }), /new engine heartbeat absent/);
    assert.equal(fs.readFileSync(f.configPath, "utf8"), f.original);
    assert.equal(fs.readFileSync(f.servicePath, "utf8"), `service ${f.priorEngineSha}`);
    fs.appendFileSync(f.descriptorPath, "\n");
    await assert.rejects(applyAdoption(plan, { checkJava: () => ({ javaExecutable: f.javaExecutable }),
      readPid: () => 777,
      install: f.install, probe: f.probe }), /plan changed/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("fresh authenticated heartbeat must match exact agent, machine and engineering pack", () => {
  const f = fixture();
  try {
    const plan = f.plan();
    const now = Date.now();
    const manifestHash = digest("loaded-pack-manifest");
    const config = JSON.parse(f.original);
    const snapshot = { registry: {
      "codex-node": { instanceId: "codex-node", machineId: "fixture-machine",
        status: "healthy", lastSeen: new Date(now + 1000).toISOString(),
        supportedTools: ["workflow.engine.execute-workflow"],
        capabilities: ["workflow-pack:engineering-project:1.0.0"],
        workflowRuntime: { healthy: true, capabilityPackManifestHash: manifestHash } },
    } };
    assert.equal(verifyHeartbeatSnapshot(snapshot, plan, manifestHash, now, config).instanceId,
      "codex-node");
    snapshot.registry["codex-node"].lastSeen = new Date(now - 5000).toISOString();
    assert.throws(() => verifyHeartbeatSnapshot(snapshot, plan, manifestHash, now, config), /does not match/);
    snapshot.registry["codex-node"].lastSeen = new Date(now + 1000).toISOString();
    snapshot.registry["codex-node"].machineId = "wrong-machine";
    assert.throws(() => verifyHeartbeatSnapshot(snapshot, plan, manifestHash, now, config), /does not match/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
