#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "https://api-0.valkyrlabs.com/v1";
const DEFAULT_KEYCHAIN_SERVICE = "VALKYR_AUTH";
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".config", "valkyr-swarm", "auth-token");
const DEFAULT_CREDENTIAL_FILE = path.join(os.homedir(), ".config", "valkyr-swarm", "credentials.json");

function expandPath(value) {
  if (!value) return null;
  if (value === "~") return os.homedir();
  if (String(value).startsWith("~/")) return path.join(os.homedir(), String(value).slice(2));
  return path.resolve(String(value));
}

function normalizeApiBase(value = DEFAULT_API_BASE) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("API base must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API base must not contain credentials, query parameters, or fragments");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function extractCookie(headers, name) {
  const cookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const cookie of cookies) {
    const match = String(cookie).match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`, "i"));
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractToken(body, headers) {
  const candidates = [
    body?.VALKYR_AUTH,
    body?.data?.VALKYR_AUTH,
    body?.token,
    body?.session,
    body?.jwt,
    body?.jwtSession,
    body?.data?.jwtSession,
    headers.get("valkyr_auth"),
    headers.get("valkyr-auth"),
    headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
    extractCookie(headers, "VALKYR_AUTH"),
    extractCookie(headers, "jwtSession"),
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() ?? null;
}

async function loginWithCredentials({ username, password, apiBase = DEFAULT_API_BASE, fetchImpl = fetch }) {
  if (!username || !password) {
    throw new Error("Set VALKYR_USERNAME and VALKYR_PASSWORD (or VALKYR_SWARM_USERNAME and VALKYR_SWARM_PASSWORD)");
  }
  const response = await fetchImpl(`${normalizeApiBase(apiBase)}/auth/login`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(60_000),
  });
  let body = {};
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  if (!response.ok) throw new Error(`Valkyr Labs login failed with HTTP ${response.status}`);
  const token = extractToken(body, response.headers);
  if (!token) throw new Error("Login succeeded but no VALKYR_AUTH session was returned");
  return token;
}

function safeService(value) {
  const service = String(value ?? DEFAULT_KEYCHAIN_SERVICE).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(service)) throw new Error("Invalid Keychain service name");
  return service;
}

function keychainRead(service = DEFAULT_KEYCHAIN_SERVICE, account = "default") {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", safeService(service), "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function keychainWrite(service, account, value) {
  const normalized = safeService(service);
  spawnSync("/usr/bin/security", ["delete-generic-password", "-a", account, "-s", normalized], {
    stdio: "ignore",
  });
  const result = spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-a", account, "-s", normalized, "-w", value], {
    stdio: "ignore",
  });
  if (result.status !== 0) throw new Error(`Unable to store authentication in Keychain service ${normalized}`);
}

function readTokenFile(tokenFile = DEFAULT_TOKEN_FILE) {
  const resolved = expandPath(tokenFile);
  try {
    const stat = fs.statSync(resolved);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Token file permissions must be 0600: ${resolved}`);
    return fs.readFileSync(resolved, "utf8").trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeTokenFile(token, tokenFile = DEFAULT_TOKEN_FILE) {
  const resolved = expandPath(tokenFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(resolved, 0o600);
  return resolved;
}

function readCredentialsFile(credentialFile = DEFAULT_CREDENTIAL_FILE) {
  const resolved = expandPath(credentialFile);
  try {
    const stat = fs.statSync(resolved);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Credential file permissions must be 0600: ${resolved}`);
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return {
      username: typeof value.username === "string" ? value.username : null,
      password: typeof value.password === "string" ? value.password : null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { username: null, password: null };
    throw error;
  }
}

function writeCredentialsFile({ username, password }, credentialFile = DEFAULT_CREDENTIAL_FILE) {
  if (!username || !password) return null;
  const resolved = expandPath(credentialFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${JSON.stringify({ username, password })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(resolved, 0o600);
  return resolved;
}

function credentialsFromEnvironment(env = process.env) {
  return {
    username: env.VALKYR_SWARM_USERNAME ?? env.VALKYR_USERNAME ?? env.GRAYMATTER_USERNAME,
    password: env.VALKYR_SWARM_PASSWORD ?? env.VALKYR_PASSWORD ?? env.GRAYMATTER_PASSWORD,
  };
}

function credentialsFromSecureStorage({
  env = process.env,
  keychainService = DEFAULT_KEYCHAIN_SERVICE,
  credentialFile = DEFAULT_CREDENTIAL_FILE,
} = {}) {
  const environment = credentialsFromEnvironment(env);
  if (environment.username && environment.password) return environment;
  if (process.platform === "darwin") {
    const username = keychainRead(`${keychainService}_USERNAME`, "default");
    const password = username ? keychainRead(`${keychainService}_PASSWORD`, username) : null;
    return { username, password };
  }
  return readCredentialsFile(credentialFile);
}

function loadStoredToken({
  env = process.env,
  keychainService = DEFAULT_KEYCHAIN_SERVICE,
  tokenFile = DEFAULT_TOKEN_FILE,
} = {}) {
  const environmentToken = env.VALKYR_AUTH_TOKEN ?? env.API0_JWT_SESSION ?? env.VALKYR_JWT_SESSION;
  if (environmentToken) return environmentToken;
  return keychainRead(keychainService) ?? readTokenFile(tokenFile);
}

function persistAuthentication({
  token,
  username,
  password,
  keychainService = DEFAULT_KEYCHAIN_SERVICE,
  tokenFile = DEFAULT_TOKEN_FILE,
  credentialFile = DEFAULT_CREDENTIAL_FILE,
}) {
  if (process.platform === "darwin") {
    keychainWrite(keychainService, "default", token);
    if (username) {
      keychainWrite(`${keychainService}_USERNAME`, "default", username);
      if (password) keychainWrite(`${keychainService}_PASSWORD`, username, password);
    }
    return { storage: "keychain", location: keychainService };
  }
  const tokenLocation = writeTokenFile(token, tokenFile);
  const credentialLocation = writeCredentialsFile({ username, password }, credentialFile);
  return { storage: "file", location: tokenLocation, credentialLocation };
}

function selfTest() {
  const base = normalizeApiBase("https://api-0.valkyrlabs.com/v1/");
  if (base !== DEFAULT_API_BASE) throw new Error("API base normalization failed");
  const headers = new Headers({ Authorization: "Bearer test-token" });
  if (extractToken({}, headers) !== "test-token") throw new Error("Authorization token extraction failed");
  const credentials = credentialsFromEnvironment({ VALKYR_USERNAME: "user", VALKYR_PASSWORD: "pass" });
  if (credentials.username !== "user" || credentials.password !== "pass") throw new Error("Credential discovery failed");
  process.stdout.write("Valkyr SWARM auth self-test passed\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--self-test")) {
  selfTest();
}

export {
  DEFAULT_API_BASE,
  DEFAULT_CREDENTIAL_FILE,
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_TOKEN_FILE,
  credentialsFromEnvironment,
  credentialsFromSecureStorage,
  expandPath,
  extractToken,
  keychainRead,
  loadStoredToken,
  loginWithCredentials,
  normalizeApiBase,
  persistAuthentication,
  readCredentialsFile,
  readTokenFile,
  selfTest,
  writeTokenFile,
  writeCredentialsFile,
};
