import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_RECEIPT_SOURCE = "valkyr-swarm:receipts";
const DEFAULT_HANDOFF_SOURCE = "valkyr-swarm:handoff";
const MAX_MEMORY_TEXT_CHARS = 16_000;
const GRAYMATTER_REQUEST_TIMEOUT_MS = 60_000;
const DEFINITIVE_RECEIPT_REJECTIONS = new Set([401, 402, 403]);
const DEFAULT_REPLAY_DIR = path.join(os.homedir(), ".config", "valkyr-swarm", "graymatter-replay");
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SENSITIVE_KEY = /(authorization|bearer|cookie|credential|password|private.?key|secret|token|api.?key)/i;
const PROTECTED_ACTIONS = new Set([
  "outbound.send",
  "production.deploy",
  "merge",
  "service.lifecycle.restart",
]);
const CANONICAL_APPROVAL_REF = /^gm_approval_[0-9a-f]{64}$/;
const MEMORY_ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_MEMORY_REFS = 8;
const MAX_CONTEXT_MEMORY_TEXT_CHARS = 6_000;
const CONTEXT_OBJECT_TYPES = new Set(["ContentData", "MemoryEntry"]);

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
  if (!response.ok) {
    const error = new Error(`GrayMatter ${pathname} returned HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return parsed;
}

async function readGrayMatterObject({ apiBase, token, objectType, id, fetchImpl = fetch }) {
  const memoryId = String(id ?? "").trim();
  const type = String(objectType ?? "").trim();
  if (!CONTEXT_OBJECT_TYPES.has(type)) throw new Error("Unsupported GrayMatter context object type");
  if (!MEMORY_ENTRY_ID.test(memoryId)) throw new Error("Invalid GrayMatter MemoryEntry ID");
  const response = await fetchImpl(
    `${normalizeApiBase(apiBase)}/${type}/${encodeURIComponent(memoryId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(GRAYMATTER_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`GrayMatter ${type} read returned HTTP ${response.status}`);
  const value = await response.json();
  const entry = {
    id: memoryId,
    objectType: type,
    type: boundedText(value?.type ?? value?.contentType ?? "unknown", 80),
    title: boundedText(value?.title ?? value?.name ?? "", 500),
    subtitle: boundedText(value?.subtitle ?? "", 500),
    fileName: boundedText(value?.fileName ?? "", 240),
    status: boundedText(value?.status ?? "", 80),
    version: value?.version ?? null,
    slug: boundedText(value?.slug ?? "", 240),
    sourceChannel: boundedText(value?.sourceChannel ?? value?.source ?? "", 200),
    tags: Array.isArray(value?.tags)
      ? value.tags.slice(0, 25).map((tag) => safeTag(tag?.name ?? tag)).filter(Boolean)
      : [],
    text: redactText(value?.text ?? value?.contentData ?? value?.content ?? "", MAX_CONTEXT_MEMORY_TEXT_CHARS),
  };
  entry.contentDigest = `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`;
  return entry;
}

async function readMemoryEntry(options) {
  return readGrayMatterObject({ ...options, objectType: "MemoryEntry" });
}

function structuredCommandData(wire) {
  const command = wire?.command ?? {};
  const raw = command?.payload?.data ?? command?.data ?? command?.payload ?? {};
  if (typeof raw !== "string") return raw && typeof raw === "object" ? raw : {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requestedGrayMatterObjects(wire) {
  const data = structuredCommandData(wire);
  const objectRefs = data?.grayMatterObjectRefs;
  if (objectRefs !== undefined) {
    if (!Array.isArray(objectRefs) || objectRefs.length > MAX_CONTEXT_MEMORY_REFS) {
      throw new Error(`grayMatterObjectRefs must contain at most ${MAX_CONTEXT_MEMORY_REFS} refs`);
    }
    const unique = new Map();
    for (const ref of objectRefs) {
      const objectType = String(ref?.objectType ?? ref?.type ?? "").trim();
      const id = String(ref?.id ?? "").trim();
      if (!CONTEXT_OBJECT_TYPES.has(objectType)) {
        throw new Error("Unsupported GrayMatter context object type");
      }
      if (!MEMORY_ENTRY_ID.test(id)) throw new Error("Invalid GrayMatter object ID");
      unique.set(`${objectType}:${id}`, { objectType, id });
    }
    return [...unique.values()];
  }
  const raw = data?.grayMatterMemoryRefs;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CONTEXT_MEMORY_REFS) {
    throw new Error(`grayMatterMemoryRefs must contain at most ${MAX_CONTEXT_MEMORY_REFS} IDs`);
  }
  return [...new Set(raw.map((id) => String(id ?? "").trim()))].map((id) => {
    if (!MEMORY_ENTRY_ID.test(id)) throw new Error("Invalid GrayMatter MemoryEntry ID");
    return { objectType: "MemoryEntry", id };
  });
}

async function hydrateRuntimeGrayMatterContext({
  apiBase,
  tokenProvider,
  wire,
  fetchImpl = fetch,
}) {
  const refs = requestedGrayMatterObjects(wire);
  if (refs.length === 0) return null;
  const token = await tokenProvider();
  if (!token) throw new Error("GrayMatter context hydration requires authenticated SWARM access");
  const entries = [];
  for (const ref of refs) {
    entries.push(await readGrayMatterObject({ apiBase, token, ...ref, fetchImpl }));
  }
  return {
    schemaVersion: "valkyr-swarm-graymatter-context/v1",
    access: "rbac-scoped-read-only",
    requestedRefs: refs.map(({ objectType, id }) => `${objectType}:${id}`),
    entries,
  };
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
    contextPageRef: commandTraceRef(wire, "contextPageRef"),
    retrievalReceiptRef: commandTraceRef(wire, "retrievalReceiptRef"),
    trajectoryRef: commandTraceRef(wire, "trajectoryRef"),
    skillOptReceiptRef: commandTraceRef(wire, "skillOptReceiptRef"),
    workflowExecutionRef: commandTraceRef(wire, "workflowExecutionRef"),
    capabilityGrantRef: commandTraceRef(wire, "capabilityGrantRef"),
    policyReceiptRef: commandTraceRef(wire, "policyReceiptRef"),
    bifrostChainRef: commandTraceRef(wire, "bifrostChainRef"),
    bifrostChainHash: commandTraceRef(wire, "bifrostChainHash"),
    bifrostComplete: wire.trace?.bifrostComplete === true
      || wire.command?.bifrostComplete === true,
    swarmReceiptRef: commandTraceRef(wire, "receiptRef")
      ?? safeReceiptRef(wire.receiptRef),
    protectedAction,
    approvalRef: protectedAction && CANONICAL_APPROVAL_REF.test(approvalRef) ? approvalRef : null,
    recordedAt: new Date().toISOString(),
  });
}

function commandTraceRef(wire, key) {
  const value = wire?.trace?.[key] ?? wire?.command?.[key];
  return safeReceiptRef(value);
}

function receiptBodyFingerprint(body) {
  const parsed = JSON.parse(body.text);
  const { recordedAt, ...content } = parsed;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function commandReceiptFingerprint(input) {
  return receiptBodyFingerprint({ text: boundedText(commandReceiptText(input)) });
}

function safeReceiptRef(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (text.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) return null;
  return redactText(text, 256) === text ? text : null;
}

function compactCommandResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result ?? null;
  const compact = {};
  for (const key of [
    "adapter",
    "actionDigest",
    "attempted",
    "checkpoint",
    "executed",
    "executionState",
    "journalPersisted",
    "journalState",
    "quarantined",
    "receiptOnly",
    "replayed",
    "runtimeAgentId",
    "sessionKey",
    "scopeDigest",
    "status",
    "workflowRunId",
    "workflowExecutionId",
    "workflowRunnerId",
    "leaseFence",
    "terminalState",
    "checkpointRef",
    "grayMatterReceiptRef",
    "grayMatterReceiptStatus",
    "pendingRecovery",
    "serviceHandle",
    "supervisor",
  ]) {
    if (result[key] !== undefined) compact[key] = result[key];
  }
  if (result.outcome && typeof result.outcome === "object" && !Array.isArray(result.outcome)) {
    compact.outcome = redactStructured(result.outcome);
  }
  if (result.service && typeof result.service === "object" && !Array.isArray(result.service)) {
    compact.service = Object.fromEntries(
      [
        "displayName",
        "expectedAgentId",
        "handle",
        "installed",
        "kind",
        "restartable",
        "running",
        "selfRestart",
        "sharedBridge",
        "state",
        "supervisor",
      ]
        .filter((key) => result.service[key] !== undefined)
        .map((key) => [key, redactStructured(result.service[key], key)]),
    );
  }
  if (result.proof && typeof result.proof === "object" && !Array.isArray(result.proof)) {
    compact.proof = Object.fromEntries(
      [
        "capabilities",
        "expectedAgentId",
        "handle",
        "healthy",
        "heartbeatAt",
        "heartbeatFresh",
        "supervisorRunning",
        "version",
      ]
        .filter((key) => result.proof[key] !== undefined)
        .map((key) => [key, redactStructured(result.proof[key], key)]),
    );
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
      submissionUncertain: !DEFINITIVE_RECEIPT_REJECTIONS.has(error?.httpStatus),
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
      submissionUncertain: !DEFINITIVE_RECEIPT_REJECTIONS.has(error?.httpStatus),
    });
    return {
      id: null,
      queued: true,
      queuePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function queueReceiptReplay({ agentId, apiBase, body, replayDir = DEFAULT_REPLAY_DIR, submissionUncertain = false }) {
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
    ...(submissionUncertain ? { submissionStarted: true } : {}),
  };
  saveReceiptReplayState(queuePath, record);
  return queuePath;
}

async function replayQueuedReceipts({
  agentId,
  apiBase,
  tokenProvider,
  fetchImpl = fetch,
  replayDir = DEFAULT_REPLAY_DIR,
  onPersisted = async () => {},
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
      // Retain the returned identity before downstream completion bookkeeping.
      // Replaying a receipt that is already persisted must not submit it again.
      if (!record.persistedMemoryEntryId && (record.submissionStarted || record.persistenceUncertain)) {
        results.push({ queuePath, id: null, status: record.persistenceUncertain ? "persisted_without_valid_id" : "outcome_uncertain" });
        continue;
      }
      let memory = { id: record.persistedMemoryEntryId };
      if (!record.persistedMemoryEntryId) {
        record.submissionStarted = true;
        saveReceiptReplayState(queuePath, record);
        memory = await requestGrayMatter({ apiBase, token, pathname: "/MemoryEntry/write", body: record.body, fetchImpl });
      }
      if (!MEMORY_ENTRY_ID.test(String(memory?.id ?? ""))) {
        if (!record.persistenceUncertain) {
          record.persistenceUncertain = true;
          saveReceiptReplayState(queuePath, record);
        }
        results.push({ queuePath, id: null, status: "persisted_without_valid_id" });
        continue;
      }
      if (!record.persistedMemoryEntryId) {
        record.persistedMemoryEntryId = memory.id;
        saveReceiptReplayState(queuePath, record);
      }
      const result = { queuePath, id: memory.id, status: "persisted", sourceMessageId: record.body.sourceMessageId,
        bodyFingerprint: record.body.sourceChannel === DEFAULT_RECEIPT_SOURCE ? receiptBodyFingerprint(record.body) : null };
      await onPersisted(result);
      fs.unlinkSync(queuePath);
      results.push(result);
    } catch (error) {
      // These responses reject the request before creating a MemoryEntry. A
      // timeout, transport loss, server error or local disk failure is ambiguous.
      if (!record.persistedMemoryEntryId && DEFINITIVE_RECEIPT_REJECTIONS.has(error?.httpStatus)) {
        record.submissionStarted = false;
        try { saveReceiptReplayState(queuePath, record); } catch { /* Retain the conservative started marker. */ }
      }
      results.push({
        queuePath,
        id: record.persistedMemoryEntryId ?? null,
        status: record.persistedMemoryEntryId ? "persisted_pending_delivery" : record.submissionStarted ? "outcome_uncertain" : "queued",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function saveReceiptReplayState(queuePath, record) {
  const temporary = `${queuePath}.${randomUUID()}.state.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, queuePath);
    const parent = fs.openSync(path.dirname(queuePath), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally { fs.rmSync(temporary, { force: true }); }
}

export {
  DEFAULT_HANDOFF_SOURCE,
  DEFAULT_RECEIPT_SOURCE,
  boundedText,
  compactCommandResult,
  commandReceiptText,
  commandReceiptFingerprint,
  persistCommandReceipt,
  persistWorkflowHandoff,
  hydrateRuntimeGrayMatterContext,
  queryMemory,
  queueReceiptReplay,
  readGrayMatterObject,
  readMemoryEntry,
  replayQueuedReceipts,
  redactStructured,
  requestGrayMatter,
  writeMemory,
};
