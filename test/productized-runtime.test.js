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
  resolveWorkflowRuntimeRelease,
  selectCapabilityPacksForAgent,
  validateWorkflowReleaseDescriptor,
  workflowRuntimeForegroundArguments,
  writeConfig,
} from "../scripts/swarm-activate.mjs";
import {
  buildOpenClawPrompt,
  buildRuntimeInvocation,
  buildRuntimePrompt,
  executeRuntimeCommand,
  runtimeExecutionConfig,
  supervisedRuntimeEnvironment,
  terminalAgentText,
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
  assert.equal(target.config.agents[0].capabilities.includes("merge"), true);

  const openclaw = buildConfig({
    runtime: "openclaw",
    machineId: "Marketing Host",
    runtimeExecutable: "/bin/echo",
  }).config.agents[0];
  for (const capability of [
    "market.research", "crm.write", "inbound.triage", "cms.write", "outbound.send",
    "openclaw.skill.execute", "openclaw.research-draft.execute",
  ]) {
    assert.equal(openclaw.capabilities.includes(capability), true);
  }

  const valoride = buildConfig({
    runtime: "valoride",
    machineId: "Build Host",
    runtimeExecutable: "/bin/echo",
  }).config.agents[0];
  assert.equal(valoride.capabilities.includes("production.deploy"), true);
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

test("activation productizes an optional checksum-pinned local Workflow runtime", () => {
  const target = buildConfig({
    runtime: "codex",
    machineId: "workflow-host",
    runtimeExecutable: "/bin/echo",
    workflowRuntime: true,
    workflowArtifactUrl: "https://downloads.example.test/valkyrai-workflow-runtime.jar",
    workflowArtifactSha256: "a".repeat(64),
    workflowRuntimePort: "9876",
    workflowRuntimeMaxHeap: "768M",
  });
  const runtime = target.config.agents[0].workflowRuntime;
  assert.equal(runtime.endpoint, "http://127.0.0.1:9876/v1/swarm/workflow-runs/execute");
  assert.equal(runtime.supportedTools.includes("workflow.runner.execute-module"), true);
  assert.equal(runtime.install.sha256, "a".repeat(64));
  assert.deepEqual(runtime.install.jvmArgs, ["-Xms128m", "-Xmx768m"]);
  assert.equal(target.config.agents[0].capabilities.includes("workflow.runner.execute-module"), false);
});

test("foreground activation launches the requested Workflow tier through the productized service", () => {
  const args = workflowRuntimeForegroundArguments(
    "/private/agent.json",
    "codex-workflow-host",
  );
  assert.deepEqual(args.slice(1), [
    "foreground",
    "--config", "/private/agent.json",
    "--agent", "codex-workflow-host",
  ]);
  assert.match(args[0], /scripts\/swarm-workflow-service\.mjs$/);
  assert.equal(args.some((arg) => /token|password|authorization|bearer/i.test(arg)), false);
});

test("activation productizes the durable Workflow engine as a separate advertised tier", () => {
  const target = buildConfig({
    runtime: "codex",
    machineId: "engine-host",
    runtimeExecutable: "/bin/echo",
    workflowEngine: true,
    workflowArtifactUrl: "https://downloads.example.test/valkyrai-workflow-engine.jar",
    workflowArtifactSha256: "e".repeat(64),
    workflowCredentialRefs: "keychain:OPENCLAW_API:default,credential:research-token",
  });
  const runtime = target.config.agents[0].workflowRuntime;
  assert.equal(runtime.tier, "engine");
  assert.equal(runtime.endpoint, "http://127.0.0.1:8767/v1/swarm/workflow-engine/execute");
  assert.equal(runtime.healthEndpoint, "http://127.0.0.1:8767/v1/swarm/workflow-engine/health");
  assert.deepEqual(runtime.supportedTools, ["workflow.engine.execute-workflow"]);
  assert.equal(runtime.install.tier, "engine");
  assert.equal(runtime.install.sha256, "e".repeat(64));
  assert.deepEqual(runtime.workspaceRoots, [process.cwd()]);
  assert.equal(target.config.agents[0].capabilities.includes("workspace.files.read"), true);
  assert.equal(target.config.agents[0].capabilities.includes("engineering.project.execute"), true);
  assert.deepEqual(runtime.credentialReferences, [
    "credential:research-token",
    "keychain:OPENCLAW_API:default",
  ]);
  assert.throws(() => buildConfig({
    runtime: "codex",
    machineId: "runner-with-credentials",
    runtimeExecutable: "/bin/echo",
    workflowRuntime: true,
    workflowCredentialRefs: "credential:forbidden",
  }), /runner does not accept credential references/);
});

test("deployment capability is productized only with an exact node-local runner", () => {
  const target = buildConfig({
    runtime: "valoride",
    machineId: "deployment-host",
    runtimeExecutable: "/bin/echo",
    workflowEngine: true,
    workflowArtifactUrl: "https://downloads.example.test/valkyrai-workflow-engine.jar",
    workflowArtifactSha256: "e".repeat(64),
    deploymentRunnerEndpoint: "http://127.0.0.1:3002/api/deployments/execute",
    deploymentCredentialRef: "keychain:VALKYR_DEPLOY:primary",
  });
  const agent = target.config.agents[0];
  assert.equal(agent.capabilities.includes("production.deploy"), true);
  assert.equal(agent.capabilities.includes("deployment.runner.execute"), true);
  assert.deepEqual(agent.workflowRuntime.allowedEnvironments, ["sandbox", "staging", "production"]);
  assert.deepEqual(agent.workflowRuntime.deploymentRunner, {
    endpoint: "http://127.0.0.1:3002/api/deployments/execute",
    healthEndpoint: "http://127.0.0.1:3002/api/deployments/health",
    protocol: "valkyr-deployment-runner/v1",
    credentialReference: "keychain:VALKYR_DEPLOY:primary",
  });
  assert.deepEqual(agent.workflowRuntime.credentialReferences,
    ["keychain:VALKYR_DEPLOY:primary"]);

  assert.throws(() => buildConfig({
    runtime: "valoride",
    machineId: "unsafe-deployment-host",
    runtimeExecutable: "/bin/echo",
    workflowEngine: true,
    deploymentRunnerEndpoint: "https://deploy.example/api/deployments/execute",
  }), /exact loopback/);
  assert.throws(() => buildConfig({
    runtime: "valoride",
    machineId: "runner-only-host",
    runtimeExecutable: "/bin/echo",
    deploymentRunnerEndpoint: "http://127.0.0.1:3002/api/deployments/execute",
  }), /requires the durable Workflow engine/);
});

test("activation rejects unbounded Workflow runtime heap configuration", () => {
  assert.throws(() => buildConfig({
    runtime: "codex",
    machineId: "workflow-host",
    runtimeExecutable: "/bin/echo",
    workflowRuntime: true,
    workflowRuntimeMaxHeap: "16g",
  }), /between 256m and 8g/);
  assert.throws(() => buildConfig({
    runtime: "codex",
    machineId: "workflow-host",
    runtimeExecutable: "/bin/echo",
    workflowRuntime: true,
    workflowRuntimeMaxHeap: "768",
  }), /whole-number m or g suffix/);
});

test("activation discovers the approved Workflow runtime release with the authenticated session", async () => {
  const target = buildConfig({
    runtime: "codex",
    machineId: "workflow-host",
    runtimeExecutable: "/bin/echo",
    workflowRuntime: true,
  });
  const install = target.config.agents[0].workflowRuntime.install;
  assert.equal(install.releaseDiscovery, true);
  assert.equal(install.artifactUrl, undefined);
  assert.deepEqual(install.jvmArgs, ["-Xms128m", "-Xmx3g"]);
  assert.equal(install.useReleaseRecommendedHeap, true);

  let request;
  await resolveWorkflowRuntimeRelease(target, "private-session", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return {
          protocol: "valkyr-workflow-runtime-release/v1",
          runnerProtocol: "valkyr-workflow-runner/v1",
          version: "1.0.3",
          artifactUrl: "https://downloads.example.test/runner-1.0.3.jar",
          sha256: "B".repeat(64),
          minimumJavaVersion: 17,
          recommendedMaxHeap: "384M",
        };
      },
    };
  });

  assert.equal(request.url, "https://api-0.valkyrlabs.com/v1/swarm/workflow-runtime/release");
  assert.equal(request.options.headers.Authorization, "Bearer private-session");
  assert.equal(install.releaseDiscovery, undefined);
  assert.equal(install.sha256, "b".repeat(64));
  assert.equal(install.version, "1.0.3");
  assert.equal(install.minimumJavaVersion, 17);
  assert.deepEqual(install.jvmArgs, ["-Xms64m", "-Xmx384m"]);
  assert.equal(install.useReleaseRecommendedHeap, undefined);
});

test("activation discovers the independently versioned durable engine release", async () => {
  const target = buildConfig({
    runtime: "openclaw",
    machineId: "engine-host",
    runtimeExecutable: "/bin/echo",
    workflowEngine: true,
  });
  let requestUrl;
  await resolveWorkflowRuntimeRelease(target, "private-session", async (url) => {
    requestUrl = url;
    return {
      ok: true,
      async json() {
        return {
          protocol: "valkyr-workflow-runtime-release/v1",
          tier: "engine",
          runtimeProtocol: "valkyr-workflow-engine/v1",
          engineProtocol: "valkyr-workflow-engine/v1",
          version: "1.0.3-engine",
          artifactUrl: "https://downloads.example.test/engine-1.0.3.jar",
          sha256: "f".repeat(64),
          minimumJavaVersion: 17,
          recommendedMaxHeap: "768m",
          capabilityPacks: [{
            id: "openclaw-research-drafting",
            version: "1.0.0",
            artifactUrl: "https://downloads.example.test/packs/openclaw-research-drafting-1.0.0.jar",
            sha256: "b".repeat(64),
            requiredNodeCapabilities: ["openclaw.skill.execute", "openclaw.research-draft.execute"],
          }, {
            id: "openclaw-gtm",
            version: "2.0.0",
            artifactUrl: "https://downloads.example.test/packs/openclaw-gtm-2.0.0.jar",
            sha256: "c".repeat(64),
            requiredNodeCapabilities: ["openclaw.skill.execute", "outbound.send"],
          }, {
            id: "deployment",
            version: "1.0.0",
            artifactUrl: "https://downloads.example.test/packs/deployment-1.0.0.jar",
            sha256: "d".repeat(64),
            requiredNodeCapabilities: ["deployment.runner.execute", "production.deploy"],
          }],
        };
      },
    };
  });
  const install = target.config.agents[0].workflowRuntime.install;
  assert.equal(requestUrl, "https://api-0.valkyrlabs.com/v1/swarm/workflow-runtime/release?tier=engine");
  assert.equal(install.tier, "engine");
  assert.equal(install.engineProtocol, "valkyr-workflow-engine/v1");
  assert.equal(install.runtimeProtocol, "valkyr-workflow-engine/v1");
  assert.deepEqual(install.jvmArgs, ["-Xms64m", "-Xmx768m"]);
  assert.deepEqual(install.capabilityPacks, [{
    id: "openclaw-research-drafting",
    version: "1.0.0",
    artifactUrl: "https://downloads.example.test/packs/openclaw-research-drafting-1.0.0.jar",
    sha256: "b".repeat(64),
    requiredNodeCapabilities: ["openclaw.research-draft.execute", "openclaw.skill.execute"],
  }, {
    id: "openclaw-gtm",
    version: "2.0.0",
    artifactUrl: "https://downloads.example.test/packs/openclaw-gtm-2.0.0.jar",
    sha256: "c".repeat(64),
    requiredNodeCapabilities: ["openclaw.skill.execute", "outbound.send"],
  }]);
  assert.deepEqual(install.skippedCapabilityPacks, [{
    id: "deployment",
    missingCapabilities: ["deployment.runner.execute", "production.deploy"],
  }]);
});

test("configured ValorIDE deployment engine selects the deployment pack", () => {
  const agent = buildConfig({
    runtime: "valoride",
    machineId: "deployment-host",
    runtimeExecutable: "/bin/echo",
    workflowEngine: true,
    deploymentRunnerEndpoint: "http://127.0.0.1:3002/api/deployments/execute",
  }).config.agents[0];
  const selection = selectCapabilityPacksForAgent([{
    id: "deployment",
    version: "1.0.0",
    requiredNodeCapabilities: ["deployment.runner.execute", "production.deploy"],
  }], agent);

  assert.deepEqual(selection.selected.map((pack) => pack.id), ["deployment"]);
  assert.deepEqual(selection.skipped, []);
});

test("capability selection cannot install outbound GTM on a research-only ValKlaw node", () => {
  const agent = buildConfig({
    runtime: "valklaw",
    machineId: "Research Host",
    runtimeExecutable: "/bin/echo",
  }).config.agents[0];
  const releases = [{
    id: "openclaw-research-drafting",
    version: "1.0.0",
    requiredNodeCapabilities: ["openclaw.skill.execute", "openclaw.research-draft.execute"],
  }, {
    id: "openclaw-gtm",
    version: "2.0.0",
    requiredNodeCapabilities: ["openclaw.skill.execute", "outbound.send"],
  }];

  const selection = selectCapabilityPacksForAgent(releases, agent);

  assert.deepEqual(selection.selected.map((pack) => pack.id), ["openclaw-research-drafting"]);
  assert.deepEqual(selection.skipped, [{
    id: "openclaw-gtm",
    missingCapabilities: ["outbound.send"],
  }]);
});

test("Workflow runtime release discovery fails closed on unsafe or incompatible metadata", () => {
  const base = {
    protocol: "valkyr-workflow-runtime-release/v1",
    runnerProtocol: "valkyr-workflow-runner/v1",
    version: "1.0.3",
    artifactUrl: "https://downloads.example.test/runner.jar",
    sha256: "a".repeat(64),
    minimumJavaVersion: 17,
    recommendedMaxHeap: "384m",
  };
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...base, protocol: "unknown/v1" }),
    /Unsupported Workflow runtime release protocol/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...base, runnerProtocol: "unknown/v1" }),
    /Unsupported Workflow runner protocol/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...base, artifactUrl: "https://user:secret@example.test/runner.jar" }),
    /credential-free HTTPS/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...base, sha256: "not-a-digest" }),
    /SHA-256 is invalid/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...base, recommendedMaxHeap: "64g" }),
    /recommended max heap is invalid/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...base, capabilityPacks: [{
      id: "research",
      version: "1.0.0",
      artifactUrl: "https://downloads.example.test/research.jar",
      sha256: "c".repeat(64),
    }] }),
    /runner release must not include capability packs/,
  );
  const engine = {
    ...base,
    tier: "engine",
    runtimeProtocol: "valkyr-workflow-engine/v1",
    engineProtocol: "valkyr-workflow-engine/v1",
    runnerProtocol: undefined,
  };
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...engine, capabilityPacks: [{
      id: "research",
      version: "1.0.0",
      artifactUrl: "https://user:secret@downloads.example.test/research.jar",
      sha256: "c".repeat(64),
    }] }, "engine"),
    /credential-free HTTPS/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...engine, capabilityPacks: [
      { id: "research", version: "1.0.0", artifactUrl: "https://downloads.example.test/r1.jar", sha256: "c".repeat(64) },
      { id: "research", version: "1.0.1", artifactUrl: "https://downloads.example.test/r2.jar", sha256: "d".repeat(64) },
    ] }, "engine"),
    /invalid or duplicated/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...engine, capabilityPacks: [
      { id: "core-transforms", version: "1.0.0", artifactUrl: "https://downloads.example.test/core.jar", sha256: "c".repeat(64) },
    ] }, "engine"),
    /invalid or duplicated/,
  );
  assert.throws(
    () => validateWorkflowReleaseDescriptor({ ...engine, capabilityPacks: [{
      id: "research",
      version: "1.0.0",
      artifactUrl: "https://downloads.example.test/research.jar",
      sha256: "c".repeat(64),
      requiredNodeCapabilities: ["market.research", "header\ninjection"],
    }] }, "engine"),
    /required node capability is invalid/,
  );
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

test("runtime prompt authorizes only the exact content-bound protected action", () => {
  const approvalRef = `gm_approval_${"b".repeat(64)}`;
  const prompt = buildRuntimePrompt({
    action: "merge",
    commandId: "cmd-approved-merge",
    command: { requiresApproval: true, approvalRef, data: { pullRequest: 42 } },
    trace: { traceId: "trace-approved-merge" },
  }, { agentId: "codex-host", runtime: "codex" });
  assert.match(prompt, new RegExp(approvalRef));
  assert.match(prompt, /authorizes only the exact protected action merge/);
  assert.match(prompt, /Do not perform any other outbound send/);
});

test("autonomous OpenClaw drafting remains explicitly unable to send", () => {
  const prompt = buildOpenClawPrompt({
    action: "outreach.draft",
    commandId: "cmd-draft-only",
    command: { data: { objective: "Draft a follow-up", recipient: "lead@example.test" } },
    trace: { traceId: "trace-draft-only" },
  }, { agentId: "openclaw-marketing", runtime: "openclaw" });

  assert.match(prompt, /SWARM action: outreach\.draft/);
  assert.match(prompt, /Protected actions remain prohibited/);
  assert.match(prompt, /do not send outbound messages/);
  assert.doesNotMatch(prompt, /authorizes only the exact protected action/);
});

test("runtime prompt keeps bounded commands from expanding into unrelated work", () => {
  const prompt = buildRuntimePrompt({
    action: "workflow.debug",
    commandId: "cmd-read-only",
    command: { data: { instruction: "Read the first heading in README.md" } },
    trace: { traceId: "trace-read-only" },
  }, { agentId: "codex-host", runtime: "codex" });

  assert.match(prompt, /Obey only the bounded Task payload/);
  assert.match(prompt, /Do not expand a direct or read-only task/);
  assert.match(prompt, /Use GrayMatter for durable shared context/);
});

test("OpenClaw and ValorIDE adapters execute and stream terminal progress", async () => {
  const cases = [
    {
      agent: {
        agentId: "openclaw-marketing",
        runtime: "openclaw",
        execution: {
          adapter: "openclaw-agent",
          agentId: "valor",
          executable: "/bin/openclaw",
          timeoutSeconds: 30,
          workingDirectory: "/tmp",
          requireGateway: true,
        },
      },
      action: "market.research",
      output: JSON.stringify({
        payloads: [{ text: "market result" }],
        meta: { transport: "gateway", runId: "run-openclaw" },
      }),
      adapter: "openclaw-agent",
    },
    {
      agent: {
        agentId: "valoride-builder",
        runtime: "valoride",
        execution: {
          adapter: "valoride-cli",
          agentId: "valoride-builder",
          executable: "/bin/valoride",
          timeoutSeconds: 30,
          workingDirectory: "/tmp",
        },
      },
      action: "code.execute",
      output: "implemented and verified\n",
      adapter: "valoride-cli",
    },
  ];

  for (const item of cases) {
    validateRuntimeAdapter(item.agent);
    const progress = [];
    const result = await executeRuntimeCommand({
      agent: item.agent,
      wire: {
        action: item.action,
        commandId: `cmd-${item.agent.agentId}`,
        command: { data: { objective: "complete bounded work" } },
        trace: { traceId: `trace-${item.agent.agentId}` },
      },
      spawnImpl: fakeSpawn(item.output),
      onProgress: (event) => progress.push(event),
    });
    assert.equal(result.executed, true);
    assert.equal(result.status, "completed");
    assert.equal(result.adapter, item.adapter);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].stream, "stdout");
  }
});

test("ValorIDE starts a fresh task instead of attaching to a nonexistent session", () => {
  const invocation = buildRuntimeInvocation({
    adapter: "valoride-cli",
    workingDirectory: "/tmp",
  }, {
    commandId: "new-valor-task",
  }, "bounded task");

  assert.deepEqual(invocation.args, ["task", "bounded task", "--act"]);
  assert.equal(invocation.args.includes("--session"), false);
  assert.equal(invocation.sessionKey, "valor-new-valor-task");
});

test("CLI terminal receipts retain the final structured agent reply after long progress", async () => {
  const finalReply = "# Valkyr SWARM\n/Users/example/ValkyrSWARM";
  const stdout = `${"progress".repeat(2_000)}\n${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: finalReply },
  })}\n`;
  assert.equal(terminalAgentText(stdout), finalReply);

  const result = await executeRuntimeCommand({
    agent: {
      agentId: "codex-terminal-proof",
      runtime: "codex",
      execution: {
        adapter: "codex-cli",
        agentId: "codex-terminal-proof",
        executable: "/bin/codex",
        timeoutSeconds: 30,
        workingDirectory: "/tmp",
      },
    },
    wire: {
      action: "workflow.debug",
      commandId: "terminal-proof",
      command: { data: { objective: "read only" } },
      trace: { traceId: "trace-terminal-proof" },
    },
    spawnImpl: fakeSpawn(stdout),
  });

  assert.equal(result.artifact.terminalText, finalReply);
  assert.match(result.artifact.output, /TERMINAL TAIL RETAINED/);
  assert.match(result.artifact.output, /Valkyr SWARM/);
});

test("supervised runtime execution always makes the active Node binary discoverable", () => {
  const env = supervisedRuntimeEnvironment({ PATH: "/usr/bin:/bin" });
  assert.equal(env.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.equal(env.PATH.split(path.delimiter).includes("/usr/bin"), true);
});
