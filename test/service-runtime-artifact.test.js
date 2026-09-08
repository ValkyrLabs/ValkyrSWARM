import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { serviceRuntimeDigest, stageServiceRuntime } from "../scripts/swarm-service.mjs";

test("the staged service artifact boots with its complete runtime dependency closure", (t) => {
  const source = fileURLToPath(new URL("../scripts/", import.meta.url));
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-artifact-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const digest = serviceRuntimeDigest(source);
  const staged = stageServiceRuntime({
    serviceRuntimeDigest: digest,
    serviceRuntimeRoot: path.join(temporary, digest),
  }, source);
  const result = spawnSync(process.execPath, [path.join(staged, "swarm-agent.mjs"), "--self-test"], {
    cwd: temporary, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  assert.match(result.stdout, /self-test passed/i);
});
