#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "plugins", "valkyr-swarm");
const RELEASE_ENTRIES = [
  ".codex-plugin", ".mcp.json", "LICENSE", "SECURITY.md", "README.md", "SKILL.md",
  "assets", "clawhub.json", "config", "mcp-server", "references", "scripts", "skills",
];

function digest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function inventory(root, relative = "") {
  const current = path.join(root, relative);
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`Distribution must not contain symlinks: ${current}`);
  if (stat.isFile()) return [{ relative, type: "file", digest: digest(current), executable: Boolean(stat.mode & 0o111) }];
  if (!stat.isDirectory()) throw new Error(`Unsupported distribution entry: ${current}`);
  const rows = relative ? [{ relative, type: "directory" }] : [];
  for (const name of fs.readdirSync(current).sort()) rows.push(...inventory(root, path.join(relative, name)));
  return rows;
}

function verifyDistribution() {
  if (!fs.existsSync(TARGET)) throw new Error(`Missing plugin mirror: ${TARGET}`);
  const expected = RELEASE_ENTRIES.flatMap((entry) => inventory(ROOT, entry))
    .sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const actual = inventory(TARGET);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedMap = new Map(expected.map((row) => [row.relative, row]));
    const actualMap = new Map(actual.map((row) => [row.relative, row]));
    const mismatches = [...new Set([...expectedMap.keys(), ...actualMap.keys()])]
      .sort()
      .filter((key) => JSON.stringify(expectedMap.get(key)) !== JSON.stringify(actualMap.get(key)));
    throw new Error(`Plugin mirror differs from canonical release inputs: ${mismatches.slice(0, 20).join(", ")}`);
  }
  process.stdout.write(`Valkyr SWARM distribution parity verified (${actual.filter((row) => row.type === "file").length} files)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    verifyDistribution();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { inventory, verifyDistribution };
