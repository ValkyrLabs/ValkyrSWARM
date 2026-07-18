import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_PROMPT_CHARS = 24_000;
const MAX_RESULT_TEXT_CHARS = 8_000;
const MAX_STREAM_BYTES = 1024 * 1024;

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
  return [
    `Execute this governed tenant-scoped Valkyr SWARM task using the canonical ${agent.runtime} runtime.`,
    "",
    `SWARM command id: ${wire.commandId}`,
    `SWARM action: ${wire.action}`,
    `Target agent: ${agent.agentId}`,
    `Trace id: ${wire.trace?.traceId ?? "unavailable"}`,
    scope ? `Authorized scope: ${boundedText(scope, 2_000)}` : null,
    "",
    "Protected actions remain prohibited inside this task: do not send outbound messages, deploy to production, or merge changes. Stop and request a separately correlated human approval receipt if any protected action becomes necessary.",
    "Preserve unrelated work. Use GrayMatter for durable shared context and return concrete verification evidence and changed artifacts.",
    "",
    "Task payload:",
    boundedText(commandData, MAX_PROMPT_CHARS),
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
      args: ["task", prompt, "--act", "--session", `swarm-${safeSessionSegment(wire.commandId)}`],
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
  return {
    output: boundedText(stdout, MAX_RESULT_TEXT_CHARS),
    stderr: boundedText(stderr, 2_000),
    eventCount: lines.length,
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
      env: process.env,
      timeoutMs: (config.timeoutSeconds + 30) * 1000,
    },
    { spawnImpl, onProgress },
  );
  return {
    adapter: config.adapter,
    executed: true,
    receiptOnly: false,
    runtimeAgentId: config.runtimeAgentId,
    sessionKey,
    status: "completed",
    artifact: summarizeCliResult(config, stdout, stderr),
  };
}

export {
  buildOpenClawAgentArgs,
  buildOpenClawPrompt,
  buildRuntimeInvocation,
  buildRuntimePrompt,
  executeRuntimeCommand,
  openClawExecutionConfig,
  runtimeExecutionConfig,
  summarizeOpenClawResult,
  validateRuntimeAdapter,
};
