#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ACTIVATE_SCRIPT = path.join(SCRIPT_DIR, "swarm-activate.mjs");

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/swarm-openclaw-bootstrap.mjs bootstrap [options]\n\nOptions:\n  --machine-id <id>           Stable host ID; auto-derived when omitted\n  --agent-id <id>             Tenant SWARM agent ID; auto-derived when omitted\n  --openclaw-agent-id <id>    Local OpenClaw Gateway agent ID\n  --url <url>                 Default https://api-0.valkyrlabs.com/v1\n  --config <path>             Private machine config\n  --receipt-log <path>        Redacted JSONL evidence\n  --foreground                Run attached\n  --no-service                Authenticate/configure only\n  --dry-run                   Print the non-secret activation plan\n  --self-test                 Validate argument mapping\n  -h, --help                  Show this help\n\nSet VALKYR_USERNAME and VALKYR_PASSWORD for unattended first use.\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {};
  const valueOptions = new Set([
    "--machine-id", "--agent-id", "--openclaw-agent-id", "--url", "--config", "--receipt-log",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (["--foreground", "--no-service", "--dry-run", "--self-test"].includes(arg)) {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (!valueOptions.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

function activationArgs(options) {
  const args = [ACTIVATE_SCRIPT, "--runtime", "openclaw"];
  const mappings = [
    ["machineId", "--machine-id"],
    ["agentId", "--agent-id"],
    ["openclawAgentId", "--openclaw-agent-id"],
    ["url", "--api-base"],
    ["config", "--config"],
    ["receiptLog", "--receipt-log"],
  ];
  for (const [key, flag] of mappings) if (options[key]) args.push(flag, options[key]);
  for (const [key, flag] of [["foreground", "--foreground"], ["noService", "--no-service"], ["dryRun", "--dry-run"]]) {
    if (options[key]) args.push(flag);
  }
  return args;
}

function selfTest() {
  const args = activationArgs({ machineId: "mac-1", openclawAgentId: "valor", dryRun: true });
  for (const expected of ["--runtime", "openclaw", "--machine-id", "mac-1", "--openclaw-agent-id", "valor", "--dry-run"]) {
    if (!args.includes(expected)) throw new Error(`Activation mapping omitted ${expected}`);
  }
  process.stdout.write("Valkyr SWARM OpenClaw bootstrap self-test passed\n");
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") usage(command ? 0 : 2);
  if (command !== "bootstrap") throw new Error(`Unknown command: ${command}`);
  const options = parseArgs(argv);
  if (options.selfTest) return selfTest();
  const result = spawnSync(process.execPath, activationArgs(options), { stdio: "inherit" });
  if (result.status !== 0) throw new Error("OpenClaw SWARM activation failed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Valkyr SWARM OpenClaw bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { activationArgs, parseArgs };
