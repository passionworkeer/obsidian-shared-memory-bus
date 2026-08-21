// ops/memory/lazy-loaders.js
// Lazy module loaders for entity extraction and knowledge graph ingestion.
// Extracted from memory-layers-parse.js. Both functions return either the
// real module (when present) or a stub with the same shape (when missing)
// so callers can use the API uniformly.
//
// F3.4: each loader is cached at module scope so repeat calls within a
// single Node process share one dynamic import + one constructor (instead
// of paying both costs per call). Cross-process (CLI restart) still pays
// startup cost — that requires a persistent worker, out of scope here.

import { STORE_ROOT } from "./paths-and-io.js";

// Module-level cache: store the Promise, not the resolved value, so
// concurrent callers share the same in-flight import and we never expose
// a half-resolved stub.
let entityExtractorPromise = null;
let knowledgeGraphPromise = null;

/** @returns {Promise<{ extractFromRecord: (r: object) => object }>} */
function loadEntityExtractor() {
  if (entityExtractorPromise) return entityExtractorPromise;
  entityExtractorPromise = (async () => {
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
  })();
  return entityExtractorPromise;
}

/** @returns {Promise<{ ingestRecord: (r: object) => void, close: () => void }>} */
function loadKnowledgeGraph() {
  if (knowledgeGraphPromise) return knowledgeGraphPromise;
  knowledgeGraphPromise = (async () => {
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
  })();
  return knowledgeGraphPromise;
}

// Test-only escape hatches — do not call from production code.
export function __resetLazyLoaderCache() {
  entityExtractorPromise = null;
  knowledgeGraphPromise = null;
}

export { loadEntityExtractor, loadKnowledgeGraph };
