#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workflowRuntimeConfig } from "./swarm-workflow-runtime.mjs";

const LABEL_PREFIX = "com.valkyrlabs.workflow-runtime";
const WORKFLOW_RUNNER_MAIN = "com.valkyrlabs.workflow.runner.WorkflowRunnerApplication";
const WORKFLOW_ENGINE_MAIN = "com.valkyrlabs.workflow.engine.sidecar.WorkflowEngineApplication";
const SPRING_PROPERTIES_LAUNCHER = "org.springframework.boot.loader.launch.PropertiesLauncher";

function usage(code = 0) {
  (code ? process.stderr : process.stdout).write(`Usage: node scripts/swarm-workflow-service.mjs <command> --config <json> --agent <id>\n\nCommands:\n  install          Download the checksum-pinned runtime, install, and start it\n  uninstall        Stop and remove the supervised runtime\n  foreground       Verify, install, and run attached to this process\n  start|stop|restart|status\n  print-service    Print the launchd/systemd-user definition\n  self-test        Validate service and artifact safety offline\n\nThe agent workflowRuntime.install block supplies artifactUrl, sha256, optional\nartifactPath, javaExecutable, jvmArgs, and arguments. The runtime is bound to\nloopback and receives no inline username, password, JWT, or tenant identity.\n`);
  process.exit(code);
}

function parseArgs(argv) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") usage(argv.length ? 0 : 2);
  const commands = new Set(["install", "uninstall", "foreground", "start", "stop", "restart", "status", "print-service", "self-test"]);
  if (!commands.has(argv[0])) throw new Error(`Unknown command: ${argv[0]}`);
  const options = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--config", "--agent"].includes(key) || !value) throw new Error(`Invalid option: ${key}`);
    options[key === "--config" ? "config" : "agent"] = value;
  }
  return options;
}

function expandPath(value) {
  if (value === "~") return os.homedir();
  if (String(value).startsWith("~/")) return path.join(os.homedir(), String(value).slice(2));
  return path.resolve(String(value));
}

function safeToken(value, label) {
  const text = String(value ?? "").trim();
  if (!text || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

function safeArgument(value, label) {
  const text = String(value ?? "");
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`${label} contains unsupported characters`);
  return text;
}

function safeRuntimeArgument(value) {
  const text = safeArgument(value, "runtime argument");
  if (/(password|passwd|secret|token|credential|authorization|api[-_.]?key|bearer)/i.test(text)) {
    throw new Error("workflowRuntime.install.arguments must not contain credential material");
  }
  return text;
}

function credentialFreeHttpsUrl(value, label) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS`);
  }
  return url.toString();
}

function capabilityPackSpecs(value, tier, root, availableNodeCapabilities = []) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("workflowRuntime.install.capabilityPacks must contain at most 32 entries");
  }
  if (tier !== "engine" && value.length > 0) {
    throw new Error("The stateless Workflow runner does not accept capability packs");
  }
  const ids = new Set();
  return value.map((pack) => {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      throw new Error("Workflow capability pack metadata must be an object");
    }
    const id = String(pack.id ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || id === "core-transforms" || ids.has(id)) {
      throw new Error(`Workflow capability pack id is invalid or duplicated: ${id || "missing"}`);
    }
    ids.add(id);
    const version = String(pack.version ?? "").trim();
    if (!version || version.length > 64 || !/^[A-Za-z0-9._-]+$/.test(version)) {
      throw new Error(`Workflow capability pack ${id} version is invalid`);
    }
    const sha256 = String(pack.sha256 ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Workflow capability pack ${id} SHA-256 is invalid`);
    }
    const requiredNodeCapabilities = pack.requiredNodeCapabilities == null
      ? []
      : pack.requiredNodeCapabilities;
    if (!Array.isArray(requiredNodeCapabilities) || requiredNodeCapabilities.length > 32) {
      throw new Error(`Workflow capability pack ${id} required node capabilities are invalid`);
    }
    const normalizedCapabilities = [...new Set(requiredNodeCapabilities.map((capability) => {
      const normalized = String(capability ?? "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(normalized)) {
        throw new Error(`Workflow capability pack ${id} required node capability is invalid`);
      }
      return normalized;
    }))].sort();
    const available = new Set(availableNodeCapabilities.map(
      (capability) => String(capability).trim().toLowerCase(),
    ));
    const missing = normalizedCapabilities.filter((capability) => !available.has(capability));
    if (missing.length > 0) {
      throw new Error(`Workflow capability pack ${id} requires unavailable node capabilities: ${missing.join(",")}`);
    }
    return {
      id,
      version,
      // Digest-addressed paths keep an already running engine on its complete old
      // pack set until the new service definition is atomically installed.
      artifactPath: path.join(root, `${id}-${sha256}.jar`),
      artifactUrl: credentialFreeHttpsUrl(
        pack.artifactUrl,
        `Workflow capability pack ${id} artifact URL`,
      ),
      requiredNodeCapabilities: normalizedCapabilities,
      sha256,
    };
  });
}

function credentialReferenceSpecs(value, tier) {
  if (value == null) return [];
  if (tier !== "engine") {
    throw new Error("The stateless Workflow runner does not accept credential references");
  }
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("workflowRuntime.credentialReferences must contain at most 32 entries");
  }
  const references = [...new Set(value.map((reference) => String(reference ?? "").trim()))].sort();
  for (const reference of references) {
    if (!/^(?:keychain:[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}|credential:[A-Za-z0-9._-]{1,128})$/.test(reference)) {
      throw new Error(`Workflow credential reference is invalid: ${reference}`);
    }
  }
  return references;
}

function workspaceRootSpecs(value, tier) {
  if (value == null) return [];
  if (tier !== "engine") {
    throw new Error("The stateless Workflow runner does not accept workspace roots");
  }
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error("workflowRuntime.workspaceRoots must contain at most 64 entries");
  }
  const roots = [...new Set(value.map((root) => {
    const raw = String(root ?? "").trim();
    if (!raw || /[,\r\n\0]/.test(raw)) {
      throw new Error("workflowRuntime.workspaceRoots contains an invalid path");
    }
    return expandPath(raw);
  }))].sort();
  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(`Workflow workspace root is not an existing directory: ${root}`);
    }
  }
  return roots;
}

function deploymentRunnerSpec(value, tier, nodeCapabilities, credentialReferences) {
  if (value == null) return null;
  if (tier !== "engine") {
    throw new Error("The stateless Workflow runner does not accept a deployment runner");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflowRuntime.deploymentRunner must be an object");
  }
  const endpoint = new URL(String(value.endpoint ?? ""));
  const healthEndpoint = new URL(String(value.healthEndpoint ?? ""));
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  for (const [url, pathname, label] of [
    [endpoint, "/api/deployments/execute", "endpoint"],
    [healthEndpoint, "/api/deployments/health", "healthEndpoint"],
  ]) {
    if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== pathname) {
      throw new Error(`workflowRuntime.deploymentRunner.${label} must be exact loopback HTTP ${pathname}`);
    }
  }
  if (String(value.protocol ?? "") !== "valkyr-deployment-runner/v1") {
    throw new Error("workflowRuntime.deploymentRunner protocol is invalid");
  }
  if (!nodeCapabilities.includes("deployment.runner.execute")) {
    throw new Error("The deployment runner requires deployment.runner.execute node capability");
  }
  const credentialReference = String(value.credentialReference ?? "").trim();
  if (credentialReference && !credentialReferences.includes(credentialReference)) {
    throw new Error("The deployment credential reference is not authorized by the Workflow engine");
  }
  return {
    endpoint: endpoint.toString(),
    healthEndpoint: healthEndpoint.toString(),
    protocol: "valkyr-deployment-runner/v1",
    credentialReference,
  };
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function systemdArg(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function loadSpec(configPath, agentId, platform = process.platform) {
  if (!configPath || !agentId) throw new Error("--config and --agent are required");
  const resolvedConfig = expandPath(configPath);
  const root = JSON.parse(fs.readFileSync(resolvedConfig, "utf8"));
  const agent = root.agents?.find((value) => value.agentId === agentId);
  if (!agent) throw new Error(`SWARM agent not found: ${agentId}`);
  const runtime = workflowRuntimeConfig(agent);
  if (!runtime) throw new Error(`SWARM agent ${agentId} has no enabled workflowRuntime`);
  const install = agent.workflowRuntime.install;
  if (!install || typeof install !== "object") throw new Error("workflowRuntime.install is required");
  const artifactUrl = credentialFreeHttpsUrl(
    install.artifactUrl,
    "workflowRuntime.install.artifactUrl",
  );
  const sha256 = String(install.sha256 ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("workflowRuntime.install.sha256 must be a 64-character digest");
  const endpoint = new URL(runtime.endpoint);
  const tier = agent.workflowRuntime.tier === "engine"
    || runtime.supportedTools.includes("workflow.engine.execute-workflow")
    ? "engine" : "runner";
  const artifactPath = expandPath(install.artifactPath
    ?? path.join("~/.local/share/valkyr-swarm/workflow-runtimes", `${agentId}.jar`));
  const runtimePropertiesPath = expandPath(install.runtimePropertiesPath
    ?? path.join("~/.config/valkyr-swarm/workflow-runtimes", `${agentId}.properties`));
  const runtimeDataPath = expandPath(install.runtimeDataPath
    ?? path.join("~/.local/share/valkyr-swarm/workflow-runtimes", `${agentId}-data`));
  const runtimeWorkingDirectory = expandPath(install.runtimeWorkingDirectory
    ?? path.join("~/.local/share/valkyr-swarm/workflow-runtimes", `${agentId}-work`));
  const engineKeyPath = expandPath(install.engineKeyPath
    ?? path.join("~/.config/valkyr-swarm/workflow-runtimes", `${agentId}.engine-key`));
  const capabilityPackRoot = expandPath(path.join(
    "~/.local/share/valkyr-swarm/workflow-runtimes", `${agentId}-packs`));
  const nodeCapabilities = [...new Set([
    ...(agent.capabilities ?? []),
    ...(runtime.capabilities ?? []),
  ].map((capability) => safeToken(capability, "node capability").toLowerCase()))].sort();
  const capabilityPacks = capabilityPackSpecs(
    install.capabilityPacks,
    tier,
    capabilityPackRoot,
    nodeCapabilities,
  );
  const credentialReferences = credentialReferenceSpecs(
    agent.workflowRuntime.credentialReferences,
    tier,
  );
  const deploymentRunner = deploymentRunnerSpec(
    agent.workflowRuntime.deploymentRunner,
    tier,
    nodeCapabilities,
    credentialReferences,
  );
  const workspaceRoots = workspaceRootSpecs(agent.workflowRuntime.workspaceRoots, tier);
  const label = `${LABEL_PREFIX}.${safeToken(agentId, "agentId")}`;
  const servicePath = platform === "darwin"
    ? path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)
    : path.join(os.homedir(), ".config", "systemd", "user", `${label}.service`);
  const logRoot = platform === "darwin" ? path.join(os.homedir(), "Library", "Logs")
    : path.join(os.homedir(), ".local", "state", "valkyr-swarm");
  return {
    agentId,
    artifactPath,
    artifactUrl,
    arguments: Array.isArray(install.arguments) ? install.arguments.map(safeRuntimeArgument) : [],
    capabilityPackRoot,
    capabilityPacks,
    credentialReferences,
    deploymentRunner,
    configPath: resolvedConfig,
    endpoint,
    engineKeyPath,
    javaExecutable: safeArgument(install.javaExecutable ?? "java", "javaExecutable"),
    jvmArgs: Array.isArray(install.jvmArgs) ? install.jvmArgs.map((v) => safeArgument(v, "JVM argument")) : [],
    label,
    platform,
    runtimeDataPath,
    runtimePropertiesPath,
    runtimeWorkingDirectory,
    workspaceRoots,
    tier,
    servicePath,
    sha256,
    minimumJavaVersion: (() => {
      const value = Number(install.minimumJavaVersion ?? 17);
      if (!Number.isInteger(value) || value < 17 || value > 99) {
        throw new Error("workflowRuntime.install.minimumJavaVersion must be an integer from 17 to 99");
      }
      return value;
    })(),
    nodeCapabilities,
    stderrLog: path.join(logRoot, `${agentId}-workflow-runtime.err.log`),
    stdoutLog: path.join(logRoot, `${agentId}-workflow-runtime.out.log`),
  };
}

function runtimeArguments(spec) {
  const engine = spec.tier === "engine";
  const packs = engine ? (spec.capabilityPacks ?? []) : [];
  return [
    ...spec.jvmArgs,
    `-Dloader.main=${engine ? WORKFLOW_ENGINE_MAIN : WORKFLOW_RUNNER_MAIN}`,
    ...(packs.length > 0 ? [`-Dloader.path=${packs.map((pack) => pack.artifactPath).join(",")}`] : []),
    "-cp", spec.artifactPath,
    SPRING_PROPERTIES_LAUNCHER,
    ...spec.arguments,
    `--spring.config.name=${engine ? "application-workflow-engine" : "application-workflow-runner"}`,
    `--spring.profiles.active=${engine ? "workflow-engine" : "workflow-runner"}`,
    "--spring.main.banner-mode=off",
    "--spring.main.lazy-initialization=true",
    "--spring.jmx.enabled=false",
    "--server.address=127.0.0.1",
    `--server.port=${spec.endpoint.port}`,
    `--valkyrai.swarm.runner.config=${spec.configPath}`,
    ...(engine ? [
      `--valkyrai.workflow.engine.database-path=${spec.runtimeDataPath}`,
      `--valkyrai.workflow.engine.key-file=${spec.engineKeyPath}`,
      `--valkyrai.workflow.engine.enabled-packs=${["core-transforms", ...packs.map((pack) => pack.id)].join(",")}`,
      `--valkyrai.workflow.engine.node-capabilities=${(spec.nodeCapabilities ?? []).join(",")}`,
      `--valkyrai.workflow.engine.workspace-roots=${(spec.workspaceRoots ?? []).join(",")}`,
      `--valkyrai.workflow.engine.process-home=${spec.runtimeWorkingDirectory}`,
      ...(spec.credentialReferences?.length > 0 ? [
        `--valkyrai.workflow.engine.allowed-credential-references=${spec.credentialReferences.join(",")}`,
      ] : []),
      ...(spec.deploymentRunner ? [
        `--valkyrai.workflow.engine.deployment-runner-endpoint=${spec.deploymentRunner.endpoint}`,
        ...(spec.deploymentRunner.credentialReference ? [
          `--valkyrai.workflow.engine.deployment-credential-reference=${spec.deploymentRunner.credentialReference}`,
        ] : []),
      ] : []),
    ] : []),
  ];
}

/** Prepare only tier-required node-local state; engine keys are references, never inline arguments. */
function prepareRuntimeDirectory(spec) {
  fs.mkdirSync(spec.runtimeWorkingDirectory, { recursive: true, mode: 0o700 });
  if (spec.tier !== "engine") return;
  fs.mkdirSync(path.dirname(spec.runtimeDataPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(spec.engineKeyPath), { recursive: true, mode: 0o700 });
  if (spec.capabilityPackRoot) {
    fs.mkdirSync(spec.capabilityPackRoot, { recursive: true, mode: 0o700 });
  }
  const journalFiles = [".mv.db", ".trace.db", ".lock.db"]
    .map((suffix) => `${spec.runtimeDataPath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate));
  if (!fs.existsSync(spec.engineKeyPath) && journalFiles.length > 0) {
    throw new Error(
      `Workflow engine key is missing for existing journal ${journalFiles[0]}; restore the key or quarantine the journal before activation`,
    );
  }
  if (!fs.existsSync(spec.engineKeyPath)) {
    fs.writeFileSync(spec.engineKeyPath, `${crypto.randomBytes(32).toString("base64url")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }
  fs.chmodSync(spec.engineKeyPath, 0o600);
}

function serviceDefinition(spec) {
  const args = [spec.javaExecutable, ...runtimeArguments(spec)];
  if (spec.platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(spec.label)}</string>\n  <key>ProgramArguments</key><array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}\n  </array>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>Umask</key><integer>63</integer>\n  <key>WorkingDirectory</key><string>${xml(spec.runtimeWorkingDirectory)}</string>\n  <key>ThrottleInterval</key><integer>15</integer>\n  <key>StandardOutPath</key><string>${xml(spec.stdoutLog)}</string>\n  <key>StandardErrorPath</key><string>${xml(spec.stderrLog)}</string>\n</dict></plist>\n`;
  }
  if (spec.platform !== "linux") throw new Error("Workflow runtime supervision supports macOS and Linux");
  return `[Unit]\nDescription=Valkyr Workflow runtime (${spec.agentId})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${spec.runtimeWorkingDirectory}\nExecStart=${args.map(systemdArg).join(" ")}\nRestart=on-failure\nRestartSec=15\nStandardOutput=append:${spec.stdoutLog}\nStandardError=append:${spec.stderrLog}\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

function run(executable, args, allowFailure = false) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: allowFailure ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${path.basename(executable)} failed`);
  return result;
}

function parseJavaMajorVersion(output) {
  const match = String(output ?? "").match(/(?:java|openjdk) version "(?:1\.)?(\d+)(?:[._-]|\")/i);
  return match ? Number(match[1]) : null;
}

function ensureJavaVersion(spec, spawnImpl = spawnSync) {
  const result = spawnImpl(spec.javaExecutable, ["-version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const major = parseJavaMajorVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (result.status !== 0 || major === null) {
    throw new Error(`Unable to verify Java ${spec.minimumJavaVersion}+ for the Workflow runtime`);
  }
  if (major < spec.minimumJavaVersion) {
    throw new Error(`Workflow runtime requires Java ${spec.minimumJavaVersion}+; found Java ${major}`);
  }
  return major;
}

function launchTarget(spec) { return `gui/${process.getuid()}/${spec.label}`; }

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(digest.digest("hex")));
  });
}

async function installArtifact(spec, fetchImpl = fetch) {
  // Activation is intentionally idempotent. When the exact checksum-pinned
  // release is already present, reuse it instead of depending on the network
  // merely to regenerate or restart the supervised service.
  if (fs.existsSync(spec.artifactPath) && await sha256File(spec.artifactPath) === spec.sha256) {
    return { artifactPath: spec.artifactPath, reused: true, sha256: spec.sha256 };
  }
  // Keep a finite deadline, but allow slower production links enough time to
  // finish before the checksum and atomic replacement gates run.
  const response = await fetchImpl(spec.artifactUrl, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Workflow runtime download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual !== spec.sha256) throw new Error("Workflow runtime artifact checksum mismatch");
  fs.mkdirSync(path.dirname(spec.artifactPath), { recursive: true, mode: 0o700 });
  const temporary = `${spec.artifactPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, spec.artifactPath);
  return { artifactPath: spec.artifactPath, reused: false, sha256: spec.sha256 };
}

async function installCapabilityPacks(spec, fetchImpl = fetch) {
  if (spec.tier !== "engine") {
    if ((spec.capabilityPacks ?? []).length > 0) {
      throw new Error("The stateless Workflow runner does not accept capability packs");
    }
    return [];
  }
  const installed = [];
  for (const pack of spec.capabilityPacks ?? []) {
    installed.push({ id: pack.id, version: pack.version, ...await installArtifact(pack, fetchImpl) });
  }
  return installed;
}

function installService(spec) {
  fs.mkdirSync(path.dirname(spec.servicePath), { recursive: true, mode: 0o700 });
  for (const log of [spec.stdoutLog, spec.stderrLog]) fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  fs.writeFileSync(spec.servicePath, serviceDefinition(spec), { mode: 0o600 });
  if (spec.platform === "darwin") {
    run("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, spec.servicePath], true);
    run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, spec.servicePath]);
    run("/bin/launchctl", ["kickstart", "-k", launchTarget(spec)]);
  } else {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${spec.label}.service`]);
  }
}

function workflowRuntimeEnvironment(source = process.env) {
  const allowed = [
    "HOME", "JAVA_HOME", "LANG", "LC_ALL", "LC_CTYPE", "PATH", "SHELL",
    "SYSTEMROOT", "TMP", "TMPDIR", "TEMP", "USER", "USERNAME",
  ];
  return Object.fromEntries(allowed
    .filter((key) => source[key] != null)
    .map((key) => [key, source[key]]));
}

async function foreground(spec, spawnImpl = spawn) {
  ensureJavaVersion(spec);
  await installArtifact(spec);
  await installCapabilityPacks(spec);
  prepareRuntimeDirectory(spec);

  const child = spawnImpl(spec.javaExecutable, runtimeArguments(spec), {
    cwd: spec.runtimeWorkingDirectory,
    env: workflowRuntimeEnvironment(),
    stdio: "inherit",
  });
  await new Promise((resolve, reject) => {
    const signals = ["SIGINT", "SIGTERM"];
    const handlers = new Map(signals.map((signal) => [signal, () => {
      if (!child.killed) child.kill(signal);
    }]));
    for (const signal of signals) process.once(signal, handlers.get(signal));
    const cleanup = () => {
      for (const signal of signals) process.removeListener(signal, handlers.get(signal));
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
        resolve();
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`Workflow runtime exited with code ${code ?? "unknown"}`));
    });
  });
}

function lifecycle(spec, command) {
  if (spec.platform === "darwin") {
    if (command === "status") {
      const result = run("/bin/launchctl", ["print", launchTarget(spec)], true);
      process.stdout.write(result.stdout || result.stderr || `not-loaded ${spec.label}\n`);
      if (result.status !== 0) process.exitCode = 3;
      return result;
    }
    if (command === "stop") return run("/bin/launchctl", ["kill", "SIGTERM", launchTarget(spec)], true);
    return run("/bin/launchctl", ["kickstart", ...(command === "restart" ? ["-k"] : []), launchTarget(spec)]);
  }
  const result = run("systemctl", ["--user", command, `${spec.label}.service`], command === "status");
  if (command === "status") {
    process.stdout.write(result.stdout || result.stderr || `not-loaded ${spec.label}\n`);
    if (result.status !== 0) process.exitCode = 3;
  }
  return result;
}

function uninstall(spec) {
  if (spec.platform === "darwin") run("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, spec.servicePath], true);
  else run("systemctl", ["--user", "disable", "--now", `${spec.label}.service`], true);
  fs.rmSync(spec.servicePath, { force: true });
  fs.rmSync(spec.artifactPath, { force: true });
  fs.rmSync(spec.runtimePropertiesPath, { force: true });
  fs.rmSync(spec.engineKeyPath, { force: true });
  fs.rmSync(spec.capabilityPackRoot, { recursive: true, force: true });
  for (const suffix of [".mv.db", ".trace.db", ".lock.db"]) {
    fs.rmSync(`${spec.runtimeDataPath}${suffix}`, { force: true });
  }
  for (const directory of [
    spec.runtimeWorkingDirectory,
    `${spec.runtimeDataPath}-files`,
    `${spec.runtimeDataPath}-bootstrap`,
  ]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function selfTest() {
  const fake = {
    agentId: "workflow-test",
    artifactPath: "/tmp/workflow-test.jar",
    arguments: [],
    capabilityPackRoot: "/tmp/workflow-test-packs",
    capabilityPacks: [],
    configPath: "/tmp/swarm.json",
    endpoint: new URL("http://127.0.0.1:8765/v1/swarm/workflow-runs/execute"),
    engineKeyPath: "/tmp/workflow-test.engine-key",
    javaExecutable: "/usr/bin/java",
    jvmArgs: ["-Xmx512m"],
    label: "com.valkyrlabs.workflow-runtime.workflow-test",
    runtimeDataPath: "/tmp/workflow-test-data",
    runtimePropertiesPath: "/tmp/workflow-test.properties",
    runtimeWorkingDirectory: "/tmp/workflow-test-work",
    tier: "runner",
    stderrLog: "/tmp/workflow-test.err",
    stdoutLog: "/tmp/workflow-test.out",
  };
  for (const platform of ["darwin", "linux"]) {
    const definition = serviceDefinition({ ...fake, platform });
    for (const expected of [
      "workflow-runner", "127.0.0.1", "8765", fake.artifactPath,
      fake.configPath, WORKFLOW_RUNNER_MAIN, SPRING_PROPERTIES_LAUNCHER,
    ]) {
      if (!definition.includes(expected)) throw new Error(`${platform} definition omitted ${expected}`);
    }
    if (/Bearer |eyJ[A-Za-z0-9_-]+\.|password/i.test(definition)) throw new Error(`${platform} definition contains credential material`);
  }
  const engine = { ...fake, tier: "engine", endpoint: new URL("http://127.0.0.1:8767/v1/swarm/workflow-engine/execute") };
  const engineArgs = runtimeArguments(engine);
  for (const expected of [
    `-Dloader.main=${WORKFLOW_ENGINE_MAIN}`,
    "--spring.config.name=application-workflow-engine",
    "--spring.profiles.active=workflow-engine",
    `--valkyrai.workflow.engine.database-path=${engine.runtimeDataPath}`,
    `--valkyrai.workflow.engine.key-file=${engine.engineKeyPath}`,
  ]) {
    if (!engineArgs.includes(expected)) throw new Error(`engine arguments omitted ${expected}`);
  }
  process.stdout.write("Valkyr Workflow runtime service self-test passed\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "self-test") return selfTest();
  const spec = loadSpec(options.config, options.agent);
  if (options.command === "print-service") return process.stdout.write(serviceDefinition(spec));
  if (options.command === "foreground") return foreground(spec);
  if (options.command === "install") {
    ensureJavaVersion(spec);
    await installArtifact(spec);
    await installCapabilityPacks(spec);
    prepareRuntimeDirectory(spec);
    installService(spec);
    return process.stdout.write(`Installed ${spec.label}\n`);
  }
  if (options.command === "uninstall") return uninstall(spec);
  return lifecycle(spec, options.command);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Valkyr Workflow runtime service failed: ${error?.message ?? String(error)}\n`);
    process.exit(1);
  });
}

export {
  ensureJavaVersion,
  foreground,
  installArtifact,
  installCapabilityPacks,
  loadSpec,
  parseArgs,
  parseJavaMajorVersion,
  prepareRuntimeDirectory,
  runtimeArguments,
  serviceDefinition,
  workflowRuntimeEnvironment,
};
