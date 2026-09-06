const NODE_CONTRACT_PROTOCOL = "valkyr-swarm-node/v1";
const PROVIDER_CONTRACT_PROTOCOL = "valkyr-local-inference-provider/v1";

const NODE_CLASS_AGENTIC = "agentic-runtime";
const NODE_CLASS_MODEL_ONLY = "model-only";

const MODEL_ONLY_WORKFLOW_ACTIONS = Object.freeze([
  "workflow.engine.execute-workflow",
  "workflow.engine.kill-execution",
  "workflow.engine.deny-approval",
]);

const MODEL_ONLY_LIFECYCLE_ACTIONS = Object.freeze([
  "service.lifecycle.status",
  "service.lifecycle.restart",
]);

const MODEL_ONLY_ADVERTISED_ACTIONS = new Set([
  ...MODEL_ONLY_WORKFLOW_ACTIONS,
  ...MODEL_ONLY_LIFECYCLE_ACTIONS,
]);

const PROVIDER_OPERATIONS = new Set([
  "models.list",
  "inference.chat",
  "inference.stream",
  "inference.cancel",
  "inference.structured-output",
]);

const PROVIDER_KINDS = new Set(["lm-studio", "ollama"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function distinctStrings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item) => String(item ?? "").trim());
  if (values.some((item) => !item)) throw new Error(`${label} must not contain empty values`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates`);
  return values;
}

function validateProviderDescriptor(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error("model-only node requires a localInferenceProvider descriptor");
  }
  if (provider.protocol !== PROVIDER_CONTRACT_PROTOCOL) {
    throw new Error(`local inference provider protocol must be ${PROVIDER_CONTRACT_PROTOCOL}`);
  }
  if (!PROVIDER_KINDS.has(provider.kind)) {
    throw new Error("local inference provider kind must be lm-studio or ollama");
  }
  let endpoint;
  try {
    endpoint = new URL(String(provider.endpoint ?? ""));
  } catch {
    throw new Error("local inference provider endpoint must be a valid loopback HTTP URL");
  }
  if (endpoint.protocol !== "http:"
      || !LOOPBACK_HOSTS.has(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("local inference provider endpoint must be credential-free loopback HTTP");
  }
  const operations = distinctStrings(provider.operations, "local inference provider operations");
  if (operations.length === 0) {
    throw new Error("local inference provider requires at least one inference operation");
  }
  for (const operation of operations) {
    if (!PROVIDER_OPERATIONS.has(operation)) {
      throw new Error(`local inference provider operation is not allowed: ${operation}`);
    }
  }
  if (typeof provider.model !== "string" || !provider.model.trim() || provider.model.length > 240) {
    throw new Error("local inference provider model must be an explicit bounded model identifier");
  }
  return provider;
}

function nodeClass(agent) {
  return agent?.nodeContract?.nodeClass ?? NODE_CLASS_AGENTIC;
}

function validateNodeContract(agent) {
  const contract = agent?.nodeContract;
  if (contract == null) return NODE_CLASS_AGENTIC;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("nodeContract must be an object");
  }
  if (contract.protocol !== NODE_CONTRACT_PROTOCOL) {
    throw new Error(`node contract protocol must be ${NODE_CONTRACT_PROTOCOL}`);
  }
  if (![NODE_CLASS_AGENTIC, NODE_CLASS_MODEL_ONLY].includes(contract.nodeClass)) {
    throw new Error("node class must be agentic-runtime or model-only");
  }
  if (contract.nodeClass === NODE_CLASS_AGENTIC) {
    if (contract.localInferenceProvider != null) {
      throw new Error("agentic-runtime nodes must not use the model-only provider descriptor");
    }
    return contract.nodeClass;
  }

  validateProviderDescriptor(contract.localInferenceProvider);
  if (agent.execution != null) {
    throw new Error("model-only nodes cannot configure a native agent execution adapter");
  }
  if (agent.workflowRuntime?.enabled !== true || agent.workflowRuntime?.tier !== "engine") {
    throw new Error("model-only nodes require the durable Workflow engine tier");
  }
  const supportedTools = distinctStrings(
    agent.workflowRuntime.supportedTools,
    "model-only workflowRuntime.supportedTools",
  );
  if (!supportedTools.includes("workflow.engine.execute-workflow")) {
    throw new Error("model-only nodes must support workflow.engine.execute-workflow");
  }
  for (const action of supportedTools) {
    if (!MODEL_ONLY_WORKFLOW_ACTIONS.includes(action)) {
      throw new Error(`model-only node cannot support native action: ${action}`);
    }
  }
  const capabilities = distinctStrings(agent.capabilities, "model-only capabilities");
  for (const capability of capabilities) {
    if (!MODEL_ONLY_ADVERTISED_ACTIONS.has(capability)) {
      throw new Error(`model-only node cannot advertise native capability: ${capability}`);
    }
  }
  return contract.nodeClass;
}

function constrainNodeAdvertisement(agent, advertisement = {}) {
  if (nodeClass(agent) !== NODE_CLASS_MODEL_ONLY) return advertisement;
  return {
    ...advertisement,
    capabilities: (advertisement.capabilities ?? [])
      .filter((capability) => MODEL_ONLY_ADVERTISED_ACTIONS.has(capability)),
    supportedTools: (advertisement.supportedTools ?? [])
      .filter((tool) => MODEL_ONLY_WORKFLOW_ACTIONS.includes(tool)),
    supportedModels: undefined,
    localInferenceProvider: {
      protocol: PROVIDER_CONTRACT_PROTOCOL,
      kind: agent.nodeContract.localInferenceProvider.kind,
      model: agent.nodeContract.localInferenceProvider.model,
      operations: [...agent.nodeContract.localInferenceProvider.operations],
    },
    nodeContract: {
      protocol: NODE_CONTRACT_PROTOCOL,
      nodeClass: NODE_CLASS_MODEL_ONLY,
    },
  };
}

function modelOnlyActionAllowed(action) {
  return MODEL_ONLY_ADVERTISED_ACTIONS.has(String(action ?? "").trim());
}

export {
  MODEL_ONLY_ADVERTISED_ACTIONS,
  MODEL_ONLY_LIFECYCLE_ACTIONS,
  MODEL_ONLY_WORKFLOW_ACTIONS,
  NODE_CLASS_AGENTIC,
  NODE_CLASS_MODEL_ONLY,
  NODE_CONTRACT_PROTOCOL,
  PROVIDER_CONTRACT_PROTOCOL,
  PROVIDER_OPERATIONS,
  constrainNodeAdvertisement,
  modelOnlyActionAllowed,
  nodeClass,
  validateNodeContract,
  validateProviderDescriptor,
};
