import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HEADER = "X-Valkyr-Engine-Authorization";
const PURPOSE = "valkyr-workflow-engine-transport/v1";
const MAX_KEY_BYTES = 514;

function workflowEngineKeyPath(agent) {
  const id = String(agent?.agentId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) throw new Error("Workflow engine key requires a stable node identity");
  const value = agent?.workflowRuntime?.install?.engineKeyPath
    ?? path.join(os.homedir(), ".config", "valkyr-swarm", "workflow-runtimes", `${id}.engine-key`);
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw new Error("Workflow engine key path is invalid");
  return path.resolve(value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

function requirePrivate(stats, directory = false) {
  if (!process.getuid || !fs.constants.O_NOFOLLOW
      || (directory ? !stats.isDirectory() : !stats.isFile()) || stats.isSymbolicLink()
      || (stats.mode & 0o777) !== (directory ? 0o700 : 0o600) || stats.uid !== process.getuid()
      || (!directory && (stats.nlink !== 1 || stats.size > MAX_KEY_BYTES))) {
    throw new Error("Workflow engine key storage must be private, bounded, owned by this node user and free of links");
  }
}

function readKey(keyPath) {
  try {
    requirePrivate(fs.lstatSync(path.dirname(keyPath)), true);
    requirePrivate(fs.lstatSync(keyPath));
    const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd); requirePrivate(before);
      const bytes = Buffer.alloc(MAX_KEY_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      const after = fs.lstatSync(keyPath); requirePrivate(after);
      if (size > MAX_KEY_BYTES || size !== after.size || before.ino !== after.ino || before.dev !== after.dev) throw new Error();
      const value = bytes.subarray(0, size).toString("utf8").replace(/\r?\n$/, "");
      if (!/^[\x21-\x7e]{32,512}$/.test(value)) throw new Error();
      return value;
    } finally { fs.closeSync(fd); }
  } catch {
    // Do not propagate filesystem paths, secret contents or caller-supplied exception text.
    throw new Error("Unable to verify private node-local workflow engine key storage");
  }
}

function prepareWorkflowEngineKey(keyPath, existingJournal = false) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  requirePrivate(fs.lstatSync(path.dirname(keyPath)), true);
  let exists = true;
  try { fs.lstatSync(keyPath); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
  if (!exists) {
    if (existingJournal) throw new Error("Workflow engine key is missing for an existing journal; restore the original key before activation");
    let fd;
    try { fd = fs.openSync(keyPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (fd !== undefined) {
      try { fs.writeFileSync(fd, crypto.randomBytes(32).toString("base64url") + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
  }
  readKey(keyPath); // Never chmod, replace or silently repair an existing key.
}

function workflowEngineTransportHeaders(agent) {
  if (agent?.workflowRuntime?.tier !== "engine") return {};
  const key = readKey(workflowEngineKeyPath(agent));
  return { [HEADER]: crypto.createHmac("sha256", key).update(PURPOSE).digest("hex") };
}

export { workflowEngineKeyPath, workflowEngineTransportHeaders, prepareWorkflowEngineKey };
