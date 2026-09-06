import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SERVICE_RUNTIME_FILES,
  serviceDefinition,
  serviceSpec,
  stageServiceRuntime,
} from "../scripts/swarm-service.mjs";

const loaded = {
  config: {
    machineId: "stable-service-host",
    serverUrl: "https://api-0.valkyrlabs.com/v1",
    agents: [{ agentId: "codex-stable-service-host", runtime: "codex" }],
  },
  configPath: "/private/config/agent-stable-service-host.json",
};

test("native service definitions use a private content-addressed runtime outside the plugin cache", () => {
  for (const platform of ["darwin", "linux"]) {
    const spec = serviceSpec({}, loaded, platform);
    const definition = serviceDefinition(spec);

    assert.match(spec.serviceRuntimeDigest, /^[a-f0-9]{64}$/);
    assert.equal(
      spec.agentScript,
      path.join(spec.serviceRuntimeRoot, "swarm-agent.mjs"),
    );
    assert.match(
      spec.serviceRuntimeRoot,
      /\.local[\\/]share[\\/]valkyr-swarm[\\/]service-runtimes[\\/][a-f0-9]{64}$/,
    );
    assert.equal(definition.includes(spec.agentScript), true);
    assert.equal(definition.includes(spec.serviceRuntimeRoot), true);
    assert.equal(definition.includes(".codex/plugins/cache"), false);
  }
});

test("service runtime staging copies the exact dependency closure and fails closed on tampering", () => {
  assert.equal(SERVICE_RUNTIME_FILES.includes("swarm-node-contract.mjs"), true);
  assert.equal(SERVICE_RUNTIME_FILES.includes("swarm-local-inference-provider.mjs"), true);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "valkyr-swarm-service-runtime-"),
  );
  try {
    const generated = serviceSpec({}, loaded, "darwin");
    const runtimeRoot = path.join(temporaryRoot, generated.serviceRuntimeDigest);
    const spec = {
      ...generated,
      agentScript: path.join(runtimeRoot, "swarm-agent.mjs"),
      serviceRuntimeRoot: runtimeRoot,
    };

    assert.equal(stageServiceRuntime(spec), runtimeRoot);
    assert.equal(fs.statSync(runtimeRoot).mode & 0o777, 0o700);
    for (const name of SERVICE_RUNTIME_FILES) {
      const installed = path.join(runtimeRoot, name);
      assert.equal(fs.statSync(installed).isFile(), true);
      assert.equal(fs.statSync(installed).mode & 0o777, 0o600);
    }

    assert.equal(stageServiceRuntime(spec), runtimeRoot);
    const linkedRoot = path.join(temporaryRoot, "linked-runtime");
    fs.symlinkSync(runtimeRoot, linkedRoot, "dir");
    assert.throws(
      () => stageServiceRuntime({
        ...spec,
        agentScript: path.join(linkedRoot, "swarm-agent.mjs"),
        serviceRuntimeRoot: linkedRoot,
      }),
      /not a private directory/,
    );
    fs.appendFileSync(spec.agentScript, "\n// tampered\n");
    assert.throws(
      () => stageServiceRuntime(spec),
      /failed content verification/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
