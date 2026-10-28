#!/usr/bin/env node

// An exact local update for an existing engineering Workflow sidecar. The
// private config is patched at one JSON value so every other byte survives.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const WORKFLOW_SERVICE = path.join(path.dirname(SCRIPT), "swarm-workflow-service.mjs");
const HEX64 = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function regularOwned(file, maxBytes = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > maxBytes) {
    throw new Error(`Unsafe or non-owned input: ${file}`);
  }
  return stat;
}

function skipSpace(source, offset) {
  while (/\s/.test(source[offset] ?? "")) offset += 1;
  return offset;
}

function stringEnd(source, start) {
  if (source[start] !== '"') throw new Error("Expected JSON string");
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === '"') return index + 1;
  }
  throw new Error("Unterminated JSON string");
}

function valueEnd(source, start) {
  if (source[start] === '"') return stringEnd(source, start);
  if (source[start] === "{" || source[start] === "[") {
    const stack = [source[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < source.length; index += 1) {
      const value = source[index];
      if (value === '"') { index = stringEnd(source, index) - 1; continue; }
      if (value === "{" || value === "[") stack.push(value === "{" ? "}" : "]");
      if (value === "}" || value === "]") {
        if (stack.pop() !== value) throw new Error("Mismatched JSON boundary");
        if (stack.length === 0) return index + 1;
      }
    }
    throw new Error("Unterminated JSON value");
  }
  let index = start;
  while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
  return index;
}

function objectMembers(source, start) {
  if (source[start] !== "{") throw new Error("Expected JSON object");
  const members = [];
  let index = skipSpace(source, start + 1);
  while (source[index] !== "}") {
    const keyEnd = stringEnd(source, index);
    const key = JSON.parse(source.slice(index, keyEnd));
    index = skipSpace(source, keyEnd);
    if (source[index] !== ":") throw new Error("Expected JSON member colon");
    const valueStart = skipSpace(source, index + 1);
    const end = valueEnd(source, valueStart);
    members.push({ key, start: valueStart, end });
    index = skipSpace(source, end);
    if (source[index] === ",") index = skipSpace(source, index + 1);
    else if (source[index] !== "}") throw new Error("Expected JSON member separator");
  }
  return members;
}

function onlyMember(source, start, name) {
  const matches = objectMembers(source, start).filter((item) => item.key === name);
  if (matches.length !== 1) throw new Error(`Expected one JSON ${name} member`);
  return matches[0];
}

function arrayItems(source, start) {
  if (source[start] !== "[") throw new Error("Expected JSON array");
  const items = [];
  let index = skipSpace(source, start + 1);
  while (source[index] !== "]") {
    const end = valueEnd(source, index);
    items.push({ start: index, end });
    index = skipSpace(source, end);
    if (source[index] === ",") index = skipSpace(source, index + 1);
    else if (source[index] !== "]") throw new Error("Expected JSON array separator");
  }
  return items;
}

function patchAgentJava(source, agentId, javaExecutable) {
  const config = JSON.parse(source);
  const matching = config.agents?.filter((agent) => agent?.agentId === agentId) ?? [];
  if (matching.length !== 1) throw new Error("Expected one exact engineering agent");
  const agent = matching[0];
  if (agent.workflowRuntime?.tier !== "engine"
      || !agent.capabilities?.includes("engineering.project.execute")
      || !agent.workflowRuntime.capabilities?.includes("java:17")) {
    throw new Error("Selected agent lacks the engineering Java 17 engine contract");
  }
  if (typeof agent.workflowRuntime.install?.javaExecutable !== "string") {
    throw new Error("Existing engineering Java executable is missing");
  }
  const agents = onlyMember(source, skipSpace(source, 0), "agents");
  const spans = arrayItems(source, agents.start).filter((item) =>
    JSON.parse(source.slice(item.start, item.end))?.agentId === agentId);
  if (spans.length !== 1) throw new Error("Ambiguous engineering agent JSON span");
  const workflow = onlyMember(source, spans[0].start, "workflowRuntime");
  const install = onlyMember(source, workflow.start, "install");
  const java = onlyMember(source, install.start, "javaExecutable");
  if (JSON.parse(source.slice(java.start, java.end)) !== agent.workflowRuntime.install.javaExecutable) {
    throw new Error("Engineering Java source value changed");
  }
  const updated = source.slice(0, java.start) + JSON.stringify(javaExecutable) + source.slice(java.end);
  const expected = structuredClone(config);
  expected.agents.find((item) => item.agentId === agentId).workflowRuntime.install.javaExecutable = javaExecutable;
  assert.deepEqual(JSON.parse(updated), expected);
  return { updated, priorJavaExecutable: agent.workflowRuntime.install.javaExecutable,
    healthEndpoint: agent.workflowRuntime.healthEndpoint };
}

function patchAgentInstall(source, agentId, releaseFields) {
  const config = JSON.parse(source);
  const matching = config.agents?.filter((agent) => agent?.agentId === agentId) ?? [];
  if (matching.length !== 1) throw new Error("Expected one exact engineering agent");
  const agent = matching[0];
  if (agent.workflowRuntime?.tier !== "engine"
      || !agent.capabilities?.includes("engineering.project.execute")
      || !agent.workflowRuntime.supportedTools?.includes("workflow.engine.execute-workflow")) {
    throw new Error("Selected agent lacks the engineering Workflow engine contract");
  }
  const originalInstall = agent.workflowRuntime.install;
  if (!originalInstall || typeof originalInstall.artifactUrl !== "string"
      || !HEX64.test(originalInstall.sha256 ?? "")) {
    throw new Error("Existing engineering engine cannot be restored");
  }
  const updatedInstall = { ...originalInstall, ...releaseFields };
  const agents = onlyMember(source, skipSpace(source, 0), "agents");
  const spans = arrayItems(source, agents.start).filter((item) =>
    JSON.parse(source.slice(item.start, item.end))?.agentId === agentId);
  if (spans.length !== 1) throw new Error("Ambiguous engineering agent JSON span");
  const workflow = onlyMember(source, spans[0].start, "workflowRuntime");
  const install = onlyMember(source, workflow.start, "install");
  const updated = source.slice(0, install.start) + JSON.stringify(updatedInstall) + source.slice(install.end);
  const expected = structuredClone(config);
  expected.agents.find((item) => item.agentId === agentId).workflowRuntime.install = updatedInstall;
  assert.deepEqual(JSON.parse(updated), expected);
  return { updated, originalInstall, updatedInstall,
    healthEndpoint: agent.workflowRuntime.healthEndpoint,
    capabilities: [...agent.capabilities, ...(agent.workflowRuntime.capabilities ?? [])] };
}

function exactJava17(executable) {
  if (!path.isAbsolute(executable)) throw new Error("Java executable must be absolute");
  const resolved = fs.realpathSync(executable);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100 * 1024 * 1024
      || !(stat.mode & 0o111) || path.basename(resolved) !== "java") {
    throw new Error("Selected Java executable is not executable");
  }
  const javac = path.join(path.dirname(resolved), "javac");
  if (!fs.existsSync(javac)) throw new Error("Selected Java 17 installation has no javac");
  const version = spawnSync(resolved, ["-version"], { encoding: "utf8", timeout: 5000 });
  const compiler = spawnSync(javac, ["-version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0 || !/version "17(?:[.\"])/.test(`${version.stdout}\n${version.stderr}`)
      || compiler.status !== 0 || !/^javac 17(?:[.\s])/m.test(`${compiler.stdout}\n${compiler.stderr}`)) {
    throw new Error("Selected Java toolchain must be JDK 17 exactly");
  }
  return { path: resolved, sha256: sha256(fs.readFileSync(resolved)) };
}

function buildPlan({ configPath, agentId, javaExecutable, servicePath, serviceScript = WORKFLOW_SERVICE,
  inspectJava = exactJava17 }) {
  if (!path.isAbsolute(configPath) || !AGENT_ID.test(agentId)) throw new Error("Exact config and agent are required");
  regularOwned(configPath);
  regularOwned(servicePath);
  regularOwned(serviceScript);
  const java = inspectJava(javaExecutable);
  const original = fs.readFileSync(configPath, "utf8");
  const patched = patchAgentJava(original, agentId, java.path);
  const endpoint = new URL(patched.healthEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
      || endpoint.pathname !== "/v1/swarm/workflow-engine/health") {
    throw new Error("Engineering sidecar health must use the exact loopback engine endpoint");
  }
  const plan = {
    schemaVersion: "valkyr-engineering-toolchain-update/v1",
    configPath, agentId, servicePath, serviceScript,
    currentConfigSha256: sha256(original),
    updatedConfigSha256: sha256(patched.updated),
    currentServiceSha256: sha256(fs.readFileSync(servicePath)),
    serviceScriptSha256: sha256(fs.readFileSync(serviceScript)),
    priorJavaExecutable: patched.priorJavaExecutable,
    targetJavaExecutable: java.path,
    targetJavaSha256: java.sha256,
    healthEndpoint: endpoint.toString(),
  };
  return { ...plan, planSha256: sha256(JSON.stringify(plan)) };
}

function privateWrite(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function replaceConfig(file, bytes, mode) {
  const temporary = `${file}.update-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", mode & 0o777);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function runWorkflowService(command, plan) {
  const result = spawnSync(process.execPath,
    [plan.serviceScript, command, "--config", plan.configPath, "--agent", plan.agentId],
    { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Workflow sidecar ${command} failed`);
}

async function probeService(plan, expectedJava) {
  if (process.platform !== "darwin") throw new Error("This update requires the local macOS LaunchAgent");
  const label = `com.valkyrlabs.workflow-runtime.${plan.agentId}`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`],
      { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    const output = state.stdout ?? "";
    const program = output.match(/^\s*program = (.+)$/m)?.[1];
    const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1]);
    if (state.status === 0 && /\bstate = running\b/.test(output)
        && program === expectedJava && Number.isInteger(pid) && pid > 0) {
      try {
        const response = await fetch(plan.healthEndpoint, { signal: AbortSignal.timeout(2500) });
        const health = response.ok ? await response.json() : null;
        if (health?.status === "UP" && health.protocol === "valkyr-workflow-engine/v1"
            && health.supportedTools?.includes("workflow.engine.execute-workflow")) {
          return { pid, program, healthStatus: health.status };
        }
      } catch { /* Sidecar may still be starting. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Updated engineering sidecar did not attest Java and healthy engine");
}

function backupDirectory(plan) {
  return path.join(path.dirname(plan.configPath), `.engineering-toolchain-${plan.planSha256}`);
}

async function applyPlan(plan, { runService = runWorkflowService, probe = probeService,
  inspectJava = exactJava17 } = {}) {
  const current = buildPlan({ configPath: plan.configPath, agentId: plan.agentId,
    javaExecutable: plan.targetJavaExecutable, servicePath: plan.servicePath,
    serviceScript: plan.serviceScript, inspectJava });
  if (current.planSha256 !== plan.planSha256 || !HEX64.test(plan.planSha256)) {
    throw new Error("Engineering toolchain plan changed before apply");
  }
  if (current.currentConfigSha256 === current.updatedConfigSha256) {
    throw new Error("Engineering toolchain is already selected");
  }
  const original = fs.readFileSync(plan.configPath);
  const service = fs.readFileSync(plan.servicePath);
  const patched = patchAgentJava(original.toString("utf8"), plan.agentId, plan.targetJavaExecutable);
  const directory = backupDirectory(plan);
  fs.mkdirSync(directory, { mode: 0o700 });
  privateWrite(path.join(directory, "config.original"), original);
  privateWrite(path.join(directory, "service.original"), service);
  privateWrite(path.join(directory, "plan.json"), JSON.stringify(plan));
  const mode = regularOwned(plan.configPath).mode;
  try {
    replaceConfig(plan.configPath, patched.updated, mode);
    await runService("install", plan);
    const verified = await probe(plan, plan.targetJavaExecutable);
    const receipt = { planSha256: plan.planSha256, agentId: plan.agentId,
      priorConfigSha256: plan.currentConfigSha256, configSha256: plan.updatedConfigSha256,
      priorServiceSha256: plan.currentServiceSha256,
      serviceSha256: sha256(fs.readFileSync(plan.servicePath)),
      targetJavaSha256: plan.targetJavaSha256,
      pid: verified.pid, javaExecutable: verified.program,
      healthStatus: verified.healthStatus, rollbackDirectory: directory };
    privateWrite(path.join(directory, "receipt.json"), JSON.stringify(receipt));
    return receipt;
  } catch (error) {
    replaceConfig(plan.configPath, original, mode);
    try {
      await runService("install", plan);
      await probe(plan, plan.priorJavaExecutable);
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      throw new Error("Engineering toolchain apply failed; rollback outcome uncertain, private backup retained");
    }
    throw error;
  }
}

async function rollbackPlan(plan, { runService = runWorkflowService, probe = probeService } = {}) {
  const directory = backupDirectory(plan);
  const backup = fs.lstatSync(directory);
  if (!backup.isDirectory() || backup.isSymbolicLink() || backup.uid !== process.getuid()
      || (backup.mode & 0o077) !== 0) {
    throw new Error("Engineering toolchain rollback directory is unsafe");
  }
  for (const name of ["config.original", "service.original", "plan.json", "receipt.json"]) {
    regularOwned(path.join(directory, name));
  }
  if (sha256(fs.readFileSync(plan.serviceScript)) !== plan.serviceScriptSha256) {
    throw new Error("Engineering toolchain service installer changed before rollback");
  }
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"));
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"));
  const { planSha256: savedDigest, ...savedPayload } = saved;
  if (savedDigest !== sha256(JSON.stringify(savedPayload))
      || saved.planSha256 !== plan.planSha256 || receipt.planSha256 !== plan.planSha256
      || sha256(fs.readFileSync(plan.configPath)) !== receipt.configSha256
      || sha256(fs.readFileSync(plan.servicePath)) !== receipt.serviceSha256) {
    throw new Error("Engineering sidecar changed since the pinned apply; rollback refused");
  }
  const original = fs.readFileSync(path.join(directory, "config.original"));
  const service = fs.readFileSync(path.join(directory, "service.original"));
  if (sha256(original) !== plan.currentConfigSha256 || sha256(service) !== plan.currentServiceSha256) {
    throw new Error("Engineering toolchain rollback backup mismatch");
  }
  replaceConfig(plan.configPath, original, regularOwned(plan.configPath).mode);
  try {
    await runService("install", plan);
    const verified = await probe(plan, plan.priorJavaExecutable);
    if (sha256(fs.readFileSync(plan.servicePath)) !== plan.currentServiceSha256) {
      throw new Error("Original engineering sidecar definition was not restored");
    }
    return { planSha256: plan.planSha256, restoredConfigSha256: plan.currentConfigSha256,
      restoredServiceSha256: sha256(fs.readFileSync(plan.servicePath)),
      pid: verified.pid, javaExecutable: verified.program, healthStatus: verified.healthStatus };
  } catch {
    throw new Error("Engineering toolchain rollback uncertain; private backup retained");
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "apply", "rollback"].includes(command)) throw new Error("Use plan, apply, or rollback");
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || !rest[index + 1]) throw new Error("Malformed option");
    options[rest[index].slice(2)] = rest[index + 1];
  }
  if (!options.config || !options.agent || (command !== "rollback" && !options.java)) {
    throw new Error("Exact --config, --agent, and --java are required");
  }
  if (command !== "plan" && !HEX64.test(options["plan-sha256"] ?? "")) {
    throw new Error("Exact --plan-sha256 is required");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const servicePath = path.join(os.homedir(), "Library", "LaunchAgents",
    `com.valkyrlabs.workflow-runtime.${options.agent}.plist`);
  if (options.command === "rollback") {
    const directory = path.join(path.dirname(options.config),
      `.engineering-toolchain-${options["plan-sha256"]}`);
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"));
    if (saved.configPath !== options.config || saved.agentId !== options.agent
        || saved.servicePath !== servicePath) throw new Error("Rollback target differs from pinned plan");
    process.stdout.write(`${JSON.stringify(await rollbackPlan(saved))}\n`);
    return;
  }
  const plan = buildPlan({ configPath: options.config, agentId: options.agent,
    javaExecutable: options.java, servicePath });
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  if (plan.planSha256 !== options["plan-sha256"]) throw new Error("Plan SHA-256 changed");
  process.stdout.write(`${JSON.stringify(await applyPlan(plan))}\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT)) {
  main().catch((error) => {
    process.stderr.write(`Engineering toolchain update failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { applyPlan, buildPlan, patchAgentInstall, patchAgentJava, rollbackPlan };
