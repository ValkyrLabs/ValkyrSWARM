#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const LABEL_PREFIX = "com.valkyrlabs.swarm";
const SERVICE_RUNTIME_FILES = Object.freeze([
  "swarm-agent.mjs",
  "swarm-auth.mjs",
  "swarm-command-journal.mjs",
  "swarm-graymatter.mjs",
  "swarm-local-inference-provider.mjs",
  "swarm-node-contract.mjs",
  "swarm-runtime-adapters.mjs",
  "swarm-service-lifecycle.mjs",
  "swarm-workflow-runtime.mjs",
  "swarm-workflow-transport.mjs",
  "swarm-workflow-trust.mjs",
]);

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-service.mjs <command> --config <json> [options]\n\nInstalls and operates a launchd or systemd-user service for one SWARM host.\n\nCommands:\n  install          Install and start the service\n  uninstall        Stop and remove the service\n  start            Start the installed service\n  stop             Stop the service\n  restart          Restart the service\n  status           Print service state\n  plan-update      Preview an exact shared-bridge artifact update without applying it\n  stage-update     Stage private candidate bytes for an exact preview; never activate\n  print-service    Print the native service definition\n  print-plist      Alias for macOS compatibility\n  print-unit       Alias for Linux compatibility\n  self-test        Validate service safety offline\n\nOptions:\n  --expected-plan-sha256 <hex> Required plan identity for stage-update\n  --config <path>              Machine SWARM configuration\n  --url <url>                  Override config.serverUrl\n  --receipt-log <path>         Redacted JSONL evidence path\n  --stdout-log <path>          Supervisor stdout path\n  --stderr-log <path>          Supervisor stderr path\n  --keychain-service <name>    macOS token service\n  --token-file <path>          Mode-0600 token file\n  --credential-file <path>     Mode-0600 credentials for session refresh\n  --label <name>               Override deterministic service label\n  -h, --help                   Show this help\n\nNo JWT, username, or password is written into the service definition.\n`);
  process.exit(exitCode);
}

function optionName(argument) {
  return argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  if (argv.length === 0) usage(2);
  if (argv[0] === "-h" || argv[0] === "--help") usage(0);
  const command = argv[0];
  const commands = new Set([
    "install", "uninstall", "start", "stop", "restart", "status",
    "print-service", "print-plist", "print-unit", "plan-update", "stage-update", "self-test",
  ]);
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
  const options = { command };
  const valueOptions = new Set([
    "--config", "--url", "--receipt-log", "--stdout-log", "--stderr-log",
    "--keychain-service", "--token-file", "--credential-file", "--label", "--expected-plan-sha256",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") usage(0);
    if (!valueOptions.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    options[optionName(argument)] = value;
    index += 1;
  }
  return options;
}

function expandPath(value) {
  if (!value) return null;
  if (value === "~") return os.homedir();
  if (String(value).startsWith("~/")) return path.join(os.homedir(), String(value).slice(2));
  return path.resolve(String(value));
}

function safeToken(value, description) {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error(`${description} contains unsupported characters`);
  }
  return normalized;
}

function safeServerUrl(value) {
  if (!value) throw new Error("SWARM config requires serverUrl or --url");
  const url = new URL(String(value));
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`Unsupported SWARM URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SWARM URL must not contain credentials, query parameters, or fragments");
  }
  return url.toString();
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdArg(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function loadConfig(configPath, { bounded = false } = {}) {
  if (!configPath) throw new Error("--config is required");
  const resolved = expandPath(configPath);
  if (!fs.existsSync(resolved)) throw new Error(`SWARM config not found: ${resolved}`);
  const config = JSON.parse(bounded
    ? readPreviewFile(resolved, "SWARM configuration").toString("utf8")
    : fs.readFileSync(resolved, "utf8"));
  if (!config.machineId || !Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("SWARM config requires machineId and at least one agent");
  }
  return { config, configPath: resolved };
}

function serviceRuntimeDigest(runtimeRoot = SCRIPT_DIR) {
  const digest = createHash("sha256");
  for (const name of SERVICE_RUNTIME_FILES) {
    const source = path.join(runtimeRoot, name);
    digest.update(name);
    digest.update("\0");
    digest.update(readPreviewFile(source, `SWARM service runtime ${name}`, { limit: 8 * 1024 * 1024 }));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function serviceRuntimeBinding(homedir = os.homedir()) {
  const digest = serviceRuntimeDigest();
  const runtimeRoot = path.join(
    homedir,
    ".local",
    "share",
    "valkyr-swarm",
    "service-runtimes",
    digest,
  );
  return {
    agentScript: path.join(runtimeRoot, "swarm-agent.mjs"),
    digest,
    runtimeRoot,
  };
}

function verifyInstalledServiceRuntime(runtimeRoot, expectedDigest) {
  const stat = fs.lstatSync(runtimeRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Installed SWARM service runtime is not a private directory");
  }
  if (serviceRuntimeDigest(runtimeRoot) !== expectedDigest) {
    throw new Error("Installed SWARM service runtime failed content verification");
  }
}

function stageServiceRuntime(spec, sourceRoot = SCRIPT_DIR) {
  const expectedDigest = serviceRuntimeDigest(sourceRoot);
  if (expectedDigest !== spec.serviceRuntimeDigest) {
    throw new Error("SWARM service runtime source changed after service specification");
  }
  if (fs.existsSync(spec.serviceRuntimeRoot)) {
    verifyInstalledServiceRuntime(spec.serviceRuntimeRoot, expectedDigest);
    return spec.serviceRuntimeRoot;
  }

  const parent = path.dirname(spec.serviceRuntimeRoot);
  const temporary = `${spec.serviceRuntimeRoot}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const name of SERVICE_RUNTIME_FILES) {
      const destination = path.join(temporary, name);
      fs.copyFileSync(path.join(sourceRoot, name), destination);
      fs.chmodSync(destination, 0o600);
    }
    if (serviceRuntimeDigest(temporary) !== expectedDigest) {
      throw new Error("Staged SWARM service runtime failed content verification");
    }
    try {
      fs.renameSync(temporary, spec.serviceRuntimeRoot);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      verifyInstalledServiceRuntime(spec.serviceRuntimeRoot, expectedDigest);
    }
    verifyInstalledServiceRuntime(spec.serviceRuntimeRoot, expectedDigest);
    fs.chmodSync(spec.serviceRuntimeRoot, 0o700);
    return spec.serviceRuntimeRoot;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function serviceSpec(options, loaded, platform = process.platform) {
  const machineId = safeToken(loaded.config.machineId, "machineId");
  const label = safeToken(options.label ?? `${LABEL_PREFIX}.${machineId}`, "service label");
  const keychainService = safeToken(
    options.keychainService ?? loaded.config.authKeychainService ?? "VALKYR_AUTH",
    "keychain service",
  );
  const tokenFile = expandPath(
    options.tokenFile ?? loaded.config.authTokenFile ?? "~/.config/valkyr-swarm/auth-token",
  );
  const credentialFile = expandPath(
    options.credentialFile ?? loaded.config.authCredentialFile ?? "~/.config/valkyr-swarm/credentials.json",
  );
  const serverUrl = safeServerUrl(options.url ?? loaded.config.serverUrl);
  const logRoot = platform === "darwin"
    ? path.join(os.homedir(), "Library", "Logs")
    : path.join(os.homedir(), ".local", "state", "valkyr-swarm");
  const receiptLog = expandPath(options.receiptLog ?? path.join(logRoot, `${machineId}.jsonl`));
  const stdoutLog = expandPath(options.stdoutLog ?? path.join(logRoot, `${machineId}.out.log`));
  const stderrLog = expandPath(options.stderrLog ?? path.join(logRoot, `${machineId}.err.log`));
  const servicePath = platform === "darwin"
    ? path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)
    : path.join(os.homedir(), ".config", "systemd", "user", `${label}.service`);
  const runtimePath = [...new Set([
    path.dirname(process.execPath),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])].join(":");
  const serviceRuntime = serviceRuntimeBinding();
  return {
    agentScript: serviceRuntime.agentScript,
    configPath: loaded.configPath,
    credentialFile,
    keychainService,
    label,
    machineId,
    platform,
    receiptLog,
    runtimePath,
    serviceRuntimeDigest: serviceRuntime.digest,
    serviceRuntimeRoot: serviceRuntime.runtimeRoot,
    serverUrl,
    servicePath,
    stderrLog,
    stdoutLog,
    tokenFile,
  };
}

function agentArguments(spec) {
  return [
    process.execPath,
    spec.agentScript,
    "--config", spec.configPath,
    "--receipt-log", spec.receiptLog,
    "--url", spec.serverUrl,
    "--keychain-service", spec.keychainService,
    "--token-file", spec.tokenFile,
    "--credential-file", spec.credentialFile,
    "--continuous",
  ];
}

function plist(spec) {
  const argumentsXml = agentArguments(spec)
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xml(spec.label)}</string>
    <key>ProgramArguments</key><array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key><string>${xml(spec.serviceRuntimeRoot)}</string>
    <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(spec.runtimePath)}</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>15</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${xml(spec.stdoutLog)}</string>
    <key>StandardErrorPath</key><string>${xml(spec.stderrLog)}</string>
  </dict>
</plist>
`;
}

function systemdUnit(spec) {
  return `[Unit]
Description=Valkyr SWARM agent bridge (${spec.machineId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdArg(spec.serviceRuntimeRoot)}
Environment=${systemdArg(`PATH=${spec.runtimePath}`)}
ExecStart=${agentArguments(spec).map(systemdArg).join(" ")}
SyslogIdentifier=${spec.label}
Restart=on-failure
RestartSec=15
StandardOutput=append:${spec.stdoutLog}
StandardError=append:${spec.stderrLog}
UMask=0077

[Install]
WantedBy=default.target
`;
}

function serviceDefinition(spec) {
  if (spec.platform === "darwin") return plist(spec);
  if (spec.platform === "linux") return systemdUnit(spec);
  throw new Error("Supervised service installation supports macOS launchd and Linux systemd-user");
}

// Preview is filesystem observation only. Its digest is neither authorization
// nor a claim about the process currently loaded by the native supervisor.
function readPreviewFile(filePath, label, { limit = 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing or not installed`);
    if (error?.code === "ELOOP") throw new Error(`${label} must be a regular file`);
    throw error;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    if (before.size > limit) throw new Error(`${label} exceeds the preview size limit`);
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const received = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (received === 0) break;
      count += received;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filePath);
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino
        || current.isSymbolicLink()) {
      throw new Error(`${label} changed while preparing its preview`);
    }
    return buffer.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

function serviceUpdatePlan(spec, { sourceRoot = SCRIPT_DIR } = {}) {
  if (spec.label !== `${LABEL_PREFIX}.${safeToken(spec.machineId, "machineId")}`) {
    throw new Error("Update preview requires the canonical shared bridge label");
  }
  const configBytes = readPreviewFile(spec.configPath, "SWARM configuration");
  const config = JSON.parse(configBytes.toString("utf8"));
  if (config.machineId !== spec.machineId) throw new Error("SWARM update preview host mismatch");
  if (!Array.isArray(config.agents) || config.agents.length === 0 || config.agents.length > 256) {
    throw new Error("SWARM update preview requires between 1 and 256 agents (agent limit)");
  }
  const affectedAgentIds = config.agents.map((agent) => {
    const id = safeToken(agent?.agentId, "agent id");
    if (id.length > 160) throw new Error("SWARM update preview agent id exceeds its limit");
    return id;
  }).sort();
  if (new Set(affectedAgentIds).size !== affectedAgentIds.length) {
    throw new Error("SWARM update preview has duplicate agent identities");
  }
  const currentDefinition = readPreviewFile(spec.servicePath, "Native service definition");
  const runtimeSha256 = serviceRuntimeDigest(sourceRoot);
  if (runtimeSha256 !== spec.serviceRuntimeDigest) {
    throw new Error("SWARM service runtime source changed after service specification");
  }
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const plan = {
    schemaVersion: "valkyr-service-update-plan/v1",
    applied: false,
    authorized: false,
    requiresCanonicalApproval: true,
    expectedMachineId: spec.machineId,
    serviceHandle: "swarm-bridge",
    sharedBridge: true,
    affectedAgentIds,
    supervisor: spec.platform === "darwin" ? "launchd" : "systemd-user",
    label: spec.label,
    serverUrl: safeServerUrl(spec.serverUrl),
    configuration: { sha256: digest(configBytes) },
    current: {
      definitionSha256: digest(currentDefinition),
      processState: "not-observed",
    },
    candidate: {
      definitionSha256: digest(serviceDefinition(spec)),
      runtimeSha256,
      runtimeFileCount: SERVICE_RUNTIME_FILES.length,
    },
  };
  return { ...plan, planSha256: digest(JSON.stringify(plan)) };
}

// This is local preparation, never a lifecycle command or an approval receipt.
// Read-only modes discourage accidental edits; every reuse verifies the bytes.
// The account owner can still change its own files. Activation must revalidate
// the current plan and canonical approval independently at the effect boundary.
function verifyStageDirectory(directory, mode) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("SWARM candidate requires a real directory without symbolic links");
  }
  if (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0
      || (mode !== undefined && (stat.mode & 0o777) !== mode)) {
    throw new Error("SWARM candidate directory permissions must be private and read-only when staged");
  }
}

function candidateParent() {
  let directory = fs.realpathSync(os.homedir());
  verifyStageDirectory(directory);
  for (const component of [".local", "share", "valkyr-swarm", "service-update-candidates"]) {
    directory = path.join(directory, component);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    verifyStageDirectory(directory, component === "service-update-candidates" ? 0o700 : undefined);
  }
  return directory;
}

function verifyCandidate(directory, plan, definition) {
  // macOS requires owner write permission on a directory during rename.
  // Its contents remain read-only and their exact names/bytes are verified.
  verifyStageDirectory(directory, 0o700);
  const runtime = path.join(directory, "runtime");
  verifyStageDirectory(runtime, 0o500);
  for (const [dir, expected] of [[directory, ["plan.json", "runtime", "service-definition"]], [runtime, SERVICE_RUNTIME_FILES]]) {
    if (JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify([...expected].sort())) {
      throw new Error("SWARM candidate verification found unexpected or missing files");
    }
  }
  for (const file of [path.join(directory, "plan.json"), path.join(directory, "service-definition"), ...SERVICE_RUNTIME_FILES.map((name) => path.join(runtime, name))]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o777) !== 0o400) {
      throw new Error("SWARM candidate file verification requires private read-only files without links");
    }
  }
  if (readPreviewFile(path.join(directory, "plan.json"), "Staged plan").toString() !== `${JSON.stringify(plan, null, 2)}\n`
      || readPreviewFile(path.join(directory, "service-definition"), "Staged definition").toString() !== definition
      || serviceRuntimeDigest(runtime) !== plan.candidate.runtimeSha256) {
    throw new Error("SWARM candidate content verification failed");
  }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeCandidateFile(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, 0o400);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function stageServiceUpdate(spec, { expectedPlanSha256, sourceRoot = SCRIPT_DIR } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256 ?? "")) {
    throw new Error("Staging requires the exact expected plan digest from plan-update");
  }
  const checkPlan = () => {
    const current = serviceUpdatePlan(spec, { sourceRoot });
    if (current.planSha256 !== expectedPlanSha256) {
      throw new Error("SWARM update plan does not match the expected digest; create a fresh preview");
    }
    return current;
  };
  const plan = checkPlan();
  const definition = serviceDefinition(spec);
  const parent = candidateParent();
  const destination = path.join(parent, plan.planSha256);
  let existing;
  try { existing = fs.lstatSync(destination); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing) {
    verifyCandidate(destination, plan, definition);
    checkPlan();
  } else {
    const temporary = fs.mkdtempSync(path.join(parent, ".preparing-"));
    try {
      const runtime = path.join(temporary, "runtime");
      fs.mkdirSync(runtime, { mode: 0o700 });
      for (const name of SERVICE_RUNTIME_FILES) {
        writeCandidateFile(path.join(runtime, name), readPreviewFile(path.join(sourceRoot, name), `SWARM service runtime ${name}`, { limit: 8 * 1024 * 1024 }));
      }
      writeCandidateFile(path.join(temporary, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
      writeCandidateFile(path.join(temporary, "service-definition"), definition);
      fs.chmodSync(runtime, 0o500);
      verifyCandidate(temporary, plan, definition);
      syncDirectory(runtime);
      syncDirectory(temporary);
      checkPlan();
      verifyStageDirectory(parent, 0o700);
      try { fs.renameSync(temporary, destination); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
        verifyCandidate(destination, plan, definition);
      }
      syncDirectory(parent);
      verifyCandidate(destination, plan, definition);
      checkPlan();
    } finally {
      if (fs.existsSync(temporary)) {
        fs.chmodSync(temporary, 0o700);
        const runtime = path.join(temporary, "runtime");
        if (fs.existsSync(runtime)) fs.chmodSync(runtime, 0o700);
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
  return {
    schemaVersion: "valkyr-service-update-stage/v1",
    staged: true,
    applied: false,
    authorized: false,
    requiresCanonicalApproval: true,
    planSha256: plan.planSha256,
    expectedMachineId: plan.expectedMachineId,
    serviceHandle: plan.serviceHandle,
    affectedAgentIds: plan.affectedAgentIds,
    candidate: plan.candidate,
    candidateDirectory: destination,
  };
}

function run(executable, args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout).trim() : "";
    throw new Error(`${path.basename(executable)} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function launchTarget(spec) {
  return `gui/${process.getuid()}/${spec.label}`;
}

function install(spec) {
  stageServiceRuntime(spec);
  fs.mkdirSync(path.dirname(spec.servicePath), { recursive: true, mode: 0o700 });
  for (const logPath of [spec.receiptLog, spec.stdoutLog, spec.stderrLog]) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(spec.servicePath, serviceDefinition(spec), { encoding: "utf8", mode: 0o600 });
  if (spec.platform === "darwin") {
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, spec.servicePath], { allowFailure: true });
    run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, spec.servicePath]);
    run("/bin/launchctl", ["enable", launchTarget(spec)]);
    run("/bin/launchctl", ["kickstart", "-k", launchTarget(spec)]);
  } else {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${spec.label}.service`]);
  }
  process.stdout.write(`Installed and started ${spec.label}\n${spec.servicePath}\n`);
}

function uninstall(spec) {
  if (spec.platform === "darwin") {
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, spec.servicePath], { allowFailure: true });
  } else {
    run("systemctl", ["--user", "disable", "--now", `${spec.label}.service`], { allowFailure: true });
  }
  if (fs.existsSync(spec.servicePath)) fs.unlinkSync(spec.servicePath);
  if (spec.platform === "linux") run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  process.stdout.write(`Uninstalled ${spec.label}\n`);
}

function lifecycle(spec, command) {
  if (!fs.existsSync(spec.servicePath)) throw new Error(`Service is not installed: ${spec.servicePath}`);
  if (spec.platform === "darwin") {
    if (command === "stop") return run("/bin/launchctl", ["kill", "SIGTERM", launchTarget(spec)], { allowFailure: true });
    return run("/bin/launchctl", ["kickstart", ...(command === "restart" ? ["-k"] : []), launchTarget(spec)]);
  }
  return run("systemctl", ["--user", command, `${spec.label}.service`]);
}

function status(spec) {
  const result = spec.platform === "darwin"
    ? run("/bin/launchctl", ["print", launchTarget(spec)], { allowFailure: true, capture: true })
    : run("systemctl", ["--user", "status", `${spec.label}.service`, "--no-pager"], { allowFailure: true, capture: true });
  process.stdout.write(result.stdout || result.stderr || `not-loaded ${spec.label}\n`);
  if (result.status !== 0) process.exitCode = 3;
}

function selfTest() {
  const loaded = {
    config: {
      machineId: "agent-host-test",
      serverUrl: "https://api-0.valkyrlabs.com/v1",
      authTokenFile: "~/.config/valkyr-swarm/auth-token",
      authCredentialFile: "~/.config/valkyr-swarm/credentials.json",
      agents: [{ agentId: "codex-test", runtime: "codex" }],
    },
    configPath: "/tmp/valkyr-swarm-test.json",
  };
  for (const platform of ["darwin", "linux"]) {
    const spec = serviceSpec({}, loaded, platform);
    const content = serviceDefinition(spec);
    for (const required of [spec.label, process.execPath, path.dirname(process.execPath), spec.agentScript, spec.serviceRuntimeRoot, "--continuous", "--token-file", "--credential-file", "VALKYR_AUTH", "PATH"]) {
      if (!content.includes(required)) throw new Error(`${platform} service is missing ${required}`);
    }
    if (content.includes(REPO_ROOT) || content.includes(path.join(SCRIPT_DIR, "swarm-agent.mjs"))) {
      throw new Error(`${platform} service depends on the mutable plugin or checkout path`);
    }
    if (/Bearer |eyJ[A-Za-z0-9_-]+\.|API0_JWT_SESSION|VALKYR_AUTH_TOKEN|VALKYR_PASSWORD/.test(content)) {
      throw new Error(`${platform} service contains credential material`);
    }
  }
  for (const unsafeUrl of [
    "https://operator:secret@api-0.valkyrlabs.com/v1",
    "https://api-0.valkyrlabs.com/v1?token=secret",
    "file:///tmp/swarm",
  ]) {
    try {
      safeServerUrl(unsafeUrl);
      throw new Error(`Unsafe SWARM URL was accepted: ${unsafeUrl}`);
    } catch (error) {
      if (String(error?.message ?? error).startsWith("Unsafe SWARM URL was accepted:")) throw error;
    }
  }
  process.stdout.write("Valkyr SWARM service self-test passed\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "self-test") return selfTest();
  if (!["darwin", "linux"].includes(process.platform)) {
    throw new Error("Use swarm-activate --foreground on platforms without launchd or systemd-user");
  }
  const spec = serviceSpec(options, loadConfig(options.config, { bounded: ["plan-update", "stage-update"].includes(options.command) }));
  if (options.command === "plan-update") {
    process.stdout.write(`${JSON.stringify(serviceUpdatePlan(spec), null, 2)}\n`);
    return;
  }
  if (options.command === "stage-update") {
    process.stdout.write(`${JSON.stringify(stageServiceUpdate(spec, { expectedPlanSha256: options.expectedPlanSha256 }), null, 2)}\n`);
    return;
  }
  if (["print-service", "print-plist", "print-unit"].includes(options.command)) {
    process.stdout.write(serviceDefinition(spec));
    return;
  }
  if (options.command === "install") return install(spec);
  if (options.command === "uninstall") return uninstall(spec);
  if (options.command === "start") return lifecycle(spec, "start");
  if (options.command === "stop") return lifecycle(spec, "stop");
  if (options.command === "restart") return lifecycle(spec, "restart");
  if (options.command === "status") return status(spec);
}

// Node resolves the module URL through symlinks, while argv retains the path
// used to launch it (including macOS /var aliases and installed CLI links).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Valkyr SWARM service failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export {
  SERVICE_RUNTIME_FILES,
  parseArgs,
  plist,
  serviceDefinition,
  serviceRuntimeDigest,
  serviceSpec,
  serviceUpdatePlan,
  stageServiceRuntime,
  stageServiceUpdate,
  systemdUnit,
};
