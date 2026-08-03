// OpenAI-compatible embedding provider (fetch + retry + backoff).

import { DomainError, COMMON_CODES } from "../domain-error.js";
import { redactRemoteEmbeddingTexts } from "../redaction.js";
import { getProviderHost, normalizeString } from "./utils.js";

export function createOpenAICompatibleProvider({ fetchImpl, sleep }) {
  async function embedWithOpenAICompatible(texts, runtime) {
    const baseUrl = normalizeString(runtime.baseUrl).replace(/\/+$/, "");
    const apiKey = normalizeString(runtime.apiKey);
    const timeoutMs = Math.max(1000, Number(runtime.timeoutMs || 120000) || 120000);
    const requestDelayMs = Math.max(0, Number(runtime.requestDelayMs || 0) || 0);
    const maxRetries = Math.max(0, Number(runtime.maxRetries || 3) || 3);
    const safeTexts = redactRemoteEmbeddingTexts(texts);

    if (!baseUrl) {
      throw new DomainError(COMMON_CODES.INVALID_INPUT, "missing-openai-base-url");
    }
    if (!apiKey) {
      throw new DomainError(COMMON_CODES.INVALID_INPUT, "missing-openai-api-key");
    }
    if (typeof fetchImpl !== "function") {
      throw new DomainError(COMMON_CODES.INTERNAL, "fetch-unavailable");
    }

    if (requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        await sleep(delayMs);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: normalizeString(runtime.model),
            input: safeTexts,
            encoding_format: "float",
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          const error = new Error(`openai-compatible-http-${response.status}: ${detail.slice(0, 500)}`);
          const isRetryable = response.status === 429 || response.status >= 500;
          if (isRetryable && attempt < maxRetries) {
            lastError = error;
            clearTimeout(timeout);
            continue;
          }
          clearTimeout(timeout);
          throw error;
        }

        const payload = await response.json();
        const vectors = Array.isArray(payload.data)
          ? payload.data
              .slice()
              .sort((left, right) => (left.index || 0) - (right.index || 0))
              .map((item) => item.embedding)
          : [];

        if (vectors.length !== safeTexts.length) {
          throw new DomainError(
            COMMON_CODES.EXTERNAL_SERVICE,
            `openai-compatible-count-mismatch:${vectors.length}/${safeTexts.length}`,
          );
        }

        for (const vector of vectors) {
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new DomainError(COMMON_CODES.EXTERNAL_SERVICE, "openai-compatible-empty-vector");
          }
        }

        clearTimeout(timeout);
        return {
          backendName: "openai-compatible",
          modelName: normalizeString(runtime.model),
          vectors,
          providerHost: getProviderHost(baseUrl),
        };
      } catch (error) {
        lastError = error;
        const isRetryable = error.message && (error.message.includes("429") || error.message.includes("5"));
        if (!isRetryable || attempt >= maxRetries) {
          clearTimeout(timeout);
          throw error;
        }
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  return { embedWithOpenAICompatible };
}
