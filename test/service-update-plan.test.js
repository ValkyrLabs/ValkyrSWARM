import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as service from "../scripts/swarm-service.mjs";

const sourceRoot = fileURLToPath(new URL("../scripts/", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t, platform = "darwin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-update-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    machineId: "shared-host",
    serverUrl: "https://api-0.valkyrlabs.com/v1",
    agents: [
      { agentId: "valoride-shared-host", runtime: "valoride" },
      { agentId: "codex-shared-host", runtime: "codex" },
    ],
  };
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const generated = service.serviceSpec({}, { config, configPath }, platform);
  const spec = {
    ...generated,
    servicePath: path.join(root, platform === "darwin" ? "installed.plist" : "installed.service"),
    serviceRuntimeRoot: path.join(root, "not-staged", generated.serviceRuntimeDigest),
  };
  spec.agentScript = path.join(spec.serviceRuntimeRoot, "swarm-agent.mjs");
  fs.writeFileSync(spec.servicePath, "previous service definition\n", { mode: 0o600 });
  return { root, spec, config, plan: () => service.serviceUpdatePlan(spec) };
}

test("CLI exposes a read-only update preview", () => {
  assert.equal(service.parseArgs(["plan-update", "--config", "/private/agent.json"]).command, "plan-update");
});

test("the packaged CLI executes when launched through a symbolic path", (t) => {
  const { root } = fixture(t);
  const alias = path.join(root, "swarm-service-alias.mjs");
  fs.symlinkSync(fileURLToPath(new URL("../scripts/swarm-service.mjs", import.meta.url)), alias);
  const result = spawnSync(process.execPath, [alias, "self-test"], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, "Packaged CLI must start within its bounded smoke-test deadline");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Valkyr SWARM service self-test passed/);
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} preview pins the actual files and shared-agent impact without staging`, (t) => {
    const { spec, plan } = fixture(t, platform);
    const before = fs.readFileSync(spec.servicePath);
    const result = plan();
    assert.equal(result.schemaVersion, "valkyr-service-update-plan/v1");
    assert.equal(result.applied, false);
    assert.equal(result.authorized, false);
    assert.equal(result.requiresCanonicalApproval, true);
    assert.equal(result.current.processState, "not-observed");
    assert.equal(result.expectedMachineId, "shared-host");
    assert.equal(result.serviceHandle, "swarm-bridge");
    assert.deepEqual(result.affectedAgentIds, ["codex-shared-host", "valoride-shared-host"]);
    assert.equal(result.current.definitionSha256, sha256(before));
    assert.equal(result.configuration.sha256, sha256(fs.readFileSync(spec.configPath)));
    assert.equal(result.candidate.definitionSha256, sha256(service.serviceDefinition(spec)));
    assert.equal(result.candidate.runtimeSha256, spec.serviceRuntimeDigest);
    assert.equal(result.candidate.runtimeFileCount, service.SERVICE_RUNTIME_FILES.length);
    assert.match(result.planSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(plan(), result);
    assert.deepEqual(fs.readFileSync(spec.servicePath), before);
    assert.equal(fs.existsSync(spec.serviceRuntimeRoot), false);
  });
}

test("configuration and installed-definition changes invalidate the prior plan identity", (t) => {
  const { spec, config, plan } = fixture(t);
  const initial = plan();
  fs.appendFileSync(spec.servicePath, "changed\n");
  const definitionChanged = plan();
  assert.notEqual(definitionChanged.planSha256, initial.planSha256);
  config.agents.push({ agentId: "openclaw-shared-host", runtime: "openclaw" });
  fs.writeFileSync(spec.configPath, JSON.stringify(config));
  const configChanged = plan();
  assert.notEqual(configChanged.planSha256, definitionChanged.planSha256);
  assert.equal(configChanged.affectedAgentIds.includes("openclaw-shared-host"), true);
});

test("a changed candidate closure cannot retain the previous runtime identity", (t) => {
  const { root, spec } = fixture(t);
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  for (const name of service.SERVICE_RUNTIME_FILES) fs.copyFileSync(path.join(sourceRoot, name), path.join(source, name));
  fs.appendFileSync(path.join(source, "swarm-auth.mjs"), "\n// candidate changed\n");
  assert.throws(() => service.serviceUpdatePlan(spec, { sourceRoot: source }), /source changed/);
});

test("preview never projects raw configuration, credential references or definition text", (t) => {
  const { spec, config, plan } = fixture(t);
  config.password = "fixture-private-secret";
  config.authTokenFile = "/fixture/private-token-location";
  fs.writeFileSync(spec.configPath, JSON.stringify(config));
  fs.appendFileSync(spec.servicePath, "fixture-private-definition-content");
  const output = JSON.stringify(plan());
  for (const privateValue of [config.password, config.authTokenFile, "fixture-private-definition-content"]) {
    assert.equal(output.includes(privateValue), false);
  }
});

test("changed host identity and arbitrary service labels cannot produce a matching preview", (t) => {
  const { spec, config, plan } = fixture(t);
  assert.throws(() => service.serviceUpdatePlan({ ...spec, label: "caller-selected-service" }), /canonical shared bridge/);
  config.machineId = "different-host";
  fs.writeFileSync(spec.configPath, JSON.stringify(config));
  assert.throws(plan, /host mismatch/);
});

test("missing or linked native definitions are not update targets", (t) => {
  const { root, spec, plan } = fixture(t);
  fs.renameSync(spec.servicePath, path.join(root, "previous"));
  assert.throws(plan, /not installed|missing/);
  fs.symlinkSync(path.join(root, "previous"), spec.servicePath);
  assert.throws(plan, /regular file/);
});

test("linked configuration and named pipes are rejected without a blocking read", (t) => {
  const { root, spec, plan } = fixture(t);
  fs.renameSync(spec.configPath, path.join(root, "saved-config"));
  fs.symlinkSync(path.join(root, "saved-config"), spec.configPath);
  assert.throws(plan, /regular file/);
  fs.unlinkSync(spec.configPath);
  fs.renameSync(path.join(root, "saved-config"), spec.configPath);
  fs.unlinkSync(spec.servicePath);
  const pipe = spawnSync("mkfifo", [spec.servicePath], { encoding: "utf8", timeout: 1000 });
  assert.equal(pipe.status, 0, pipe.stderr);
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {serviceUpdatePlan} from ${JSON.stringify(new URL("../scripts/swarm-service.mjs", import.meta.url).href)}; serviceUpdatePlan(${JSON.stringify(spec)});`,
  ], { encoding: "utf8", timeout: 1000 });
  assert.equal(probe.error, undefined, "Preview must not block opening a named pipe");
  assert.equal(probe.status, 1);
  assert.match(probe.stderr, /must be a regular file/);
});

test("preview input reads and affected-agent projection have explicit limits", (t) => {
  const { spec, config, plan } = fixture(t);
  fs.writeFileSync(spec.servicePath, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(plan, /size limit/);
  fs.writeFileSync(spec.servicePath, "previous definition");
  config.agents = Array.from({ length: 257 }, (_, i) => ({ agentId: `agent-${i}` }));
  fs.writeFileSync(spec.configPath, JSON.stringify(config));
  assert.throws(plan, /agent limit/);
  fs.writeFileSync(spec.configPath, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(plan, /size limit/);
});

test("ambiguous or unsafe agent identities cannot be presented as verified impact", (t) => {
  const { spec, config, plan } = fixture(t);
  for (const agents of [[], [{ agentId: "same" }, { agentId: "same" }], [{ agentId: "../escape" }]]) {
    config.agents = agents;
    fs.writeFileSync(spec.configPath, JSON.stringify(config));
    assert.throws(plan, /agent|unsupported/);
  }
});
