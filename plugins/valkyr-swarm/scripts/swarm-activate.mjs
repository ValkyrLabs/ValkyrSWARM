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
const WORKFLOW_SERVICE_SCRIPT = path.join(SCRIPT_DIR, "swarm-workflow-service.mjs");
const WORKFLOW_RELEASE_PROTOCOL = "valkyr-workflow-runtime-release/v1";
const WORKFLOW_RUNNER_PROTOCOL = "valkyr-workflow-runner/v1";
const WORKFLOW_ENGINE_PROTOCOL = "valkyr-workflow-engine/v1";

const DEFAULT_CAPABILITIES = {
  "claude-code": ["code.execute", "engineering.project.execute", "pr.review", "merge", "workflow.debug", "workspace.files.read"],
  codex: ["code.execute", "engineering.project.execute", "pr.review", "merge", "workflow.debug", "workspace.files.read"],
  openclaw: [
    "task.write", "market.research", "crm.write", "inbound.triage", "cms.write",
    "outbound.send", "workflow.debug", "openclaw.skill.execute",
    "openclaw.research-draft.execute",
  ],
  valoride: ["code.execute", "engineering.project.execute", "pr.review", "production.deploy", "workflow.debug", "workspace.files.read"],
  valklaw: ["task.write", "code.execute", "engineering.project.execute", "pr.review", "workflow.debug", "openclaw.skill.execute", "openclaw.research-draft.execute", "workspace.files.read"],
  agent: ["task.write", "workflow.debug"],
};

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-activate.mjs [options]

Authenticates, creates or updates a production tenant SWARM config, and starts its supervised bridge.
For unattended first use, set VALKYR_USERNAME and VALKYR_PASSWORD.

Options:
  --runtime <name>            Auto-detected; codex, claude-code, openclaw, valoride, valklaw
  --agent-id <id>             Default <runtime>-<machine-id>
  --machine-id <id>           Default normalized hostname
  --capabilities <csv>        Runtime-safe defaults when omitted
  --capacity <n>              Default 1
  --api-base <url>            Production api-0; non-production requires --test-mode
  --config <path>             Default ~/.config/valkyr-swarm/agent-<machine-id>.json
  --receipt-log <path>        Default platform log directory
  --runtime-agent-id <id>     Local runtime identity (OpenClaw/ValorIDE/etc.)
  --runtime-executable <path> Override auto-discovered runtime CLI
  --workspace <path>          Runtime working directory
  --workflow-runtime          Install ValkyrAI's approved local Workflow runner
  --workflow-engine           Install the approved durable mini-ValkyrAI engine
  --workflow-artifact-url <u> Optional approved-release override (with SHA-256)
  --workflow-artifact-sha256  SHA-256 paired with the artifact override
  --workflow-runtime-port <n> Loopback runtime port (default 8765)
  --workflow-runtime-max-heap Override the release-recommended bounded heap
  --workflow-credential-refs  Comma-separated node-owned Keychain/systemd references
  --deployment-runner-endpoint Exact node-local deployment runner execute endpoint
  --deployment-credential-ref Optional node-owned deployment credential reference
  --receipt-only              Explicitly disable local execution
  --replace-agent             Replace, rather than merge, the machine agent set
  --test-mode                 Allow an isolated non-production endpoint
  --foreground                Run attached instead of installing supervision
  --no-service                Create/authenticate only; do not start
  --dry-run                   Print the non-secret plan without login or writes
  --self-test                 Validate discovery/config contracts offline
  -h, --help                  Show this help

Protected outbound.send, production.deploy, and merge actions require an exact
content-bound human approval reference from the authenticated mothership.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  const values = new Set([
    "--runtime", "--agent-id", "--machine-id", "--capabilities", "--capacity",
    "--api-base", "--config", "--receipt-log", "--openclaw-agent-id",
    "--runtime-agent-id", "--runtime-executable", "--workspace",
    "--workflow-artifact-url", "--workflow-artifact-sha256", "--workflow-runtime-port",
    "--workflow-runtime-max-heap", "--workflow-credential-refs",
    "--deployment-runner-endpoint", "--deployment-credential-ref",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (["--foreground", "--no-service", "--dry-run", "--self-test", "--receipt-only", "--replace-agent", "--test-mode", "--workflow-runtime", "--workflow-engine"].includes(arg)) {
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

function parseWorkflowRuntimeMaxHeap(value = "512m") {
  const normalized = String(value).trim().toLowerCase();
  const match = /^(\d+)(m|g)$/.exec(normalized);
  if (!match) {
    throw new Error("workflow runtime max heap must use a whole-number m or g suffix");
  }
  const amount = Number(match[1]);
  const mebibytes = match[2] === "g" ? amount * 1024 : amount;
  if (!Number.isSafeInteger(mebibytes) || mebibytes < 256 || mebibytes > 8192) {
    throw new Error("workflow runtime max heap must be between 256m and 8g");
  }
  return normalized;
}

function parseWorkflowCredentialReferences(value) {
  if (value == null || String(value).trim() === "") return [];
  const references = [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
  if (references.length > 32) throw new Error("workflow credential references must contain at most 32 entries");
  for (const reference of references) {
    if (!/^(?:keychain:[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}|credential:[A-Za-z0-9._-]{1,128})$/.test(reference)) {
      throw new Error(`Workflow credential reference is invalid: ${reference}`);
    }
  }
  return references.sort();
}

function parseDeploymentRunnerEndpoint(value) {
  if (value == null || String(value).trim() === "") return null;
  const endpoint = new URL(String(value));
  if (endpoint.protocol !== "http:"
      || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || endpoint.pathname !== "/api/deployments/execute") {
    throw new Error("deployment runner endpoint must be exact loopback HTTP /api/deployments/execute");
  }
  return endpoint.toString();
}

function commandPath(name) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

function runtimeExecutable(runtime, override) {
  if (override) return expandPath(override);
  const candidates = {
    // Prefer the self-contained desktop binary on macOS. Homebrew's `codex`
    // launcher commonly relies on `#!/usr/bin/env node`, which is not
    // available under launchd's intentionally minimal PATH.
    codex: ["/Applications/ChatGPT.app/Contents/Resources/codex", "codex"],
    "claude-code": ["claude"],
    openclaw: ["openclaw"],
    valoride: ["valor", "valoride"],
    valklaw: ["valor", "valklaw"],
  }[runtime] ?? [];
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && fs.existsSync(candidate)) return candidate;
    const resolved = commandPath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function executionConfig(runtime, options, agentId, machineId) {
  if (options.receiptOnly || runtime === "agent") return null;
  const executable = runtimeExecutable(runtime, options.runtimeExecutable);
  if (!executable) {
    throw new Error(`No executable runtime found for ${runtime}; install its product CLI or use --receipt-only explicitly`);
  }
  const workingDirectory = expandPath(options.workspace ?? process.env.VALKYR_SWARM_WORKSPACE ?? process.cwd());
  const runtimeAgentId = safeId(
    options.runtimeAgentId ?? options.openclawAgentId ?? process.env.OPENCLAW_AGENT_ID ?? agentId,
    "runtimeAgentId",
  );
  if (runtime === "openclaw") {
    return {
      adapter: "openclaw-agent",
      agentId: runtimeAgentId,
      executable,
      requireGateway: true,
      sessionKeyPrefix: `valkyr-swarm-${machineId}`,
      timeoutSeconds: 600,
      workingDirectory,
    };
  }
  const adapter = {
    codex: "codex-cli",
    "claude-code": "claude-code-cli",
    valoride: "valoride-cli",
    valklaw: "valoride-cli",
  }[runtime];
  if (!adapter) throw new Error(`Runtime ${runtime} does not have a productized execution adapter`);
  return { adapter, agentId: runtimeAgentId, executable, timeoutSeconds: 600, workingDirectory };
}

function requireProductionApiBase(apiBase, testMode = false) {
  if (apiBase !== DEFAULT_API_BASE && !testMode) {
    throw new Error(`Durable SWARM activation must use ${DEFAULT_API_BASE}; use --test-mode only for isolated tests`);
  }
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
  requireProductionApiBase(apiBase, options.testMode);
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
  const deploymentRunnerEndpoint = parseDeploymentRunnerEndpoint(
    options.deploymentRunnerEndpoint ?? process.env.VALKYR_DEPLOYMENT_RUNNER_ENDPOINT,
  );
  const deploymentCredentialRef = options.deploymentCredentialRef
    ?? process.env.VALKYR_DEPLOYMENT_CREDENTIAL_REF;
  if ((deploymentRunnerEndpoint || deploymentCredentialRef) && !options.workflowEngine) {
    throw new Error("The productized deployment runner requires the durable Workflow engine tier");
  }
  if (deploymentCredentialRef && !deploymentRunnerEndpoint) {
    throw new Error("A deployment credential reference requires a configured deployment runner endpoint");
  }
  if (deploymentRunnerEndpoint && !agent.capabilities.includes("production.deploy")) {
    throw new Error("The deployment runner requires an explicit production.deploy node capability");
  }
  if (deploymentCredentialRef) {
    parseWorkflowCredentialReferences(deploymentCredentialRef);
  }
  if (deploymentRunnerEndpoint
      && !agent.capabilities.includes("deployment.runner.execute")) {
    agent.capabilities.push("deployment.runner.execute");
  }
  const execution = executionConfig(runtime, options, agentId, machineId);
  if (execution) agent.execution = execution;
  if (options.workflowRuntime && options.workflowEngine) {
    throw new Error("Choose either the stateless Workflow runner or durable Workflow engine tier");
  }
  const workflowRuntimeRequested = options.workflowRuntime || options.workflowEngine
    || options.workflowArtifactUrl
    || process.env.VALKYR_WORKFLOW_RUNTIME_ARTIFACT_URL
    || process.env.VALKYR_WORKFLOW_RUNTIME_ARTIFACT_SHA256;
  if (workflowRuntimeRequested) {
    const tier = options.workflowEngine ? "engine" : "runner";
    const credentialReferences = parseWorkflowCredentialReferences(
      options.workflowCredentialRefs ?? process.env.VALKYR_WORKFLOW_CREDENTIAL_REFS,
    );
    if (deploymentCredentialRef && !credentialReferences.includes(deploymentCredentialRef)) {
      credentialReferences.push(deploymentCredentialRef);
      credentialReferences.sort();
    }
    if (tier !== "engine" && credentialReferences.length > 0) {
      throw new Error("The stateless Workflow runner does not accept credential references");
    }
    const artifactUrl = options.workflowArtifactUrl ?? process.env.VALKYR_WORKFLOW_RUNTIME_ARTIFACT_URL;
    const sha256 = options.workflowArtifactSha256 ?? process.env.VALKYR_WORKFLOW_RUNTIME_ARTIFACT_SHA256;
    if (Boolean(artifactUrl) !== Boolean(sha256)) {
      throw new Error("Workflow runtime artifact URL and SHA-256 overrides must be supplied together");
    }
    const port = Number(options.workflowRuntimePort ?? process.env.VALKYR_WORKFLOW_RUNTIME_PORT
      ?? (tier === "engine" ? 8767 : 8765));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("workflow runtime port must be between 1024 and 65535");
    }
    const heapOverride = options.workflowRuntimeMaxHeap
      ?? process.env.VALKYR_WORKFLOW_RUNTIME_MAX_HEAP;
    // Existing releases booted the full application and required this conservative fallback.
    // New releases advertise a measured slim-runner heap during authenticated discovery.
    const maximumHeap = parseWorkflowRuntimeMaxHeap(heapOverride ?? "3g");
    agent.workflowRuntime = {
      enabled: true,
      tier,
      endpoint: tier === "engine"
        ? `http://127.0.0.1:${port}/v1/swarm/workflow-engine/execute`
        : `http://127.0.0.1:${port}/v1/swarm/workflow-runs/execute`,
      healthEndpoint: tier === "engine"
        ? `http://127.0.0.1:${port}/v1/swarm/workflow-engine/health`
        : `http://127.0.0.1:${port}/v1/swarm/workflow-runs/health`,
      timeoutSeconds: 900,
      capabilities: ["java:17", "graymatter.context"],
      ...(tier === "engine" && execution?.workingDirectory
        ? { workspaceRoots: [execution.workingDirectory] }
        : {}),
      ...(credentialReferences.length > 0 ? { credentialReferences } : {}),
      supportedTools: [tier === "engine"
        ? "workflow.engine.execute-workflow"
        : "workflow.runner.execute-module"],
      allowedEnvironments: deploymentRunnerEndpoint
          && agent.capabilities.includes("production.deploy")
        ? ["sandbox", "staging", "production"]
        : ["sandbox", "staging"],
      allowedDataClassifications: ["internal"],
      privacyZones: ["internal"],
      networkZones: ["loopback"],
      maxConcurrency: capacity,
      estimatedCost: 0,
      estimatedLatencyMs: 100,
      trustScore: 0.9,
      localExecution: true,
      leaseDurationSeconds: 120,
      ...(deploymentRunnerEndpoint ? {
        deploymentRunner: {
          endpoint: deploymentRunnerEndpoint,
          healthEndpoint: new URL("/api/deployments/health", deploymentRunnerEndpoint).toString(),
          protocol: "valkyr-deployment-runner/v1",
          ...(deploymentCredentialRef ? { credentialReference: deploymentCredentialRef } : {}),
        },
      } : {}),
      install: {
        tier,
        ...(artifactUrl ? {
          artifactUrl,
          sha256: String(sha256).toLowerCase(),
        } : { releaseDiscovery: true }),
        minimumJavaVersion: 17,
        artifactPath: path.join(
          os.homedir(), ".local", "share", "valkyr-swarm", "workflow-runtimes", `${agentId}.jar`),
        javaExecutable: process.env.JAVA_HOME
          ? path.join(process.env.JAVA_HOME, "bin", "java") : "java",
        jvmArgs: ["-Xms128m", `-Xmx${maximumHeap}`],
        ...(heapOverride == null && !artifactUrl ? { useReleaseRecommendedHeap: true } : {}),
        arguments: [],
      },
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
    mergeAgents: !options.replaceAgent,
  };
}

function writeConfig(target) {
  fs.mkdirSync(path.dirname(target.configPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(target.receiptLog), { recursive: true, mode: 0o700 });
  let config = target.config;
  if (target.mergeAgents && fs.existsSync(target.configPath)) {
    const existing = JSON.parse(fs.readFileSync(target.configPath, "utf8"));
    if (existing.machineId !== config.machineId) throw new Error("Existing SWARM config belongs to another machine");
    requireProductionApiBase(normalizeApiBase(existing.serverUrl));
    const agents = new Map((existing.agents ?? []).map((agent) => [agent.agentId, agent]));
    config.agents.forEach((agent) => agents.set(agent.agentId, agent));
    config = {
      ...existing,
      ...config,
      agents: [...agents.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    };
  }
  target.config = config;
  fs.writeFileSync(target.configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

function validateWorkflowReleaseDescriptor(value, expectedTier = "runner") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow runtime release response must be an object");
  }
  if (value.protocol !== WORKFLOW_RELEASE_PROTOCOL) {
    throw new Error(`Unsupported Workflow runtime release protocol: ${String(value.protocol ?? "missing")}`);
  }
  const tier = String(value.tier ?? "runner");
  if (tier !== expectedTier || !["runner", "engine"].includes(tier)) {
    throw new Error(`Workflow runtime release tier mismatch: ${tier}`);
  }
  const runtimeProtocol = String(value.runtimeProtocol
    ?? value.runnerProtocol
    ?? (tier === "engine" ? value.engineProtocol : ""));
  const expectedRuntimeProtocol = tier === "engine" ? WORKFLOW_ENGINE_PROTOCOL : WORKFLOW_RUNNER_PROTOCOL;
  if (runtimeProtocol !== expectedRuntimeProtocol) {
    throw new Error(`Unsupported Workflow ${tier} protocol: ${runtimeProtocol || "missing"}`);
  }
  const version = String(value.version ?? "").trim();
  if (!version || version.length > 128 || /[\r\n\0]/.test(version)) {
    throw new Error("Workflow runtime release version is invalid");
  }
  const artifactUrl = new URL(String(value.artifactUrl ?? ""));
  if (artifactUrl.protocol !== "https:"
      || !artifactUrl.hostname
      || artifactUrl.username
      || artifactUrl.password
      || artifactUrl.search
      || artifactUrl.hash) {
    throw new Error("Workflow runtime release artifact URL must be credential-free HTTPS");
  }
  const sha256 = String(value.sha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Workflow runtime release SHA-256 is invalid");
  }
  const minimumJavaVersion = Number(value.minimumJavaVersion);
  if (!Number.isInteger(minimumJavaVersion) || minimumJavaVersion < 17 || minimumJavaVersion > 99) {
    throw new Error("Workflow runtime minimum Java version is invalid");
  }
  let recommendedMaxHeap = null;
  if (value.recommendedMaxHeap != null) {
    try {
      recommendedMaxHeap = parseWorkflowRuntimeMaxHeap(value.recommendedMaxHeap);
    } catch {
      throw new Error("Workflow runtime recommended max heap is invalid");
    }
  }
  const capabilityPacks = validateCapabilityPackReleases(value.capabilityPacks, tier);
  return {
    artifactUrl: artifactUrl.toString(),
    capabilityPacks,
    minimumJavaVersion,
    ...(tier === "runner" ? { runnerProtocol: WORKFLOW_RUNNER_PROTOCOL } : { engineProtocol: WORKFLOW_ENGINE_PROTOCOL }),
    runtimeProtocol: expectedRuntimeProtocol,
    tier,
    recommendedMaxHeap,
    sha256,
    version,
  };
}

function validateCapabilityPackReleases(value, tier) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Workflow capability pack release list is invalid");
  }
  if (tier !== "engine" && value.length > 0) {
    throw new Error("The stateless Workflow runner release must not include capability packs");
  }
  const ids = new Set();
  return value.map((pack) => {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      throw new Error("Workflow capability pack release must be an object");
    }
    const id = String(pack.id ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || id === "core-transforms" || ids.has(id)) {
      throw new Error(`Workflow capability pack release id is invalid or duplicated: ${id || "missing"}`);
    }
    ids.add(id);
    const version = String(pack.version ?? "").trim();
    if (!version || version.length > 64 || !/^[A-Za-z0-9._-]+$/.test(version)) {
      throw new Error(`Workflow capability pack ${id} version is invalid`);
    }
    const artifactUrl = new URL(String(pack.artifactUrl ?? ""));
    if (artifactUrl.protocol !== "https:"
        || !artifactUrl.hostname
        || artifactUrl.username
        || artifactUrl.password
        || artifactUrl.search
        || artifactUrl.hash) {
      throw new Error(`Workflow capability pack ${id} artifact URL must be credential-free HTTPS`);
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
    return {
      id,
      version,
      artifactUrl: artifactUrl.toString(),
      sha256,
      ...(normalizedCapabilities.length > 0
        ? { requiredNodeCapabilities: normalizedCapabilities }
        : {}),
    };
  });
}

function selectCapabilityPacksForAgent(capabilityPacks, agent) {
  const available = new Set([
    ...(agent?.capabilities ?? []),
    ...(agent?.workflowRuntime?.capabilities ?? []),
  ].map((capability) => String(capability).trim().toLowerCase()));
  const selected = [];
  const skipped = [];
  for (const pack of capabilityPacks ?? []) {
    const missing = (pack.requiredNodeCapabilities ?? [])
      .filter((capability) => !available.has(capability));
    if (missing.length === 0) selected.push(pack);
    else skipped.push({ id: pack.id, missingCapabilities: missing });
  }
  return { selected, skipped };
}

async function resolveWorkflowRuntimeRelease(target, token, fetchImpl = fetch) {
  const pending = target.config.agents.filter(
    (agent) => agent.workflowRuntime?.enabled && agent.workflowRuntime.install?.releaseDiscovery === true,
  );
  if (pending.length === 0) return target;
  if (!token) throw new Error("Authentication is required to discover the Workflow runtime release");
  for (const agent of pending) {
    const tier = agent.workflowRuntime?.install?.tier === "engine" ? "engine" : "runner";
    const releaseUrl = tier === "runner"
      ? `${target.apiBase}/swarm/workflow-runtime/release`
      : `${target.apiBase}/swarm/workflow-runtime/release?tier=engine`;
    const response = await fetchImpl(releaseUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Workflow ${tier} release discovery failed with HTTP ${response.status}`);
    }
    const release = validateWorkflowReleaseDescriptor(await response.json(), tier);
    const packSelection = selectCapabilityPacksForAgent(release.capabilityPacks, agent);
    release.capabilityPacks = packSelection.selected;
    if (packSelection.skipped.length > 0) {
      agent.workflowRuntime.install.skippedCapabilityPacks = packSelection.skipped;
    } else {
      delete agent.workflowRuntime.install.skippedCapabilityPacks;
    }
    if (agent.workflowRuntime.install.useReleaseRecommendedHeap && release.recommendedMaxHeap) {
      agent.workflowRuntime.install.jvmArgs = ["-Xms64m", `-Xmx${release.recommendedMaxHeap}`];
    }
    delete agent.workflowRuntime.install.useReleaseRecommendedHeap;
    delete agent.workflowRuntime.install.releaseDiscovery;
    Object.assign(agent.workflowRuntime.install, release);
  }
  return target;
}

function workflowRuntimeForegroundArguments(configPath, agentId) {
  return [
    WORKFLOW_SERVICE_SCRIPT,
    "foreground",
    "--config", configPath,
    "--agent", agentId,
  ];
}

function startWorkflowRuntimeForeground(target, requestedAgentId, spawnImpl = spawn) {
  return target.config.agents
    .filter((agent) => agent.workflowRuntime?.enabled && agent.agentId === requestedAgentId)
    .map((agent) => spawnImpl(
      process.execPath,
      workflowRuntimeForegroundArguments(target.configPath, agent.agentId),
      { stdio: "inherit" },
    ));
}

function startForeground(target, token, workflowChildren = [], spawnImpl = spawn) {
  const bridge = spawnImpl(process.execPath, [
    AGENT_SCRIPT,
    "--config", target.configPath,
    "--receipt-log", target.receiptLog,
    "--continuous",
  ], {
    env: { ...process.env, VALKYR_AUTH_TOKEN: token },
    stdio: "inherit",
  });
  const children = [bridge, ...workflowChildren];
  let stopping = false;
  const stopAll = (signal, exitCode, exitedChild = null) => {
    if (!stopping) {
      stopping = true;
      process.exitCode = exitCode;
    }
    for (const child of children) {
      if (child !== exitedChild && !child.killed) child.kill(signal);
    }
  };
  const signals = ["SIGINT", "SIGTERM"];
  const handlers = new Map(signals.map((signal) => [signal, () => {
    stopAll(signal, signal === "SIGINT" ? 130 : 143);
  }]));
  for (const signal of signals) process.once(signal, handlers.get(signal));
  const cleanupIfStopped = () => {
    if (!stopping) return;
    if (children.some((child) => child.exitCode == null && child.signalCode == null && !child.killed)) return;
    for (const signal of signals) process.removeListener(signal, handlers.get(signal));
  };
  for (const child of children) {
    child.once("error", (error) => {
      process.stderr.write(`Valkyr SWARM foreground child failed: ${error.message}\n`);
      stopAll("SIGTERM", 1, child);
      cleanupIfStopped();
    });
    child.once("exit", (code, signal) => {
      if (!stopping) {
        const bridgeExitCode = signal ? 1 : code ?? 1;
        const unexpectedRuntimeExit = child !== bridge && bridgeExitCode === 0;
        stopAll("SIGTERM", unexpectedRuntimeExit ? 1 : bridgeExitCode, child);
      }
      cleanupIfStopped();
    });
  }
  return children;
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

function installWorkflowRuntime(target, requestedAgentId) {
  for (const agent of target.config.agents.filter(
    (value) => value.workflowRuntime?.enabled && value.agentId === requestedAgentId,
  )) {
    const result = spawnSync(process.execPath, [
      WORKFLOW_SERVICE_SCRIPT,
      "install",
      "--config", target.configPath,
      "--agent", agent.agentId,
    ], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Workflow runtime installation failed for ${agent.agentId}`);
  }
}

function selfTest() {
  const prior = process.env.VALKYR_SWARM_RUNTIME;
  process.env.VALKYR_SWARM_RUNTIME = "codex";
  const target = buildConfig({ machineId: "Example Host" });
  if (target.config.machineId !== "example-host") throw new Error("Machine normalization failed");
  if (target.config.agents[0].agentId !== "codex-example-host") throw new Error("Agent derivation failed");
  if (target.apiBase !== DEFAULT_API_BASE) throw new Error("Default API base failed");
  if (target.config.agents[0].execution?.adapter !== "codex-cli") throw new Error("Codex activation must enable productized execution");
  try {
    buildConfig({ runtime: "codex", machineId: "test", apiBase: "https://loki.valkyrlabs.com/v1" });
    throw new Error("Non-production activation was accepted");
  } catch (error) {
    if (String(error?.message ?? error) === "Non-production activation was accepted") throw error;
  }
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
    executionAdapter: target.config.agents[0].execution?.adapter ?? "receipt-only",
    mode: options.noService ? "configure-only" : options.foreground ? "foreground" : "supervised",
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ...summary, dryRun: true }, null, 2)}\n`);
    return;
  }
  const token = await authenticate(target);
  await resolveWorkflowRuntimeRelease(target, token);
  writeConfig(target);
  if (options.noService) {
    process.stdout.write(`${JSON.stringify({ ...summary, authenticated: true, started: false })}\n`);
    return;
  }
  if (options.foreground || !["darwin", "linux"].includes(process.platform)) {
    process.stdout.write(`${JSON.stringify({ ...summary, authenticated: true, started: true })}\n`);
    const workflowChildren = startWorkflowRuntimeForeground(target, summary.agent.agentId);
    startForeground(target, token, workflowChildren);
    return;
  }
  installWorkflowRuntime(target, summary.agent.agentId);
  installService(target);
  process.stdout.write(`${JSON.stringify({ ...summary, authenticated: true, started: true })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Valkyr SWARM activation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export {
  buildConfig,
  detectRuntime,
  executionConfig,
  parseArgs,
  parseCapabilities,
  parseWorkflowRuntimeMaxHeap,
  parseWorkflowCredentialReferences,
  requireProductionApiBase,
  resolveWorkflowRuntimeRelease,
  runtimeExecutable,
  safeId,
  selectCapabilityPacksForAgent,
  validateCapabilityPackReleases,
  validateWorkflowReleaseDescriptor,
  workflowRuntimeForegroundArguments,
  writeConfig,
};
