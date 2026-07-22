import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureJavaVersion,
  installArtifact,
  installCapabilityPacks,
  loadSpec,
  parseArgs as parseWorkflowServiceArgs,
  parseJavaMajorVersion,
  prepareRuntimeDirectory,
  runtimeArguments,
  serviceDefinition,
  workflowRuntimeEnvironment,
} from "../scripts/swarm-workflow-service.mjs";

test("workflow runtime service exposes a productized attached foreground command", () => {
  assert.deepEqual(
    parseWorkflowServiceArgs(["foreground", "--config", "/private/agent.json", "--agent", "codex-node"]),
    { command: "foreground", config: "/private/agent.json", agent: "codex-node" },
  );
  const environment = workflowRuntimeEnvironment({
    HOME: "/private/home",
    PATH: "/usr/bin",
    VALKYR_AUTH_TOKEN: "must-not-cross-runtime-boundary",
    VALKYR_PASSWORD: "must-not-cross-runtime-boundary",
    OPENAI_API_KEY: "must-not-cross-runtime-boundary",
  });
  assert.deepEqual(environment, { HOME: "/private/home", PATH: "/usr/bin" });
});

test("workflow runtime installer verifies the pinned artifact before replacing the local JAR", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-workflow-runtime-"));
  const artifactPath = path.join(root, "runtime.jar");
  const bytes = Buffer.from("signed-workflow-runtime-test-artifact");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const spec = { artifactPath, artifactUrl: "https://downloads.example.test/runtime.jar", sha256 };

  await installArtifact(spec, async () => new Response(bytes, { status: 200 }));
  assert.deepEqual(fs.readFileSync(artifactPath), bytes);

  await assert.rejects(
    installArtifact({ ...spec, sha256: "0".repeat(64) }, async () => new Response(Buffer.from("tampered"))),
    /checksum mismatch/,
  );
  assert.deepEqual(fs.readFileSync(artifactPath), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow runtime installer reuses an existing checksum-pinned artifact without downloading it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-workflow-runtime-reuse-"));
  const artifactPath = path.join(root, "runtime.jar");
  const bytes = Buffer.from("already-verified-workflow-runtime");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(artifactPath, bytes, { mode: 0o600 });
  let fetchCount = 0;

  const result = await installArtifact(
    { artifactPath, artifactUrl: "https://downloads.example.test/runtime.jar", sha256 },
    async () => {
      fetchCount += 1;
      throw new Error("fetch must not be called for an exact installed artifact");
    },
  );

  assert.equal(fetchCount, 0);
  assert.equal(result.reused, true);
  assert.equal(result.sha256, sha256);
  assert.deepEqual(fs.readFileSync(artifactPath), bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test("durable engine installs exact checksum-pinned capability packs and loads only their canonical paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-workflow-packs-"));
  const bytes = Buffer.from("research-pack-v1");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const pack = {
    id: "research",
    version: "1.2.0",
    artifactPath: path.join(root, "research.jar"),
    artifactUrl: "https://downloads.example.test/research-1.2.0.jar",
    sha256,
  };
  const spec = {
    tier: "engine",
    capabilityPacks: [pack],
  };
  let fetchCount = 0;
  const installed = await installCapabilityPacks(spec, async () => {
    fetchCount += 1;
    return new Response(bytes, { status: 200 });
  });
  assert.equal(fetchCount, 1);
  assert.equal(installed[0].id, "research");
  assert.deepEqual(fs.readFileSync(pack.artifactPath), bytes);
  await installCapabilityPacks(spec, async () => {
    throw new Error("verified pack must be reused");
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow engine service loads and enables only its installed capability packs", () => {
  const args = runtimeArguments({
    tier: "engine",
    artifactPath: "/private/engine.jar",
    arguments: [],
    capabilityPacks: [{ id: "research", artifactPath: "/private/packs/research.jar" }],
    credentialReferences: ["keychain:OPENCLAW_API:default"],
    configPath: "/private/agent.json",
    endpoint: new URL("http://127.0.0.1:8767/v1/swarm/workflow-engine/execute"),
    engineKeyPath: "/private/engine.key",
    jvmArgs: [],
    nodeCapabilities: ["market.research", "workflow.engine.execute-workflow"],
    runtimeDataPath: "/private/engine-data",
    runtimeWorkingDirectory: "/private/engine-work",
    workspaceRoots: ["/private/project"],
  });
  assert.equal(args.includes("-Dloader.path=/private/packs/research.jar"), true);
  assert.equal(args.includes("--valkyrai.workflow.engine.enabled-packs=core-transforms,research"), true);
  assert.equal(args.includes("--valkyrai.workflow.engine.node-capabilities=market.research,workflow.engine.execute-workflow"), true);
  assert.equal(args.includes("--valkyrai.workflow.engine.workspace-roots=/private/project"), true);
  assert.equal(args.includes("--valkyrai.workflow.engine.process-home=/private/engine-work"), true);
  assert.equal(args.includes("--valkyrai.workflow.engine.allowed-credential-references=keychain:OPENCLAW_API:default"), true);
  assert.equal(args.some((arg) => /password|secret|authorization|bearer/i.test(arg)), false);
});

test("workflow engine receives only productized deployment runner properties", () => {
  const args = runtimeArguments({
    tier: "engine",
    artifactPath: "/private/engine.jar",
    arguments: [],
    capabilityPacks: [{ id: "deployment", artifactPath: "/private/packs/deployment.jar" }],
    credentialReferences: ["keychain:VALKYR_DEPLOY:primary"],
    deploymentRunner: {
      endpoint: "http://127.0.0.1:3002/api/deployments/execute",
      healthEndpoint: "http://127.0.0.1:3002/api/deployments/health",
      protocol: "valkyr-deployment-runner/v1",
      credentialReference: "keychain:VALKYR_DEPLOY:primary",
    },
    configPath: "/private/agent.json",
    endpoint: new URL("http://127.0.0.1:8767/v1/swarm/workflow-engine/execute"),
    engineKeyPath: "/private/engine.key",
    jvmArgs: [],
    nodeCapabilities: ["deployment.runner.execute", "production.deploy"],
    runtimeDataPath: "/private/engine-data",
    runtimeWorkingDirectory: "/private/engine-work",
    workspaceRoots: [],
  });
  assert.equal(args.includes("--valkyrai.workflow.engine.deployment-runner-endpoint=http://127.0.0.1:3002/api/deployments/execute"), true);
  assert.equal(args.includes("--valkyrai.workflow.engine.deployment-credential-reference=keychain:VALKYR_DEPLOY:primary"), true);
  assert.equal(args.some((arg) => arg.includes("deploy.example")), false);
});

test("workflow runtime config rejects unsafe packs and any runner pack", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-workflow-pack-config-"));
  const configPath = path.join(root, "agent.json");
  const basePack = {
    id: "research",
    version: "1.0.0",
    artifactUrl: "https://downloads.example.test/research.jar",
    sha256: "a".repeat(64),
    requiredNodeCapabilities: ["market.research"],
  };
  const write = (tier, capabilityPacks, credentialReferences = tier === "engine"
    ? ["credential:research-token"] : undefined) => fs.writeFileSync(configPath, JSON.stringify({
    agents: [{
      agentId: "node-1",
      capabilities: ["market.research"],
      workflowRuntime: {
        enabled: true,
        tier,
        endpoint: tier === "engine"
          ? "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute"
          : "http://127.0.0.1:8765/v1/swarm/workflow-runs/execute",
        supportedTools: [tier === "engine"
          ? "workflow.engine.execute-workflow" : "workflow.runner.execute-module"],
        credentialReferences,
        install: {
          artifactUrl: "https://downloads.example.test/runtime.jar",
          sha256: "b".repeat(64),
          capabilityPacks,
        },
      },
    }],
  }));
  write("runner", [basePack]);
  assert.throws(() => loadSpec(configPath, "node-1"), /runner does not accept capability packs/);
  write("engine", [{ ...basePack, artifactUrl: "https://user:secret@downloads.example.test/research.jar" }]);
  assert.throws(() => loadSpec(configPath, "node-1"), /credential-free HTTPS/);
  write("engine", [basePack, { ...basePack }]);
  assert.throws(() => loadSpec(configPath, "node-1"), /invalid or duplicated/);
  write("engine", [{ ...basePack, requiredNodeCapabilities: ["production.deploy"] }]);
  assert.throws(() => loadSpec(configPath, "node-1"), /requires unavailable node capabilities: production.deploy/);
  write("engine", [basePack], ["credential:../outside"]);
  assert.throws(() => loadSpec(configPath, "node-1"), /credential reference is invalid/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Workflow service enforces the release minimum Java version before installation", () => {
  assert.equal(parseJavaMajorVersion('openjdk version "17.0.12" 2024-07-16'), 17);
  assert.equal(parseJavaMajorVersion('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajorVersion("unexpected output"), null);
  assert.equal(ensureJavaVersion(
    { javaExecutable: "/fake/java", minimumJavaVersion: 17 },
    () => ({ status: 0, stdout: "", stderr: 'openjdk version "21.0.2"' }),
  ), 21);
  assert.throws(
    () => ensureJavaVersion(
      { javaExecutable: "/fake/java", minimumJavaVersion: 17 },
      () => ({ status: 0, stdout: "", stderr: 'openjdk version "11.0.24"' }),
    ),
    /requires Java 17\+; found Java 11/,
  );
});

test("workflow runtime service definitions are loopback-bound and secret-free", () => {
  const common = {
    agentId: "workflow-test",
    artifactPath: "/private/runtime.jar",
    arguments: [],
    configPath: "/private/agent.json",
    endpoint: new URL("http://127.0.0.1:8765/v1/swarm/workflow-runs/execute"),
    javaExecutable: "/usr/bin/java",
    jvmArgs: ["-Xmx512m"],
    label: "com.valkyrlabs.workflow-runtime.workflow-test",
    runtimeDataPath: "/private/runtime-data",
    runtimePropertiesPath: "/private/runtime.properties",
    runtimeWorkingDirectory: "/private/runtime-work",
    stderrLog: "/private/runtime.err",
    stdoutLog: "/private/runtime.out",
  };
  for (const platform of ["darwin", "linux"]) {
    const definition = serviceDefinition({ ...common, platform });
    assert.match(definition, /server\.address=127\.0\.0\.1/);
    assert.match(definition, /spring\.profiles\.active=workflow-runner/);
    assert.match(definition, /loader\.main=com\.valkyrlabs\.workflow\.runner\.WorkflowRunnerApplication/);
    assert.match(definition, /org\.springframework\.boot\.loader\.launch\.PropertiesLauncher/);
    assert.match(definition, /private\/runtime-work/);
    assert.doesNotMatch(definition, /Bearer |eyJ[A-Za-z0-9_-]+\.|password|secret|datasource|hibernate|bootstrap\.super|file-service/i);
  }
});

test("slim workflow runtime prepares only a private working directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-workflow-working-directory-"));
  const spec = {
    runtimeDataPath: path.join(root, "runtime-data"),
    runtimePropertiesPath: path.join(root, "runtime.properties"),
    runtimeWorkingDirectory: path.join(root, "runtime-work"),
  };

  prepareRuntimeDirectory(spec);
  assert.equal(fs.statSync(spec.runtimeWorkingDirectory).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(spec.runtimePropertiesPath), false);
  assert.equal(fs.existsSync(spec.runtimeDataPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});
