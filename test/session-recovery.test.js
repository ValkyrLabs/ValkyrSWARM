import assert from "node:assert/strict";
import test from "node:test";
import { createTokenProvider, SwarmAgent } from "../scripts/swarm-agent.mjs";

const provider = (overrides = {}) => createTokenProvider({
  apiBase: "https://api-0.valkyrlabs.com/v1", keychainService: "VALKYR_AUTH",
  tokenFile: "/unused/session", credentialFile: "/unused/credentials",
}, {
  keychainReader: () => null, fileReader: () => null, credentialReader: () => null,
  login: () => assert.fail("Unexpected login"), persist: () => assert.fail("Unexpected write"),
  ...overrides,
});

test("a stale peer adopts a refreshed Keychain session without login or persistence", async () => {
  let stored = "old-session";
  const read = provider({ keychainReader: () => stored });
  assert.equal(await read(), "old-session");
  stored = "new-session";
  // A healthy peer can already have read this token. Recovery must compare
  // with the failed connection, not the provider's most recent return value.
  assert.equal(await read(), "new-session");
  assert.equal(await read({ forceRefresh: true, rejectedToken: "old-session" }), "new-session");
});

test("token-file recovery follows the same exact rejected-session rule", async () => {
  const read = provider({ fileReader: () => "new-file-session" });
  assert.equal(await read({ forceRefresh: true, rejectedToken: "old-session" }), "new-file-session");
});

test("unchanged or missing rejected sessions stay closed and a later refresh can recover", async () => {
  let stored = "old-session";
  const read = provider({ keychainReader: () => stored });
  for (const rejectedToken of ["old-session", undefined, null, ""]) {
    await assert.rejects(read({ forceRefresh: true, rejectedToken }), /Authentication expired/);
  }
  stored = null;
  await assert.rejects(read({ forceRefresh: true, rejectedToken: "old-session" }), /Authentication expired/);
  stored = "new-session";
  assert.equal(await read({ forceRefresh: true, rejectedToken: "old-session" }), "new-session");
});

test("simultaneous expired peers share one credential login and durable session replacement", async () => {
  let loginCount = 0, persistCount = 0, complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const read = provider({ keychainReader: () => "old-session",
    credentialReader: () => ({ username: "fixture", password: "fixture-secret" }),
    login: async () => { loginCount++; return pending; },
    persist: ({ token }) => { assert.equal(token, "fresh-session"); persistCount++; },
  });
  const a = read({ forceRefresh: true, rejectedToken: "old-session" });
  const b = read({ forceRefresh: true, rejectedToken: "old-session" });
  complete("fresh-session");
  assert.deepEqual(await Promise.all([a, b]), ["fresh-session", "fresh-session"]);
  assert.equal(loginCount, 1);
  assert.equal(persistCount, 1);
});

test("failed shared login releases the refresh so a later attempt can recover", async () => {
  let attempts = 0;
  const read = provider({
    credentialReader: () => ({ username: "fixture", password: "fixture-secret" }),
    login: async () => {
      if (++attempts === 1) throw new Error("Fixture login unavailable");
      return "fresh-session";
    },
    persist: () => {},
  });
  const results = await Promise.allSettled([
    read({ forceRefresh: true, rejectedToken: "old-session" }),
    read({ forceRefresh: true, rejectedToken: "old-session" }),
  ]);
  assert.equal(attempts, 1);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /Fixture login unavailable/);
  }
  assert.equal(await read({ forceRefresh: true, rejectedToken: "old-session" }), "fresh-session");
  assert.equal(attempts, 2);
});

test("secure-store recovery retires the rejected configured bootstrap token", async () => {
  const read = createTokenProvider({ configuredToken: "old-bootstrap" }, {
    keychainReader: () => "new-session", fileReader: () => null,
    credentialReader: () => assert.fail("Unexpected credential read"),
  });
  assert.equal(await read(), "old-bootstrap");
  assert.equal(await read({ forceRefresh: true, rejectedToken: "old-bootstrap" }), "new-session");
  assert.equal(await read(), "new-session");
});

class Socket {
  static instances = [];
  listeners = new Map();
  sent = [];
  constructor() { Socket.instances.push(this); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, event = {}) { this.listeners.get(name)?.(event); }
  send(frame) { this.sent.push(frame); }
  close() {}
}

test("the affected agent supplies its rejected session and ignores replaced socket events", async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; Socket.instances = []; });
  const requests = [], evidence = [];
  const agent = new SwarmAgent({
    agent: { agentId: "session-test-agent", runtime: "codex", capabilities: [] },
    apiBase: "https://api-0.valkyrlabs.com/v1", machineId: "session-test-machine",
    url: "wss://api-0.valkyrlabs.com/swarm", heartbeatSeconds: 30,
    tokenProvider: async (options) => { requests.push(options); return requests.length === 1 ? "old-session" : "new-session"; },
    evidence: { record: (event, details) => evidence.push({ event, ...details }) },
  });
  let closes = 0;
  agent.onClose = () => { closes++; };
  await agent.connect();
  const first = Socket.instances[0]; first.emit("open");
  first.emit("message", { data: "ERROR\nmessage:Authentication rejected\n\n\0" });
  assert.equal(agent.forceAuthRefresh, true);
  await agent.connect();
  const second = Socket.instances[1]; second.emit("open");
  assert.deepEqual(requests[1], { forceRefresh: true, rejectedToken: "old-session" });
  assert.equal(agent.forceAuthRefresh, false);
  const eventCount = evidence.length;
  first.emit("message", { data: "ERROR\nmessage:late error\n\n\0" });
  first.emit("close"); first.emit("open"); first.emit("error");
  assert.equal(agent.forceAuthRefresh, false);
  assert.equal(closes, 0);
  assert.equal(evidence.length, eventCount);
  assert.equal(first.sent.length, 1);
  assert.match(second.sent[0], /Bearer new-session/);
  assert.doesNotMatch(JSON.stringify(evidence), /old-session|new-session/);
});

test("temporary registration rejection retries on the current connection and stops after acknowledgment", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const announcements = [];
  const runtime = new SwarmAgent({
    agent: { agentId: "registration-recovery", runtime: "codex", capabilities: ["graymatter.context"] },
    apiBase: "https://api-0.valkyrlabs.com/v1", machineId: "registration-host",
    url: "wss://api-0.valkyrlabs.com/ws", heartbeatSeconds: 30,
    tokenProvider: async () => "identified-session-fixture", evidence: { record() {} },
  });
  runtime.websocket = { readyState: WebSocket.OPEN, send() {}, close() {} };
  runtime.sendAppTopic = (_topic, message) => announcements.push(message);
  t.after(() => runtime.stop());
  runtime.sendRegistration();
  const first = announcements.at(-1);
  runtime.onServerControlReply(JSON.stringify({ payload: { topic: "nack", payload: { ackId: first.id,
    status: "rejected", code: "ERR_SWARM_DATABASE_PRESSURE", error: "Deferred while database recovers" } } }));
  assert.equal(announcements.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(announcements.length, 2, "The product node re-registers without a test driver");
  const second = announcements.at(-1);
  runtime.onServerControlReply(JSON.stringify({ payload: { topic: "ack", payload: { ackId: second.id,
    status: "registered", data: { instanceId: runtime.agent.agentId } } } }));
  t.mock.timers.tick(60000);
  assert.equal(announcements.length, 2, "An accepted registration has no remaining retry");
});

test("registration authorization denial is not retried", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const announcements = [];
  const runtime = new SwarmAgent({
    agent: { agentId: "registration-denied", runtime: "codex", capabilities: ["graymatter.context"] },
    apiBase: "https://api-0.valkyrlabs.com/v1", machineId: "registration-host",
    url: "wss://api-0.valkyrlabs.com/ws", heartbeatSeconds: 30,
    tokenProvider: async () => "identified-session-fixture", evidence: { record() {} },
  });
  runtime.websocket = { readyState: WebSocket.OPEN, send() {}, close() {} };
  runtime.sendAppTopic = (_topic, message) => announcements.push(message);
  t.after(() => runtime.stop());
  runtime.sendRegistration();
  runtime.onServerControlReply(JSON.stringify({ payload: { topic: "nack", payload: { ackId: announcements[0].id,
    status: "rejected", code: "ERR_SWARM_ACCESS_DENIED", error: "Not authorized" } } }));
  t.mock.timers.tick(60000);
  assert.equal(announcements.length, 1);
});

test("missing registration acknowledgment retries and disconnect cancels the retry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const announcements = [];
  const runtime = new SwarmAgent({
    agent: { agentId: "registration-timeout", runtime: "codex", capabilities: ["graymatter.context"] },
    apiBase: "https://api-0.valkyrlabs.com/v1", machineId: "registration-host",
    url: "wss://api-0.valkyrlabs.com/ws", heartbeatSeconds: 30,
    tokenProvider: async () => "identified-session-fixture", evidence: { record() {} },
  });
  runtime.websocket = { readyState: WebSocket.OPEN, send() {}, close() {} };
  runtime.sendAppTopic = (_topic, message) => announcements.push(message);
  t.after(() => runtime.stop());
  runtime.sendRegistration();
  t.mock.timers.tick(15000);
  t.mock.timers.tick(1000);
  assert.equal(announcements.length, 2);
  runtime.stopped = true;
  runtime.onClose({ code: 1006 });
  t.mock.timers.tick(60000);
  assert.equal(announcements.length, 2);
});
