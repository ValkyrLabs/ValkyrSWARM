#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "plugins", "valkyr-swarm");
const FILES = [".mcp.json", "LICENSE", "SECURITY.md", "README.md", "SKILL.md", "clawhub.json"];
const DIRECTORIES = [".codex-plugin", "assets", "config", "mcp-server", "references", "scripts", "skills"];

fs.mkdirSync(TARGET, { recursive: true });
for (const name of [...FILES, ...DIRECTORIES]) {
  const source = path.join(ROOT, name);
  const destination = path.join(TARGET, name);
  fs.rmSync(destination, { recursive: true, force: true });
  if (!fs.existsSync(source)) throw new Error(`Missing release input: ${name}`);
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: false });
}

for (const relative of [
  "scripts/package-valkyr-swarm",
  "scripts/swarm-claude-install",
  "scripts/swarm-agent.mjs",
  "scripts/swarm-activate.mjs",
  "scripts/swarm-auth.mjs",
  "scripts/swarm-doctor.mjs",
  "scripts/swarm-graymatter.mjs",
  "scripts/swarm-login.mjs",
  "scripts/swarm-openclaw-bootstrap.mjs",
  "scripts/swarm-service.mjs",
  "scripts/sync-plugin.mjs",
  "scripts/verify-distribution.mjs",
]) {
  fs.chmodSync(path.join(TARGET, relative), 0o755);
}

process.stdout.write(`Synchronized Valkyr SWARM plugin: ${TARGET}\n`);
