import { execFile } from "node:child_process";

const DEFAULT_OPENCLAW_TIMEOUT_SECONDS = 600;
const MAX_PROMPT_CHARS = 24_000;
const MAX_RESULT_TEXT_CHARS = 8_000;

function boundedText(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[TRUNCATED]`;
}

function safeSessionSegment(value) {
  return String(value ?? "command")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "command";
}

function openClawExecutionConfig(agent) {
  const execution = agent?.execution;
  if (!execution || execution.adapter !== "openclaw-agent") return null;
  return {
    adapter: "openclaw-agent",
    agentId: String(execution.agentId ?? agent.agentId).trim(),
    executable: String(execution.executable ?? "openclaw").trim(),
    requireGateway: execution.requireGateway !== false,
    sessionKeyPrefix: safeSessionSegment(
      execution.sessionKeyPrefix ?? "valkyr-swarm",
    ),
    timeoutSeconds: Number(
      execution.timeoutSeconds ?? DEFAULT_OPENCLAW_TIMEOUT_SECONDS,
    ),
    workingDirectory: execution.workingDirectory
      ? String(execution.workingDirectory)
      : undefined,
  };
}

function validateRuntimeAdapter(agent) {
  if (!agent?.execution) return;
  const config = openClawExecutionConfig(agent);
  if (!config) {
    throw new Error(
      `Unsupported execution adapter for ${agent.agentId}: ${agent.execution.adapter}`,
    );
  }
  if (!config.agentId) {
    throw new Error(
      `OpenClaw execution adapter for ${agent.agentId} requires agentId`,
    );
  }
  if (!config.executable || /[\r\n\0]/.test(config.executable)) {
    throw new Error(
      `OpenClaw execution adapter for ${agent.agentId} has an invalid executable`,
    );
  }
  if (
    !Number.isInteger(config.timeoutSeconds) ||
    config.timeoutSeconds < 1 ||
    config.timeoutSeconds > 3600
  ) {
    throw new Error(
      `OpenClaw execution timeout for ${agent.agentId} must be between 1 and 3600 seconds`,
    );
  }
}

function buildOpenClawPrompt(wire, agent) {
  const command = wire?.command ?? {};
  const commandData =
    command?.payload?.data ?? command?.data ?? command?.payload ?? command;
  const scope =
    command?.scope ??
    command?.payload?.metadata?.scope ??
    command?.metadata?.scope;
  const prompt = [
    "Execute this governed tenant-scoped Valkyr SWARM task using the canonical OpenClaw agent runtime.",
    "",
    `SWARM command id: ${wire.commandId}`,
    `SWARM action: ${wire.action}`,
    `Target agent: ${agent.agentId}`,
    `Trace id: ${wire.trace?.traceId ?? "unavailable"}`,
    scope ? `Authorized scope: ${boundedText(scope, 2_000)}` : null,
    "",
    "Protected actions remain prohibited inside this task: do not send outbound messages, deploy to production, or merge changes. Stop and request a separately correlated human approval receipt if any protected action becomes necessary.",
    "Preserve unrelated work and report concrete verification evidence and changed artifacts.",
    "",
    "Task payload:",
    boundedText(commandData, MAX_PROMPT_CHARS),
  ].filter(Boolean);
  return prompt.join("\n");
}

function buildOpenClawAgentArgs(config, wire, prompt) {
  const sessionKey = `${config.sessionKeyPrefix}-${safeSessionSegment(wire.commandId)}`;
  return {
    args: [
      "agent",
      "--agent",
      config.agentId,
      "--session-key",
      sessionKey,
      "--message",
      prompt,
      "--timeout",
      String(config.timeoutSeconds),
      "--json",
    ],
    sessionKey,
  };
}

function execFilePromise(executable, args, options, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
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

async function executeRuntimeCommand({
  agent,
  wire,
  execFileImpl = execFile,
}) {
  const config = openClawExecutionConfig(agent);
  if (!config) {
    return {
      adapter: "receipt-only",
      executed: false,
      receiptOnly: true,
      status: "received",
    };
  }

  const prompt = buildOpenClawPrompt(wire, agent);
  const { args, sessionKey } = buildOpenClawAgentArgs(config, wire, prompt);
  const { stdout } = await execFilePromise(
    config.executable,
    args,
    {
      cwd: config.workingDirectory,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: (config.timeoutSeconds + 30) * 1000,
      windowsHide: true,
    },
    execFileImpl,
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("OpenClaw agent returned invalid JSON output");
  }
  if (config.requireGateway && parsed?.meta?.transport === "embedded") {
    throw new Error(
      `OpenClaw gateway execution was required but the CLI used embedded fallback (${parsed.meta.fallbackReason ?? "gateway unavailable"})`,
    );
  }
  return {
    adapter: config.adapter,
    executed: true,
    receiptOnly: false,
    runtimeAgentId: config.agentId,
    sessionKey,
    status: "completed",
    artifact: summarizeOpenClawResult(parsed),
  };
}

export {
  buildOpenClawAgentArgs,
  buildOpenClawPrompt,
  executeRuntimeCommand,
  openClawExecutionConfig,
  summarizeOpenClawResult,
  validateRuntimeAdapter,
};
