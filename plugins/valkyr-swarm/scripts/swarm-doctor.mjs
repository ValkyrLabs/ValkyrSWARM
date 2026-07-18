#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  credentialsFromSecureStorage,
  expandPath,
  loadStoredToken,
  normalizeApiBase,
} from "./swarm-auth.mjs";
import { validateConfig } from "./swarm-agent.mjs";
import { ValkyrSwarmClient } from "../mcp-server/index.js";

const VERSION = "0.3.0";
const FORBIDDEN_CONFIG_KEYS = new Set([
  "authorization", "bearertoken", "jwt", "ownerid", "organizationid",
  "password", "secret", "tenantid", "token", "username",
]);
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-doctor.mjs [options]\n\nRuns secret-safe local diagnostics and optional authenticated tenant verification.\n\nOptions:\n  --config <path>        Default ~/.config/valkyr-swarm/agent-<hostname>.json\n  --receipt-log <path>   Default platform receipt path for the machine\n  --live                 Verify registered agents through authenticated api-0\n  --self-test            Validate doctor contracts without local or network state\n  --json                 Explicit machine-readable output (the default)\n  -h, --help             Show this help\n`);
  process.exit(exitCode);
}

function safeId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--live" || arg === "--self-test" || arg === "--json") {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (!new Set(["--config", "--receipt-log"]).has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

function defaultPaths(options = {}) {
  const machineId = safeId(os.hostname());
  const configPath = expandPath(options.config ?? path.join(os.homedir(), ".config", "valkyr-swarm", `agent-${machineId}.json`));
  return {
    configPath,
    machineId,
    receiptLog: expandPath(options.receiptLog ?? defaultReceiptLog(machineId)),
  };
}

function defaultReceiptLog(machineId) {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Logs", `valkyr-swarm-${machineId}.jsonl`)
    : path.join(os.homedir(), ".local", "state", "valkyr-swarm", `${machineId}.jsonl`);
}

function privateMode(filePath) {
  if (process.platform === "win32") return true;
  return (fs.statSync(filePath).mode & 0o077) === 0;
}

function forbiddenConfigPaths(value, prefix = []) {
  if (!value || typeof value !== "object") return [];
  const violations = [];
  for (const [key, child] of Object.entries(value)) {
    const current = [...prefix, key];
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_CONFIG_KEYS.has(normalized)) violations.push(current.join("."));
    violations.push(...forbiddenConfigPaths(child, current));
  }
  return violations;
}

function readReceiptEvidence(receiptPath, agentIds, now = Date.now()) {
  if (!fs.existsSync(receiptPath)) return { exists: false, heartbeatAgeSeconds: null, latestEvent: null, secretSafe: true };
  const stat = fs.statSync(receiptPath);
  const start = Math.max(0, stat.size - 128 * 1024);
  const buffer = Buffer.alloc(stat.size - start);
  const descriptor = fs.openSync(receiptPath, "r");
  try {
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(descriptor);
  }
  const text = buffer.toString("utf8");
  const rows = text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const heartbeats = rows.filter((row) => row.event === "heartbeat_sent" && agentIds.includes(row.agentId));
  const latestHeartbeat = heartbeats.at(-1);
  const latestEvent = rows.at(-1) ?? null;
  return {
    exists: true,
    heartbeatAgeSeconds: latestHeartbeat?.timestamp
      ? Math.max(0, Math.round((now - Date.parse(latestHeartbeat.timestamp)) / 1000))
      : null,
    latestEvent: latestEvent ? { event: latestEvent.event, timestamp: latestEvent.timestamp } : null,
    secretSafe: !JWT.test(text) && !/\bBearer\s+[A-Za-z0-9._~-]{8,}/i.test(text),
  };
}

function serviceState(machineId) {
  const label = `com.valkyrlabs.swarm.${machineId}`;
  if (process.platform === "darwin") {
    const target = `gui/${process.getuid()}/${label}`;
    const result = spawnSync("/bin/launchctl", ["print", target], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    return {
      label,
      installed: result.status === 0,
      running: result.status === 0 && /\bstate = running\b/.test(output),
      pid: Number(output.match(/\bpid = (\d+)/)?.[1] ?? 0) || null,
      supervisor: "launchd",
    };
  }
  if (process.platform === "linux") {
    const unit = `${label}.service`;
    const result = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" });
    return { label, installed: result.status === 0, running: result.stdout.trim() === "active", pid: null, supervisor: "systemd-user" };
  }
  return { label, installed: false, running: false, pid: null, supervisor: "foreground" };
}

function check(name, status, details = {}) {
  return { name, status, ...details };
}

async function diagnose(options = {}) {
  const paths = defaultPaths(options);
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(check("node_runtime", nodeMajor >= 22 ? "pass" : "fail", { version: process.versions.node, required: ">=22" }));

  let config = null;
  if (!fs.existsSync(paths.configPath)) {
    checks.push(check("private_config", "fail", { path: paths.configPath, reason: "not_found" }));
  } else {
    try {
      config = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
      validateConfig(config);
      const forbidden = forbiddenConfigPaths(config);
      const serialized = JSON.stringify(config);
      checks.push(check("private_config", privateMode(paths.configPath) && forbidden.length === 0 && !JWT.test(serialized) ? "pass" : "fail", {
        path: paths.configPath,
        modePrivate: privateMode(paths.configPath),
        forbiddenFields: forbidden,
        containsJwt: JWT.test(serialized),
      }));
      normalizeApiBase(config.serverUrl);
      paths.machineId = config.machineId;
      if (!options.receiptLog) paths.receiptLog = defaultReceiptLog(config.machineId);
    } catch (error) {
      checks.push(check("config_contract", "fail", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  const keychainService = config?.authKeychainService ?? process.env.VALKYR_KEYCHAIN_SERVICE ?? "VALKYR_AUTH";
  const tokenFile = config?.authTokenFile ?? process.env.VALKYR_SWARM_TOKEN_FILE;
  const credentialFile = config?.authCredentialFile ?? process.env.VALKYR_SWARM_CREDENTIAL_FILE;
  let tokenAvailable = false;
  let reusableCredentials = false;
  try {
    tokenAvailable = Boolean(loadStoredToken({ keychainService, tokenFile }));
    const credentials = credentialsFromSecureStorage({ keychainService, credentialFile });
    reusableCredentials = Boolean(credentials.username && credentials.password);
    checks.push(check("secure_auth", tokenAvailable && reusableCredentials ? "pass" : tokenAvailable ? "warn" : "fail", {
      tokenAvailable,
      reusableCredentials,
      storage: process.platform === "darwin" ? "keychain" : "mode-0600-files",
    }));
  } catch (error) {
    checks.push(check("secure_auth", "fail", { reason: error instanceof Error ? error.message : String(error) }));
  }

  const agents = config?.agents ?? [];
  const receipt = readReceiptEvidence(paths.receiptLog, agents.map((agent) => agent.agentId));
  const receiptPrivate = receipt.exists ? privateMode(paths.receiptLog) : null;
  checks.push(check("receipt_log", receipt.exists && receipt.secretSafe && receiptPrivate ? "pass" : receipt.exists ? "fail" : "warn", {
    path: paths.receiptLog,
    ...receipt,
    modePrivate: receiptPrivate,
  }));
  if (receipt.exists && receipt.heartbeatAgeSeconds !== null) {
    checks.push(check("heartbeat", receipt.heartbeatAgeSeconds <= 120 ? "pass" : "warn", { ageSeconds: receipt.heartbeatAgeSeconds }));
  }

  const service = serviceState(paths.machineId);
  checks.push(check("supervision", service.running ? "pass" : service.installed ? "warn" : "fail", service));

  let live = null;
  if (options.live && config) {
    try {
      const client = new ValkyrSwarmClient({ env: { ...process.env, VALKYR_API_BASE: config.serverUrl } });
      const snapshot = await client.agentsSnapshot();
      const registry = snapshot?.registry && typeof snapshot.registry === "object" ? snapshot.registry : {};
      const registered = agents.map((agent) => ({
        agentId: agent.agentId,
        present: Boolean(registry[agent.agentId]),
        status: registry[agent.agentId]?.status ?? null,
        runtime: registry[agent.agentId]?.runtime ?? null,
        lastSeen: registry[agent.agentId]?.lastSeen ?? registry[agent.agentId]?.lastHeartbeat ?? null,
      }));
      live = { agentCount: Object.keys(registry).length, registered };
      const healthy = registered.length > 0 && registered.every((agent) => agent.present && agent.status === "healthy");
      checks.push(check("tenant_registry", healthy ? "pass" : "fail", live));
    } catch (error) {
      checks.push(check("tenant_registry", "fail", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  const failed = checks.filter((item) => item.status === "fail").length;
  const warned = checks.filter((item) => item.status === "warn").length;
  return {
    product: "Valkyr SWARM",
    version: VERSION,
    status: failed ? "failed" : warned ? "degraded" : "ready",
    configPath: paths.configPath,
    receiptLog: paths.receiptLog,
    machineId: paths.machineId,
    agents: agents.map((agent) => ({ agentId: agent.agentId, runtime: agent.runtime, capabilities: agent.capabilities })),
    live,
    checks,
  };
}

function selfTest() {
  const safe = { machineId: "host", authTokenFile: "/private/token", agents: [] };
  if (forbiddenConfigPaths(safe).length !== 0) throw new Error("Secure-store paths must be allowed in config");
  const unsafe = { tenantId: "prompt-tenant", agents: [{ password: "secret" }] };
  if (forbiddenConfigPaths(unsafe).join(",") !== "tenantId,agents.0.password") {
    throw new Error("Forbidden tenant/secret fields were not detected");
  }
  if (safeId("Test Host") !== "test-host") throw new Error("Doctor machine normalization failed");
  process.stdout.write("Valkyr SWARM doctor self-test passed\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  const report = await diagnose(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === "failed") process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Valkyr SWARM doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { defaultPaths, defaultReceiptLog, diagnose, forbiddenConfigPaths, parseArgs, readReceiptEvidence, safeId, serviceState };
