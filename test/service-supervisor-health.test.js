import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  probeServiceBinding,
  resolveServiceBindings,
} from "../scripts/swarm-service-lifecycle.mjs";

const cases = [
  ["launchd running process", "darwin", 0, "state = running\npid = 42\n", true],
  ["launchd loaded but waiting", "darwin", 0, "state = waiting\n", false],
  ["launchd loaded after process exit", "darwin", 0, "state = exited\nlast exit code = 1\n", false],
  ["launchd running without a process", "darwin", 0, "state = running\npid = 0\n", false],
  ["launchd failed lookup with stale output", "darwin", 1, "state = running\npid = 42\n", false],
  ["systemd running process", "linux", 0, "ActiveState=active\nSubState=running\nMainPID=43\n", true],
  ["systemd exited active unit", "linux", 0, "ActiveState=active\nSubState=exited\nMainPID=0\n", false],
  ["systemd exited unit with stale process reference", "linux", 0, "ActiveState=active\nSubState=exited\nMainPID=43\n", false],
  ["systemd running without a process", "linux", 0, "ActiveState=active\nSubState=running\nMainPID=0\n", false],
];

for (const [name, platform, status, stdout, expectedRunning] of cases) {
  test(`supervisor health: ${name}`, (t) => {
    const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-supervisor-health-"));
    t.after(() => fs.rmSync(homedir, { recursive: true, force: true }));
    const options = {
      agent: { agentId: "codex-fixture-host", runtime: "codex" },
      machineId: "fixture-host",
      platform,
      homedir,
    };
    const definition = resolveServiceBindings(options)[0].definitionPath;
    fs.mkdirSync(path.dirname(definition), { recursive: true });
    fs.writeFileSync(definition, "fixture service definition");
    const binding = resolveServiceBindings(options)[0];
    const result = probeServiceBinding(binding, {
      uid: 501,
      spawnImpl: () => ({ status, stdout }),
    });
    assert.equal(result.installed, true);
    assert.equal(result.running, expectedRunning);
    assert.equal(result.state, expectedRunning ? "running" : "stopped");
  });
}
