import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const TRUST_PROTOCOL = "valkyr-workflow-trust/v1";
const GRANT_PROTOCOL = "valkyr-workflow-capability-grant/v1";
const MAX_TRUST_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function workflowGrantTrustPath(thor_agent) {
  const thor_id = String(thor_agent?.agentId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(thor_id)) throw new Error("Workflow trust requires a stable node identity");
  const thor_configured = thor_agent?.workflowRuntime?.install?.grantTrustPath;
  const thor_value = thor_configured ?? path.join(os.homedir(), ".config", "valkyr-swarm", "workflow-runtimes", `${thor_id}.grant-trust.json`);
  if (typeof thor_value !== "string" || !thor_value || /[\r\n\0]/.test(thor_value)) throw new Error("Workflow trust path is invalid");
  return path.resolve(thor_value.startsWith("~/") ? path.join(os.homedir(), thor_value.slice(2)) : thor_value);
}

function trustOrigin(thor_apiBase) {
  const thor_url = new URL(thor_apiBase);
  const thor_loopback = ["127.0.0.1", "localhost", "[::1]"].includes(thor_url.hostname);
  if ((thor_url.protocol !== "https:" && !(thor_url.protocol === "http:" && thor_loopback))
      || thor_url.username || thor_url.password || thor_url.search || thor_url.hash) {
    throw new Error("Workflow trust requires a credential-free authenticated API origin");
  }
  return thor_url.origin;
}

function validateGrantTrust(thor_body, thor_agent, thor_apiBase) {
  if (!thor_body || thor_body.protocol !== GRANT_PROTOCOL || !UUID.test(thor_body.tenantId ?? "")
      || thor_body.swarmInstanceId !== thor_agent.agentId
      || Object.keys(thor_body).some((thor_key) => !["protocol", "tenantId", "swarmInstanceId", "issuer"].includes(thor_key))) {
    throw new Error("Workflow trust scope does not match this authenticated node");
  }
  const thor_issuer = thor_body.issuer;
  if (!thor_issuer || typeof thor_issuer.keyId !== "string" || !/^[^\x00-\x20\x7f]{1,256}$/.test(thor_issuer.keyId)
      || typeof thor_issuer.publicKeyX509Base64 !== "string" || thor_issuer.publicKeyX509Base64.length > 256
      || Object.keys(thor_issuer).some((thor_key) => !["keyId", "publicKeyX509Base64"].includes(thor_key))) {
    throw new Error("Workflow trust issuer is malformed");
  }
  try {
    const thor_bytes = Buffer.from(thor_issuer.publicKeyX509Base64, "base64");
    if (thor_bytes.toString("base64") !== thor_issuer.publicKeyX509Base64) throw new Error();
    const thor_key = crypto.createPublicKey({ key: thor_bytes, type: "spki", format: "der" });
    if (thor_key.asymmetricKeyType !== "ed25519" || !thor_key.export({ type: "spki", format: "der" }).equals(thor_bytes)) throw new Error();
  } catch { throw new Error("Workflow trust requires a canonical Ed25519 public key"); }
  return { protocol: TRUST_PROTOCOL, apiOrigin: trustOrigin(thor_apiBase), tenantId: thor_body.tenantId.toLowerCase(),
    swarmInstanceId: thor_body.swarmInstanceId, issuers: { [thor_issuer.keyId]: thor_issuer.publicKeyX509Base64 } };
}

function requirePrivate(thor_stats, thor_directory = false) {
  if (thor_stats.isSymbolicLink() || (thor_directory ? !thor_stats.isDirectory() : !thor_stats.isFile())
      || (thor_stats.mode & 0o077) !== 0
      || (process.getuid && thor_stats.uid !== process.getuid())) {
    throw new Error("Workflow trust storage must be private and owned by this node user");
  }
}

// JSON.parse validates the grammar; this bounded scan also rejects duplicate object
// keys, including differently escaped spellings of the same security field.
function parseTrustJson(thor_text) {
  const thor_value = JSON.parse(thor_text), thor_objects = [];
  for (let thor_i = 0; thor_i < thor_text.length; thor_i++) {
    if (thor_text[thor_i] === "{") thor_objects.push(new Set());
    else if (thor_text[thor_i] === "}") thor_objects.pop();
    else if (thor_text[thor_i] === '"') {
      const thor_start = thor_i++;
      while (thor_i < thor_text.length && thor_text[thor_i] !== '"') {
        if (thor_text[thor_i] === "\\") thor_i++;
        thor_i++;
      }
      let thor_after = thor_i + 1;
      while (/\s/.test(thor_text[thor_after] ?? "") && thor_after < thor_text.length) thor_after++;
      if (thor_text[thor_after] === ":") {
        const thor_key = JSON.parse(thor_text.slice(thor_start, thor_i + 1)), thor_keys = thor_objects.at(-1);
        if (thor_keys.has(thor_key)) throw new Error("Workflow trust JSON is malformed: duplicate field");
        thor_keys.add(thor_key);
      }
    }
  }
  return thor_value;
}

function persistGrantTrust(thor_agent, thor_trust) {
  const thor_target = workflowGrantTrustPath(thor_agent), thor_parent = path.dirname(thor_target);
  fs.mkdirSync(thor_parent, { recursive: true, mode: 0o700 });
  requirePrivate(fs.lstatSync(thor_parent), true);
  const thor_existing = () => {
    requirePrivate(fs.lstatSync(thor_target));
    const thor_fd = fs.openSync(thor_target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const thor_stats = fs.fstatSync(thor_fd); requirePrivate(thor_stats);
      if (thor_stats.size > MAX_TRUST_BYTES) throw new Error("Workflow trust file exceeds the bounded size");
      const thor_saved = parseTrustJson(fs.readFileSync(thor_fd, "utf8"));
      if (!isDeepStrictEqual(thor_saved, thor_trust)) {
        throw new Error("Workflow public trust changed; reconcile the pinned issuer and scope before execution");
      }
    } finally { fs.closeSync(thor_fd); }
  };
  try { thor_existing(); return thor_target; }
  catch (thor_error) { if (thor_error.code !== "ENOENT") throw thor_error; }
  const thor_temporary = path.join(thor_parent, `.trust-${crypto.randomUUID()}.tmp`);
  const thor_fd = fs.openSync(thor_temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    try { fs.writeFileSync(thor_fd, JSON.stringify(thor_trust) + "\n"); fs.fsyncSync(thor_fd); }
    finally { fs.closeSync(thor_fd); }
    try { fs.linkSync(thor_temporary, thor_target); }
    catch (thor_error) { if (thor_error.code !== "EEXIST") throw thor_error; thor_existing(); }
  } finally { fs.unlinkSync(thor_temporary); }
  return thor_target;
}

async function readTrustResponse(thor_response) {
  let thor_size = 0; const thor_parts = [];
  for await (const thor_chunk of thor_response.body) {
    thor_size += thor_chunk.byteLength;
    if (thor_size > MAX_TRUST_BYTES) throw new Error("Workflow trust response exceeds the bounded size");
    thor_parts.push(Buffer.from(thor_chunk));
  }
  try { return parseTrustJson(Buffer.concat(thor_parts).toString("utf8")); }
  catch { throw new Error("Workflow trust response is malformed"); }
}

async function bootstrapWorkflowGrantTrust({ agent: thor_agent, apiBase: thor_apiBase, runnerId: thor_runnerId,
    tokenProvider: thor_tokens, fetchImpl: thor_fetch = fetch }) {
  if (!UUID.test(thor_runnerId ?? "")) throw new Error("Workflow trust requires a canonical runner identity");
  const thor_url = new URL(`/v1/swarm/workflow-runtime/grant-trust/${thor_runnerId}`, trustOrigin(thor_apiBase));
  const thor_send = async (thor_refresh) => {
    const thor_token = await thor_tokens({ forceRefresh: thor_refresh });
    if (!thor_token) throw new Error("Workflow trust bootstrap requires an authenticated SWARM session");
    return thor_fetch(thor_url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${thor_token}`, Accept: "application/json" } });
  };
  let thor_response = await thor_send(false);
  if (thor_response.status === 401 || thor_response.status === 403) {
    await thor_response.body?.cancel();
    thor_response = await thor_send(true);
  }
  if (!thor_response.ok) { await thor_response.body?.cancel(); throw new Error(`Workflow trust discovery failed with HTTP ${thor_response.status}`); }
  const thor_trust = validateGrantTrust(await readTrustResponse(thor_response), thor_agent, thor_apiBase);
  return { path: persistGrantTrust(thor_agent, thor_trust), trust: thor_trust };
}

export { bootstrapWorkflowGrantTrust, persistGrantTrust, validateGrantTrust, workflowGrantTrustPath };
