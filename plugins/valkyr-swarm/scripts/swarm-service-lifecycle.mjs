import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const SERVICE_STATUS_ACTION = "service.lifecycle.status";
const SERVICE_RESTART_ACTION = "service.lifecycle.restart";
const SERVICE_LIFECYCLE_PROTOCOL = "valkyr-service-lifecycle/v1";
const SERVICE_HANDLES = new Set([
  "claude-code",
  "codex",
  "openclaw",
  "swarm-bridge",
  "valoride",
  "workflow-engine",
  "workflow-runner",
]);
const RUNTIME_HANDLES = new Set([
  "claude-code",
  "codex",
  "openclaw",
  "valoride",
]);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const CANONICAL_APPROVAL_REF = /^gm_approval_[0-9a-f]{64}$/;
const DEFAULT_RECOVERY_ROOT = path.join(
  os.homedir(),
  ".config",
  "valkyr-swarm",
  "service-recovery",
);

function plainObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeId(value, label) {
  const normalized = String(value ?? "").trim();
  if (!SAFE_ID.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function normalizeRuntime(value) {
  const runtime = String(value ?? "").trim().toLowerCase();
  return runtime === "valklaw" ? "valoride" : runtime;
}

function nativeSupervisor(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd-user";
  return null;
}

function serviceDefinitionPath(label, platform = process.platform, homedir = os.homedir()) {
  return platform === "darwin"
    ? path.join(homedir, "Library", "LaunchAgents", `${label}.plist`)
    : path.join(homedir, ".config", "systemd", "user", `${label}.service`);
}

function binding({
  agentId,
  displayName,
  handle,
  kind,
  label,
  machineId,
  platform,
  selfRestart,
  sharedBridge,
  homedir,
}) {
  safeId(agentId, "expected agent id");
  safeId(label, "native service label");
  safeId(machineId, "machine id");
  if (!SERVICE_HANDLES.has(handle)) {
    throw new Error(`Unsupported service handle: ${handle}`);
  }
  const supervisor = nativeSupervisor(platform);
  if (!supervisor) return null;
  const definitionPath = serviceDefinitionPath(label, platform, homedir);
  return {
    agentId,
    definitionPath,
    displayName,
    handle,
    kind,
    label,
    machineId,
    platform,
    restartable: fs.existsSync(definitionPath),
    selfRestart: selfRestart === true,
    sharedBridge: sharedBridge === true,
    supervisor,
  };
}

function resolveServiceBindings({
  agent,
  machineId,
  platform = process.platform,
  homedir = os.homedir(),
}) {
  const supervisor = nativeSupervisor(platform);
  if (!supervisor || !agent || !machineId) return [];
  const agentId = safeId(agent.agentId, "agent id");
  const normalizedMachineId = safeId(machineId, "machine id");
  const runtime = normalizeRuntime(agent.runtime);
  const bindings = [];
  const bridgeLabel = `com.valkyrlabs.swarm.${normalizedMachineId}`;
  if (RUNTIME_HANDLES.has(runtime)) {
    const runtimeBinding = binding({
      agentId,
      displayName: `${runtime === "valoride" ? "ValorIDE" : runtime === "openclaw" ? "OpenClaw" : runtime === "codex" ? "Codex" : "Claude Code"} SWARM bridge`,
      handle: runtime,
      kind: runtime,
      label: bridgeLabel,
      machineId: normalizedMachineId,
      platform,
      selfRestart: true,
      sharedBridge: true,
      homedir,
    });
    if (runtimeBinding) bindings.push(runtimeBinding);
  }
  const bridgeBinding = binding({
    agentId,
    displayName: "Valkyr SWARM bridge",
    handle: "swarm-bridge",
    kind: "swarm",
    label: bridgeLabel,
    machineId: normalizedMachineId,
    platform,
    selfRestart: true,
    sharedBridge: true,
    homedir,
  });
  if (bridgeBinding) bindings.push(bridgeBinding);

  const workflow = agent.workflowRuntime;
  if (workflow?.enabled === true) {
    const tier = workflow.tier === "engine" ? "engine" : "runner";
    const workflowBinding = binding({
      agentId,
      displayName: tier === "engine" ? "Workflow engine" : "Workflow runner",
      handle: tier === "engine" ? "workflow-engine" : "workflow-runner",
      kind: `workflow-${tier}`,
      label: `com.valkyrlabs.workflow-runtime.${agentId}`,
      machineId: normalizedMachineId,
      platform,
      selfRestart: false,
      sharedBridge: false,
      homedir,
    });
    if (workflowBinding) bindings.push(workflowBinding);
  }
  return bindings;
}

function runSupervisor(bindingValue, operation, spawnImpl = spawnSync, uid = process.getuid?.()) {
  const binding = validateResolvedBinding(bindingValue);
  if (binding.supervisor === "launchd") {
    if (!Number.isInteger(uid) || uid < 0) {
      throw new Error("launchd lifecycle requires the current numeric user id");
    }
    const target = `gui/${uid}/${binding.label}`;
    const args = operation === "status"
      ? ["print", target]
      : ["kickstart", "-k", target];
    return spawnImpl("/bin/launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  }
  const args = operation === "status"
    ? ["--user", "show", `${binding.label}.service`, "--property=ActiveState,SubState,MainPID", "--no-pager"]
    : ["--user", "restart", `${binding.label}.service`];
  return spawnImpl("systemctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
}

function validateResolvedBinding(value) {
  if (!plainObject(value)
      || !SERVICE_HANDLES.has(value.handle)
      || !["launchd", "systemd-user"].includes(value.supervisor)
      || !SAFE_ID.test(String(value.label ?? ""))
      || !SAFE_ID.test(String(value.agentId ?? ""))
      || !SAFE_ID.test(String(value.machineId ?? ""))) {
    throw new Error("Invalid resolved service binding");
  }
  return value;
}

function probeServiceBinding(bindingValue, {
  spawnImpl = spawnSync,
  uid = process.getuid?.(),
} = {}) {
  const binding = validateResolvedBinding(bindingValue);
  if (!fs.existsSync(binding.definitionPath)) {
    return {
      handle: binding.handle,
      installed: false,
      running: false,
      state: "not-installed",
      supervisor: binding.supervisor,
    };
  }
  const result = runSupervisor(binding, "status", spawnImpl, uid);
  const stdout = String(result.stdout ?? "");
  const pidMatch = binding.supervisor === "launchd"
    ? /^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout)
    : /^MainPID=(\d+)\r?$/m.exec(stdout);
  const parsedPid = pidMatch ? Number(pidMatch[1]) : null;
  const pid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null;
  // A successful lookup proves a loaded job, not a live supervised process.
  const running = result.status === 0 && pid !== null && (
    binding.supervisor === "launchd"
      ? /^\s*state\s*=\s*running\s*$/m.test(stdout)
      : /^ActiveState=active\r?$/m.test(stdout) && /^SubState=running\r?$/m.test(stdout)
  );
  return {
    handle: binding.handle,
    installed: true,
    running,
    state: running ? "running" : "stopped",
    supervisor: binding.supervisor,
    ...(pid ? { pid } : {}),
  };
}

function restartServiceBinding(bindingValue, {
  spawnImpl = spawnSync,
  uid = process.getuid?.(),
} = {}) {
  const binding = validateResolvedBinding(bindingValue);
  if (!binding.restartable || !fs.existsSync(binding.definitionPath)) {
    throw new Error(`Service ${binding.handle} is not installed under the canonical supervisor`);
  }
  const result = runSupervisor(binding, "restart", spawnImpl, uid);
  if (result.status !== 0) {
    throw new Error(`Native supervisor restart failed for ${binding.handle}`);
  }
  return {
    handle: binding.handle,
    invoked: true,
    supervisor: binding.supervisor,
  };
}

function buildServiceLifecycleState({
  agent,
  machineId,
  platform = process.platform,
  homedir = os.homedir(),
  spawnImpl = spawnSync,
  uid = process.getuid?.(),
}) {
  const bindings = resolveServiceBindings({
    agent,
    machineId,
    platform,
    homedir,
  });
  const services = bindings.map((resolved) => {
    const status = probeServiceBinding(resolved, { spawnImpl, uid });
    return {
      binding: resolved,
      public: {
        displayName: resolved.displayName,
        expectedAgentId: resolved.agentId,
        handle: resolved.handle,
        kind: resolved.kind,
        restartable: resolved.restartable,
        selfRestart: resolved.selfRestart,
        sharedBridge: resolved.sharedBridge,
        supervisor: resolved.supervisor,
        ...status,
      },
    };
  });
  const available = services.filter(({ public: item }) => item.installed);
  const restartable = available.filter(({ public: item }) => item.restartable);
  return {
    bindings,
    capabilities: [
      ...(available.length > 0 ? [SERVICE_STATUS_ACTION] : []),
      ...(restartable.length > 0 ? [SERVICE_RESTART_ACTION] : []),
    ],
    metadata: {
      protocol: SERVICE_LIFECYCLE_PROTOCOL,
      services: services.map(({ public: item }) => item),
    },
    services,
  };
}

function serviceLifecycleAdvertisement(agent, state) {
  const base = Array.isArray(agent?.capabilities) ? agent.capabilities : [];
  const capabilities = [...new Set([...base, ...(state?.capabilities ?? [])])];
  return {
    capabilities,
    serviceLifecycle: state?.metadata ?? {
      protocol: SERVICE_LIFECYCLE_PROTOCOL,
      services: [],
    },
  };
}

function parseServiceLifecyclePayload(wire, machineId) {
  const command = plainObject(wire?.command) ? wire.command : {};
  const payload = plainObject(command.payload)
    ? command.payload
    : plainObject(command.data)
      ? command.data
      : null;
  if (!payload) throw new Error("Service lifecycle payload must be an object");
  const allowed = new Set(["expectedMachineId", "serviceHandle"]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`Service lifecycle payload field is not allowed: ${key}`);
    }
  }
  const serviceHandle = String(payload.serviceHandle ?? "").trim().toLowerCase();
  const expectedMachineId = String(payload.expectedMachineId ?? "").trim();
  if (!SERVICE_HANDLES.has(serviceHandle)) {
    throw new Error("Service lifecycle handle is unsupported");
  }
  if (!SAFE_ID.test(expectedMachineId) || expectedMachineId !== machineId) {
    throw new Error("Service lifecycle host mismatch");
  }
  return { expectedMachineId, serviceHandle };
}

function resolveRequestedBinding(wire, state, machineId) {
  const payload = parseServiceLifecyclePayload(wire, machineId);
  const resolved = state?.bindings?.find((candidate) =>
    candidate.handle === payload.serviceHandle);
  if (!resolved) {
    throw new Error(`Service ${payload.serviceHandle} is not present on the target node`);
  }
  return { binding: resolved, payload };
}

function pendingRecoveryPath(commandId, recoveryRoot = DEFAULT_RECOVERY_ROOT) {
  const safeCommandId = safeId(commandId, "command id");
  return path.join(recoveryRoot, `${safeCommandId}.json`);
}

function writePendingRecovery({
  agent,
  binding: bindingValue,
  recoveryRoot = DEFAULT_RECOVERY_ROOT,
  wire,
}) {
  const binding = validateResolvedBinding(bindingValue);
  if (!CANONICAL_APPROVAL_REF.test(String(wire?.command?.approvalRef ?? ""))) {
    throw new Error("Self-restart requires a canonical content-bound approval reference");
  }
  fs.mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(recoveryRoot, 0o700);
  const record = {
    schemaVersion: "valkyr-service-recovery/v1",
    action: SERVICE_RESTART_ACTION,
    agentId: safeId(agent.agentId, "agent id"),
    approvalRef: String(wire.command.approvalRef),
    commandId: safeId(wire.commandId, "command id"),
    createdAt: new Date().toISOString(),
    expectedMachineId: binding.machineId,
    serviceHandle: binding.handle,
    targetInstanceId: safeId(wire.targetInstanceId, "target instance id"),
    traceId: SAFE_ID.test(String(wire.trace?.traceId ?? ""))
      ? String(wire.trace.traceId)
      : null,
  };
  const target = pendingRecoveryPath(record.commandId, recoveryRoot);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const file = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
      });
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.chmodSync(target, 0o600);
  try {
    const directory = fs.openSync(recoveryRoot, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } catch {
    // Some platforms cannot fsync directories; the atomic file remains valid.
  }
  return { path: target, record };
}

function readPendingRecoveries({
  agentId,
  recoveryRoot = DEFAULT_RECOVERY_ROOT,
}) {
  if (!fs.existsSync(recoveryRoot)) return [];
  const rootStat = fs.lstatSync(recoveryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid()
      || (rootStat.mode & 0o077) !== 0) return [];
  const records = [];
  for (const name of fs.readdirSync(recoveryRoot).filter((entry) => entry.endsWith(".json")).sort()) {
    const target = path.join(recoveryRoot, name);
    try {
      const record = readPrivateRecovery(target);
      if (record?.schemaVersion !== "valkyr-service-recovery/v1"
          || record.agentId !== agentId
          || record.action !== SERVICE_RESTART_ACTION
          || !CANONICAL_APPROVAL_REF.test(String(record.approvalRef ?? ""))
          || !SERVICE_HANDLES.has(record.serviceHandle)
          || !SAFE_ID.test(String(record.commandId ?? ""))
          || name !== `${record.commandId}.json`
          || !SAFE_ID.test(String(record.targetInstanceId ?? ""))
          || !SAFE_ID.test(String(record.expectedMachineId ?? ""))) {
        continue;
      }
      records.push({ path: target, record });
    } catch {
      // An invalid recovery artifact is ignored rather than becoming authority.
    }
  }
  return records;
}

function readPrivateRecovery(target) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1
        || (before.mode & 0o077) !== 0 || before.size > 64 * 1024) {
      throw new Error("Recovery checkpoint must be a bounded private regular file");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(target);
    if (count !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs
        || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error("Recovery checkpoint changed during inspection");
    }
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function checkpointServiceRecoveryTerminal({ pending, terminal, recoveryRoot = DEFAULT_RECOVERY_ROOT }) {
  const target = pendingRecoveryPath(pending.record.commandId, recoveryRoot);
  if (path.resolve(target) !== path.resolve(pending.path)
      || JSON.stringify(readPrivateRecovery(target)) !== JSON.stringify(pending.record)) {
    throw new Error("Recovery checkpoint changed before outcome persistence");
  }
  if (!plainObject(terminal)) throw new Error("Recovery terminal outcome must be an object");
  const record = { ...pending.record, terminal, receipt: { status: "submission_started", id: null } };
  writePrivateRecoveryRecord(target, record, recoveryRoot);
  return record;
}

function checkpointServiceRecoveryReceipt({ pending, receipt, recoveryRoot = DEFAULT_RECOVERY_ROOT }) {
  const target = pendingRecoveryPath(pending.record.commandId, recoveryRoot);
  const current = readPrivateRecovery(target);
  const { receipt: previousReceipt, ...previous } = pending.record;
  const { receipt: currentReceipt, ...observed } = current;
  if (path.resolve(target) !== path.resolve(pending.path)
      || JSON.stringify(previous) !== JSON.stringify(observed)) {
    throw new Error("Recovery outcome changed before receipt persistence");
  }
  // A replay callback may persist the receipt while the original submitter is
  // still unwinding. Never downgrade that durable identity to queued/degraded.
  if (currentReceipt?.status === "persisted"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentReceipt?.id ?? "")) return current;
  const record = { ...current, receipt: { status: receipt.status, id: receipt.id ?? null } };
  writePrivateRecoveryRecord(target, record, recoveryRoot);
  return record;
}

function writePrivateRecoveryRecord(target, record, recoveryRoot) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > 64 * 1024) throw new Error("Recovery terminal checkpoint exceeds its size limit");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    const directory = fs.openSync(recoveryRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function removePendingRecovery(target, recoveryRoot = DEFAULT_RECOVERY_ROOT) {
  const resolvedRoot = path.resolve(recoveryRoot);
  const resolvedTarget = path.resolve(target);
  if (path.dirname(resolvedTarget) !== resolvedRoot || !resolvedTarget.endsWith(".json")) {
    throw new Error("Pending recovery path is outside the recovery root");
  }
  if (fs.existsSync(resolvedTarget)) fs.unlinkSync(resolvedTarget);
}

async function executeServiceLifecycleCommand({
  agent,
  machineId,
  onProgress = () => {},
  recoveryRoot = DEFAULT_RECOVERY_ROOT,
  spawnImpl = spawnSync,
  state,
  uid = process.getuid?.(),
  verifyRecovery,
  wire,
}) {
  if (![SERVICE_STATUS_ACTION, SERVICE_RESTART_ACTION].includes(wire.action)) {
    throw new Error("Unsupported service lifecycle action");
  }
  const { binding: requested } = resolveRequestedBinding(wire, state, machineId);
  onProgress({ stream: "lifecycle", text: `Inspecting ${requested.handle}` });
  const before = probeServiceBinding(requested, { spawnImpl, uid });
  if (wire.action === SERVICE_STATUS_ACTION) {
    return {
      adapter: "native-service-lifecycle",
      executed: true,
      receiptOnly: false,
      service: {
        ...before,
        displayName: requested.displayName,
        expectedAgentId: requested.agentId,
        kind: requested.kind,
        restartable: requested.restartable,
        selfRestart: requested.selfRestart,
        sharedBridge: requested.sharedBridge,
      },
    };
  }
  if (!CANONICAL_APPROVAL_REF.test(String(wire.command?.approvalRef ?? ""))
      || wire.command?.requiresApproval !== true) {
    throw new Error("Service restart requires canonical content-bound approval");
  }
  if (!before.installed) {
    throw new Error(`Service ${requested.handle} is not installed`);
  }
  onProgress({ stream: "lifecycle", text: `Restarting ${requested.handle} through ${requested.supervisor}` });
  if (requested.selfRestart) {
    const pending = writePendingRecovery({ agent, binding: requested, recoveryRoot, wire });
    try {
      restartServiceBinding(requested, { spawnImpl, uid });
    } catch (error) {
      removePendingRecovery(pending.path, recoveryRoot);
      throw error;
    }
    return {
      adapter: "native-service-lifecycle",
      executed: false,
      pendingRecovery: true,
      receiptOnly: false,
      serviceHandle: requested.handle,
      supervisor: requested.supervisor,
    };
  }
  restartServiceBinding(requested, { spawnImpl, uid });
  if (typeof verifyRecovery !== "function") {
    throw new Error("Service restart verification is unavailable");
  }
  const proof = await verifyRecovery(requested, before);
  if (!proof?.healthy || !proof?.heartbeatFresh) {
    throw new Error(`Service ${requested.handle} did not produce fresh recovery proof`);
  }
  return {
    adapter: "native-service-lifecycle",
    executed: true,
    receiptOnly: false,
    serviceHandle: requested.handle,
    supervisor: requested.supervisor,
    proof,
  };
}

export {
  DEFAULT_RECOVERY_ROOT,
  SERVICE_HANDLES,
  SERVICE_LIFECYCLE_PROTOCOL,
  SERVICE_RESTART_ACTION,
  SERVICE_STATUS_ACTION,
  buildServiceLifecycleState,
  checkpointServiceRecoveryTerminal,
  checkpointServiceRecoveryReceipt,
  executeServiceLifecycleCommand,
  nativeSupervisor,
  parseServiceLifecyclePayload,
  pendingRecoveryPath,
  probeServiceBinding,
  readPendingRecoveries,
  removePendingRecovery,
  resolveRequestedBinding,
  resolveServiceBindings,
  restartServiceBinding,
  serviceLifecycleAdvertisement,
  writePendingRecovery,
};
