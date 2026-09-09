import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diagnose } from "../scripts/swarm-doctor.mjs";

const AUTH_ENV_KEYS = [
  "VALKYR_AUTH_TOKEN", "API0_JWT_SESSION", "VALKYR_JWT_SESSION",
  "VALKYR_USERNAME", "VALKYR_PASSWORD", "VALKYR_SWARM_USERNAME",
  "VALKYR_SWARM_PASSWORD", "GRAYMATTER_USERNAME", "GRAYMATTER_PASSWORD",
  "VALKYR_KEYCHAIN_SERVICE", "VALKYR_SWARM_TOKEN_FILE",
  "VALKYR_SWARM_CREDENTIAL_FILE", "VALKYR_API_BASE",
];

function fixture(t, { selectedProfile = true, missingSelectedToken = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-doctor-auth-"));
  const previous = new Map(AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const key of AUTH_ENV_KEYS) delete process.env[key];
  const unique = `${process.pid}-${path.basename(root)}`;
  const selectedToken = path.join(root, "selected-token");
  const defaultToken = path.join(root, "default-token");
  if (!missingSelectedToken) {
    fs.writeFileSync(selectedToken, "fixture-selected-session", { mode: 0o600 });
  }
  fs.writeFileSync(defaultToken, "fixture-default-session", { mode: 0o600 });
  process.env.VALKYR_KEYCHAIN_SERVICE = `SWARM_DOCTOR_TEST_DEFAULT_${unique}`;
  process.env.VALKYR_SWARM_TOKEN_FILE = defaultToken;
  process.env.VALKYR_SWARM_CREDENTIAL_FILE = path.join(root, "absent-default-credentials");
  process.env.VALKYR_API_BASE = "https://unselected.invalid/v1";
  const config = {
    machineId: `doctor-${unique}`,
    serverUrl: "https://selected.invalid/v1",
    agents: [{ agentId: "doctor-selected-agent", runtime: "codex", capabilities: ["pr.review"] }],
    ...(selectedProfile ? {
      authKeychainService: `SWARM_DOCTOR_TEST_SELECTED_${unique}`,
      authTokenFile: selectedToken,
      authCredentialFile: path.join(root, "absent-selected-credentials"),
    } : {}),
  };
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, authorization: options.headers.Authorization });
    assert.equal(url, "https://selected.invalid/v1/swarm/agents/snapshot");
    const expected = selectedProfile ? "fixture-selected-session" : "fixture-default-session";
    const registry = options.headers.Authorization === `Bearer ${expected}`
      ? { "doctor-selected-agent": { status: "healthy", runtime: "codex" } }
      : {};
    return new Response(JSON.stringify({ registry }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    requests,
    run: () => diagnose({ config: configPath, receiptLog: path.join(root, "absent-receipts"), live: true }),
  };
}

test("doctor live registry uses the same selected secure store as its local auth check", async (t) => {
  const { run, requests } = fixture(t);
  const result = await run();
  assert.equal(result.checks.find((check) => check.name === "private_config").status, "pass");
  assert.equal(result.checks.find((check) => check.name === "secure_auth").tokenAvailable, true);
  assert.equal(result.checks.find((check) => check.name === "tenant_registry").status, "pass");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer fixture-selected-session");
});

test("doctor does not borrow the default account when the selected profile has no session", async (t) => {
  const { run, requests } = fixture(t, { missingSelectedToken: true });
  const result = await run();
  assert.equal(result.checks.find((check) => check.name === "secure_auth").tokenAvailable, false);
  assert.equal(result.checks.find((check) => check.name === "tenant_registry").status, "fail");
  assert.equal(requests.length, 0);
});

test("doctor retains environment secure-store fallback when config does not select a profile", async (t) => {
  const { run, requests } = fixture(t, { selectedProfile: false });
  const result = await run();
  assert.equal(result.checks.find((check) => check.name === "tenant_registry").status, "pass");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer fixture-default-session");
});
