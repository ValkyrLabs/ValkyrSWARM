#!/usr/bin/env node

// Adopt a published, checksum-pinned Workflow engine on one existing
// engineering node. No tenant identity or credential is accepted from a plan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSpec, ensureJavaVersion } from "./swarm-workflow-service.mjs";
import { patchAgentInstall } from "./swarm-engineering-toolchain-update.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const SERVICE_SCRIPT = path.join(path.dirname(SCRIPT), "swarm-workflow-service.mjs");
const HEX64 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fileSha256(file) {
  const digest = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      digest.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  return digest.digest("hex");
}

function privateRegular(file, limit = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || stat.size > limit || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe private release input: ${file}`);
  }
  return stat;
}

function normalRegular(file, limit = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
    throw new Error(`Unsafe release file: ${file}`);
  }
  return stat;
}

function artifactUrl(value, version, item) {
  const url = new URL(value);
  const name = item.file.slice(0, -4);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password
      || url.search || url.hash || url.port
      || !url.pathname.endsWith(`/${version}/${name}-${item.sha256.slice(0, 12)}.jar`)) {
    throw new Error("Workflow artifact URL is not the exact digest-addressed release path");
  }
}

function validateRelease(manifest, descriptor) {
  if (manifest?.schemaVersion !== 1 || !COMMIT.test(manifest.sourceCommit ?? "")
      || manifest.releaseVersion !== `1.0.3-SNAPSHOT-${manifest.sourceCommit.slice(0, 12)}`) {
    throw new Error("Exact same-commit Workflow manifest required");
  }
  const engine = manifest.engine;
  const packs = manifest.packs;
  if (!engine || !Array.isArray(packs) || packs.length === 0
      || descriptor?.protocol !== "valkyr-workflow-runtime-release/v1"
      || descriptor.tier !== "engine"
      || descriptor.runtimeProtocol !== "valkyr-workflow-engine/v1"
      || descriptor.version !== manifest.releaseVersion
      || descriptor.sha256 !== engine.sha256) {
    throw new Error("Engine release descriptor differs from same-commit manifest");
  }
  for (const item of [engine, ...packs]) {
    if (!/^[A-Za-z0-9._-]+\.jar$/.test(item?.file ?? "") || !HEX64.test(item.sha256 ?? "")) {
      throw new Error("Invalid Workflow manifest artifact");
    }
  }
  artifactUrl(descriptor.artifactUrl, manifest.releaseVersion, engine);
  const base = descriptor.artifactUrl.slice(0, descriptor.artifactUrl.lastIndexOf("/"));
  const ids = new Set();
  const expectedPacks = packs.map((item) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.id ?? "") || ids.has(item.id)
        || !/^[A-Za-z0-9._-]{1,64}$/.test(item.version ?? "")
        || !Array.isArray(item.requiredNodeCapabilities)
        || item.requiredNodeCapabilities.some((cap) => !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(cap))) {
      throw new Error("Invalid Workflow capability pack metadata");
    }
    ids.add(item.id);
    const expected = { id: item.id, version: item.version,
      artifactUrl: `${base}/${item.file.slice(0, -4)}-${item.sha256.slice(0, 12)}.jar`,
      sha256: item.sha256,
      requiredNodeCapabilities: item.requiredNodeCapabilities };
    artifactUrl(expected.artifactUrl, manifest.releaseVersion, item);
    return expected;
  });
  try { assert.deepEqual(descriptor.capabilityPacks, expectedPacks); }
  catch {
    throw new Error("Capability pack descriptor differs from same-commit manifest");
  }
  if (!ids.has("engineering-project")) throw new Error("Release lacks engineering-project pack");
  return { engine, expectedPacks };
}

function selectPacks(config, agentId, descriptor) {
  const matches = config.agents?.filter((agent) => agent?.agentId === agentId) ?? [];
  if (matches.length !== 1) throw new Error("Expected one exact engineering agent");
  const agent = matches[0];
  const available = new Set([...(agent.capabilities ?? []),
    ...(agent.workflowRuntime?.capabilities ?? [])].map((value) => String(value).toLowerCase()));
  const selected = descriptor.capabilityPacks.filter((pack) =>
    pack.requiredNodeCapabilities.every((cap) => available.has(cap)));
  if (!selected.some((pack) => pack.id === "engineering-project")) {
    throw new Error("Engineering node cannot load the required project pack");
  }
  return selected;
}

function validateJava17(configPath, agentId) {
  const spec = loadSpec(configPath, agentId);
  if (spec.tier !== "engine" || ensureJavaVersion(spec) !== 17) {
    throw new Error("Engineering runtime adoption requires a real Java 17 sidecar");
  }
  return spec;
}

function currentLaunchPid(agentId, javaExecutable) {
  if (process.platform !== "darwin") throw new Error("Engineering adoption requires macOS LaunchAgent");
  const label = `com.valkyrlabs.workflow-runtime.${agentId}`;
  const state = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  const output = state.stdout ?? "";
  const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1]);
  const program = output.match(/^\s*program = (.+)$/m)?.[1];
  if (state.status !== 0 || !/\bstate = running\b/.test(output)
      || program !== javaExecutable || !Number.isInteger(pid) || pid < 1) {
    throw new Error("Current engineering sidecar is not running on pinned Java 17");
  }
  return pid;
}

function planAdoption({ configPath, agentId, manifestPath, descriptorPath,
  expectedConfigSha256, servicePath, serviceScript = SERVICE_SCRIPT,
  checkJava = validateJava17, readPid = currentLaunchPid }) {
  if (![configPath, manifestPath, descriptorPath, servicePath].every(path.isAbsolute)
      || !SAFE_ID.test(agentId) || !HEX64.test(expectedConfigSha256 ?? "")) {
    throw new Error("Exact absolute inputs and expected config SHA-256 are required");
  }
  privateRegular(configPath);
  normalRegular(manifestPath);
  normalRegular(descriptorPath);
  privateRegular(servicePath);
  normalRegular(serviceScript);
  const original = fs.readFileSync(configPath, "utf8");
  const currentConfigSha256 = sha256(original);
  if (currentConfigSha256 !== expectedConfigSha256) throw new Error("Engineering config preimage changed");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  validateRelease(manifest, descriptor);
  const selected = selectPacks(JSON.parse(original), agentId, descriptor);
  const patched = patchAgentInstall(original, agentId, {
    artifactUrl: descriptor.artifactUrl, sha256: descriptor.sha256,
    version: descriptor.version, capabilityPacks: selected,
  });
  const spec = checkJava(configPath, agentId);
  if (!spec.javaExecutable || !path.isAbsolute(spec.javaExecutable)) {
    throw new Error("Engineering Java 17 executable is not pinned");
  }
  const plan = {
    schemaVersion: "valkyr-engineering-runtime-adoption/v1",
    configPath, agentId, manifestPath, descriptorPath, servicePath, serviceScript,
    sourceCommit: manifest.sourceCommit, releaseVersion: manifest.releaseVersion,
    manifestSha256: fileSha256(manifestPath), descriptorSha256: fileSha256(descriptorPath),
    currentConfigSha256, updatedConfigSha256: sha256(patched.updated),
    currentServiceSha256: fileSha256(servicePath), serviceScriptSha256: fileSha256(serviceScript),
    priorEngineSha256: patched.originalInstall.sha256,
    engineSha256: descriptor.sha256,
    selectedPacks: selected.map((pack) => ({ id: pack.id, version: pack.version, sha256: pack.sha256 })),
    javaExecutable: spec.javaExecutable,
    javaSha256: fileSha256(fs.realpathSync(spec.javaExecutable)),
    currentPid: readPid(agentId, spec.javaExecutable),
    healthEndpoint: patched.healthEndpoint,
  };
  return { ...plan, planSha256: sha256(JSON.stringify(plan)) };
}

function backupDirectory(plan) {
  return path.join(path.dirname(plan.configPath), `.engineering-runtime-${plan.planSha256}`);
}

function privateWrite(file, bytes) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function replaceConfig(file, bytes, mode) {
  const temporary = `${file}.adopt-${process.pid}-${randomUUID()}`;
  const fd = fs.openSync(temporary, "wx", mode & 0o777);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function installSidecar(plan) {
  const result = spawnSync(process.execPath,
    [plan.serviceScript, "install", "--config", plan.configPath, "--agent", plan.agentId],
    { encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("Exact engineering sidecar installation failed");
}

function keychainToken(config) {
  if (config.serverUrl !== "https://api-0.valkyrlabs.com/v1") {
    throw new Error("Authenticated heartbeat requires canonical production API");
  }
  const service = config.authKeychainService;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(service ?? "")) {
    throw new Error("Exact node config lacks safe Keychain service");
  }
  const result = spawnSync("/usr/bin/security",
    ["find-generic-password", "-a", "default", "-s", service, "-w"],
    { encoding: "utf8", timeout: 15000, maxBuffer: 32768 });
  const token = result.status === 0 ? result.stdout.trim() : "";
  if (!token || token.length > 16384 || /[\r\n]/.test(token)) {
    throw new Error("No authorized SWARM Keychain token for this node");
  }
  return token;
}

function verifyHeartbeatSnapshot(snapshot, plan, manifestHash, activatedAt, config,
  selectedPacks = plan.selectedPacks) {
  const registry = snapshot?.registry;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("Authenticated SWARM snapshot has no registry");
  }
  const agent = registry[plan.agentId];
  const seen = Date.parse(agent?.lastSeen ?? "");
  const runtime = agent?.workflowRuntime;
  if (agent?.instanceId !== plan.agentId || agent.machineId !== config.machineId
      || agent.status !== "healthy" || runtime?.healthy !== true
      || runtime.capabilityPackManifestHash !== manifestHash
      || !agent.supportedTools?.includes("workflow.engine.execute-workflow")
      || !agent.capabilities?.includes(`workflow-pack:engineering-project:${selectedPacks.find((pack) => pack.id === "engineering-project")?.version}`)
      || !Number.isFinite(seen) || seen < activatedAt
      || Math.abs(Date.now() - seen) > 120000) {
    throw new Error("Fresh authenticated engineering heartbeat does not match sidecar release");
  }
  return { lastSeen: agent.lastSeen, instanceId: agent.instanceId,
    capabilityPackManifestHash: manifestHash };
}

async function defaultHeartbeat(plan, manifestHash, activatedAt, selectedPacks) {
  const config = JSON.parse(fs.readFileSync(plan.configPath, "utf8"));
  const token = keychainToken(config);
  const response = await fetch("https://api-0.valkyrlabs.com/v1/swarm/agents/snapshot", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("Authenticated SWARM snapshot unavailable");
  return verifyHeartbeatSnapshot(await response.json(), plan, manifestHash, activatedAt, config, selectedPacks);
}

async function defaultProbe(plan, selectedPacks, engineSha256, activatedAt,
  heartbeat = defaultHeartbeat) {
  if (process.platform !== "darwin") throw new Error("Local engineering adoption requires macOS LaunchAgent");
  const config = JSON.parse(fs.readFileSync(plan.configPath, "utf8"));
  const agent = config.agents.find((item) => item.agentId === plan.agentId);
  const spec = loadSpec(plan.configPath, plan.agentId);
  if (ensureJavaVersion(spec) !== 17 || spec.javaExecutable !== plan.javaExecutable) {
    throw new Error("Engineering sidecar Java 17 binding changed");
  }
  if (fileSha256(fs.realpathSync(spec.javaExecutable)) !== plan.javaSha256) {
    throw new Error("Engineering Java 17 executable changed since the pinned plan");
  }
  if (fileSha256(spec.artifactPath) !== engineSha256) {
    throw new Error("Installed engineering engine bytes differ from release");
  }
  const installed = agent.workflowRuntime.install.capabilityPacks ?? [];
  if (JSON.stringify(installed.map((pack) => ({ id: pack.id, version: pack.version, sha256: pack.sha256 })))
      !== JSON.stringify(selectedPacks)) {
    throw new Error("Configured engineering pack set changed");
  }
  for (const pack of installed) {
    const packPath = path.join(spec.capabilityPackRoot, `${pack.id}-${pack.sha256}.jar`);
    if (fileSha256(packPath) !== pack.sha256) throw new Error("Installed engineering pack bytes differ from release");
  }
  const label = `com.valkyrlabs.workflow-runtime.${plan.agentId}`;
  const state = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  const output = state.stdout ?? "";
  const program = output.match(/^\s*program = (.+)$/m)?.[1];
  const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1]);
  if (state.status !== 0 || !/\bstate = running\b/.test(output)
      || program !== plan.javaExecutable || !Number.isInteger(pid) || pid < 1
      || pid === plan.currentPid) {
    throw new Error("Engineering LaunchAgent Java 17 PID is not attested");
  }
  const endpoint = new URL(plan.healthEndpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
      || endpoint.pathname !== "/v1/swarm/workflow-engine/health") {
    throw new Error("Engine health endpoint is not exact loopback HTTP");
  }
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
  const health = response.ok ? await response.json() : null;
  if (health?.status !== "UP" || health.protocol !== "valkyr-workflow-engine/v1"
      || !health.supportedTools?.includes("workflow.engine.execute-workflow")
      || !HEX64.test(health.capabilityPackManifestHash ?? "")) {
    throw new Error("Engineering engine is not healthy");
  }
  const loaded = (health.capabilityPacks ?? [])
    .filter((pack) => pack.id !== "core-transforms")
    .map((pack) => `${pack.id}:${pack.version}`).sort();
  const expected = selectedPacks.map((pack) => `${pack.id}:${pack.version}`).sort();
  if (JSON.stringify(loaded) !== JSON.stringify(expected)) {
    throw new Error("Engineering engine did not load exact capability packs");
  }
  const heartbeatReceipt = await heartbeat(plan, health.capabilityPackManifestHash,
    activatedAt, selectedPacks);
  return { pid, javaExecutable: program, capabilityPackManifestHash: health.capabilityPackManifestHash,
    heartbeat: heartbeatReceipt };
}

async function waitForProbe(plan, packs, engineSha, activatedAt, probe = defaultProbe) {
  const deadline = Date.now() + 120000;
  let lastError;
  while (Date.now() < deadline) {
    try { return await probe(plan, packs, engineSha, activatedAt); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Engineering release attestation timed out: ${lastError?.message ?? "unknown"}`);
}

async function applyAdoption(plan, { checkJava = validateJava17,
  readPid = currentLaunchPid, install = installSidecar, probe = waitForProbe } = {}) {
  const current = planAdoption({ configPath: plan.configPath, agentId: plan.agentId,
    manifestPath: plan.manifestPath, descriptorPath: plan.descriptorPath,
    expectedConfigSha256: plan.currentConfigSha256, servicePath: plan.servicePath,
    serviceScript: plan.serviceScript, checkJava, readPid });
  if (current.planSha256 !== plan.planSha256 || !HEX64.test(plan.planSha256)) {
    throw new Error("Engineering release plan changed before apply");
  }
  if (current.currentConfigSha256 === current.updatedConfigSha256) {
    throw new Error("Exact engineering release is already configured");
  }
  const original = fs.readFileSync(plan.configPath);
  const priorConfig = JSON.parse(original);
  const priorAgent = priorConfig.agents.find((item) => item.agentId === plan.agentId);
  const priorPacks = (priorAgent.workflowRuntime.install.capabilityPacks ?? [])
    .map((pack) => ({ id: pack.id, version: pack.version, sha256: pack.sha256 }));
  const patched = patchAgentInstall(original.toString("utf8"), plan.agentId, {
    artifactUrl: JSON.parse(fs.readFileSync(plan.descriptorPath, "utf8")).artifactUrl,
    sha256: plan.engineSha256, version: plan.releaseVersion,
    capabilityPacks: selectPacks(priorConfig, plan.agentId,
      JSON.parse(fs.readFileSync(plan.descriptorPath, "utf8"))),
  });
  const service = fs.readFileSync(plan.servicePath);
  const directory = backupDirectory(plan);
  fs.mkdirSync(directory, { mode: 0o700 });
  privateWrite(path.join(directory, "config.original"), original);
  privateWrite(path.join(directory, "service.original"), service);
  privateWrite(path.join(directory, "plan.json"), JSON.stringify(plan));
  const mode = privateRegular(plan.configPath).mode;
  try {
    const activatedAt = Date.now();
    replaceConfig(plan.configPath, patched.updated, mode);
    await install(plan);
    const verified = await probe(plan, plan.selectedPacks, plan.engineSha256, activatedAt);
    if (fileSha256(plan.configPath) !== plan.updatedConfigSha256) {
      throw new Error("Engineering node config changed during adoption");
    }
    const receipt = { planSha256: plan.planSha256, agentId: plan.agentId,
      sourceCommit: plan.sourceCommit, engineSha256: plan.engineSha256,
      selectedPacks: plan.selectedPacks, priorConfigSha256: plan.currentConfigSha256,
      configSha256: plan.updatedConfigSha256,
      priorServiceSha256: plan.currentServiceSha256,
      serviceSha256: fileSha256(plan.servicePath),
      pid: verified.pid, javaExecutable: verified.javaExecutable,
      capabilityPackManifestHash: verified.capabilityPackManifestHash,
      heartbeat: verified.heartbeat, rollbackDirectory: directory };
    privateWrite(path.join(directory, "receipt.json"), JSON.stringify(receipt));
    return receipt;
  } catch (error) {
    replaceConfig(plan.configPath, original, mode);
    try {
      await install(plan);
      await probe(plan, priorPacks, plan.priorEngineSha256, Date.now());
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      throw new Error("Engineering adoption failed; rollback attestation uncertain, private backup retained");
    }
    throw error;
  }
}

async function rollbackAdoption(plan, { install = installSidecar, probe = waitForProbe } = {}) {
  const directory = backupDirectory(plan);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0) throw new Error("Unsafe engineering rollback directory");
  for (const name of ["config.original", "service.original", "plan.json", "receipt.json"]) {
    privateRegular(path.join(directory, name));
  }
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"));
  const { planSha256: savedSha, ...payload } = saved;
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"));
  if (savedSha !== sha256(JSON.stringify(payload)) || savedSha !== plan.planSha256
      || receipt.planSha256 !== plan.planSha256
      || fileSha256(plan.configPath) !== receipt.configSha256
      || fileSha256(plan.servicePath) !== receipt.serviceSha256
      || fileSha256(plan.serviceScript) !== plan.serviceScriptSha256) {
    throw new Error("Engineering release changed since exact apply; rollback refused");
  }
  const original = fs.readFileSync(path.join(directory, "config.original"));
  const priorService = fs.readFileSync(path.join(directory, "service.original"));
  if (sha256(original) !== plan.currentConfigSha256
      || sha256(priorService) !== plan.currentServiceSha256) {
    throw new Error("Engineering rollback backup digest differs");
  }
  const originalConfig = JSON.parse(original);
  const priorPacks = originalConfig.agents.find((item) => item.agentId === plan.agentId)
    .workflowRuntime.install.capabilityPacks.map((pack) =>
      ({ id: pack.id, version: pack.version, sha256: pack.sha256 }));
  replaceConfig(plan.configPath, original, privateRegular(plan.configPath).mode);
  try {
    await install(plan);
    const verified = await probe(plan, priorPacks, plan.priorEngineSha256, Date.now());
    if (fileSha256(plan.servicePath) !== plan.currentServiceSha256) {
      throw new Error("Prior engineering service definition not restored");
    }
    return { planSha256: plan.planSha256, status: "RESTORED_EXACT_PRIOR_ENGINEERING_RUNTIME",
      configSha256: plan.currentConfigSha256, serviceSha256: plan.currentServiceSha256,
      pid: verified.pid, heartbeat: verified.heartbeat };
  } catch {
    throw new Error("Engineering rollback outcome uncertain; private backup retained");
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
  if (!options.config || !options.agent || !SAFE_ID.test(options.agent)) {
    throw new Error("Exact config and engineering agent are required");
  }
  if (command !== "rollback" && (!options.manifest || !options.descriptor
      || !HEX64.test(options["expected-config-sha256"] ?? "")
      || !COMMIT.test(options["expected-source-sha"] ?? ""))) {
    throw new Error("Exact tested source, same-commit manifest, descriptor, and config preimage are required");
  }
  if (command !== "plan" && !HEX64.test(options["plan-sha256"] ?? "")) {
    throw new Error("Exact adoption plan SHA-256 is required");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const servicePath = path.join(os.homedir(), "Library", "LaunchAgents",
    `com.valkyrlabs.workflow-runtime.${options.agent}.plist`);
  if (options.command === "rollback") {
    const directory = path.join(path.dirname(options.config),
      `.engineering-runtime-${options["plan-sha256"]}`);
    const plan = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"));
    if (plan.configPath !== options.config || plan.agentId !== options.agent
        || plan.servicePath !== servicePath) throw new Error("Rollback target differs from pinned plan");
    process.stdout.write(`${JSON.stringify(await rollbackAdoption(plan))}\n`);
    return;
  }
  const plan = planAdoption({ configPath: options.config, agentId: options.agent,
    manifestPath: options.manifest, descriptorPath: options.descriptor,
    expectedConfigSha256: options["expected-config-sha256"], servicePath });
  if (plan.sourceCommit !== options["expected-source-sha"]) {
    throw new Error("Engineering runtime manifest does not match the tested source commit");
  }
  if (options.command === "plan") {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  if (plan.planSha256 !== options["plan-sha256"]) throw new Error("Exact adoption plan changed");
  process.stdout.write(`${JSON.stringify(await applyAdoption(plan))}\n`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT)) {
  main().catch((error) => {
    process.stderr.write(`Engineering runtime adoption failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export { applyAdoption, planAdoption, rollbackAdoption, selectPacks,
  validateRelease, verifyHeartbeatSnapshot };
