import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as service from "../scripts/swarm-service.mjs";

function fixture(t, platform = "darwin") {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-local-release-")));
  t.mock.method(os, "homedir", () => home);
  t.after(() => {
    const unlock = (directory) => {
      if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) return;
      fs.chmodSync(directory, 0o700);
      for (const name of fs.readdirSync(directory)) {
        const child = path.join(directory, name);
        if (!fs.lstatSync(child).isSymbolicLink()) unlock(child);
      }
    };
    unlock(home);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const config = { machineId: "shared-host", serverUrl: "https://api-0.valkyrlabs.com/v1",
    agents: [{ agentId: "codex-host" }, { agentId: "valoride-host" }] };
  const configPath = path.join(home, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const spec = service.serviceSpec({}, { config, configPath }, platform);
  fs.mkdirSync(path.dirname(spec.servicePath), { recursive: true });
  const prior = "prior private native definition\n";
  fs.writeFileSync(spec.servicePath, prior, { mode: 0o600 });
  const plan = service.serviceUpdatePlan(spec);
  const sourceSha = "a".repeat(40);
  const calls = [];
  const adapters = {
    assertIdle: async (ids) => { assert.deepEqual(ids, plan.affectedAgentIds); calls.push("idle"); return true; },
    reload: async ({ operation }) => { calls.push(operation); return { accepted: true }; },
    attest: async ({ operation, expectedDefinitionSha256 }) => {
      calls.push(`attest:${operation}`);
      assert.equal(expectedDefinitionSha256, operation === "activate"
        ? plan.candidate.definitionSha256 : plan.current.definitionSha256);
      return { healthy: true, observedAt: new Date().toISOString(), nativePid: 123 };
    },
  };
  const release = (overrides = {}) => service.applyLocalServiceRelease(spec, {
    expectedPlanSha256: plan.planSha256,
    expectedConfigSha256: plan.configuration.sha256,
    expectedDefinitionSha256: plan.current.definitionSha256,
    sourceSha, ...adapters, ...overrides,
  });
  const rollback = (overrides = {}) => service.rollbackLocalServiceRelease(spec, {
    expectedPlanSha256: plan.planSha256, sourceSha,
    reload: adapters.reload, attest: adapters.attest, ...overrides,
  });
  return { home, configPath, spec, prior, plan, sourceSha, calls, release, rollback };
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} exact local release verifies all agents and restores prior definition`, async (t) => {
    const f = fixture(t, platform);
    const applied = await f.release();
    assert.equal(applied.status, "verified");
    assert.equal(applied.completed, true);
    assert.deepEqual(applied.affectedAgentIds, ["codex-host", "valoride-host"]);
    assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), service.serviceDefinition(f.spec));
    assert.equal(service.serviceRuntimeDigest(f.spec.serviceRuntimeRoot), f.plan.candidate.runtimeSha256);
    assert.equal(fs.readFileSync(path.join(applied.recoveryDirectory, "rollback-definition"), "utf8"), f.prior);
    const rolledBack = await f.rollback();
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.prior);
    assert.deepEqual(f.calls, ["idle", "activate", "attest:activate", "rollback", "attest:rollback"]);
  });
}

test("local release rejects mismatched plan, config, native preimage and source before effects", async (t) => {
  const f = fixture(t);
  for (const change of ["expectedPlanSha256", "expectedConfigSha256", "expectedDefinitionSha256", "sourceSha"]) {
    await assert.rejects(f.release({ [change]: "b".repeat(64) }),
      /preimage|plan|source/i);
  }
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.prior);
  assert.deepEqual(f.calls, []);
});

test("active commands and config changes during lease gate prevent replacement", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.release({ assertIdle: async () => false }), /active/i);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.prior);
  await assert.rejects(f.release({ assertIdle: async () => {
    fs.appendFileSync(f.configPath, " ");
    return true;
  } }), /plan|preimage/i);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.prior);
});

test("lost fresh attestation retains exact rollback and blocks repeat activation", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.release({ attest: async () => ({ healthy: false }) }), /attestation/i);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), service.serviceDefinition(f.spec));
  await assert.rejects(f.release(), /pending|preimage|plan/i);
  const restored = await f.rollback();
  assert.equal(restored.status, "rolled_back");
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.prior);
});

test("uncertain supervisor activation retains recovery without resubmitting", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.release({ reload: async () => { throw new Error("supervisor response lost"); } }),
    /response lost/);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), service.serviceDefinition(f.spec));
  await assert.rejects(f.release(), /pending|preimage|plan/i);
  const restored = await f.rollback();
  assert.equal(restored.status, "rolled_back");
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.prior);
});

test("rollback refuses a changed native definition and wrong source", async (t) => {
  const f = fixture(t);
  await f.release();
  await assert.rejects(f.rollback({ sourceSha: "b".repeat(40) }), /authority/i);
  fs.writeFileSync(f.spec.servicePath, "third-party definition", { mode: 0o600 });
  await assert.rejects(f.rollback(), /unrecognized/i);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), "third-party definition");
});

test("registry lease and post-reload proof rejects stale, busy, wrong-host and missing agents", () => {
  const now = Date.now();
  const plan = { affectedAgentIds: ["codex-host", "valoride-host"] };
  const agent = (overrides = {}) => ({ machineId: "shared-host", status: "healthy",
    activeTasks: 0, lastSeen: new Date(now - 1000).toISOString(), ...overrides });
  const snapshot = { registry: { "codex-host": agent(), "valoride-host": agent() } };
  assert.equal(service.registryReleaseProof(snapshot, plan, "shared-host", null, now), true);
  assert.equal(service.registryReleaseProof(snapshot, plan, "shared-host", new Date(now - 2000).toISOString(), now), true);
  assert.equal(service.registryReleaseProof({ registry: { "codex-host": agent() } }, plan, "shared-host", null, now), false);
  for (const changed of [agent({ activeTasks: 1 }), agent({ machineId: "wrong-host" }),
    agent({ status: "busy" }), agent({ lastSeen: new Date(now - 120_000).toISOString() })]) {
    assert.equal(service.registryReleaseProof({ registry: { "codex-host": changed,
      "valoride-host": agent() } }, plan, "shared-host", null, now), false);
  }
  assert.equal(service.registryReleaseProof(snapshot, plan, "shared-host", new Date(now).toISOString(), now), false);
});
