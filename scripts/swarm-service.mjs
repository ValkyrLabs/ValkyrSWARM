#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const AGENT_SCRIPT = path.join(SCRIPT_DIR, "swarm-agent.mjs");
const LABEL_PREFIX = "com.valkyrlabs.swarm";

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-service.mjs <command> --config <json> [options]\n\nInstalls and operates a launchd or systemd-user service for one SWARM host.\n\nCommands:\n  install          Install and start the service\n  uninstall        Stop and remove the service\n  start            Start the installed service\n  stop             Stop the service\n  restart          Restart the service\n  status           Print service state\n  print-service    Print the native service definition\n  print-plist      Alias for macOS compatibility\n  print-unit       Alias for Linux compatibility\n  self-test        Validate service safety offline\n\nOptions:\n  --config <path>              Machine SWARM configuration\n  --url <url>                  Override config.serverUrl\n  --receipt-log <path>         Redacted JSONL evidence path\n  --stdout-log <path>          Supervisor stdout path\n  --stderr-log <path>          Supervisor stderr path\n  --keychain-service <name>    macOS token service\n  --token-file <path>          Mode-0600 token file\n  --credential-file <path>     Mode-0600 credentials for session refresh\n  --label <name>               Override deterministic service label\n  -h, --help                   Show this help\n\nNo JWT, username, or password is written into the service definition.\n`);
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
    "print-service", "print-plist", "print-unit", "self-test",
  ]);
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
  const options = { command };
  const valueOptions = new Set([
    "--config", "--url", "--receipt-log", "--stdout-log", "--stderr-log",
    "--keychain-service", "--token-file", "--credential-file", "--label",
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

function loadConfig(configPath) {
  if (!configPath) throw new Error("--config is required");
  const resolved = expandPath(configPath);
  if (!fs.existsSync(resolved)) throw new Error(`SWARM config not found: ${resolved}`);
  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!config.machineId || !Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error("SWARM config requires machineId and at least one agent");
  }
  return { config, configPath: resolved };
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
  return {
    configPath: loaded.configPath,
    credentialFile,
    keychainService,
    label,
    machineId,
    platform,
    receiptLog,
    runtimePath,
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
    AGENT_SCRIPT,
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
    <key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>
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
WorkingDirectory=${systemdArg(REPO_ROOT)}
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
    for (const required of [spec.label, process.execPath, path.dirname(process.execPath), AGENT_SCRIPT, "--continuous", "--token-file", "--credential-file", "VALKYR_AUTH", "PATH"]) {
      if (!content.includes(required)) throw new Error(`${platform} service is missing ${required}`);
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
  const spec = serviceSpec(options, loadConfig(options.config));
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Valkyr SWARM service failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { parseArgs, plist, serviceDefinition, serviceSpec, systemdUnit };
