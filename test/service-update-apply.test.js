import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as service from "../scripts/swarm-service.mjs";

function fixture(t, platform = "darwin") {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-apply-")));
  t.mock.method(os, "homedir", () => home);
  t.after(() => {
    const unlock = (dir) => {
      if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return;
      fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) {
        const child = path.join(dir, name);
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
  const original = "previous native definition\n";
  fs.writeFileSync(spec.servicePath, original, { mode: 0o600 });
  const plan = service.serviceUpdatePlan(spec);
  const staged = service.stageServiceUpdate(spec, { expectedPlanSha256: plan.planSha256 });
  const wire = { commandId: "update-command", action: "service.lifecycle.update", targetInstanceId: "codex-host",
    command: { action: "service.lifecycle.update", requiresApproval: true,
      approvalRef: `gm_approval_${"a".repeat(64)}`,
      payload: { expectedMachineId: "shared-host", serviceHandle: "swarm-bridge", planSha256: plan.planSha256 } } };
  const calls = [];
  const options = { wire, assertIdle: async (ids) => { assert.deepEqual(ids, plan.affectedAgentIds); return true; },
    reload: async (request) => { calls.push(request.operation); return { accepted: true }; } };
  const apply = (overrides = {}) => service.applyStagedServiceUpdate(spec, { ...options, ...overrides });
  const rollback = (overrides = {}) => service.rollbackServiceUpdate(spec, { wire, reload: options.reload, ...overrides });
  return { home, spec, plan, original, staged, wire, options, calls, apply, rollback };
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} apply checkpoints reviewed rollback bytes before replacing the definition`, async (t) => {
    const f = fixture(t, platform);
    const result = await f.apply({ reload: async ({ operation, recoveryDirectory }) => {
      assert.equal(operation, "activate");
      assert.equal(fs.readFileSync(path.join(recoveryDirectory, "rollback-definition"), "utf8"), f.original);
      const record = JSON.parse(fs.readFileSync(path.join(recoveryDirectory, "record.json")));
      assert.equal(record.phase, "activation_started");
      assert.equal(record.plan.planSha256, f.plan.planSha256);
      assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), service.serviceDefinition(f.spec));
      return { accepted: true };
    } });
    assert.equal(result.applied, true);
    assert.equal(result.pendingRecovery, true);
    assert.equal(result.completed, false);
    assert.equal(result.phase, "awaiting_recovery");
    assert.equal(service.serviceRuntimeDigest(f.spec.serviceRuntimeRoot), f.plan.candidate.runtimeSha256);
    assert.deepEqual(result.affectedAgentIds, f.plan.affectedAgentIds);
    assert.equal(fs.statSync(f.spec.servicePath).mode & 0o777, 0o600);
    const restored = await f.rollback();
    assert.equal(restored.rolledBack, true);
    assert.equal(restored.completed, false);
    assert.equal(restored.pendingRecovery, true);
    assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
    assert.deepEqual(f.calls, ["rollback"]);
  });
}

for (const change of ["approval", "action", "plan", "target", "host", "handle", "extra-payload"]) {
  test(`apply rejects ${change} authority mismatch before native effects`, async (t) => {
    const f = fixture(t);
    if (change === "approval") f.wire.command.approvalRef = f.plan.planSha256;
    if (change === "action") f.wire.action = f.wire.command.action = "service.lifecycle.restart";
    if (change === "plan") f.wire.command.payload.planSha256 = "b".repeat(64);
    if (change === "target") f.wire.targetInstanceId = "other-agent";
    if (change === "host") f.wire.command.payload.expectedMachineId = "other-host";
    if (change === "handle") f.wire.command.payload.serviceHandle = "workflow-engine";
    if (change === "extra-payload") f.wire.command.payload.executable = "/bin/unsafe";
    await assert.rejects(f.apply(), /approval|authority|plan|target|host|handle|payload/i);
    assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
    assert.equal(fs.existsSync(f.spec.serviceRuntimeRoot), false);
    assert.deepEqual(f.calls, []);
  });
}

for (const change of ["config", "definition", "candidate"]) {
  test(`apply rechecks ${change} after the asynchronous active-lease gate`, async (t) => {
    const f = fixture(t);
    await assert.rejects(f.apply({ assertIdle: async () => {
      const target = change === "config" ? f.spec.configPath : change === "definition" ? f.spec.servicePath
        : path.join(f.staged.candidateDirectory, "runtime", "swarm-agent.mjs");
      fs.chmodSync(target, 0o600);
      fs.appendFileSync(target, " ");
      return true;
    } }), /plan|verification|read-only/i);
    assert.deepEqual(f.calls, []);
    if (change !== "definition") assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
  });
}

test("missing adapters and active shared-agent leases fail closed", async (t) => {
  const f = fixture(t);
  for (const overrides of [{ reload: undefined }, { assertIdle: undefined }, { assertIdle: async () => false }]) {
    await assert.rejects(f.apply(overrides), /adapter|lease|idle/i);
  }
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
  assert.deepEqual(f.calls, []);
});

test("interrupted activation preserves recovery and does not replay the apply", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.apply({ reload: async () => { throw new Error("simulated worker interruption"); } }), /interruption/);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), service.serviceDefinition(f.spec));
  await assert.rejects(f.apply(), /pending|recovery|plan/i);
  await f.rollback();
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
  assert.deepEqual(f.calls, ["rollback"]);
});

test("rollback refuses to overwrite a third party definition", async (t) => {
  const f = fixture(t);
  await f.apply();
  fs.writeFileSync(f.spec.servicePath, "concurrent owner definition");
  await assert.rejects(f.rollback(), /changed|unrecognized/i);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), "concurrent owner definition");
  assert.deepEqual(f.calls, ["activate"]);
});

test("tampered rollback bytes are rejected", async (t) => {
  const f = fixture(t);
  const result = await f.apply();
  const rollback = path.join(result.recoveryDirectory, "rollback-definition");
  fs.chmodSync(rollback, 0o600);
  fs.writeFileSync(rollback, "tampered");
  await assert.rejects(f.rollback(), /rollback|private|read-only|verification/i);
  assert.deepEqual(f.calls, ["activate"]);
});

test("a symlinked native ancestor cannot redirect replacement", async (t) => {
  const f = fixture(t);
  const parent = path.dirname(f.spec.servicePath);
  const moved = `${parent}-moved`;
  fs.renameSync(parent, moved);
  fs.symlinkSync(moved, parent);
  await assert.rejects(f.apply(), /symbolic|directory|canonical/i);
  assert.equal(fs.readFileSync(path.join(moved, path.basename(f.spec.servicePath)), "utf8"), f.original);
  assert.deepEqual(f.calls, []);
});

test("configuration changes while preparing the native replacement still prevent activation", async (t) => {
  const f = fixture(t);
  const chmod = fs.chmodSync;
  let changed = false;
  t.mock.method(fs, "chmodSync", (file, ...args) => {
    const result = chmod(file, ...args);
    if (!changed && String(file).startsWith(`${f.spec.servicePath}.`)) {
      changed = true;
      fs.appendFileSync(f.spec.configPath, " ");
    }
    return result;
  });
  await assert.rejects(f.apply(), /plan|configuration|changed/i);
  assert.equal(changed, true);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
  assert.deepEqual(f.calls, []);
});

test("rollback can resume before its native reload was submitted", async (t) => {
  const f = fixture(t);
  await f.apply();
  const rename = fs.renameSync;
  let interrupted = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!interrupted && to === f.spec.servicePath) {
      interrupted = true;
      throw new Error("simulated rollback replacement interruption");
    }
    return rename(from, to);
  });
  await assert.rejects(f.rollback(), /interruption/);
  assert.equal(interrupted, true);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), service.serviceDefinition(f.spec));
  const result = await f.rollback();
  assert.equal(result.rolledBack, true);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
  assert.deepEqual(f.calls, ["activate", "rollback"]);
});

test("recovery authority stays bound to the original command", async (t) => {
  const f = fixture(t);
  await f.apply();
  const other = structuredClone(f.wire);
  other.commandId = "another-command";
  await assert.rejects(f.rollback({ wire: other }), /authority|original/i);
  assert.deepEqual(f.calls, ["activate"]);
});

test("an unresolved rollback reload is retained and cannot be blindly repeated", async (t) => {
  const f = fixture(t);
  await f.apply();
  await assert.rejects(f.rollback({ reload: async () => { throw new Error("uncertain rollback reload"); } }), /uncertain/);
  assert.equal(fs.readFileSync(f.spec.servicePath, "utf8"), f.original);
  await assert.rejects(f.rollback(), /pending|uncertain|already/i);
  assert.deepEqual(f.calls, ["activate"]);
});
