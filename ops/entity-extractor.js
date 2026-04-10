/**
 * ops/entity-extractor.js
 * =======================
 * Lightweight entity extraction for memory records.
 *
 * Two-pass approach (inspired by MemPalace's entity_detector.py):
 *   Pass 1: Scan text, extract entity candidates with frequency + signal patterns
 *   Pass 2: Score and classify each candidate as person / project / concept
 *
 * Output: structured facts[] and concepts[] attached to each record.
 * Input:  raw content string or memory record object.
 *
 * No external dependencies — pure regex + heuristics.
 * Designed for Node.js 18+ (no ESM-only features).
 *
 * Usage (standalone):
 *   node entity-extractor.js extract "Alice said the project uses Postgres"
 *   node entity-extractor.js extract-file <path-to-jsonl>
 *
 * Usage (as module):
 *   const { extractEntities, extractFromRecord, extractEntitiesFromRecords } = require('./ops/entity-extractor')
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const STOPWORDS = new Set([
  // Pronouns / articles
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by","from","as",
  "is","was","are","were","be","been","being","have","has","had","do","does","did",
  "will","would","could","should","may","might","must","shall","can","this","that",
  "these","those","it","its","they","them","their","we","our","you","your","i","my","me",
  "he","she","his","her","who","what","when","where","why","how","which","if","then",
  "so","not","no","yes","ok","okay","just","really","very","also","already","still","even",
  "only","here","there","now","too","up","out","about","like","use","get","got","make",
  "made","take","put","come","go","see","know","think","true","false","none","new","old",
  "all","any","some","every","each","more","less","next","last","first","second",
  // Programming keywords
  "return","print","def","class","import","from","function","const","let","var","async",
  "await","try","catch","throw","finally","switch","case","break","continue","while",
  "for","if","else","elif","else","yield","raise","pass","global","nonlocal","lambda",
  "static","public","private","protected","final","abstract","extends","implements",
  "void","null","undefined","true","false","typeof","instanceof",
  // Common prose filler words
  "step","usage","run","check","find","add","set","list","args","dict","str","int","bool",
  "path","file","name","note","example","option","result","error","warning","info",
  "returns","raises","yields","self","cls","kwargs","kwargs","args","arg","args",
  "item","key","value","type","type","type",
  // Abstract nouns that appear as subjects but aren't entities
  "system","system","agent","agents","tool","tools","memory","memory","model","models",
  "network","networks","training","inference","data","data","content","content",
  "thing","things","way","ways","time","times","day","days","part","parts","point","points",
  "idea","ideas","fact","facts","sense","question","answer","reason","number","version",
  "people","person","something","nothing","everything","anything","someone","everyone",
  // Tech-abstract that are too generic
  "stack","layer","mode","test","stop","start","copy","move","source","target",
  "output","outputs","input","inputs","records","record","entry","entries",
  // Greetings / filler
  "hey","hi","hello","thanks","thank","right","let",
]);

// Person signals — things people say/do (formatted strings, {name} replaced at runtime)
const PERSON_VERB_PATTERNS = [
  "{name} said", "{name} told", "{name} asked", "{name} replied", "{name} wrote",
  "{name} thinks", "{name} believes", "{name} wants", "{name} knows",
  "{name} decided", "{name} prefers", "{name} told me",
  "hey {name}", "hi {name}", "dear {name}", "thanks {name}",
];

// Project signals — things projects have/do
const PROJECT_VERB_PATTERNS = [
  "building {name}", "built {name}", "ship {name}", "shipped {name}",
  "deploy {name}", "deployed {name}", "install {name}", "installed {name}",
  "the {name} architecture", "the {name} system", "the {name} pipeline",
  "{name} v", "{name} v1", "{name} v2", "the {name} repo",
  "{name}.py", "{name}.js", "{name}.ts", "{name}.go",
  "{name}-core", "{name}-local", "{name}-server",
  "pip install {name}", "npm install {name}",
];

// Relationship predicate extraction patterns
// Matches patterns like: "Alice is the author of X" → { subject: "Alice", predicate: "is_author_of", object: "X" }
const RELATIONSHIP_PATTERNS = [
  // [regex, predicate_template]
  [/(\w+)\s+(?:is|are)\s+(?:the\s+)?(\w+)\s+of\s+(.+)/i, "{1}_is_{2}_of"],
  [/(\w+)\s+(?:is|are)\s+(?:a|an)\s+(\w+)/i, "{1}_is_{2}"],
  [/(\w+)\s+(?:uses|using|used)\s+(\w+)/i, "{1}_uses_{2}"],
  [/(\w+)\s+(?:built|building|creates?)\s+(\w+)/i, "{1}_builds_{2}"],
  [/(\w+)\s+(?:owns?|owning)\s+(\w+)/i, "{1}_owns_{2}"],
  [/(\w+)\s+(?:works? on|working on)\s+(\w+)/i, "{1}_works_on_{2}"],
  [/(\w+)\s+(?:depends? on|depends on)\s+(\w+)/i, "{1}_depends_on_{2}"],
  [/(\w+)\s+(?:calls? |calls)\s+(\w+)/i, "{1}_calls_{2}"],
];

// ---------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------

/**
 * Extract all capitalized proper noun candidates from text.
 * Returns { name: frequency } for names appearing 2+ times.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
function extractCandidates(text) {
  /** @type {Map<string, number>} */
  const counts = new Map();

  // Single-word proper nouns: "Alice", "MemPalace", "NodeJS"
  const singleWords = text.match(/\b([A-Z][a-zA-Z0-9]{1,24})\b/g) || [];
  for (const word of singleWords) {
    if (!STOPWORDS.has(word.toLowerCase()) && word.length > 1) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }

  // Multi-word proper nouns: "Memory Palace", "Claude Code", "Open AI"
  const multiWords = text.match(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,4})\b/g) || [];
  for (const phrase of multiWords) {
    const words = phrase.split(/\s+/);
    if (!words.some(w => STOPWORDS.has(w.toLowerCase()))) {
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }

  // Filter: must appear at least 2 times
  const candidates = new Map();
  for (const [name, count] of counts) {
    if (count >= 2) candidates.set(name, count);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Signal scoring
// ---------------------------------------------------------------------------

/**
 * Score a candidate entity as person vs project vs concept.
 * Returns scores and signals that fired.
 *
 * @param {string} name
 * @param {string} text  - full normalized text
 * @param {string[]} [lines] - optional pre-split lines
 * @returns {{ person_score: number, project_score: number, concept_score: number,
 *             person_signals: string[], project_signals: string[], concept_signals: string[] }}
 */
function scoreEntity(name, text, lines) {
  const lower = name.toLowerCase();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let personScore = 0;
  let projectScore = 0;
  let conceptScore = 0;
  /** @type {string[]} */
  const personSignals = [];
  /** @type {string[]} */
  const projectSignals = [];
  /** @type {string[]} */
  const conceptSignals = [];

  // --- Person signals ---
  for (const pattern of PERSON_VERB_PATTERNS) {
    const rx = new RegExp(pattern.replace("{name}", escaped), "gi");
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      personScore += matches * 2;
      personSignals.push(`"${name}" ${pattern.split("{name}")[1]} (${matches}x)`);
    }
  }

  // Direct address: "hey Alice" / "hi Alice"
  const directRx = new RegExp(`\\b(hey|hi|hello|dear|thanks)\\s+${escaped}\\b`, "gi");
  const directMatches = (text.match(directRx) || []).length;
  if (directMatches > 0) {
    personScore += directMatches * 3;
    personSignals.push(`direct address (${directMatches}x)`);
  }

  // Quoted speech near the name
  const quoteRx = new RegExp(`["']${escaped}["']\\s*,?\\s*(said|told|asked|replied|whispered)`, "gi");
  const quoteMatches = (text.match(quoteRx) || []).length;
  if (quoteMatches > 0) {
    personScore += quoteMatches * 2;
    personSignals.push(`quoted speech marker (${quoteMatches}x)`);
  }

  // --- Project signals ---
  for (const pattern of PROJECT_VERB_PATTERNS) {
    const rx = new RegExp(pattern.replace("{name}", escaped), "gi");
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      projectScore += matches * 2;
      projectSignals.push(`"${pattern.split("{name}")[1]}" (${matches}x)`);
    }
  }

  // Versioned / hyphenated references: "MemPalace v2", "obsidian-core"
  const versionRx = new RegExp(`\\b${escaped}[-v]\\w+`, "gi");
  const versionMatches = (text.match(versionRx) || []).length;
  if (versionMatches > 0) {
    projectScore += versionMatches * 3;
    projectSignals.push(`versioned/hyphenated ref (${versionMatches}x)`);
  }

  // Code file reference: "mempalace.py", "config.json"
  const codeRx = new RegExp(`\\b${escaped}\\.(py|js|ts|go|rs|java|cpp|c|h|css|html|json|yaml|yml|toml|sh|md)\\b`, "gi");
  const codeMatches = (text.match(codeRx) || []).length;
  if (codeMatches > 0) {
    projectScore += codeMatches * 3;
    projectSignals.push(`code file reference (${codeMatches}x)`);
  }

  // --- Concept signals ---
  // A term is a concept if it appears in definitional patterns
  const definitionRx = new RegExp(`\\b(${escaped})\\s+(?:is|means|refers to|describes?|represents?|defines?)\\b`, "gi");
  const defMatches = (text.match(definitionRx) || []).length;
  if (defMatches > 0) {
    conceptScore += defMatches * 4;
    conceptSignals.push(`definitional pattern (${defMatches}x)`);
  }

  // Appears in a list of topics / categories
  const listRx = new RegExp(`[-*]\\s*${escaped}\\b`, "gi");
  const listMatches = (text.match(listRx) || []).length;
  if (listMatches >= 2) {
    conceptScore += listMatches;
    conceptSignals.push(`listed as topic (${listMatches}x)`);
  }

  return {
    person_score: personScore,
    project_score: projectScore,
    concept_score: conceptScore,
    person_signals: personSignals.slice(0, 3),
    project_signals: projectSignals.slice(0, 3),
    concept_signals: conceptSignals.slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a scored candidate entity.
 *
 * @param {string} name
 * @param {number} frequency
 * @param {ReturnType<typeof scoreEntity>} scores
 * @returns {{ name: string, type: 'person'|'project'|'concept'|'uncertain',
 *             confidence: number, frequency: number, signals: string[] }}
 */
function classifyEntity(name, frequency, scores) {
  const ps = scores.person_score;
  const pjs = scores.project_score;
  const cs = scores.concept_score;
  const total = ps + pjs + cs;

  // Count distinct signal categories for person classification
  const personSignalCategories = new Set(scores.person_signals.map(s => s.split(" ")[0]));
  const hasMultiplePersonSignals = personSignalCategories.size >= 2;

  if (total === 0) {
    // Frequency-only candidate — low confidence uncertain
    return {
      name,
      type: "uncertain",
      confidence: Math.min(0.4, frequency / 30),
      frequency,
      signals: [`appears ${frequency}x, no strong type signals`],
    };
  }

  const personRatio = ps / total;
  const projectRatio = pjs / total;
  const conceptRatio = cs / total;

  if (personRatio >= 0.6 && hasMultiplePersonSignals && ps >= 4) {
    return {
      name,
      type: "person",
      confidence: Math.min(0.95, 0.5 + personRatio * 0.5),
      frequency,
      signals: scores.person_signals,
    };
  }
  if (projectRatio >= 0.6 && pjs >= 3) {
    return {
      name,
      type: "project",
      confidence: Math.min(0.95, 0.5 + projectRatio * 0.5),
      frequency,
      signals: scores.project_signals,
    };
  }
  if (conceptRatio >= 0.5 && cs >= 2) {
    return {
      name,
      type: "concept",
      confidence: Math.min(0.85, 0.5 + conceptRatio * 0.5),
      frequency,
      signals: scores.concept_signals,
    };
  }

  return {
    name,
    type: "uncertain",
    confidence: 0.3,
    frequency,
    signals: [...scores.person_signals, ...scores.project_signals, ...scores.concept_signals].slice(0, 3),
  };
}

// ---------------------------------------------------------------------------
// Relationship extraction
// ---------------------------------------------------------------------------

/**
 * Extract relationship triples from text using pattern matching.
 *
 * @param {string} text
 * @returns {{ subject: string, predicate: string, object: string, confidence: number }[]}
 */
function extractRelationships(text) {
  const triples = [];

  for (const [rx, predTemplate] of RELATIONSHIP_PATTERNS) {
    let match;
    const re = new RegExp(rx.source, "gi");
    while ((match = re.exec(text)) !== null) {
      const subject = match[1].trim();
      const object = (match[match.length - 1] || "").trim();
      if (!subject || !object || subject.length < 2 || object.length < 2) continue;

      // Build predicate from template
      const predicate = predTemplate
        .replace("{1}", subject.toLowerCase().replace(/\s+/g, "_"))
        .replace("{2}", (match[2] || "").toLowerCase().replace(/\s+/g, "_"));

      // Avoid obvious stopwords as subject/object
      if (STOPWORDS.has(subject.toLowerCase()) || STOPWORDS.has(object.toLowerCase())) continue;

      triples.push({
        subject,
        predicate,
        object,
        confidence: 0.7,
      });
    }
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Main extraction functions
// ---------------------------------------------------------------------------

/**
 * Extract entities + relationships from raw text.
 *
 * @param {string} text
 * @returns {{ entities: object[], facts: object[], concepts: object[] }}
 */
function extractEntities(text) {
  if (!text || text.trim().length < 10) {
    return { entities: [], facts: [], concepts: [] };
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  const lines = normalized.split(/\n/);
  const candidates = extractCandidates(normalized);

  if (candidates.size === 0) {
    return { entities: [], facts: [], concepts: [] };
  }

  /** @type {object[]} */
  const entities = [];
  /** @type {object[]} */
  const facts = [];
  /** @type {object[]} */
  const concepts = [];

  // Sort by frequency descending
  const sorted = [...candidates.entries()].sort((a, b) => b[1] - a[1]);

  for (const [name, frequency] of sorted) {
    const scores = scoreEntity(name, normalized, lines);
    const classified = classifyEntity(name, frequency, scores);

    entities.push({
      name: classified.name,
      type: classified.type,
      confidence: classified.confidence,
      frequency: classified.frequency,
      signals: classified.signals,
    });

    // Generate facts for high-confidence persons/projects
    if (classified.confidence >= 0.6 && classified.type !== "uncertain") {
      facts.push({
        value: `${classified.name} is a ${classified.type}`,
        entity_type: classified.type,
        confidence: classified.confidence,
      });
    }
  }

  // Extract relationship triples
  const triples = extractRelationships(normalized);
  for (const triple of triples) {
    facts.push({
      value: `${triple.subject} → ${triple.predicate} → ${triple.object}`,
      predicate: triple.predicate,
      subject: triple.subject,
      object: triple.object,
      confidence: triple.confidence,
    });
  }

  // Deduplicate facts by value
  const seenFacts = new Set();
  const uniqueFacts = facts.filter(f => {
    const key = typeof f === "string" ? f : f.value;
    if (seenFacts.has(key)) return false;
    seenFacts.add(key);
    return true;
  });

  // Concepts: medium-confidence terms that aren't persons/projects
  for (const entity of entities) {
    if (
      entity.type === "concept" ||
      (entity.type === "uncertain" && entity.confidence >= 0.25 && entity.frequency >= 3)
    ) {
      concepts.push({
        value: entity.name,
        confidence: entity.confidence,
      });
    }
  }

  // Deduplicate concepts
  const seenConcepts = new Set();
  const uniqueConcepts = concepts.filter(c => {
    const key = typeof c === "string" ? c : c.value;
    if (seenConcepts.has(key)) return false;
    seenConcepts.add(key);
    return true;
  });

  return {
    entities,
    facts: uniqueFacts.slice(0, 10),   // cap at 10 facts per record
    concepts: uniqueConcepts.slice(0, 5), // cap at 5 concepts per record
  };
}

/**
 * Extract from a single memory record object.
 * Reads record.content + record.title as source text.
 *
 * @param {object} record - memory record with at least `content` or `title` field
 * @returns {object} - record augmented with `entities`, `facts`, `concepts`
 */
function extractFromRecord(record) {
  const content = (record.content || record.text || "") + " " + (record.title || "");
  const { entities, facts, concepts } = extractEntities(content);

  return {
    ...record,
    entities: entities || [],
    facts: facts || [],
    concepts: concepts || [],
  };
}

/**
 * Process multiple records in batch.
 *
 * @param {object[]} records
 * @returns {object[]} - records augmented with entities/facts/concepts
 */
function extractEntitiesFromRecords(records) {
  return records.map(r => extractFromRecord(r));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 */
function cliExtract(text) {
  const result = extractEntities(text);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * @param {string} filePath
 */
async function cliExtractFile(filePath) {
  const fs = require("fs");
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim());
  const records = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const enriched = extractEntitiesFromRecords(records);
  for (const record of enriched) {
    if (record.facts?.length > 0 || record.concepts?.length > 0) {
      console.log(JSON.stringify(record, null, 2));
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  extractEntities,
  extractFromRecord,
  extractEntitiesFromRecords,
  scoreEntity,
  classifyEntity,
  extractRelationships,
  extractCandidates,
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [,, action, ...args] = process.argv;
  if (action === "extract" && args.length > 0) {
    cliExtract(args.join(" "));
  } else if (action === "extract-file" && args.length > 0) {
    cliExtractFile(args[0]);
  } else {
    console.error("Usage: node entity-extractor.js extract <text>");
    console.error("       node entity-extractor.js extract-file <path-to-jsonl>");
    process.exit(1);
  }
}
