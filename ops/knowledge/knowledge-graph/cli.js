// ops/knowledge/knowledge-graph/cli.js
//
// CLI entry point for ops/knowledge/knowledge-graph.js.
// Executed when the module is run directly via `node knowledge-graph.js`.

import path from "node:path";
import { KnowledgeGraph } from "./class-core.js";
import { attachQueryMethods } from "./methods.js";

// Attach query methods to prototype before CLI usage
attachQueryMethods(KnowledgeGraph);

const __filename = path.resolve(process.argv[1] || "");
const isDirectRun = process.argv[1] && __filename.endsWith("knowledge-graph.js");

export function runCli() {
  if (!isDirectRun) return;

  const [,, action, ...args] = process.argv;
  const storeRoot =
    process.env.AI_MEMORY_STORE ||
    process.env.AI_MEMORY_STORE_ROOT ||
    process.env.AI_MEMORY_ROOT ||
    path.join(process.env.USERPROFILE || process.env.HOME || "", ".ai-memory");

  const kg = new KnowledgeGraph({ storeRoot });

  try {
    switch (action) {
      case "add": {
        const [subject, predicate, object] = args;
        if (!subject || !predicate || !object) {
          console.error("Usage: node knowledge-graph.js add <subject> <predicate> <object> [--valid-from YYYY-MM-DD] [--source-scope project|shared|archive]");
          process.exit(1);
        }
        const vfIdx    = args.indexOf("--valid-from");
        const validFrom = vfIdx >= 0 ? args[vfIdx + 1] : null;
        const ssIdx    = args.indexOf("--source-scope");
        const sourceScope = ssIdx >= 0 ? args[ssIdx + 1] : "project";
        const tid = kg.addTriple(subject, predicate, object, { validFrom, sourceScope });
        console.log(`Added: ${subject} --${predicate}--> ${object}  [${tid}]`);
        break;
      }
      case "upsert": {
        const [subject, predicate, object] = args;
        if (!subject || !predicate || !object) {
          console.error("Usage: node knowledge-graph.js upsert <subject> <predicate> <object>");
          process.exit(1);
        }
        const tid = kg.upsertTriple(subject, predicate, object);
        console.log(`Upserted: ${subject} --${predicate}--> ${object}  [${tid}]`);
        break;
      }
      case "query": {
        const [name] = args;
        if (!name) { console.error("Usage: node knowledge-graph.js query <name>"); process.exit(1); }
        const results = kg.queryEntity(name);
        console.log(`\n=== ${name} (${results.length} relationships) ===`);
        for (const r of results) {
          const tag = r.current ? " [current]" : ` [expired ${r.valid_to}]`;
          console.log(`  [${r.direction}] ${r.subject} --${r.predicate}--> ${r.object}${tag}`);
        }
        break;
      }
      case "stats": {
        console.log(JSON.stringify(kg.stats(), null, 2));
        break;
      }
      case "timeline": {
        console.log(JSON.stringify(kg.timeline(args[0] || undefined), null, 2));
        break;
      }
      case "invalidate": {
        const [subject, predicate, object, ended] = args;
        kg.invalidate(subject, predicate, object, ended);
        console.log(`Invalidated: ${subject} --${predicate}--> ${object}`);
        break;
      }
      case "search": {
        const [query] = args;
        if (!query) { console.error("Usage: node knowledge-graph.js search <name>"); process.exit(1); }
        const results = kg.searchEntities(query);
        console.log(`Found ${results.length} entities:`);
        for (const e of results) console.log(`  ${e.name} [${e.type}]`);
        break;
      }
      default:
        console.error("Actions: add | upsert | query | stats | timeline | invalidate | search");
        process.exit(1);
    }
  } finally {
    kg.close();
  }
}