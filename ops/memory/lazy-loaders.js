// ops/memory/lazy-loaders.js
// Lazy module loaders for entity extraction and knowledge graph ingestion.
// Extracted from memory-layers-parse.js. Both functions return either the
// real module (when present) or a stub with the same shape (when missing)
// so callers can use the API uniformly.

import { STORE_ROOT } from "./paths-and-io.js";

/** @returns {Promise<{ extractFromRecord: (r: object) => object }>} */
async function loadEntityExtractor() {
  try {
    const moduleUrl = new URL("../entity/entity-extractor.js", import.meta.url);
    const mod = await import(moduleUrl.href);
    return mod.default || mod;
  } catch (error) {
    return {
      available: false,
      error: String(error?.message || error),
      extractFromRecord: (r) => r,
    };
  }
}

/** @returns {Promise<{ ingestRecord: (r: object) => void, close: () => void }>} */
async function loadKnowledgeGraph() {
  try {
    const moduleUrl = new URL("../knowledge/knowledge-graph.js", import.meta.url);
    const { KnowledgeGraph } = await import(moduleUrl.href);
    return new KnowledgeGraph({ storeRoot: STORE_ROOT });
  } catch (error) {
    return {
      available: false,
      error: String(error?.message || error),
      ingestRecord: () => {},
      beginBatch: () => {},
      endBatch: () => {},
      close: () => {},
      stats: () => ({ entities: 0, triples: 0, currentFacts: 0, expiredFacts: 0 }),
    };
  }
}

export { loadEntityExtractor, loadKnowledgeGraph };
