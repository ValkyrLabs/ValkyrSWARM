import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  RUNTIME_OUTCOME_SCHEMA,
  commandBinding,
} from "./swarm-command-journal.mjs";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_PROMPT_CHARS = 24_000;
const MAX_RESULT_TEXT_CHARS = 8_000;
const MAX_STREAM_BYTES = 1024 * 1024;
const VALORIDE_TERMINAL_OUTCOME_SCHEMA = "valoride.swarm.terminal-outcome/1.0";
const RUNTIME_OUTCOME_STATUSES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "WAITING_APPROVAL",
  "OUTCOME_UNCERTAIN",
]);
const RUNTIME_OUTCOME_STATUS_SET = new Set(RUNTIME_OUTCOME_STATUSES);

function boundedText(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[TRUNCATED]`;
}

function boundedTerminalText(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  if (text.length <= limit) return text;
  const marker = "\n[TRUNCATED MIDDLE; TERMINAL TAIL RETAINED]\n";
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.floor(available / 4);
  return `${text.slice(0, headLength)}${marker}${text.slice(-(available - headLength))}`;
}

function supervisedRuntimeEnvironment(env = process.env) {
  const nodeDirectory = path.dirname(process.execPath);
  const pathEntries = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  return {
    ...env,
    PATH: [...new Set([nodeDirectory, ...pathEntries])].join(path.delimiter),
  };
}

function safeSessionSegment(value) {
  return String(value ?? "command")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "command";
}

function runtimeExecutionConfig(agent) {
  const execution = agent?.execution;
  if (!execution) return null;
  const base = {
    adapter: String(execution.adapter ?? "").trim(),
    executable: String(execution.executable ?? "").trim(),
    timeoutSeconds: Number(execution.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS),
    workingDirectory: execution.workingDirectory ? String(execution.workingDirectory) : undefined,
  };
  if (base.adapter === "openclaw-agent") {
    return {
      ...base,
      runtimeAgentId: String(execution.agentId ?? agent.agentId).trim(),
      requireGateway: execution.requireGateway !== false,
      sessionKeyPrefix: safeSessionSegment(execution.sessionKeyPrefix ?? "valkyr-swarm"),
    };
  }
  if (["codex-cli", "claude-code-cli", "valoride-cli"].includes(base.adapter)) {
    return { ...base, runtimeAgentId: String(execution.agentId ?? agent.agentId).trim() };
  }
  return null;
}

function openClawExecutionConfig(agent) {
  const config = runtimeExecutionConfig(agent);
  return config?.adapter === "openclaw-agent" ? config : null;
}

function validateRuntimeAdapter(agent) {
  if (!agent?.execution) return;
  const config = runtimeExecutionConfig(agent);
  if (!config) {
    throw new Error(`Unsupported execution adapter for ${agent.agentId}: ${agent.execution.adapter}`);
  }
  if (!config.executable || /[\r\n\0]/.test(config.executable)) {
    throw new Error(`Execution adapter for ${agent.agentId} has an invalid executable`);
  }
  if (!config.runtimeAgentId || /[\r\n\0]/.test(config.runtimeAgentId)) {
    throw new Error(`Execution adapter for ${agent.agentId} requires a valid runtime agent ID`);
  }
  if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 1 || config.timeoutSeconds > 3600) {
    throw new Error(`Execution timeout for ${agent.agentId} must be between 1 and 3600 seconds`);
  }
}

function buildRuntimePrompt(wire, agent) {
  const command = wire?.command ?? {};
  const commandData = command?.payload?.data ?? command?.data ?? command?.payload ?? command;
  const scope = command?.scope ?? command?.payload?.metadata?.scope ?? command?.metadata?.scope;
  const approvalRef = String(command?.approvalRef ?? "").trim();
  const approvedProtectedAction = ["outbound.send", "production.deploy", "merge", "service.lifecycle.restart"].includes(wire?.action)
    && /^gm_approval_[0-9a-f]{64}$/.test(approvalRef)
    && command?.requiresApproval === true;
  const protectedActionInstruction = approvedProtectedAction
    ? `Canonical human approval ${approvalRef} authorizes only the exact protected action ${wire.action}. Do not perform any other outbound send, production deployment, merge, service restart, destructive, financial, legal, or personnel action.`
    : "Protected actions remain prohibited inside this task: do not send outbound messages, deploy to production, or merge changes. Stop and request a separately correlated human approval receipt if any protected action becomes necessary.";
  const binding = commandBinding(wire);
  return [
    `Execute this governed tenant-scoped Valkyr SWARM task using the canonical ${agent.runtime} runtime.`,
    "",
    `SWARM command id: ${wire.commandId}`,
    `SWARM action: ${wire.action}`,
    `Target agent: ${agent.agentId}`,
    `Trace id: ${wire.trace?.traceId ?? "unavailable"}`,
    `Canonical action digest: ${binding.actionDigest}`,
    `Authorized target instance: ${binding.targetInstanceId ?? "null"}`,
    `Canonical scope digest: ${binding.scopeDigest}`,
    scope ? `Authorized scope: ${boundedText(scope, 2_000)}` : null,
    "",
    protectedActionInstruction,
    "Obey only the bounded Task payload. Do not expand a direct or read-only task into unrelated infrastructure diagnosis, plugin inspection, agent coordination, remediation, or project changes.",
    "Preserve unrelated work. Use GrayMatter for durable shared context and return concrete verification evidence and changed artifacts.",
    `Your final output MUST end with one single-line JSON object using schemaVersion ${RUNTIME_OUTCOME_SCHEMA}. It MUST include status (SUCCEEDED, FAILED, BLOCKED, WAITING_APPROVAL, or OUTCOME_UNCERTAIN), commandId ${binding.commandId}, actionDigest ${binding.actionDigest}, targetInstanceId ${JSON.stringify(binding.targetInstanceId)}, scopeDigest ${binding.scopeDigest}, a concise summary, and evidenceRefs as an array of durable artifact or verification references. SUCCEEDED requires at least one evidenceRef, bounded evidence item, or valid outcomeHash. Do not report SUCCEEDED unless the requested outcome and its verification are complete.`,
    "",
    "Task payload:",
    boundedText(commandData, MAX_PROMPT_CHARS),
    wire?.authorizedGrayMatterContext
      ? "Authorized GrayMatter context hydrated by the SWARM bridge (RBAC-scoped, read-only):"
      : null,
    wire?.authorizedGrayMatterContext
      ? boundedText(wire.authorizedGrayMatterContext, 10_000)
      : null,
  ].filter(Boolean).join("\n");
}

function buildOpenClawPrompt(wire, agent) {
  return buildRuntimePrompt(wire, agent);
}

function buildOpenClawAgentArgs(config, wire, prompt) {
  const sessionKey = `${config.sessionKeyPrefix}-${safeSessionSegment(wire.commandId)}`;
  return {
    args: [
      "agent", "--agent", config.runtimeAgentId ?? config.agentId,
      "--session-key", sessionKey,
      "--message", prompt,
      "--timeout", String(config.timeoutSeconds),
      "--json",
    ],
    sessionKey,
  };
}

function buildRuntimeInvocation(config, wire, prompt) {
  if (config.adapter === "openclaw-agent") return buildOpenClawAgentArgs(config, wire, prompt);
  if (config.adapter === "codex-cli") {
    return {
      args: ["exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", config.workingDirectory ?? process.cwd(), prompt],
      sessionKey: `codex-${safeSessionSegment(wire.commandId)}`,
    };
  }
  if (config.adapter === "claude-code-cli") {
    return {
      args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"],
      sessionKey: `claude-${safeSessionSegment(wire.commandId)}`,
    };
  }
  if (config.adapter === "valoride-cli") {
    return {
      // `valor task --session <id>` attaches to an existing CLI session; it does
      // not create one. Every governed SWARM command is an independent task, so
      // let Valor create its own session and keep our command-derived key only
      // as receipt correlation metadata.
      args: ["task", prompt, "--act"],
      sessionKey: `valor-${safeSessionSegment(wire.commandId)}`,
    };
  }
  throw new Error(`Unsupported execution adapter: ${config.adapter}`);
}

function appendBounded(current, chunk) {
  if (Buffer.byteLength(current, "utf8") >= MAX_STREAM_BYTES) return current;
  return `${current}${chunk}`.slice(0, MAX_STREAM_BYTES);
}

function spawnPromise(executable, args, options, { spawnImpl = spawn, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let sequence = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    const capture = (stream) => (chunk) => {
      const text = String(chunk);
      if (stream === "stdout") stdout = appendBounded(stdout, text);
      else stderr = appendBounded(stderr, text);
      onProgress?.({ sequence: ++sequence, stream, text: boundedText(text, 2_000) });
    };
    child.stdout?.on("data", capture("stdout"));
    child.stderr?.on("data", capture("stderr"));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const detail = boundedText(stderr || stdout || `signal=${signal ?? "none"}`, 2_000);
      reject(new Error(`${configLabel(executable)} exited ${code ?? "without code"}: ${detail}`));
    });
  });
}

function configLabel(executable) {
  return String(executable).split(/[\\/]/).at(-1) || "runtime";
}

function summarizeOpenClawResult(result) {
  const payloads = Array.isArray(result?.payloads)
    ? result.payloads.slice(0, 8).map((payload) => ({
        text: boundedText(payload?.text ?? "", MAX_RESULT_TEXT_CHARS),
        mediaUrl: payload?.mediaUrl ?? null,
      }))
    : [];
  return {
    payloads,
    meta: {
      durationMs: result?.meta?.durationMs,
      fallbackFrom: result?.meta?.fallbackFrom,
      fallbackReason: result?.meta?.fallbackReason,
      runId: result?.meta?.runId ?? result?.runId,
      sessionId: result?.meta?.sessionId ?? result?.sessionId,
      transport: result?.meta?.transport ?? "gateway",
    },
    deliveryStatus: result?.deliveryStatus ?? result?.result?.deliveryStatus,
  };
}

function terminalAgentText(stdout) {
  let terminal = "";
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event?.item?.type === "agent_message" && typeof event.item.text === "string") {
        terminal = event.item.text;
      } else if (event?.type === "result" && typeof event.result === "string") {
        terminal = event.result;
      } else if (typeof event?.text === "string") {
        terminal = event.text;
      }
    } catch {
      // CLI preambles and ordinary text output are retained in the bounded transcript.
    }
  }
  return terminal ? boundedTerminalText(terminal, MAX_RESULT_TEXT_CHARS) : null;
}

function boundedSummary(value, fallback = "Runtime did not provide a terminal summary") {
  const normalized = String(value ?? "").trim();
  return boundedText(normalized || fallback, 2_000);
}

function normalizedEvidenceRefs(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
      .slice(0, 50).map((item) => boundedText(item.trim(), 2_000))
    : [];
}

function normalizedEvidence(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 50).map((item) => {
    if (typeof item === "string") return boundedText(item, 2_000);
    if (item && typeof item === "object") {
      try {
        return JSON.parse(boundedText(item, 8_000));
      } catch {
        return boundedText(item, 8_000);
      }
    }
    return String(item ?? "");
  });
}

function normalizedOutcomeStatus(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[ -]+/g, "_");
  return {
    SUCCESS: "SUCCEEDED",
    COMPLETED: "SUCCEEDED",
    APPROVAL_REQUIRED: "WAITING_APPROVAL",
    PENDING_APPROVAL: "WAITING_APPROVAL",
    UNCERTAIN: "OUTCOME_UNCERTAIN",
  }[normalized] ?? normalized;
}

function candidateOutcomeStatus(candidate) {
  const schemaVersion = candidate?.__sourceSchema ?? candidate?.schemaVersion ?? candidate?.schema;
  return schemaVersion === VALORIDE_TERMINAL_OUTCOME_SCHEMA
    ? normalizedOutcomeStatus(candidate?.status)
    : String(candidate?.status ?? "");
}

function validOutcomeHash(value) {
  return typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/i.test(value);
}

function hasOutcomeEvidence(candidate) {
  return normalizedEvidenceRefs(candidate?.evidenceRefs).length > 0
    || (Array.isArray(candidate?.evidence) && candidate.evidence.length > 0)
    || validOutcomeHash(candidate?.outcomeHash);
}

function runtimeTranscriptEvidenceRef(stdout) {
  const digest = createHash("sha256").update(String(stdout ?? ""), "utf8").digest("hex");
  return `runtime-transcript:sha256:${digest}`;
}

function outcomeEnvelopeCandidate(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const candidates = trimmed.startsWith("{") && trimmed.endsWith("}")
      ? [trimmed]
      : trimmed.split(/\r?\n/).map((line) => line.trim())
        .filter((line) => line.startsWith("{") && line.endsWith("}")).reverse();
    for (const candidateText of candidates) {
      try {
        const candidate = outcomeEnvelopeCandidate(JSON.parse(candidateText), depth + 1);
        if (candidate) return candidate;
      } catch {
        // The surrounding runtime transcript is allowed to contain ordinary text.
      }
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const candidate = outcomeEnvelopeCandidate(value[index], depth + 1);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const candidateSchema = value.schemaVersion ?? value.schema;
  if ([RUNTIME_OUTCOME_SCHEMA, VALORIDE_TERMINAL_OUTCOME_SCHEMA].includes(candidateSchema)
    && typeof value.status === "string") {
    return { ...value, __sourceSchema: candidateSchema };
  }
  for (const key of ["outcome", "result", "payloads", "payload", "item", "message", "text"]) {
    const candidate = outcomeEnvelopeCandidate(value[key], depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

function extractOutcomeEnvelope(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = outcomeEnvelopeCandidate(lines[index]);
    if (candidate) return candidate;
  }
  return outcomeEnvelopeCandidate(String(stdout ?? "").trim());
}

function authoritativeOutcome({
  wire,
  status,
  summary,
  evidenceRefs = [],
  evidence,
  source,
  confidence,
  retryable,
  outcomeHash,
  metadata,
}) {
  const binding = commandBinding(wire);
  return {
    schemaVersion: RUNTIME_OUTCOME_SCHEMA,
    status,
    commandId: binding.commandId,
    actionDigest: binding.actionDigest,
    targetInstanceId: binding.targetInstanceId,
    scopeDigest: binding.scopeDigest,
    summary: boundedSummary(summary),
    evidenceRefs: normalizedEvidenceRefs(evidenceRefs),
    source,
    confidence,
    ...(normalizedEvidence(evidence) ? { evidence: normalizedEvidence(evidence) } : {}),
    ...(validOutcomeHash(outcomeHash)
      ? { outcomeHash } : {}),
    ...(metadata && typeof metadata === "object" ? { metadata } : {}),
    ...(binding.approvalRef ? { approvalRef: binding.approvalRef } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  };
}

function validateOutcomeBinding(candidate, wire) {
  const binding = commandBinding(wire);
  const schemaVersion = candidate?.__sourceSchema ?? candidate?.schemaVersion ?? candidate?.schema;
  const targetInstanceId = candidate?.targetInstanceId ?? candidate?.target ?? null;
  const scopeMatches = schemaVersion === VALORIDE_TERMINAL_OUTCOME_SCHEMA
    ? (candidate?.scopeDigest == null || candidate.scopeDigest === binding.scopeDigest)
    : candidate?.scopeDigest === binding.scopeDigest;
  return [RUNTIME_OUTCOME_SCHEMA, VALORIDE_TERMINAL_OUTCOME_SCHEMA].includes(schemaVersion)
    && RUNTIME_OUTCOME_STATUS_SET.has(candidateOutcomeStatus(candidate))
    && candidate?.commandId === binding.commandId
    && candidate?.actionDigest === binding.actionDigest
    && targetInstanceId === binding.targetInstanceId
    && scopeMatches
    && (!candidate?.approvalRef || candidate.approvalRef === binding.approvalRef);
}

function outcomeMetadata(candidate) {
  const metadata = {};
  for (const key of [
    "action",
    "checkpointId",
    "completedAt",
    "correlationId",
    "error",
    "goalId",
    "idempotencyKey",
    "localTaskId",
    "sessionId",
    "startedAt",
    "taskId",
    "trajectoryId",
    "workflowExecutionRef",
    "workflowVersionId",
  ]) {
    if (candidate?.[key] !== undefined) metadata[key] = candidate[key];
  }
  const sourceSchema = candidate?.__sourceSchema ?? candidate?.schemaVersion ?? candidate?.schema;
  if (sourceSchema && sourceSchema !== RUNTIME_OUTCOME_SCHEMA) metadata.sourceSchemaVersion = sourceSchema;
  return Object.keys(metadata).length ? metadata : undefined;
}

function legacyTerminalText(artifact, stdout) {
  if (typeof artifact?.terminalText === "string" && artifact.terminalText.trim()) {
    return artifact.terminalText;
  }
  if (Array.isArray(artifact?.payloads)) {
    const text = artifact.payloads.map((payload) => payload?.text)
      .filter((item) => typeof item === "string" && item.trim()).join("\n");
    if (text) return text;
  }
  return boundedTerminalText(stdout, MAX_RESULT_TEXT_CHARS);
}

function classifyLegacyTerminalStatus(value) {
  const text = String(value ?? "").trim();
  const normalized = text.toLowerCase()
    .replace(/\b(?:no|zero|0)\s+(?:blockers?|failures?|errors?)\b/g, "")
    .replace(/\b0\s+(?:failed|failing)\b/g, "");
  if (!normalized) return "OUTCOME_UNCERTAIN";
  if (/\b(?:waiting (?:for|on)|requires?|needs?) (?:human )?approval\b|\bapproval (?:is )?required\b|\bpending approval\b/.test(normalized)) {
    return "WAITING_APPROVAL";
  }
  if (/\bblocked\b|\bcannot\b|\bcan't\b|\bunable to\b|\bnot authorized\b|\bpermission denied\b|\bno\s+[^.\n]{0,120}\s+(?:was|were)\s+(?:created|updated|sent|deployed|merged)\b|\b(?:was|were) not (?:created|updated|sent|deployed|merged)\b/.test(normalized)) {
    return "BLOCKED";
  }
  if (/\bfailed\b|\bfailure\b|\bfatal\b|\bunhandled (?:error|exception)\b|(?:^|\n)\s*error\s*:/.test(normalized)) {
    return "FAILED";
  }
  if (/^(?:done|success|succeeded)[.!\s]*$/i.test(text)
    || /\b(?:completed|implemented|created|updated|sent|deployed|merged) successfully\b/.test(normalized)
    || /\bimplemented and verified\b/.test(normalized)
    || /\b(?:outcome|task) (?:is |was )?complete and verified\b/.test(normalized)) {
    return "SUCCEEDED";
  }
  return "OUTCOME_UNCERTAIN";
}

function classifyRuntimeOutcome({ wire, stdout, artifact }) {
  const candidate = extractOutcomeEnvelope(stdout);
  if (candidate) {
    if (!validateOutcomeBinding(candidate, wire)) {
      return authoritativeOutcome({
        wire,
        status: "OUTCOME_UNCERTAIN",
        summary: "Runtime terminal envelope did not match the dispatched command binding",
        evidenceRefs: candidate.evidenceRefs,
        evidence: candidate.evidence,
        source: "runtime-envelope",
        confidence: "UNRESOLVED",
        retryable: false,
      });
    }
    if (candidateOutcomeStatus(candidate) === "SUCCEEDED" && !hasOutcomeEvidence(candidate)) {
      return authoritativeOutcome({
        wire,
        status: "OUTCOME_UNCERTAIN",
        summary: "Runtime reported success without a verification evidence reference or outcome hash",
        source: "runtime-envelope",
        confidence: "UNRESOLVED",
        retryable: false,
      });
    }
    return authoritativeOutcome({
      wire,
      status: candidateOutcomeStatus(candidate),
      summary: candidate.summary,
      evidenceRefs: candidate.evidenceRefs ?? candidate.evidence,
      evidence: candidate.evidence,
      source: "runtime-envelope",
      confidence: "EXPLICIT",
      retryable: candidate.retryable,
      outcomeHash: candidate.outcomeHash,
      metadata: outcomeMetadata(candidate),
    });
  }
  const terminalText = legacyTerminalText(artifact, stdout);
  const status = classifyLegacyTerminalStatus(terminalText);
  return authoritativeOutcome({
    wire,
    status,
    summary: terminalText,
    evidenceRefs: [runtimeTranscriptEvidenceRef(stdout)],
    source: "legacy-classifier",
    confidence: status === "OUTCOME_UNCERTAIN" ? "UNRESOLVED" : "INFERRED",
    retryable: status === "FAILED",
  });
}

function runtimeResultStatus(outcomeStatus) {
  return {
    SUCCEEDED: "completed",
    FAILED: "failed",
    BLOCKED: "blocked",
    WAITING_APPROVAL: "waiting_approval",
    OUTCOME_UNCERTAIN: "outcome_uncertain",
  }[outcomeStatus] ?? "outcome_uncertain";
}

function summarizeCliResult(config, stdout, stderr) {
  if (config.adapter === "openclaw-agent") {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error("OpenClaw agent returned invalid JSON output");
    }
    if (config.requireGateway && parsed?.meta?.transport === "embedded") {
      throw new Error(`OpenClaw gateway was required but embedded fallback was used (${parsed.meta.fallbackReason ?? "gateway unavailable"})`);
    }
    return summarizeOpenClawResult(parsed);
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const terminalText = terminalAgentText(stdout);
  return {
    output: boundedTerminalText(stdout, MAX_RESULT_TEXT_CHARS),
    stderr: boundedText(stderr, 2_000),
    eventCount: lines.length,
    ...(terminalText ? { terminalText } : {}),
  };
}

async function executeRuntimeCommand({ agent, wire, spawnImpl = spawn, onProgress }) {
  const config = runtimeExecutionConfig(agent);
  if (!config) {
    return { adapter: "receipt-only", executed: false, receiptOnly: true, status: "received" };
  }
  const prompt = buildRuntimePrompt(wire, agent);
  const { args, sessionKey } = buildRuntimeInvocation(config, wire, prompt);
  const { stdout, stderr } = await spawnPromise(
    config.executable,
    args,
    {
      cwd: config.workingDirectory,
      env: supervisedRuntimeEnvironment(),
      timeoutMs: (config.timeoutSeconds + 30) * 1000,
    },
    { spawnImpl, onProgress },
  );
  const artifact = summarizeCliResult(config, stdout, stderr);
  const outcome = classifyRuntimeOutcome({ wire, stdout, artifact });
  return {
    adapter: config.adapter,
    attempted: true,
    executed: outcome.status === "SUCCEEDED",
    receiptOnly: false,
    runtimeAgentId: config.runtimeAgentId,
    sessionKey,
    status: runtimeResultStatus(outcome.status),
    actionDigest: outcome.actionDigest,
    scopeDigest: outcome.scopeDigest,
    outcome,
    artifact,
  };
}

export {
  buildOpenClawAgentArgs,
  buildOpenClawPrompt,
  buildRuntimeInvocation,
  buildRuntimePrompt,
  classifyLegacyTerminalStatus,
  classifyRuntimeOutcome,
  executeRuntimeCommand,
  extractOutcomeEnvelope,
  openClawExecutionConfig,
  runtimeExecutionConfig,
  RUNTIME_OUTCOME_SCHEMA,
  RUNTIME_OUTCOME_STATUSES,
  VALORIDE_TERMINAL_OUTCOME_SCHEMA,
  summarizeOpenClawResult,
  supervisedRuntimeEnvironment,
  terminalAgentText,
  validateRuntimeAdapter,
};
