#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_BASE,
  DEFAULT_CREDENTIAL_FILE,
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_TOKEN_FILE,
  credentialsFromEnvironment,
  expandPath,
  loadStoredToken,
  loginWithCredentials,
  normalizeApiBase,
  persistAuthentication,
} from "./swarm-auth.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(SCRIPT_DIR, "swarm-agent.mjs");
const SERVICE_SCRIPT = path.join(SCRIPT_DIR, "swarm-service.mjs");

const DEFAULT_CAPABILITIES = {
  "claude-code": ["code.execute", "pr.review", "workflow.debug"],
  codex: ["code.execute", "pr.review", "workflow.debug"],
  openclaw: ["task.write", "workflow.debug"],
  valoride: ["code.execute", "pr.review", "workflow.debug"],
  valklaw: ["task.write", "code.execute", "pr.review", "workflow.debug"],
  agent: ["task.write", "workflow.debug"],
};

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-activate.mjs [options]\n\nAuthenticates, creates a tenant SWARM agent config, and starts its supervised bridge.\nFor unattended first use, set VALKYR_USERNAME and VALKYR_PASSWORD.\n\nOptions:\n  --runtime <name>            Auto-detected; codex, claude-code, openclaw, valoride, valklaw\n  --agent-id <id>             Default <runtime>-<machine-id>\n  --machine-id <id>           Default normalized hostname\n  --capabilities <csv>        Runtime-safe defaults when omitted\n  --capacity <n>              Default 1\n  --api-base <url>            Default https://api-0.valkyrlabs.com/v1\n  --config <path>             Default ~/.config/valkyr-swarm/agent-<machine-id>.json\n  --receipt-log <path>        Default platform log directory\n  --openclaw-agent-id <id>    Enable the verified OpenClaw Gateway adapter\n  --foreground                Run attached instead of installing supervision\n  --no-service                Create/authenticate only; do not start\n  --dry-run                   Print the non-secret plan without login or writes\n  --self-test                 Validate discovery/config contracts offline\n  -h, --help                  Show this help\n\nProtected outbound.send, production.deploy, and merge actions remain denied locally.\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  const values = new Set([
    "--runtime", "--agent-id", "--machine-id", "--capabilities", "--capacity",
    "--api-base", "--config", "--receipt-log", "--openclaw-agent-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (["--foreground", "--no-service", "--dry-run", "--self-test"].includes(arg)) {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (!values.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

function safeId(value, label) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!normalized) throw new Error(`${label} could not be derived`);
  return normalized;
}

function detectRuntime(env = process.env) {
  if (env.VALKYR_SWARM_RUNTIME) return safeId(env.VALKYR_SWARM_RUNTIME, "runtime");
  if (env.OPENCLAW_INSTANCE_ID || env.OPENCLAW_AGENT_ID) return "openclaw";
  if (env.CLAUDE_CODE || env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.VALORIDE_HOME || env.VALORIDE_INSTANCE_ID) return "valoride";
  if (env.CODEX_HOME || env.CODEX_THREAD_ID) return "codex";
  return "agent";
}

function parseCapabilities(value, runtime) {
  const capabilities = value
    ? String(value).split(",").map((item) => item.trim()).filter(Boolean)
    : [...(DEFAULT_CAPABILITIES[runtime] ?? DEFAULT_CAPABILITIES.agent)];
  const unique = [...new Set(capabilities)];
  if (unique.length === 0) throw new Error("At least one capability is required");
  for (const capability of unique) {
    if (capability.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(capability)) throw new Error(`Capability contains unsupported characters: ${capability}`);
  }
  return unique;
}

function commandPath(name) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

function defaultReceiptLog(machineId) {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Logs", `valkyr-swarm-${machineId}.jsonl`);
  return path.join(os.homedir(), ".local", "state", "valkyr-swarm", `${machineId}.jsonl`);
}

function buildConfig(options) {
  const runtime = safeId(options.runtime ?? detectRuntime(), "runtime");
  const machineId = safeId(options.machineId ?? os.hostname(), "machineId");
  const agentId = safeId(options.agentId ?? `${runtime}-${machineId}`, "agentId");
  const capacity = Number(options.capacity ?? 1);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw new Error("capacity must be an integer from 1 to 100");
  const apiBase = normalizeApiBase(options.apiBase ?? process.env.VALKYR_API_BASE ?? DEFAULT_API_BASE);
  const keychainService = process.env.VALKYR_KEYCHAIN_SERVICE ?? DEFAULT_KEYCHAIN_SERVICE;
  const tokenFile = expandPath(process.env.VALKYR_SWARM_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
  const credentialFile = expandPath(process.env.VALKYR_SWARM_CREDENTIAL_FILE ?? DEFAULT_CREDENTIAL_FILE);
  const configPath = expandPath(options.config ?? path.join(os.homedir(), ".config", "valkyr-swarm", `agent-${machineId}.json`));
  const receiptLog = expandPath(options.receiptLog ?? defaultReceiptLog(machineId));
  const agent = {
    agentId,
    runtime,
    capacity,
    capabilities: parseCapabilities(options.capabilities, runtime),
  };
  if (runtime === "openclaw" && options.openclawAgentId) {
    const executable = commandPath("openclaw");
    if (!executable) throw new Error("--openclaw-agent-id requires the OpenClaw CLI on PATH");
    agent.execution = {
      adapter: "openclaw-agent",
      agentId: safeId(options.openclawAgentId, "openclawAgentId"),
      executable,
      requireGateway: true,
      sessionKeyPrefix: `valkyr-swarm-${machineId}`,
      timeoutSeconds: 600,
    };
  }
  return {
    apiBase,
    configPath,
    credentialFile,
    keychainService,
    receiptLog,
    tokenFile,
    config: {
      machineId,
      serverUrl: apiBase,
      authKeychainService: keychainService,
      authTokenFile: tokenFile,
      authCredentialFile: credentialFile,
      heartbeatSeconds: 30,
      agents: [agent],
    },
  };
}

function writeConfig(target) {
  fs.mkdirSync(path.dirname(target.configPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(target.receiptLog), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target.configPath, `${JSON.stringify(target.config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(target.configPath, 0o600);
}

async function authenticate(target) {
  const credentials = credentialsFromEnvironment();
  let token = null;
  if (credentials.username || credentials.password) {
    token = await loginWithCredentials({ ...credentials, apiBase: target.apiBase });
    persistAuthentication({
      token,
      ...credentials,
      keychainService: target.keychainService,
      tokenFile: target.tokenFile,
      credentialFile: target.credentialFile,
    });
  } else {
    token = loadStoredToken({ keychainService: target.keychainService, tokenFile: target.tokenFile });
  }
  if (!token) {
    throw new Error("No reusable session. Set VALKYR_USERNAME and VALKYR_PASSWORD for unattended activation");
  }
  return token;
}

function startForeground(target, token) {
  const child = spawn(process.execPath, [
    AGENT_SCRIPT,
    "--config", target.configPath,
    "--receipt-log", target.receiptLog,
    "--continuous",
  ], {
    env: { ...process.env, VALKYR_AUTH_TOKEN: token },
    stdio: "inherit",
  });
  child.once("exit", (code, signal) => process.exitCode = signal ? 1 : code ?? 1);
}

function installService(target) {
  const result = spawnSync(process.execPath, [
    SERVICE_SCRIPT,
    "install",
    "--config", target.configPath,
    "--receipt-log", target.receiptLog,
    "--url", target.apiBase,
    "--keychain-service", target.keychainService,
    "--token-file", target.tokenFile,
    "--credential-file", target.credentialFile,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("SWARM service installation failed");
}

function selfTest() {
  const prior = process.env.VALKYR_SWARM_RUNTIME;
  process.env.VALKYR_SWARM_RUNTIME = "codex";
  const target = buildConfig({ machineId: "Example Host" });
  if (target.config.machineId !== "example-host") throw new Error("Machine normalization failed");
  if (target.config.agents[0].agentId !== "codex-example-host") throw new Error("Agent derivation failed");
  if (target.apiBase !== DEFAULT_API_BASE) throw new Error("Default API base failed");
  try {
    parseCapabilities("workflow.debug,header\ninjection", "codex");
    throw new Error("Unsafe capability was accepted");
  } catch (error) {
    if (String(error?.message ?? error) === "Unsafe capability was accepted") throw error;
  }
  if (prior === undefined) delete process.env.VALKYR_SWARM_RUNTIME;
  else process.env.VALKYR_SWARM_RUNTIME = prior;
  process.stdout.write("Valkyr SWARM activation self-test passed\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  const target = buildConfig(options);
  const summary = {
    apiBase: target.apiBase,
    configPath: target.configPath,
    receiptLog: target.receiptLog,
    machineId: target.config.machineId,
    agent: target.config.agents[0],
    mode: options.noService ? "configure-only" : options.foreground ? "foreground" : "supervised",
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ...summary, dryRun: true }, null, 2)}\n`);
    return;
  }
  const token = await authenticate(target);
  writeConfig(target);
  if (options.noService) {
    process.stdout.write(`${JSON.stringify({ ...summary, authenticated: true, started: false })}\n`);
    return;
  }
  if (options.foreground || !["darwin", "linux"].includes(process.platform)) {
    process.stdout.write(`${JSON.stringify({ ...summary, authenticated: true, started: true })}\n`);
    startForeground(target, token);
    return;
  }
  installService(target);
  process.stdout.write(`${JSON.stringify({ ...summary, authenticated: true, started: true })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Valkyr SWARM activation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { buildConfig, detectRuntime, parseArgs, parseCapabilities, safeId };
