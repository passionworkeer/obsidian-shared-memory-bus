/**
 * bus/shared-crypto.js
 * Shared cryptographic utilities used across multiple bus modules.
 */

const crypto = require("crypto");

/**
 * Build a short (16-char hex) config hash from embedding backend parameters.
 * Used to detect when the embedding configuration changes and the index needs rebuilding.
 *
 * @param {{ backend: string, modelName: string, baseUrl?: string }} cfg
 * @returns {string} SHA-1 slice (16 hex chars)
 */
function buildEmbeddingConfigHash({ backend, modelName, baseUrl = "" }) {
  // Normalize backend name using the same adapter logic as embedding-provider-registry
  const normalizedBackend = normalizeEmbeddingAdapter(backend, modelName);
  const normalizedBaseUrl =
    normalizedBackend === "openai-compatible" ? String(baseUrl || "").trim().replace(/\/+$/, "") : "";
  const payload = JSON.stringify({
    backend: normalizedBackend,
    model: String(modelName || "").trim(),
    baseUrl: normalizedBaseUrl.toLowerCase(),
  });
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeString(value) {
  return String(value || "").trim();
}

/**
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
function normalizeEmbeddingAdapter(value, fallback = "") {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return normalizeString(fallback).toLowerCase();
  }
  if (normalized === "openai") return "openai-compatible";
  if (normalized === "hashing") return "hash";
  if (normalized === "sentence-transformer" || normalized === "sentence-transformers") return "transformer";
  return normalized;
}

module.exports = {
  buildEmbeddingConfigHash,
  normalizeString,
  normalizeEmbeddingAdapter,
};
