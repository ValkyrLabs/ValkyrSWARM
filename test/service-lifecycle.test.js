import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commandDisposition } from "../scripts/swarm-agent.mjs";
import { commandReceiptText } from "../scripts/swarm-graymatter.mjs";
import {
  SERVICE_RESTART_ACTION,
  SERVICE_STATUS_ACTION,
  buildServiceLifecycleState,
  executeServiceLifecycleCommand,
  parseServiceLifecyclePayload,
  readPendingRecoveries,
  resolveServiceBindings,
  restartServiceBinding,
} from "../scripts/swarm-service-lifecycle.mjs";

function fixture({ runtime = "codex", workflowTier = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valkyr-service-lifecycle-"));
  const agent = {
    agentId: `${runtime}-fixture-host`,
    runtime,
    capabilities: ["workflow.debug"],
    ...(workflowTier ? {
      workflowRuntime: {
        enabled: true,
        tier: workflowTier,
      },
    } : {}),
  };
  const launchAgents = path.join(root, "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true });
  return {
    agent,
    bridgePath: path.join(
      launchAgents,
      "com.valkyrlabs.swarm.fixture-host.plist",
    ),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    homedir: root,
    recoveryRoot: path.join(root, ".config", "valkyr-swarm", "service-recovery"),
    workflowPath: path.join(
      launchAgents,
      `com.valkyrlabs.workflow-runtime.${agent.agentId}.plist`,
    ),
  };
}

function launchdSpawn(calls, { status = 0, pid = 42 } = {}) {
  return (executable, args) => {
    calls.push({ executable, args });
    return {
      status,
      stdout: args[0] === "print" && status === 0 ? `pid = ${pid}\nstate = running\n` : "",
      stderr: status === 0 ? "" : "not loaded",
    };
  };
}

function wire(action, serviceHandle, extraPayload = {}) {
  return {
    action,
    commandId: "command-1",
    targetInstanceId: "codex-fixture-host",
    trace: { traceId: "trace-1" },
    command: {
      action,
      payload: {
        expectedMachineId: "fixture-host",
        serviceHandle,
        ...extraPayload,
      },
      ...(action === SERVICE_RESTART_ACTION ? {
        approvalRef: `gm_approval_${"a".repeat(64)}`,
        requiresApproval: true,
      } : {}),
    },
  };
}

test("service capabilities are advertised only for installed native supervisor bindings", () => {
  const supervised = fixture();
  const calls = [];
  fs.writeFileSync(supervised.bridgePath, "<plist/>");
  const state = buildServiceLifecycleState({
    agent: supervised.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: supervised.homedir,
    spawnImpl: launchdSpawn(calls),
    uid: 501,
  });
  assert.deepEqual(state.capabilities, [
    SERVICE_STATUS_ACTION,
    SERVICE_RESTART_ACTION,
  ]);
  assert.deepEqual(
    state.metadata.services.filter((service) => service.installed)
      .map((service) => service.handle),
    ["codex", "swarm-bridge"],
  );
  assert.equal(JSON.stringify(state.metadata).includes("com.valkyrlabs"), false);
  assert.equal(JSON.stringify(state.metadata).includes(supervised.homedir), false);
  supervised.cleanup();

  const interactiveClaude = fixture({ runtime: "claude-code" });
  const unsupported = buildServiceLifecycleState({
    agent: interactiveClaude.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: interactiveClaude.homedir,
    spawnImpl: launchdSpawn([]),
    uid: 501,
  });
  assert.deepEqual(unsupported.capabilities, []);
  assert.equal(
    unsupported.metadata.services.find((service) => service.handle === "claude-code")
      .restartable,
    false,
  );
  interactiveClaude.cleanup();
});

test("workflow runner and engine bindings use only deterministic canonical labels", () => {
  const runner = fixture({ workflowTier: "runner" });
  fs.writeFileSync(runner.bridgePath, "<plist/>");
  fs.writeFileSync(runner.workflowPath, "<plist/>");
  const bindings = resolveServiceBindings({
    agent: runner.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: runner.homedir,
  });
  const workflow = bindings.find((item) => item.handle === "workflow-runner");
  assert.equal(workflow.label, `com.valkyrlabs.workflow-runtime.${runner.agent.agentId}`);
  assert.equal(workflow.selfRestart, false);
  runner.cleanup();
});

test("lifecycle payload rejects host mismatch and caller-selected supervisor material", () => {
  assert.throws(
    () => parseServiceLifecyclePayload(
      wire(SERVICE_STATUS_ACTION, "codex", { label: "com.attacker.service" }),
      "fixture-host",
    ),
    /field is not allowed/,
  );
  assert.throws(
    () => parseServiceLifecyclePayload({
      ...wire(SERVICE_STATUS_ACTION, "codex"),
      command: {
        payload: {
          expectedMachineId: "another-host",
          serviceHandle: "codex",
        },
      },
    }, "fixture-host"),
    /host mismatch/,
  );
  assert.throws(
    () => parseServiceLifecyclePayload(
      wire(SERVICE_STATUS_ACTION, "../../bin/sh"),
      "fixture-host",
    ),
    /handle is unsupported/,
  );
});

test("native supervisor argv is fixed and never includes shell interpolation", () => {
  const fx = fixture();
  fs.writeFileSync(fx.bridgePath, "<plist/>");
  const binding = resolveServiceBindings({
    agent: fx.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: fx.homedir,
  }).find((item) => item.handle === "codex");
  const calls = [];
  restartServiceBinding(binding, {
    spawnImpl: launchdSpawn(calls),
    uid: 501,
  });
  assert.deepEqual(calls, [{
    executable: "/bin/launchctl",
    args: [
      "kickstart",
      "-k",
      "gui/501/com.valkyrlabs.swarm.fixture-host",
    ],
  }]);
  assert.equal(calls.some(({ executable }) => /sh$/.test(executable)), false);
  fx.cleanup();
});

test("read-only status is bounded and protected restart requires canonical approval", async () => {
  const fx = fixture();
  fs.writeFileSync(fx.bridgePath, "<plist/>");
  const state = buildServiceLifecycleState({
    agent: fx.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: fx.homedir,
    spawnImpl: launchdSpawn([]),
    uid: 501,
  });
  fx.agent.serviceLifecycleState = state;
  const statusRoute = commandDisposition(
    wire(SERVICE_STATUS_ACTION, "codex"),
    fx.agent,
  );
  assert.equal(statusRoute.disposition, "accept");
  const restartWithoutApproval = wire(SERVICE_RESTART_ACTION, "codex");
  delete restartWithoutApproval.command.approvalRef;
  assert.equal(
    commandDisposition(restartWithoutApproval, fx.agent).reason,
    "protected_action_requires_canonical_human_approval",
  );
  const status = await executeServiceLifecycleCommand({
    agent: fx.agent,
    machineId: "fixture-host",
    state,
    wire: wire(SERVICE_STATUS_ACTION, "codex"),
    spawnImpl: launchdSpawn([]),
    uid: 501,
  });
  assert.equal(status.service.running, true);
  assert.equal(status.service.handle, "codex");
  assert.equal(JSON.stringify(status).includes("com.valkyrlabs"), false);
  fx.cleanup();
});

test("shared bridge restart checkpoints durable recovery before invoking launchd", async () => {
  const fx = fixture();
  fs.writeFileSync(fx.bridgePath, "<plist/>");
  const calls = [];
  const state = buildServiceLifecycleState({
    agent: fx.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: fx.homedir,
    spawnImpl: launchdSpawn(calls),
    uid: 501,
  });
  const result = await executeServiceLifecycleCommand({
    agent: fx.agent,
    machineId: "fixture-host",
    recoveryRoot: fx.recoveryRoot,
    state,
    wire: wire(SERVICE_RESTART_ACTION, "codex"),
    spawnImpl: launchdSpawn(calls),
    uid: 501,
  });
  assert.equal(result.pendingRecovery, true);
  const pending = readPendingRecoveries({
    agentId: fx.agent.agentId,
    recoveryRoot: fx.recoveryRoot,
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].record.serviceHandle, "codex");
  assert.match(pending[0].record.approvalRef, /^gm_approval_[0-9a-f]{64}$/);
  assert.equal(calls.some(({ args }) => args[0] === "kickstart"), true);
  fx.cleanup();
});

test("failed shared bridge restart removes its pending recovery checkpoint", async () => {
  const fx = fixture();
  fs.writeFileSync(fx.bridgePath, "<plist/>");
  const state = buildServiceLifecycleState({
    agent: fx.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: fx.homedir,
    spawnImpl: launchdSpawn([]),
    uid: 501,
  });

  await assert.rejects(
    executeServiceLifecycleCommand({
      agent: fx.agent,
      machineId: "fixture-host",
      recoveryRoot: fx.recoveryRoot,
      state,
      wire: wire(SERVICE_RESTART_ACTION, "codex"),
      spawnImpl: () => ({ status: 5, stdout: "", stderr: "fixture failure" }),
      uid: 501,
    }),
    /Native supervisor restart failed/,
  );

  assert.equal(readPendingRecoveries({
    agentId: fx.agent.agentId,
    recoveryRoot: fx.recoveryRoot,
  }).length, 0);
  fx.cleanup();
});

test("separately supervised workflow restart completes only with fresh heartbeat proof", async () => {
  const fx = fixture({ workflowTier: "engine" });
  fs.writeFileSync(fx.bridgePath, "<plist/>");
  fs.writeFileSync(fx.workflowPath, "<plist/>");
  const state = buildServiceLifecycleState({
    agent: fx.agent,
    machineId: "fixture-host",
    platform: "darwin",
    homedir: fx.homedir,
    spawnImpl: launchdSpawn([]),
    uid: 501,
  });
  const inspected = await executeServiceLifecycleCommand({
    agent: fx.agent,
    machineId: "fixture-host",
    state,
    wire: wire(SERVICE_STATUS_ACTION, "workflow-engine"),
    spawnImpl: launchdSpawn([]),
    uid: 501,
  });
  assert.equal(inspected.service.running, true);
  const restartWire = wire(SERVICE_RESTART_ACTION, "workflow-engine");
  const completed = await executeServiceLifecycleCommand({
    agent: fx.agent,
    machineId: "fixture-host",
    state,
    wire: restartWire,
    spawnImpl: launchdSpawn([]),
    uid: 501,
    verifyRecovery: async () => ({
      capabilities: ["workflow.engine.execute-workflow"],
      healthy: true,
      heartbeatAt: new Date().toISOString(),
      heartbeatFresh: true,
      version: "1.2.3",
    }),
  });
  assert.equal(completed.executed, true);
  assert.equal(completed.proof.heartbeatFresh, true);
  const receipt = JSON.parse(commandReceiptText({
    agent: fx.agent,
    wire: restartWire,
    response: {
      type: "ACK",
      status: "completed",
      result: completed,
    },
  }));
  assert.equal(receipt.protectedAction, true);
  assert.equal(receipt.result.serviceHandle, "workflow-engine");
  assert.equal(receipt.result.proof.heartbeatFresh, true);
  assert.equal(receipt.result.proof.version, "1.2.3");
  assert.equal(JSON.stringify(receipt).includes("com.valkyrlabs"), false);

  await assert.rejects(
    executeServiceLifecycleCommand({
      agent: fx.agent,
      machineId: "fixture-host",
      state,
      wire: restartWire,
      spawnImpl: launchdSpawn([]),
      uid: 501,
      verifyRecovery: async () => ({
        healthy: true,
        heartbeatFresh: false,
      }),
    }),
    /fresh recovery proof/,
  );
  fx.cleanup();
});
