import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COMMAND_JOURNAL_SCHEMA = "valkyr-swarm-command-journal/v1";
const RUNTIME_OUTCOME_SCHEMA = "valkyr-swarm-runtime-outcome/v1";
const DEFAULT_COMMAND_JOURNAL_ROOT = path.join(
  os.homedir(), ".config", "valkyr-swarm", "command-journal",
);
const DEFAULT_MAX_JOURNAL_ENTRIES = 500;
const MAX_JOURNAL_BYTES = 64 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TERMINAL_JOURNAL_STATES = new Set([
  "TERMINAL",
  "CHECKPOINTED",
  "OUTCOME_UNCERTAIN",
]);
const REPLAY_SAFE_ACTIONS = new Set([
  "content.research",
  "market.research",
  "pr.review",
  "product.research",
  "support.research",
  "workflow.debug",
  "workspace.files.read",
]);
const VOLATILE_DIGEST_KEYS = new Set([
  "actionDigest",
  "commandId",
  "createdAt",
  "deliveredAt",
  "dispatchedAt",
  "heartbeatAt",
  "receiptRef",
  "retryCount",
  "sentAt",
  "scopeDigest",
  "timestamp",
  "trace",
  "traceId",
  "updatedAt",
]);
const SENSITIVE_KEY = /(?:authorization|bearer|cookie|credential|password|private[_-]?key|secret|token|api[_-]?key)/i;

function assertSafeIdentifier(value, label) {
  const normalized = String(value ?? "").trim();
  if (!SAFE_IDENTIFIER.test(normalized) || normalized.length > 160) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function canonicalValue(value, key = null) {
  if (key && VOLATILE_DIGEST_KEYS.has(key)) return undefined;
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const childKey of Object.keys(value).sort()) {
      const childValue = canonicalValue(value[childKey], childKey);
      if (childValue !== undefined) result[childKey] = childValue;
    }
    return result;
  }
  return String(value ?? "");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function commandScope(wire) {
  const command = wire?.command ?? {};
  return command?.scope
    ?? command?.payload?.metadata?.scope
    ?? command?.metadata?.scope
    ?? null;
}

function commandPayload(wire) {
  const command = wire?.command ?? {};
  return command?.payload?.data ?? command?.data ?? command?.payload ?? command;
}

function commandBinding(wire) {
  const action = String(wire?.action ?? "").trim();
  const commandId = assertSafeIdentifier(wire?.commandId, "command ID");
  const command = wire?.command ?? {};
  const targetInstanceId = wire?.targetInstanceId == null
    ? null : String(wire.targetInstanceId).trim();
  const scope = commandScope(wire);
  const approvalRef = String(command?.approvalRef ?? "").trim() || null;
  const requiresApproval = command?.requiresApproval === true;
  const scopeDigest = sha256Digest(scope);
  const actionDigest = sha256Digest({
    action,
    approvalRef,
    payload: commandPayload(wire),
    requiresApproval,
    scope,
    targetInstanceId,
  });
  const suppliedActionDigest = String(command?.actionDigest ?? "").trim() || null;
  const suppliedScopeDigest = String(command?.scopeDigest ?? "").trim() || null;
  return {
    action,
    actionDigest,
    approvalRef,
    commandId,
    requiresApproval,
    scopeDigest,
    suppliedActionDigest,
    suppliedDigestMismatch: (suppliedActionDigest !== null && suppliedActionDigest !== actionDigest)
      || (suppliedScopeDigest !== null && suppliedScopeDigest !== scopeDigest),
    suppliedScopeDigest,
    targetInstanceId,
  };
}

function isReplaySafeAction(action) {
  return REPLAY_SAFE_ACTIONS.has(String(action ?? "").trim());
}

function redactText(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk|api)[_-][A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

function sanitizeForJournal(value, depth = 0) {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactText(value).slice(0, 8_000);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForJournal(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort().slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]" : sanitizeForJournal(value[key], depth + 1);
    }
    return result;
  }
  return String(value ?? "").slice(0, 8_000);
}

function boundedTerminalResponse(response) {
  const sanitized = sanitizeForJournal(response);
  if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") <= MAX_JOURNAL_BYTES) {
    return sanitized;
  }
  return sanitizeForJournal({
    type: response?.type,
    status: response?.status,
    reason: response?.reason,
    result: {
      actionDigest: response?.result?.actionDigest,
      adapter: response?.result?.adapter,
      checkpoint: response?.result?.checkpoint,
      executed: response?.result?.executed,
      executionState: response?.result?.executionState,
      outcome: response?.result?.outcome,
      receiptOnly: response?.result?.receiptOnly,
      terminalResponseTruncated: true,
    },
  });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function atomicWriteJson(filePath, value) {
  const directory = ensurePrivateDirectory(path.dirname(filePath));
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  const directoryDescriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function atomicCreateJson(filePath, value) {
  const directory = ensurePrivateDirectory(path.dirname(filePath));
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.create`,
  );
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    fs.unlinkSync(temporary);
  }
}

function readJournalRecord(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe command journal permissions for ${path.basename(filePath)}`);
    }
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (record?.schemaVersion !== COMMAND_JOURNAL_SCHEMA) {
      throw new Error(`Unsupported command journal schema for ${path.basename(filePath)}`);
    }
    return record;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

class CommandOutcomeJournal {
  constructor({
    agentId,
    root = DEFAULT_COMMAND_JOURNAL_ROOT,
    maxEntries = DEFAULT_MAX_JOURNAL_ENTRIES,
    now = () => new Date(),
  } = {}) {
    this.agentId = assertSafeIdentifier(agentId, "agent ID");
    this.root = path.resolve(root);
    this.directory = path.join(this.root, this.agentId);
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries : DEFAULT_MAX_JOURNAL_ENTRIES;
    this.now = now;
    ensurePrivateDirectory(this.directory);
  }

  recordPath(commandId) {
    return path.join(this.directory, `${assertSafeIdentifier(commandId, "command ID")}.json`);
  }

  inspect(wire, { protectedAction = false } = {}) {
    const binding = commandBinding(wire);
    const record = readJournalRecord(this.recordPath(binding.commandId));
    if (binding.suppliedDigestMismatch) {
      return { decision: "DIGEST_MISMATCH", binding, record };
    }
    if (!record) return { decision: "NEW", binding, record: null };
    if (record.actionDigest !== binding.actionDigest
      || record.targetInstanceId !== binding.targetInstanceId
      || record.scopeDigest !== binding.scopeDigest) {
      return { decision: "DIGEST_MISMATCH", binding, record };
    }
    if (TERMINAL_JOURNAL_STATES.has(record.state) && record.terminalResponse) {
      return { decision: "REPLAY_TERMINAL", binding, record, response: record.terminalResponse };
    }
    const nonIdempotent = record.nonIdempotent !== false;
    if (record.state === "STARTED" && (protectedAction || record.protectedAction || nonIdempotent)) {
      return { decision: "QUARANTINE_UNCERTAIN", binding, record };
    }
    if (record.state === "STARTED") return { decision: "RESUME_SAFE", binding, record };
    throw new Error(`Invalid command journal state ${record.state ?? "missing"}`);
  }

  markStarted(wire, { protectedAction = false } = {}) {
    const inspection = this.inspect(wire, { protectedAction });
    if (["DIGEST_MISMATCH", "REPLAY_TERMINAL", "QUARANTINE_UNCERTAIN"].includes(inspection.decision)) {
      return inspection;
    }
    const timestamp = this.now().toISOString();
    const record = {
      schemaVersion: COMMAND_JOURNAL_SCHEMA,
      agentId: this.agentId,
      commandId: inspection.binding.commandId,
      action: inspection.binding.action,
      actionDigest: inspection.binding.actionDigest,
      targetInstanceId: inspection.binding.targetInstanceId,
      scopeDigest: inspection.binding.scopeDigest,
      approvalRef: inspection.binding.approvalRef,
      protectedAction: protectedAction === true,
      nonIdempotent: !isReplaySafeAction(inspection.binding.action),
      state: "STARTED",
      startedAt: inspection.record?.startedAt ?? timestamp,
      updatedAt: timestamp,
      attemptCount: Number(inspection.record?.attemptCount ?? 0) + 1,
    };
    const filePath = this.recordPath(record.commandId);
    if (inspection.decision === "NEW") {
      try {
        atomicCreateJson(filePath, record);
      } catch (error) {
        if (error?.code === "EEXIST") return this.inspect(wire, { protectedAction });
        throw error;
      }
    } else {
      atomicWriteJson(filePath, record);
    }
    try {
      this.prune(record.commandId);
    } catch (error) {
      if (inspection.decision === "NEW") fs.unlinkSync(filePath);
      throw error;
    }
    return { decision: inspection.decision, binding: inspection.binding, record };
  }

  markTerminal(wire, response, { state = "TERMINAL", protectedAction = false } = {}) {
    if (!TERMINAL_JOURNAL_STATES.has(state)) {
      throw new Error(`Invalid terminal command journal state ${state}`);
    }
    const binding = commandBinding(wire);
    const current = readJournalRecord(this.recordPath(binding.commandId));
    if (current && (current.actionDigest !== binding.actionDigest
      || current.targetInstanceId !== binding.targetInstanceId
      || current.scopeDigest !== binding.scopeDigest)) {
      throw new Error("Command journal action digest mismatch");
    }
    const timestamp = this.now().toISOString();
    const record = {
      ...(current ?? {}),
      schemaVersion: COMMAND_JOURNAL_SCHEMA,
      agentId: this.agentId,
      commandId: binding.commandId,
      action: binding.action,
      actionDigest: binding.actionDigest,
      targetInstanceId: binding.targetInstanceId,
      scopeDigest: binding.scopeDigest,
      approvalRef: binding.approvalRef,
      protectedAction: protectedAction === true || current?.protectedAction === true,
      nonIdempotent: current?.nonIdempotent ?? !isReplaySafeAction(binding.action),
      state,
      startedAt: current?.startedAt ?? timestamp,
      updatedAt: timestamp,
      terminalAt: timestamp,
      terminalResponse: boundedTerminalResponse(response),
      attemptCount: Number(current?.attemptCount ?? 1),
    };
    atomicWriteJson(this.recordPath(record.commandId), record);
    this.prune(record.commandId);
    return record;
  }

  prune(preserveCommandId = null) {
    let entries;
    try {
      entries = fs.readdirSync(this.directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => {
          const filePath = path.join(this.directory, entry.name);
          const record = readJournalRecord(filePath);
          return {
            commandId: record.commandId,
            filePath,
            mtimeMs: fs.statSync(filePath).mtimeMs,
            state: record.state,
          };
        })
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    let excess = Math.max(0, entries.length - this.maxEntries);
    for (const entry of entries) {
      if (excess === 0) break;
      if (entry.commandId === preserveCommandId || !TERMINAL_JOURNAL_STATES.has(entry.state)) continue;
      fs.unlinkSync(entry.filePath);
      excess -= 1;
    }
    if (excess > 0) {
      throw new Error("Command journal capacity is exhausted by nonterminal records");
    }
  }
}

export {
  COMMAND_JOURNAL_SCHEMA,
  CommandOutcomeJournal,
  DEFAULT_COMMAND_JOURNAL_ROOT,
  RUNTIME_OUTCOME_SCHEMA,
  canonicalJson,
  commandBinding,
  commandPayload,
  commandScope,
  isReplaySafeAction,
  sanitizeForJournal,
  sha256Digest,
};
