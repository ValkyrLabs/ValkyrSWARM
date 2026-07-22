import assert from "node:assert/strict";
import test from "node:test";

import { workflowEngineLifecycleResponse } from "../scripts/swarm-agent.mjs";

test("durable engine checkpoints remain progress and terminal events map to lifecycle frames", () => {
  const checkpoint = workflowEngineLifecycleResponse({
    id: 4,
    executionId: "execution-1",
    eventType: "CHECKPOINT",
    payload: {
      state: "WAITING_APPROVAL",
      checkpointRef: "engine-checkpoint:execution-1:approval:module-1",
    },
  }, { workflowRunnerId: "runner-1", leaseFence: 7 });
  assert.equal(checkpoint.type, "ACK");
  assert.equal(checkpoint.status, "progress");
  assert.equal(checkpoint.result.executed, false);
  assert.equal(checkpoint.result.executionState, "WAITING_APPROVAL");
  assert.equal(checkpoint.result.checkpoint, true);

  const success = workflowEngineLifecycleResponse({
    id: 5,
    executionId: "execution-1",
    eventType: "SUCCESS",
    payload: { terminalState: "SUCCESS", finalState: { answer: 42 } },
  }, { workflowRunnerId: "runner-1", leaseFence: 7 });
  assert.equal(success.type, "ACK");
  assert.equal(success.status, "completed");
  assert.equal(success.result.executed, true);

  const failure = workflowEngineLifecycleResponse({
    id: 6,
    executionId: "execution-2",
    eventType: "FAILED",
    payload: { terminalState: "FAILED", errorMessage: "bounded failure" },
  });
  assert.equal(failure.type, "NACK");
  assert.equal(failure.status, "failed");
  assert.match(failure.reason, /bounded failure/);
});
