import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_RECEIPT_SOURCE = "valkyr-swarm:receipts";
const DEFAULT_HANDOFF_SOURCE = "valkyr-swarm:handoff";
const MAX_MEMORY_TEXT_CHARS = 16_000;
const DEFAULT_REPLAY_DIR = path.join(os.homedir(), ".config", "valkyr-swarm", "graymatter-replay");

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
    signal: AbortSignal.timeout(10_000),
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
    protectedAction: false,
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
  queryMemory,
  queueReceiptReplay,
  replayQueuedReceipts,
  requestGrayMatter,
  writeMemory,
};
