import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_RECEIPT_SOURCE = "valkyr-swarm:receipts";
const DEFAULT_HANDOFF_SOURCE = "valkyr-swarm:handoff";
const MAX_MEMORY_TEXT_CHARS = 16_000;
const GRAYMATTER_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_REPLAY_DIR = path.join(os.homedir(), ".config", "valkyr-swarm", "graymatter-replay");
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SENSITIVE_KEY = /(authorization|bearer|cookie|credential|password|private.?key|secret|token|api.?key)/i;
const PROTECTED_ACTIONS = new Set(["outbound.send", "production.deploy", "merge"]);
const CANONICAL_APPROVAL_REF = /^gm_approval_[0-9a-f]{64}$/;

function boundedText(value, max = MAX_MEMORY_TEXT_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return text.length <= max ? text : `${text.slice(0, max)}\n[TRUNCATED]`;
}

function safeTag(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function redactText(value, max = 1_000) {
  return String(value ?? "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(
      /(password|secret|token|authorization|api.?key|credential|cookie|private.?key)(\s*[=:]\s*)([^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .slice(0, max);
}

function redactStructured(value, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth >= 5) return "[TRUNCATED_DEPTH]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value ?? null;
  }
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactStructured(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, child] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).slice(0, 25)) {
      result[childKey] = redactStructured(child, childKey, depth + 1);
    }
    return result;
  }
  return redactText(value);
}

function normalizeApiBase(value) {
  return String(value ?? "https://api-0.valkyrlabs.com/v1").replace(/\/+$/, "");
}

async function requestGrayMatter({ apiBase, token, pathname, body, fetchImpl = fetch }) {
  const response = await fetchImpl(`${normalizeApiBase(apiBase)}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    // Production writes can include authorized relationship normalization and
    // semantic indexing. Keep the request bounded while allowing the server to
    // return its durable receipt before the local replay item is removed.
    signal: AbortSignal.timeout(GRAYMATTER_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text.slice(0, 500) };
    }
  }
  if (!response.ok) throw new Error(`GrayMatter ${pathname} returned HTTP ${response.status}`);
  return parsed;
}

async function writeMemory({
  apiBase,
  token,
  type,
  text,
  sourceChannel,
  sourceMessageId,
  tags = [],
  fetchImpl = fetch,
}) {
  const payload = {
    type,
    text: boundedText(text),
    source: sourceChannel,
    sourceChannel,
    tags: [...new Set(tags.map(safeTag).filter(Boolean))],
  };
  if (sourceMessageId) payload.sourceMessageId = boundedText(sourceMessageId, 160);
  return requestGrayMatter({
    apiBase,
    token,
    pathname: "/MemoryEntry/write",
    body: payload,
    fetchImpl,
  });
}

async function queryMemory({
  apiBase,
  token,
  query,
  type,
  sourceChannel,
  limit = 10,
  fetchImpl = fetch,
}) {
  const body = {
    q: boundedText(query, 1_000),
    maxResults: Math.max(1, Math.min(50, Number(limit) || 10)),
  };
  if (type) body.type = type;
  if (sourceChannel) body.source = sourceChannel;
  return requestGrayMatter({
    apiBase,
    token,
    pathname: "/MemoryEntry/query",
    body,
    fetchImpl,
  });
}

function commandReceiptText({ agent, wire, response }) {
  const protectedAction = PROTECTED_ACTIONS.has(String(wire.action ?? "").toLowerCase());
  const approvalRef = String(wire.command?.approvalRef ?? "").trim();
  return JSON.stringify({
    schemaVersion: "valkyr-swarm-command-receipt/0.1",
    commandId: wire.commandId,
    traceId: wire.trace?.traceId ?? null,
    action: wire.action,
    agentId: agent.agentId,
    runtime: agent.runtime,
    status: response.status,
    type: response.type,
    reason: response.reason ?? null,
    result: compactCommandResult(response.result),
    protectedAction,
    approvalRef: protectedAction && CANONICAL_APPROVAL_REF.test(approvalRef) ? approvalRef : null,
    recordedAt: new Date().toISOString(),
  });
}

function compactCommandResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result ?? null;
  const compact = {};
  for (const key of [
    "adapter",
    "executed",
    "receiptOnly",
    "runtimeAgentId",
    "sessionKey",
    "status",
    "workflowRunId",
    "workflowExecutionId",
    "workflowRunnerId",
    "leaseFence",
    "terminalState",
    "checkpointRef",
    "grayMatterReceiptRef",
    "grayMatterReceiptStatus",
  ]) {
    if (result[key] !== undefined) compact[key] = result[key];
  }
  if (result.artifact && typeof result.artifact === "object") {
    const artifact = { eventCount: result.artifact.eventCount ?? null };
    const lines = String(result.artifact.output ?? "").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event?.type === "item.completed" && event?.item?.type === "agent_message") {
          artifact.terminalMessage = boundedText(event.item.text, 2_000);
        }
      } catch {
        // Runtime output may contain non-JSON lines; the websocket/local log
        // remains the authoritative raw artifact.
      }
    }
    if (!artifact.terminalMessage && result.artifact.output) {
      artifact.outputSummary = boundedText(result.artifact.output, 2_000);
    }
    if (result.artifact.stderr) artifact.stderrSummary = boundedText(result.artifact.stderr, 500);
    const structured = Object.fromEntries(
      Object.entries(result.artifact).filter(([key]) => !["output", "stderr"].includes(key)),
    );
    if (Object.keys(structured).length > 0) {
      artifact.structuredSummary = boundedText(JSON.stringify(redactStructured(structured)), 8_000);
    }
    compact.artifact = artifact;
  }
  return compact;
}

async function persistCommandReceipt({
  agent,
  apiBase,
  tokenProvider,
  wire,
  response,
  fetchImpl = fetch,
  replayDir = DEFAULT_REPLAY_DIR,
}) {
  const token = await tokenProvider();
  if (!token) throw new Error("GrayMatter command receipt requires authenticated SWARM session");
  const sourceMessageId = `swarm-command:${wire.commandId}:${response.status}`;
  const body = {
    type: "artifact",
    text: commandReceiptText({ agent, wire, response }),
    source: DEFAULT_RECEIPT_SOURCE,
    sourceChannel: DEFAULT_RECEIPT_SOURCE,
    sourceMessageId,
    tags: ["swarm", "receipt", agent.runtime, response.status, wire.action].map(safeTag).filter(Boolean),
  };
  try {
    return await requestGrayMatter({
      apiBase,
      token,
      pathname: "/MemoryEntry/write",
      body,
      fetchImpl,
    });
  } catch (error) {
    const queuePath = queueReceiptReplay({
      agentId: agent.agentId,
      apiBase,
      body,
      replayDir,
    });
    return {
      id: null,
      queued: true,
      queuePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function persistWorkflowHandoff({
  agent,
  apiBase,
  tokenProvider,
  wire,
  response,
  fetchImpl = fetch,
  replayDir = DEFAULT_REPLAY_DIR,
}) {
  const token = await tokenProvider();
  if (!token) throw new Error("GrayMatter workflow handoff requires authenticated SWARM session");
  const result = response?.result && typeof response.result === "object" ? response.result : {};
  const workflowExecutionId = String(result.workflowExecutionId ?? "").trim();
  if (!workflowExecutionId) throw new Error("GrayMatter workflow handoff requires workflowExecutionId");
  const sequence = Number.isSafeInteger(Number(result.sequence)) ? Number(result.sequence) : 0;
  const executionState = String(result.executionState ?? response.status ?? "unknown").trim().toUpperCase();
  const text = JSON.stringify({
    schemaVersion: "valkyr-swarm-workflow-handoff/0.1",
    commandId: wire.commandId,
    traceId: wire.trace?.traceId ?? null,
    workflowExecutionId,
    workflowRunnerId: result.workflowRunnerId ?? null,
    leaseFence: result.leaseFence ?? null,
    eventType: result.eventType ?? null,
    executionState,
    checkpointRef: result.checkpointRef ?? null,
    status: response.status,
    agentId: agent.agentId,
    runtime: agent.runtime,
    result: compactCommandResult(result),
    synchronizedAt: new Date().toISOString(),
  });
  const body = {
    type: "context",
    text: boundedText(text),
    source: DEFAULT_HANDOFF_SOURCE,
    sourceChannel: DEFAULT_HANDOFF_SOURCE,
    sourceMessageId: boundedText(
      `swarm-workflow:${workflowExecutionId}:${sequence}:${executionState.toLowerCase()}`, 160),
    tags: ["swarm", "workflow", "handoff", agent.runtime, response.status, executionState]
      .map(safeTag).filter(Boolean),
  };
  try {
    return await requestGrayMatter({
      apiBase,
      token,
      pathname: "/MemoryEntry/write",
      body,
      fetchImpl,
    });
  } catch (error) {
    const queuePath = queueReceiptReplay({
      agentId: agent.agentId,
      apiBase,
      body,
      replayDir,
    });
    return {
      id: null,
      queued: true,
      queuePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function queueReceiptReplay({ agentId, apiBase, body, replayDir = DEFAULT_REPLAY_DIR }) {
  fs.mkdirSync(replayDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(replayDir, 0o700);
  const filename = `${safeTag(agentId)}-${safeTag(body.sourceMessageId)}.json`;
  const queuePath = path.join(replayDir, filename);
  const record = {
    schemaVersion: "valkyr-swarm-graymatter-replay/0.1",
    agentId,
    apiBase: normalizeApiBase(apiBase),
    pathname: "/MemoryEntry/write",
    body,
    queuedAt: new Date().toISOString(),
  };
  fs.writeFileSync(queuePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(queuePath, 0o600);
  return queuePath;
}

async function replayQueuedReceipts({
  agentId,
  apiBase,
  tokenProvider,
  fetchImpl = fetch,
  replayDir = DEFAULT_REPLAY_DIR,
}) {
  if (!fs.existsSync(replayDir)) return [];
  const token = await tokenProvider();
  if (!token) return [];
  const results = [];
  for (const name of fs.readdirSync(replayDir).filter((item) => item.endsWith(".json")).sort()) {
    const queuePath = path.join(replayDir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(queuePath, "utf8"));
    } catch {
      continue;
    }
    if (record.agentId !== agentId || normalizeApiBase(record.apiBase) !== normalizeApiBase(apiBase)) continue;
    try {
      const memory = await requestGrayMatter({
        apiBase,
        token,
        pathname: "/MemoryEntry/write",
        body: record.body,
        fetchImpl,
      });
      fs.unlinkSync(queuePath);
      results.push({ queuePath, id: memory?.id ?? null, status: "persisted" });
    } catch (error) {
      results.push({
        queuePath,
        id: null,
        status: "queued",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export {
  DEFAULT_HANDOFF_SOURCE,
  DEFAULT_RECEIPT_SOURCE,
  boundedText,
  compactCommandResult,
  commandReceiptText,
  persistCommandReceipt,
  persistWorkflowHandoff,
  queryMemory,
  queueReceiptReplay,
  replayQueuedReceipts,
  redactStructured,
  requestGrayMatter,
  writeMemory,
};
