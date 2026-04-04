/**
 * Canonical FNV-1a32 LSH feature extraction for the shared memory bus.
 *
 * This module is the single source of truth for the feature extraction
 * algorithm on the Node.js side. The same algorithm is mirrored in
 * retrieval/lsh_utils.py — any change here must be synced to that file.
 *
 * VECTOR_SCHEMA_VERSION tracks the feature generation algorithm.
 * When the algorithm changes, increment this version and trigger a
 * full embeddings rebuild so all stored vectors use the same fingerprint.
 */

/** @type {number} */
const VECTOR_SCHEMA_VERSION = 1;

/**
 * Normalize whitespace: collapse runs of whitespace to a single space,
 * then trim leading/trailing spaces.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeSpaces(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * FNV-1a32 hash — returns an unsigned 32-bit integer.
 *
 * @param {string} input
 * @returns {number}
 */
function fnv1a32(input) {
  let hash = 0x811c9dc5;
  const text = String(input || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Extract LSH features from text using the 'hashing-v1' scheme.
 *
 * Feature types
 * -------------
 * w:<token>   Alphanumeric word/URL token (lowercased).
 * c:<chars>   CJK 2+-character run.
 * c2:<bigram> 2-char CJK bigram.
 * c3:<trigram> 3-char CJK trigram.
 * g3:<ngram>  3-char sliding ngram over compact (non-whitespace) text.
 * raw:<text>  Fallback raw compact text when no other features fire.
 *
 * @param {string} text
 * @returns {string[]} New array on every call — pure, no side effects.
 */
function buildHashFeatures(text) {
  const source = normalizeSpaces(text).toLowerCase();
  const features = [];
  const compact = source.replace(/\s+/g, "");

  for (const token of source.match(/[a-z0-9][a-z0-9_\-./:]{1,}/g) || []) {
    features.push(`w:${token}`);
  }

  for (const chunk of source.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    features.push(`c:${chunk}`);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      features.push(`c2:${chunk.slice(index, index + 2)}`);
    }
    for (let index = 0; index < chunk.length - 2; index += 1) {
      features.push(`c3:${chunk.slice(index, index + 3)}`);
    }
  }

  const maxGramCount = Math.max(0, Math.min(compact.length - 2, 400));
  for (let index = 0; index < maxGramCount; index += 1) {
    features.push(`g3:${compact.slice(index, index + 3)}`);
  }

  if (features.length === 0 && compact) {
    features.push(`raw:${compact}`);
  }
  return features;
}

/**
 * Build a dense hash embedding vector from raw text.
 *
 * @param {string} text
 * @param {number} [dimension=384]
 * @returns {number[]} Normalized vector (L2-normalized, 8 decimal places).
 */
function buildHashEmbedding(text, dimension = 384) {
  const vector = new Array(dimension).fill(0);
  for (const feature of buildHashFeatures(text)) {
    const hash = fnv1a32(feature);
    const slot = hash % dimension;
    const sign = ((hash >>> 1) & 1) === 0 ? 1 : -1;
    vector[slot] += sign;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] = Number((vector[index] / norm).toFixed(8));
    }
  }
  return vector;
}

module.exports = {
  VECTOR_SCHEMA_VERSION,
  normalizeSpaces,
  fnv1a32,
  buildHashFeatures,
  buildHashEmbedding,
};
