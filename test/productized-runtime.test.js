import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildConfig,
  requireProductionApiBase,
  writeConfig,
} from "../scripts/swarm-activate.mjs";
import {
  buildRuntimeInvocation,
  executeRuntimeCommand,
  runtimeExecutionConfig,
  supervisedRuntimeEnvironment,
  validateRuntimeAdapter,
} from "../scripts/swarm-runtime-adapters.mjs";

function fakeSpawn(stdoutText, stderrText = "", exitCode = 0) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("close", 143, "SIGTERM");
    process.nextTick(() => {
      if (stdoutText) child.stdout.write(stdoutText);
      if (stderrText) child.stderr.write(stderrText);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

test("normal activation is production-only and auto-enables executable runtimes", () => {
  assert.throws(
    () => requireProductionApiBase("https://loki.valkyrlabs.com/v1"),
    /Durable SWARM activation must use/,
  );
  const target = buildConfig({
    runtime: "codex",
    machineId: "Product Host",
    runtimeExecutable: "/bin/echo",
    workspace: "/tmp",
  });
  assert.equal(target.apiBase, "https://api-0.valkyrlabs.com/v1");
  assert.equal(target.config.agents[0].execution.adapter, "codex-cli");
  assert.equal(target.config.agents[0].execution.executable, "/bin/echo");
});

test("activation merges multiple product nodes into one supervised machine config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-swarm-activation-"));
  const config = path.join(root, "agent.json");
  const receipt = path.join(root, "receipt.jsonl");
  const first = buildConfig({
    runtime: "codex",
    machineId: "shared-host",
    runtimeExecutable: "/bin/echo",
    config,
    receiptLog: receipt,
  });
  writeConfig(first);
  const second = buildConfig({
    runtime: "valoride",
    machineId: "shared-host",
    runtimeExecutable: "/bin/echo",
    config,
    receiptLog: receipt,
  });
  writeConfig(second);
  const saved = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.deepEqual(saved.agents.map((agent) => agent.agentId), [
    "codex-shared-host",
    "valoride-shared-host",
  ]);
  assert.deepEqual(saved.agents.map((agent) => agent.execution.adapter), [
    "codex-cli",
    "valoride-cli",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Codex execution streams progress and returns a terminal artifact", async () => {
  const agent = {
    agentId: "codex-host",
    runtime: "codex",
    execution: {
      adapter: "codex-cli",
      agentId: "codex-host",
      executable: "/bin/codex",
      timeoutSeconds: 30,
      workingDirectory: "/tmp",
    },
  };
  validateRuntimeAdapter(agent);
  const config = runtimeExecutionConfig(agent);
  const invocation = buildRuntimeInvocation(
    config,
    { commandId: "cmd-1" },
    "Inspect without protected actions",
  );
  assert.deepEqual(invocation.args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  const progress = [];
  const result = await executeRuntimeCommand({
    agent,
    wire: {
      action: "workflow.debug",
      commandId: "cmd-1",
      command: { data: { instruction: "Inspect" } },
      trace: { traceId: "trace-1" },
    },
    spawnImpl: fakeSpawn('{"type":"item.completed","text":"done"}\n'),
    onProgress: (event) => progress.push(event),
  });
  assert.equal(result.executed, true);
  assert.equal(result.adapter, "codex-cli");
  assert.match(result.artifact.output, /item.completed/);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].stream, "stdout");
});

test("supervised runtime execution always makes the active Node binary discoverable", () => {
  const env = supervisedRuntimeEnvironment({ PATH: "/usr/bin:/bin" });
  assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.equal(env.PATH.split(path.delimiter).includes("/usr/bin"), true);
});
