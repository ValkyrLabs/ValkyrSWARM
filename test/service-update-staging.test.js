import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as service from "../scripts/swarm-service.mjs";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t, platform = "darwin") {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-stage-")));
  t.mock.method(os, "homedir", () => home);
  t.after(() => {
    // Candidate files are deliberately read-only. Restore only this fixture.
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
  fs.writeFileSync(spec.servicePath, "old supervisor definition\n", { mode: 0o600 });
  const plan = service.serviceUpdatePlan(spec);
  const parent = path.join(home, ".local/share/valkyr-swarm/service-update-candidates");
  const destination = path.join(parent, plan.planSha256);
  const stage = (options = {}) => service.stageServiceUpdate(spec, { expectedPlanSha256: plan.planSha256, ...options });
  return { home, config, spec, plan, parent, destination, stage };
}

test("staging CLI requires an exact expected plan digest", () => {
  const parsed = service.parseArgs(["stage-update", "--config", "/config.json", "--expected-plan-sha256", "a".repeat(64)]);
  assert.equal(parsed.command, "stage-update");
  assert.equal(parsed.expectedPlanSha256, "a".repeat(64));
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} staging binds immutable bytes to the plan without installing or changing the supervisor`, (t) => {
    const { spec, plan, destination, stage } = fixture(t, platform);
    const before = fs.readFileSync(spec.servicePath);
    const result = stage();
    assert.equal(result.schemaVersion, "valkyr-service-update-stage/v1");
    assert.equal(result.staged, true);
    assert.equal(result.applied, false);
    assert.equal(result.authorized, false);
    assert.equal(result.requiresCanonicalApproval, true);
    assert.equal(result.planSha256, plan.planSha256);
    assert.deepEqual(result.affectedAgentIds, ["codex-host", "valoride-host"]);
    assert.equal(result.candidateDirectory, destination);
    assert.deepEqual(fs.readFileSync(spec.servicePath), before);
    assert.equal(fs.existsSync(spec.serviceRuntimeRoot), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, "plan.json"))), plan);
    assert.equal(hash(fs.readFileSync(path.join(destination, "service-definition"))), plan.candidate.definitionSha256);
    assert.equal(service.serviceRuntimeDigest(path.join(destination, "runtime")), plan.candidate.runtimeSha256);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
    for (const name of service.SERVICE_RUNTIME_FILES) {
      assert.equal(fs.statSync(path.join(destination, "runtime", name)).mode & 0o777, 0o400);
    }
    assert.deepEqual(stage(), result, "repeated staging verifies and returns the same candidate");
  });
}

for (const change of ["config", "definition", "runtime"]) {
  test(`staging rejects a stale ${change} plan before writing candidate bytes`, (t) => {
    const { home, spec, destination, stage } = fixture(t);
    let sourceRoot;
    if (change === "config") fs.appendFileSync(spec.configPath, " ");
    if (change === "definition") fs.appendFileSync(spec.servicePath, "changed");
    if (change === "runtime") {
      sourceRoot = path.join(home, "source");
      fs.mkdirSync(sourceRoot);
      for (const name of service.SERVICE_RUNTIME_FILES) fs.copyFileSync(path.join(scripts, name), path.join(sourceRoot, name));
      fs.appendFileSync(path.join(sourceRoot, "swarm-auth.mjs"), "\n// changed");
    }
    assert.throws(() => stage({ sourceRoot }), /changed|does not match|verification/);
    assert.equal(fs.existsSync(destination), false);
  });
}

test("staging never treats a missing or malformed digest as approval to select a new plan", (t) => {
  const { destination, stage } = fixture(t);
  for (const expectedPlanSha256 of [undefined, "", "../escape", "a".repeat(64)]) {
    assert.throws(() => stage({ expectedPlanSha256 }), /plan.*digest|does not match/);
  }
  assert.equal(fs.existsSync(destination), false);
});

for (const change of ["config", "definition", "runtime"]) {
  test(`a ${change} change during staging prevents publication and removes temporary bytes`, (t) => {
    const { home, spec, parent, destination, stage } = fixture(t);
    const sourceRoot = path.join(home, "source");
    fs.mkdirSync(sourceRoot);
    for (const name of service.SERVICE_RUNTIME_FILES) fs.copyFileSync(path.join(scripts, name), path.join(sourceRoot, name));
    const original = fs.writeFileSync;
    let changed = false;
    t.mock.method(fs, "writeFileSync", (...args) => {
      const result = original(...args);
      if (!changed && typeof args[0] === "number") {
        changed = true;
        const target = change === "config" ? spec.configPath : change === "definition" ? spec.servicePath : path.join(sourceRoot, "swarm-auth.mjs");
        fs.appendFileSync(target, change === "config" ? " " : "\n// changed");
      }
      return result;
    });
    assert.throws(() => stage({ sourceRoot }), /changed|does not match|verification/);
    assert.equal(changed, true, "fixture must mutate after an actual staged write");
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  });
}

for (const target of ["runtime/swarm-agent.mjs", "plan.json", "service-definition"]) {
  test(`an existing candidate with tampered ${target} fails closed and is preserved for inspection`, (t) => {
    const { destination, stage } = fixture(t);
    stage();
    const file = path.join(destination, target);
    fs.chmodSync(file, 0o600);
    fs.appendFileSync(file, "tampered");
    fs.chmodSync(file, 0o400);
    assert.throws(stage, /verification|does not match/);
    assert.equal(fs.readFileSync(file, "utf8").endsWith("tampered"), true);
  });
}

test("extra candidate files, writable permissions and hard links invalidate reuse", (t) => {
  const { destination, stage } = fixture(t);
  stage();
  fs.chmodSync(destination, 0o700);
  fs.writeFileSync(path.join(destination, "unexpected"), "extra");
  assert.throws(stage, /verification|unexpected/);
  fs.chmodSync(destination, 0o700);
  fs.unlinkSync(path.join(destination, "unexpected"));
  fs.chmodSync(destination, 0o755);
  assert.throws(stage, /permissions|private|read-only/);
  fs.chmodSync(destination, 0o700);
  fs.linkSync(path.join(destination, "plan.json"), path.join(path.dirname(destination), "linked"));
  assert.throws(stage, /link|verification/);
});

test("symlinked staging ancestors cannot redirect candidate writes", (t) => {
  const { home, parent, stage } = fixture(t);
  const outside = path.join(home, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, ".local"));
  assert.throws(stage, /directory|symbolic|symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(parent), false);
});

test("existing candidate symlinks and non-private staging parents are rejected", (t) => {
  const { home, parent, destination, stage } = fixture(t);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o755);
  assert.throws(stage, /permissions|private/);
  fs.chmodSync(parent, 0o700);
  fs.symlinkSync(home, destination);
  assert.throws(stage, /directory|symbolic|symlink/);
});

test("runtime digest reads reject oversized input and special files without consuming them", (t) => {
  const { home } = fixture(t);
  const sourceRoot = path.join(home, "source");
  fs.mkdirSync(sourceRoot);
  for (const name of service.SERVICE_RUNTIME_FILES) fs.copyFileSync(path.join(scripts, name), path.join(sourceRoot, name));
  fs.writeFileSync(path.join(sourceRoot, "swarm-agent.mjs"), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => service.serviceRuntimeDigest(sourceRoot), /size limit/);
  fs.unlinkSync(path.join(sourceRoot, "swarm-agent.mjs"));
  fs.symlinkSync(path.join(scripts, "swarm-agent.mjs"), path.join(sourceRoot, "swarm-agent.mjs"));
  assert.throws(() => service.serviceRuntimeDigest(sourceRoot), /regular file/);
  fs.unlinkSync(path.join(sourceRoot, "swarm-agent.mjs"));
  const pipe = spawnSync("mkfifo", [path.join(sourceRoot, "swarm-agent.mjs")], { encoding: "utf8", timeout: 1000 });
  assert.equal(pipe.status, 0, pipe.stderr);
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {serviceRuntimeDigest} from ${JSON.stringify(new URL("../scripts/swarm-service.mjs", import.meta.url).href)}; serviceRuntimeDigest(${JSON.stringify(sourceRoot)});`,
  ], { encoding: "utf8", timeout: 1000 });
  assert.equal(probe.error, undefined, "Runtime read must not block on a pipe");
  assert.equal(probe.status, 1);
  assert.match(probe.stderr, /regular file/);
});
