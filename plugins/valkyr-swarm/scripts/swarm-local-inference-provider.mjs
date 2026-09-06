const PROVIDER_PROTOCOL = "valkyr-local-inference-provider/v1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function defaultProviderEndpoint(kind) {
  if (kind === "lm-studio") return "http://127.0.0.1:1234/v1";
  if (kind === "ollama") return "http://127.0.0.1:11434";
  throw new Error("local model provider must be lm-studio or ollama");
}

function normalizeProviderEndpoint(kind, value) {
  let endpoint;
  try {
    endpoint = new URL(String(value ?? defaultProviderEndpoint(kind)));
  } catch {
    throw new Error("local model provider endpoint must be a valid loopback HTTP URL");
  }
  if (endpoint.protocol !== "http:"
      || !LOOPBACK_HOSTS.has(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("local model provider endpoint must be credential-free loopback HTTP");
  }
  return endpoint.toString().replace(/\/$/, "");
}

function providerDescriptor(kind, model, endpoint) {
  if (kind !== "lm-studio" && kind !== "ollama") {
    throw new Error("local model provider must be lm-studio or ollama");
  }
  const selected = String(model ?? "").trim();
  if (!selected || selected.length > 240) {
    throw new Error("model-only activation requires an explicit bounded --local-model-id");
  }
  return {
    protocol: PROVIDER_PROTOCOL,
    kind,
    endpoint: normalizeProviderEndpoint(kind, endpoint),
    model: selected,
    operations: [
      "models.list",
      "inference.chat",
      "inference.stream",
      "inference.cancel",
      "inference.structured-output",
    ],
  };
}

function modelsEndpoint(provider) {
  const endpoint = new URL(provider.endpoint);
  if (provider.kind === "ollama") return new URL("/api/tags", endpoint).toString();
  const pathname = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${pathname}models`.replace(/\/+/g, "/");
  return endpoint.toString();
}

function parseModels(provider, payload) {
  const values = provider.kind === "ollama"
    ? payload?.models?.map((model) => model?.name ?? model?.model)
    : payload?.data?.map((model) => model?.id);
  return [...new Set((values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function generationEndpoint(provider) {
  const endpoint = new URL(provider.endpoint);
  if (provider.kind === "ollama") return new URL("/api/chat", endpoint).toString();
  const pathname = endpoint.pathname.endsWith("/") ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${pathname}chat/completions`.replace(/\/+/g, "/");
  return endpoint.toString();
}

function generationPayload(provider) {
  if (provider.kind === "ollama") {
    return {
      model: provider.model,
      messages: [{ role: "user", content: "Reply OK." }],
      stream: false,
      options: { num_predict: 1 },
    };
  }
  return {
    model: provider.model,
    messages: [{ role: "user", content: "Reply OK." }],
    max_tokens: 1,
    stream: false,
  };
}

async function probeLocalInferenceProvider(provider, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 3_000);
  const generationTimeoutMs = Number(options.generationTimeoutMs ?? 60_000);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();
  try {
    const inventoryController = new AbortController();
    const inventoryTimer = setTimeout(() => inventoryController.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(modelsEndpoint(provider), {
        headers: { accept: "application/json" },
        method: "GET",
        signal: inventoryController.signal,
      });
    } finally {
      clearTimeout(inventoryTimer);
    }
    if (!response.ok) {
      return { healthy: false, status: `http_${response.status}`, models: [] };
    }
    const models = parseModels(provider, await response.json());
    if (!models.includes(provider.model)) {
      return {
        healthy: false,
        status: "selected_model_not_loaded",
        models,
        latencyMs: Date.now() - startedAt,
      };
    }
    if (options.validateGeneration === true) {
      const generationController = new AbortController();
      const generationTimer = setTimeout(() => generationController.abort(), generationTimeoutMs);
      let generation;
      try {
        generation = await fetchImpl(generationEndpoint(provider), {
          body: JSON.stringify(generationPayload(provider)),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
          signal: generationController.signal,
        });
      } finally {
        clearTimeout(generationTimer);
      }
      if (!generation.ok) {
        return {
          healthy: false,
          status: "selected_model_not_generative",
          models,
          latencyMs: Date.now() - startedAt,
        };
      }
    }
    return {
      healthy: true,
      status: "healthy",
      model: provider.model,
      kind: provider.kind,
      latencyMs: Date.now() - startedAt,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      healthy: false,
      status: error?.name === "AbortError" ? "timeout" : "unreachable",
      models: [],
    };
  }
}

async function requireHealthyLocalInferenceProvider(provider, options = {}) {
  const result = await probeLocalInferenceProvider(provider, {
    ...options,
    validateGeneration: options.validateGeneration ?? true,
  });
  if (!result.healthy) {
    throw new Error(
      `Local ${provider.kind} provider is not ready for model ${provider.model}: ${result.status}`,
    );
  }
  return result;
}

export {
  PROVIDER_PROTOCOL,
  defaultProviderEndpoint,
  generationEndpoint,
  modelsEndpoint,
  normalizeProviderEndpoint,
  probeLocalInferenceProvider,
  providerDescriptor,
  requireHealthyLocalInferenceProvider,
};
