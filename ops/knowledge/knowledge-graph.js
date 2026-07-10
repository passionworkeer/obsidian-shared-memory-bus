// ops/knowledge/knowledge-graph.js
//
// Re-export shim for the knowledge-graph module. The implementation lives
// in ./knowledge-graph/{db,class-core,methods,cli}.js. External callers
// continue to import { KnowledgeGraph, entityId, resolveKgPath } from this
// top-level path for backward compatibility.
//
// Uses Node.js built-in `node:sqlite` (v22.5+) — no external dependencies.
// Storage: SQLite at AI_MEMORY_ROOT/kg/knowledge-graph.sqlite3
//
// Usage (standalone):
//   node knowledge-graph.js add "Alice" "works_on" "MemPalace" --valid-from 2026-01-01
//   node knowledge-graph.js query "Alice"
//   node knowledge-graph.js stats
//
// Usage (as module):
//   import { KnowledgeGraph, entityId, resolveKgPath } from './ops/knowledge/knowledge-graph.js';
//   const kg = new KnowledgeGraph({ vaultRoot });
//   kg.addTriple('Alice', 'uses', 'MemPalace');
//   const results = kg.queryEntity('Alice');

import { fileURLToPath } from "node:url";
import path from "node:path";
import { KnowledgeGraph } from "./knowledge-graph/class-core.js";
import { entityId, resolveKgPath } from "./knowledge-graph/db.js";
import { attachQueryMethods } from "./knowledge-graph/methods.js";
import { runCli } from "./knowledge-graph/cli.js";

// Attach query methods to the prototype before any external usage
attachQueryMethods(KnowledgeGraph);

export { KnowledgeGraph, entityId, resolveKgPath };

// Trigger CLI if run directly
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  runCli();
}