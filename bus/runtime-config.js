const fs = require("fs");
const path = require("path");

const EMBEDDING_RUNTIME_RESERVED_KEYS = new Set([
  "activeProfile",
  "activeProvider",
  "profiles",
  "providers",
  "defaults",
]);

const EMBEDDING_CONFIG_META_KEYS = new Set([
  "provider",
  "name",
  "label",
  "description",
  "notes",
  "enabled",
]);

const KNOWN_ADAPTERS = new Set(["hash", "transformer", "openai-compatible", "huggingface", "gemini"]);
const EMBEDDING_ADAPTER_ALIASES = {
  hash: "hash",
  hashing: "hash",
  transformer: "transformer",
  "sentence-transformer": "transformer",
  "sentence-transformers": "transformer",
  openai: "openai-compatible",
  "openai-compatible": "openai-compatible",
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const text = normalizeString(value).toLowerCase();
  if (!text) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  return fallback;
}

function normalizeInteger(value, fallback = 0, min = 0) {
  const parsed = Number(String(value || "").trim());
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.trunc(parsed));
}

function normalizeEmbeddingAdapter(value, fallback = "") {
  if (value == null) {
    return normalizeString(fallback).toLowerCase();
  }
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return normalizeString(fallback).toLowerCase();
  }
  const canonical = EMBEDDING_ADAPTER_ALIASES[normalized] || normalized;
  if (!KNOWN_ADAPTERS.has(canonical)) {
    return normalizeString(fallback).toLowerCase();
  }
  return canonical;
}

function stripConfigMetadata(config) {
  if (!isPlainObject(config)) {
    return {};
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(config)) {
    if (!EMBEDDING_CONFIG_META_KEYS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function mergeConfigBlocks(...blocks) {
  const merged = {};
  for (const block of blocks) {
    if (!isPlainObject(block)) {
      continue;
    }
    Object.assign(merged, stripConfigMetadata(block));
  }
  return merged;
}

function cloneJsonValue(value, fallback = {}) {
  if (!isPlainObject(value)) {
    return isPlainObject(fallback) ? { ...fallback } : {};
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return { ...value };
  }
}

function resolveRootCandidates(rootPath = "") {
  const candidates = [];
  for (const candidate of [rootPath, process.env.AI_MEMORY_ROOT || "", __dirname, path.resolve(__dirname, "..")]) {
    const normalized = normalizeString(candidate);
    if (!normalized) {
      continue;
    }
    const fullPath = path.resolve(normalized);
    if (!candidates.includes(fullPath)) {
      candidates.push(fullPath);
    }
  }
  return candidates;
}

function resolveRuntimeConfigPath(rootPath = "") {
  const explicitPath = normalizeString(process.env.AI_MEMORY_RUNTIME_CONFIG_PATH || "");
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  for (const candidateRoot of resolveRootCandidates(rootPath)) {
    for (const relativePath of [path.join("config", "runtime.json"), path.join("templates", "config", "runtime.json")]) {
      const configPath = path.join(candidateRoot, relativePath);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
  }

  const fallbackRoot = resolveRootCandidates(rootPath)[0] || path.resolve(__dirname);
  return path.join(fallbackRoot, "config", "runtime.json");
}

function loadRuntimeConfig(rootPath = "") {
  const configPath = resolveRuntimeConfigPath(rootPath);
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      exists: false,
      data: {},
      error: "",
    };
  }

  try {
    return {
      configPath,
      exists: true,
      data: JSON.parse(fs.readFileSync(configPath, "utf8")),
      error: "",
    };
  } catch (error) {
    return {
      configPath,
      exists: true,
      data: {},
      error: String(error && error.message ? error.message : error),
    };
  }
}

function extractEmbeddingDefaults(embeddings) {
  if (!isPlainObject(embeddings)) {
    return {};
  }

  const legacyDefaults = {};
  for (const [key, value] of Object.entries(embeddings)) {
    if (!EMBEDDING_RUNTIME_RESERVED_KEYS.has(key)) {
      legacyDefaults[key] = value;
    }
  }

  return mergeConfigBlocks(legacyDefaults, embeddings.defaults);
}

function resolveNamedRegistryEntry(registry, candidates = [], defaultName = "default") {
  const normalizedRegistry = isPlainObject(registry) ? registry : {};
  for (const candidate of candidates) {
    if (!normalizeString(candidate)) {
      continue;
    }
    if (isPlainObject(normalizedRegistry[candidate])) {
      return {
        name: candidate,
        config: normalizedRegistry[candidate],
      };
    }
  }

  if (isPlainObject(normalizedRegistry[defaultName])) {
    return {
      name: defaultName,
      config: normalizedRegistry[defaultName],
    };
  }

  const availableNames = Object.keys(normalizedRegistry);
  if (availableNames.length === 1 && isPlainObject(normalizedRegistry[availableNames[0]])) {
    return {
      name: availableNames[0],
      config: normalizedRegistry[availableNames[0]],
    };
  }

  return {
    name: "",
    config: {},
  };
}

function writeRuntimeConfig(rootPath = "", data = {}) {
  const configPath = resolveRuntimeConfigPath(rootPath);
  const normalized = isPlainObject(data) ? data : {};
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return configPath;
}

function resolveEmbeddingRuntime(options = {}) {
  const rootPath = normalizeString(options.rootPath || "");
  const defaults = isPlainObject(options.defaults) ? options.defaults : {};
  const getEnvValue =
    typeof options.getEnvValue === "function"
      ? options.getEnvValue
      : (name) => normalizeString(process.env[name] || "");
  const getProcessEnvValue =
    typeof options.getProcessEnvValue === "function"
      ? options.getProcessEnvValue
      : (name) => normalizeString(process.env[name] || "");
  const allowProcessEmbeddingOverrides = normalizeBoolean(
    getProcessEnvValue("AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES"),
    false
  );
  const getSelectionOverrideValue = (name) =>
    allowProcessEmbeddingOverrides ? normalizeString(getProcessEnvValue(name)) : "";

  const loaded = loadRuntimeConfig(rootPath);
  const embeddings = isPlainObject(loaded.data.embeddings) ? loaded.data.embeddings : {};
  const providers = isPlainObject(embeddings.providers) ? embeddings.providers : {};
  const profiles = isPlainObject(embeddings.profiles) ? embeddings.profiles : {};

  const requestedProfileName = getSelectionOverrideValue("AI_MEMORY_EMBED_PROFILE");
  const configuredProfileName = normalizeString(embeddings.activeProfile);
  const resolvedProfile = resolveNamedRegistryEntry(profiles, [requestedProfileName, configuredProfileName]);
  const profileConfig = isPlainObject(resolvedProfile.config) ? resolvedProfile.config : {};

  const requestedProviderName = getSelectionOverrideValue("AI_MEMORY_EMBED_PROVIDER");
  const profileProviderName = normalizeString(profileConfig.provider);
  const configuredProviderName = normalizeString(embeddings.activeProvider);
  const resolvedProvider = resolveNamedRegistryEntry(providers, [
    requestedProviderName,
    profileProviderName,
    configuredProviderName,
  ]);
  const providerConfig = isPlainObject(resolvedProvider.config) ? resolvedProvider.config : {};

  const mergedConfig = mergeConfigBlocks(
    extractEmbeddingDefaults(embeddings),
    providerConfig,
    profileConfig
  );

  const adapter =
    normalizeEmbeddingAdapter(getSelectionOverrideValue("AI_MEMORY_EMBED_ADAPTER")) ||
    normalizeEmbeddingAdapter(getSelectionOverrideValue("AI_MEMORY_EMBED_BACKEND")) ||
    normalizeEmbeddingAdapter(mergedConfig.adapter) ||
    normalizeEmbeddingAdapter(mergedConfig.backend) ||
    normalizeEmbeddingAdapter(defaults.adapter) ||
    normalizeEmbeddingAdapter(defaults.backend) ||
    "hash";
  const usesApiKey = adapter === "openai-compatible" || adapter === "gemini";

  const apiKeyEnv =
    normalizeString(getProcessEnvValue("AI_MEMORY_EMBED_API_KEY_ENV")) ||
    normalizeString(mergedConfig.apiKeyEnv) ||
    normalizeString(defaults.apiKeyEnv);
  const directApiKey = usesApiKey ? normalizeString(getEnvValue("AI_MEMORY_EMBED_API_KEY")) : "";
  const indirectApiKey = usesApiKey && apiKeyEnv ? normalizeString(getEnvValue(apiKeyEnv)) : "";
  const configuredApiKey = usesApiKey ? normalizeString(mergedConfig.apiKey) || normalizeString(defaults.apiKey) : "";

  let resolutionMode = "legacy-base";
  if (resolvedProfile.name && resolvedProvider.name) {
    resolutionMode = "profile-provider";
  } else if (resolvedProvider.name) {
    resolutionMode = "provider-direct";
  } else if (resolvedProfile.name) {
    resolutionMode = "legacy-profile-inline";
  }

  return {
    configPath: loaded.configPath,
    configExists: loaded.exists,
    configError: loaded.error,
    resolutionMode,
    profileName: resolvedProfile.name,
    providerName: resolvedProvider.name,
    availableProfiles: Object.keys(profiles),
    availableProviders: Object.keys(providers),
    adapter,
    backend: adapter,
    model:
      getSelectionOverrideValue("AI_MEMORY_EMBED_MODEL") ||
      normalizeString(mergedConfig.model) ||
      normalizeString(defaults.model),
    baseUrl:
      getSelectionOverrideValue("AI_MEMORY_EMBED_BASE_URL") ||
      normalizeString(mergedConfig.baseUrl) ||
      normalizeString(defaults.baseUrl),
    apiKeyEnv,
    apiKey: directApiKey || indirectApiKey || configuredApiKey,
    timeoutMs: normalizeInteger(
      getSelectionOverrideValue("AI_MEMORY_EMBED_TIMEOUT_MS") || mergedConfig.timeoutMs,
      normalizeInteger(defaults.timeoutMs, 120000, 1000),
      1000
    ),
    requestDelayMs: normalizeInteger(
      getSelectionOverrideValue("AI_MEMORY_EMBED_REQUEST_DELAY_MS") ||
        getSelectionOverrideValue("AI_MEMORY_EMBED_DELAY_MS") ||
        mergedConfig.requestDelayMs ||
        mergedConfig.delayMs,
      normalizeInteger(defaults.requestDelayMs, 0, 0),
      0
    ),
    batchSize: normalizeInteger(
      getSelectionOverrideValue("AI_MEMORY_EMBED_BATCH_SIZE") || mergedConfig.batchSize,
      normalizeInteger(defaults.batchSize, 0, 0),
      0
    ),
    allowBatchFallback: normalizeBoolean(
      getSelectionOverrideValue("AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK") || mergedConfig.allowBatchFallback,
      normalizeBoolean(defaults.allowBatchFallback, false)
    ),
    processEmbeddingOverridesAllowed: allowProcessEmbeddingOverrides,
  };
}

function describeConfigEntry(config) {
  if (!isPlainObject(config)) {
    return "";
  }

  return (
    normalizeString(config.description) ||
    normalizeString(config.label) ||
    normalizeString(config.notes) ||
    normalizeString(config.name)
  );
}

function sanitizeRuntimeSummary(runtime) {
  return {
    configPath: runtime.configPath,
    configExists: Boolean(runtime.configExists),
    configError: runtime.configError || "",
    resolutionMode: runtime.resolutionMode || "",
    profileName: runtime.profileName || "",
    providerName: runtime.providerName || "",
    availableProfiles: Array.isArray(runtime.availableProfiles) ? runtime.availableProfiles : [],
    availableProviders: Array.isArray(runtime.availableProviders) ? runtime.availableProviders : [],
    adapter: runtime.adapter || runtime.backend || "hash",
    backend: runtime.backend || runtime.adapter || "hash",
    model: runtime.model || "",
    baseUrl: runtime.baseUrl || "",
    apiKeyEnv: runtime.apiKeyEnv || "",
    apiKeyConfigured: Boolean(runtime.apiKey),
    processEmbeddingOverridesAllowed: Boolean(runtime.processEmbeddingOverridesAllowed),
    timeoutMs: runtime.timeoutMs || 0,
    requestDelayMs: runtime.requestDelayMs || 0,
    batchSize: runtime.batchSize || 0,
    allowBatchFallback: Boolean(runtime.allowBatchFallback),
  };
}

function buildEmbeddingRuntimeCatalog(options = {}) {
  const rootPath = normalizeString(options.rootPath || "");
  const defaults = isPlainObject(options.defaults) ? options.defaults : {};
  const getEnvValue =
    typeof options.getEnvValue === "function"
      ? options.getEnvValue
      : (name) => normalizeString(process.env[name] || "");
  const loaded = loadRuntimeConfig(rootPath);
  const data = isPlainObject(loaded.data) ? loaded.data : {};
  const embeddings = isPlainObject(data.embeddings) ? data.embeddings : {};
  const providers = isPlainObject(embeddings.providers) ? embeddings.providers : {};
  const profiles = isPlainObject(embeddings.profiles) ? embeddings.profiles : {};
  const defaultsBlock = mergeConfigBlocks(defaults, extractEmbeddingDefaults(embeddings));
  const runtime = resolveEmbeddingRuntime({ rootPath, defaults, getEnvValue });
  const warnings = [];

  const providerList = Object.entries(providers).map(([name, config]) => {
    const providerConfig = isPlainObject(config) ? config : {};
    const merged = mergeConfigBlocks(defaultsBlock, providerConfig);
    return {
      name,
      selected: runtime.providerName === name,
      enabled: providerConfig.enabled !== false,
      adapter:
        normalizeEmbeddingAdapter(merged.adapter) ||
        normalizeEmbeddingAdapter(merged.backend) ||
        normalizeEmbeddingAdapter(defaultsBlock.adapter) ||
        "hash",
      model: normalizeString(merged.model) || normalizeString(defaultsBlock.model),
      baseUrl: normalizeString(merged.baseUrl) || normalizeString(defaultsBlock.baseUrl),
      apiKeyEnv: normalizeString(merged.apiKeyEnv) || normalizeString(defaultsBlock.apiKeyEnv),
      description: describeConfigEntry(providerConfig),
    };
  });

  const profileList = Object.entries(profiles).map(([name, config]) => {
    const profileConfig = isPlainObject(config) ? config : {};
    const providerName = normalizeString(profileConfig.provider);
    const providerConfig = providerName && isPlainObject(providers[providerName]) ? providers[providerName] : {};
    const merged = mergeConfigBlocks(defaultsBlock, providerConfig, profileConfig);

    if (providerName && !isPlainObject(providers[providerName])) {
      warnings.push(`profile-missing-provider:${name}:${providerName}`);
    }

    return {
      name,
      selected: runtime.profileName === name,
      enabled: profileConfig.enabled !== false,
      provider: providerName,
      providerExists: !providerName || isPlainObject(providers[providerName]),
      adapter:
        normalizeEmbeddingAdapter(merged.adapter) ||
        normalizeEmbeddingAdapter(merged.backend) ||
        normalizeEmbeddingAdapter(defaultsBlock.adapter) ||
        "hash",
      model: normalizeString(merged.model) || normalizeString(defaultsBlock.model),
      baseUrl: normalizeString(merged.baseUrl) || normalizeString(defaultsBlock.baseUrl),
      apiKeyEnv: normalizeString(merged.apiKeyEnv) || normalizeString(defaultsBlock.apiKeyEnv),
      requestDelayMs: normalizeInteger(
        merged.requestDelayMs || merged.delayMs,
        normalizeInteger(defaultsBlock.requestDelayMs, 0, 0),
        0
      ),
      batchSize: normalizeInteger(merged.batchSize, normalizeInteger(defaultsBlock.batchSize, 0, 0), 0),
      allowBatchFallback: normalizeBoolean(
        merged.allowBatchFallback,
        normalizeBoolean(defaultsBlock.allowBatchFallback, false)
      ),
      description: describeConfigEntry(profileConfig),
    };
  });

  return {
    configPath: loaded.configPath,
    configExists: Boolean(loaded.exists),
    configError: loaded.error || "",
    activeProfile: normalizeString(embeddings.activeProfile),
    activeProvider: normalizeString(embeddings.activeProvider),
    defaults: {
      adapter:
        normalizeEmbeddingAdapter(defaultsBlock.adapter) ||
        normalizeEmbeddingAdapter(defaultsBlock.backend) ||
        "hash",
      model: normalizeString(defaultsBlock.model),
      baseUrl: normalizeString(defaultsBlock.baseUrl),
      apiKeyEnv: normalizeString(defaultsBlock.apiKeyEnv),
      timeoutMs: normalizeInteger(defaultsBlock.timeoutMs, 0, 0),
      requestDelayMs: normalizeInteger(defaultsBlock.requestDelayMs, 0, 0),
      batchSize: normalizeInteger(defaultsBlock.batchSize, 0, 0),
      allowBatchFallback: normalizeBoolean(defaultsBlock.allowBatchFallback, false),
    },
    runtime: sanitizeRuntimeSummary(runtime),
    providers: providerList,
    profiles: profileList,
    warnings,
  };
}

function updateEmbeddingRuntimeSelection(options = {}) {
  const rootPath = normalizeString(options.rootPath || "");
  const defaults = isPlainObject(options.defaults) ? options.defaults : {};
  const getEnvValue =
    typeof options.getEnvValue === "function"
      ? options.getEnvValue
      : (name) => normalizeString(process.env[name] || "");
  const loaded = loadRuntimeConfig(rootPath);
  if (loaded.exists && loaded.error) {
    throw new Error(`runtime-config-invalid:${loaded.error}`);
  }

  const nextData = cloneJsonValue(loaded.data);
  if (!isPlainObject(nextData.embeddings)) {
    nextData.embeddings = {};
  }
  const embeddings = nextData.embeddings;
  const providers = isPlainObject(embeddings.providers) ? embeddings.providers : {};
  const profiles = isPlainObject(embeddings.profiles) ? embeddings.profiles : {};

  const requestedProfile = normalizeString(options.profile || options.activeProfile);
  const requestedProvider = normalizeString(options.provider || options.activeProvider);
  const clearProfile = normalizeBoolean(options.clearProfile, false);
  const clearProvider = normalizeBoolean(options.clearProvider, false);

  if (!requestedProfile && !requestedProvider && !clearProfile && !clearProvider) {
    throw new Error("embedding-selection-update-requires-profile-provider-or-clear-flag");
  }
  if (requestedProfile && !isPlainObject(profiles[requestedProfile])) {
    throw new Error(`unknown-embedding-profile:${requestedProfile}`);
  }
  if (requestedProvider && !isPlainObject(providers[requestedProvider])) {
    throw new Error(`unknown-embedding-provider:${requestedProvider}`);
  }

  const previous = {
    activeProfile: normalizeString(embeddings.activeProfile),
    activeProvider: normalizeString(embeddings.activeProvider),
  };

  if (requestedProfile) {
    embeddings.activeProfile = requestedProfile;
  } else if (clearProfile || requestedProvider) {
    delete embeddings.activeProfile;
  }

  if (requestedProvider) {
    embeddings.activeProvider = requestedProvider;
  } else if (requestedProfile) {
    const profileProvider = normalizeString(profiles[requestedProfile].provider);
    if (profileProvider) {
      embeddings.activeProvider = profileProvider;
    } else {
      delete embeddings.activeProvider;
    }
  } else if (clearProvider || clearProfile) {
    delete embeddings.activeProvider;
  }

  const configPath = writeRuntimeConfig(rootPath, nextData);
  const catalog = buildEmbeddingRuntimeCatalog({ rootPath, defaults, getEnvValue });
  return {
    ok: true,
    configPath,
    previous,
    current: {
      activeProfile: normalizeString(catalog.activeProfile),
      activeProvider: normalizeString(catalog.activeProvider),
    },
    runtime: catalog.runtime,
    catalog,
  };
}

module.exports = {
  buildEmbeddingRuntimeCatalog,
  loadRuntimeConfig,
  normalizeEmbeddingAdapter,
  resolveEmbeddingRuntime,
  resolveRuntimeConfigPath,
  updateEmbeddingRuntimeSelection,
  writeRuntimeConfig,
};
