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
 *   import { extractEntities, extractFromRecord, extractEntitiesFromRecords } from './entity-extractor.js';
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { isCjkChar } from "../util/cjk-tokenize.js";

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
  "for","if","else","elif","yield","raise","pass","global","nonlocal","lambda",
  "static","public","private","protected","final","abstract","extends","implements",
  "void","null","undefined","typeof","instanceof",
  // Common prose filler words
  "step","usage","run","check","find","add","set","list","args","dict","str","int","bool",
  "path","file","name","note","example","option","result","error","warning","info",
  "returns","raises","yields","self","cls","kwargs","arg",
  "item","key","value","type",
  // Abstract nouns that appear as subjects but aren't entities
  "system","agent","agents","tool","tools","memory","model","models",
  "network","networks","training","inference","data","content",
  "thing","things","way","ways","time","times","day","days","part","parts","point","points",
  "idea","ideas","fact","facts","sense","question","answer","reason","number","version",
  "people","person","something","nothing","everything","anything","someone","everyone",
  // Tech-abstract that are too generic
  "stack","layer","mode","test","stop","start","copy","move","source","target",
  "output","outputs","input","inputs","records","record","entry","entries",
  // Greetings / filler
  "hey","hi","hello","thanks","thank","right","let",
  // Common Chinese stopwords
  "的","是","在","有","我","你","他","她","它","了","和","与","及","或","不","这","那",
  "也","还","又","就","但","而","则","因","所","以","为","于","上","下","中","后","前",
  "里","外","之","其","并","觉","得","能","会","可","要","想","说","看","来","去","用",
  "把","被","让","给","向","往","prefer","prefers",
]);

// Person signals — things people say/do (formatted strings, {name} replaced at runtime)
const PERSON_VERB_PATTERNS = [
  "{name} said", "{name} told", "{name} asked", "{name} replied", "{name} wrote",
  "{name} thinks", "{name} believes", "{name} wants", "{name} knows",
  "{name} decided", "{name} prefers", "{name} told me",
  "hey {name}", "hi {name}", "dear {name}", "thanks {name}",
  "{name} works on", "{name} working on", "{name} is working",
  "{name} helped", "{name} uses", "{name} built", "{name} created",
  "{name} with {name}",   // "Alice with Bob" — both are persons
  "\\bwith\\s+{name}",   // "with Bob" after any word — Bob is same type as antecedent
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

// Chinese person signals — patterns indicating a named person (2-char CJK name placeholder)
const CHINESE_PERSON_PATTERNS = [
  "{name}说", "{name}告诉", "{name}问", "{name}回答", "{name}写道",
  "{name}觉得", "{name}相信", "{name}想", "{name}知道",
  "{name}决定", "{name}喜欢", "喂{name}", "嗨{name}", "你好{name}",
  "{name}正在", "{name}在用", "{name}用的是",
  "{name}在", "{name}在", "{name}做了", "{name}做的",
  "{name}也是", "{name}也很", "{name}也帮",
];

// Chinese project signals — patterns indicating a named project/tool
const CHINESE_PROJECT_PATTERNS = [
  "用{name}", "使用{name}", "{name}项目", "{name}系统", "{name}架构",
  "{name}版本", "{name} v", "{name}.py", "{name}.js",
  "装了{name}", "安装了{name}", "部署{name}",
];

// Relationship predicate extraction patterns
// Matches patterns like: "Alice is the author of X" → { subject: "Alice", predicate: "is_author_of", object: "X" }
// Uses [^\s,，；;]+ to capture both Latin words and CJK characters
const RELATIONSHIP_PATTERNS = [
  // [regex, predicate_template]
  [/([^\s,，；;]+)\s+(?:is|are)\s+(?:the\s+)?(\w+)\s+of\s+(.+)/i, "{1}_is_{2}_of"],
  [/([^\s,，；;]+)\s+(?:is|are)\s+(?:a|an)\s+([^\s,，；;]+)/i, "{1}_is_{2}"],
  [/([^\s,，；;]+)\s+(?:uses|using|used)\s+([^\s,，；;]+)/i, "{1}_uses_{2}"],
  [/([^\s,，；;]+)\s+(?:built|building|creates?)\s+([^\s,，；;]+)/i, "{1}_builds_{2}"],
  [/([^\s,，；;]+)\s+(?:owns?|owning)\s+([^\s,，；;]+)/i, "{1}_owns_{2}"],
  [/([^\s,，；;]+)\s+(?:works? on|working on)\s+([^\s,，；;]+)/i, "{1}_works_on_{2}"],
  [/([^\s,，；;]+)\s+(?:depends? on|depends on)\s+([^\s,，；;]+)/i, "{1}_depends_on_{2}"],
  [/([^\s,，；;]+)\s+(?:calls? |calls)\s+([^\s,，；;]+)/i, "{1}_calls_{2}"],
  [/([^\s,，；;]+)\s+(?:store(?:s(?: data in)?)?)\s+([^\s,，；;]+)/i, "{1}_stores_in_{2}"],
  [/([^\s,，；;]+)\s+(?:integrate(?:s(?: with)?)?)\s+([^\s,，；;]+)/i, "{1}_integrates_with_{2}"],
  [/([^\s,，；;]+)\s+(?:run(?:s|ning on)?)\s+([^\s,，；;]+)/i, "{1}_runs_on_{2}"],
  [/([^\s,，；;]+)\s+(?:provide(?:s(?: with)?)?)\s+([^\s,，；;]+)/i, "{1}_provides_{2}"],
  [/([^\s,，；;]+)\s+(?:told)\s+([^\s,，；;]+)/i, "{1}_told_{2}"],
];

// Coreference map: alias → canonical name (expand this as you discover more aliases)
const COREFERENCE_MAP = new Map([
  ["she", null], ["her", null], ["hers", null],   // → resolve from context
  ["he", null], ["him", null], ["his", null],
  ["they", null], ["them", null],
  ["it", null], ["this", null],
]);

/**
 * Resolve pronouns to their likely antecedents using co-occurrence scoring.
 * @param {string} text - normalized text
 * @param {string[]} sentences - text split by sentence boundaries
 * @param {Map<string, number>} candidates - map of canonical entity names → frequency
 * @returns {Map<string, string>} resolved pronouns → canonical entity name
 */
function resolveCoreference(text, sentences, candidates) {
  const resolved = new Map();
  if (candidates.size === 0) return resolved;

  // Split into sentences (Chinese 。 or English .)
  const sentBounds = [];
  const last = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[.。!！?]/.test(text[i])) {
      sentBounds.push(i);
    }
  }

  for (const [pronoun] of COREFERENCE_MAP) {
    // Find all occurrences of the pronoun
    let pos = 0;
    while ((pos = text.indexOf(pronoun, pos)) !== -1) {
      // Find sentence index
      const sentIdx = sentBounds.filter(b => b < pos).length;
      // Score candidates within ±2 sentences
      const windowStart = Math.max(0, sentIdx - 2);
      const windowEnd   = Math.min(sentences.length - 1, sentIdx + 2);
      const windowText  = sentences.slice(windowStart, windowEnd + 1).join(" ");

      let best = null, bestScore = 0;
      for (const [name] of candidates) {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const count = (windowText.match(new RegExp(escapedName, "gi")) || []).length;
        if (count > bestScore) { bestScore = count; best = name; }
      }
      if (best && bestScore > 0) {
        resolved.set(pronoun, best);
      }
      pos += pronoun.length;
    }
  }
  return resolved;
}

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

  // Chinese words: greedy segmentation into 2-4 char tokens, deduplicated by position.
// Skips over Latin/CJK mixed segments (e.g. "MemPalace中文" → separate tokens).
const chineseRaw = [];
let cur = "";
let inCJK = false;
for (const ch of text) {
  const isCJK = isCjkChar(ch);
  if (isCJK) {
    if (!inCJK) { if (cur) chineseRaw.push(cur); cur = ""; inCJK = true; }
    cur += ch;
  } else {
    if (inCJK) { if (cur) chineseRaw.push(cur); cur = ""; inCJK = false; }
  }
}
if (cur) chineseRaw.push(cur);

// Count each segment; also record all sub-word 2-char, 3-char, 4-char prefixes for overlap
const cjkCounts = new Map();
for (const segment of chineseRaw) {
  for (let len = 2; len <= Math.min(4, segment.length); len++) {
    for (let i = 0; i <= segment.length - len; i++) {
      const token = segment.slice(i, i + len);
      if (!STOPWORDS.has(token)) {
        cjkCounts.set(token, (cjkCounts.get(token) || 0) + 1);
      }
    }
  }
}

// Characters that never appear in Chinese personal names (grammar particles / demonstratives).
const CHINESE_NON_NAME_CHARS = new Set(["这", "那", "的", "了", "在", "和", "与", "或", "有", "为", "之", "乎", "者", "也", "就", "都", "而", "且", "但", "把", "被", "让", "从", "到", "对", "于", "上", "下", "中", "内", "外", "前", "后", "里", "呢", "啊", "吧", "呀", "吗", "么"]);

function isLikelyChineseName(token) {
  if (token.length < 2 || token.length > 3) return false;
  // Must not be all the same char, and no grammar particles
  if (new Set(token).size < 2) return false;
  for (const ch of token) {
    if (CHINESE_NON_NAME_CHARS.has(ch)) return false;
  }
  return true;
}

// Pre-build Chinese person name extractor (anchor-based).
// Scans the text for known person patterns and extracts the {name} slot directly.
// Only extracts 2-3 char names that look like real personal names.
function extractChinesePersonNames(text) {
  const names = new Set();
  for (const pattern of CHINESE_PERSON_PATTERNS) {
    const anchorIdx = pattern.indexOf("{name}");
    if (anchorIdx === -1) continue;
    const before = pattern.slice(0, anchorIdx);
    const escapedBefore = before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const after = pattern.slice(anchorIdx + "{name}".length);
    if (!after) continue;
    const escapedAfter = after.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Extract 2-3 char Chinese names only (person names are never 4+ chars)
    const rx = new RegExp(escapedBefore + "([\\u4e00-\\u9fff]{2,3})" + escapedAfter, "gu");
    let m;
    while ((m = rx.exec(text)) !== null) {
      const n = m[1];
      if (isLikelyChineseName(n)) names.add(n);
    }
  }
  return names;
}

// Pre-build Chinese project name extractor (anchor-based).
// Only extracts names that look like software/project artifacts (version refs, file names, etc.)
// Avoids the {name}项目 style patterns which greedily capture too much.
function extractChineseProjectNames(text) {
  const names = new Set();
  for (const pattern of CHINESE_PROJECT_PATTERNS) {
    const anchorIdx = pattern.indexOf("{name}");
    if (anchorIdx === -1) continue;
    const before = pattern.slice(0, anchorIdx);
    const escapedBefore = before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const after = pattern.slice(anchorIdx + "{name}".length);
    if (!after) continue;
    const escapedAfter = after.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only safe patterns: file ext (.py, .js) or version refs (v) — never "项目/系统/架构"
    const SAFE_PROJECT_PATTERNS = [".py", ".js", ".ts", ".go", ".rs", " v", "版"];
    const isSafe = SAFE_PROJECT_PATTERNS.some(s => pattern.includes(s));
    if (!isSafe) continue;
    const rx = new RegExp(escapedBefore + "([\\u4e00-\\u9fff]{1,4}|[A-Za-z0-9_.-]{1,20})" + escapedAfter, "gu");
    let m;
    while ((m = rx.exec(text)) !== null) {
      const n = m[1];
      if (n.length >= 2) names.add(n);
    }
  }
  return names;
}

// Keep tokens appearing ≥2 times (sliding-window tokens are high-quality).
// Additionally include anchor-extracted Chinese names (may appear only once).
const anchorPersonNames = extractChinesePersonNames(text);
const anchorProjectNames = extractChineseProjectNames(text);
for (const n of anchorPersonNames) counts.set(n, (counts.get(n) || 0) + 1);
for (const n of anchorProjectNames) counts.set(n, (counts.get(n) || 0) + 1);

  // Filter: must appear at least 1 time (Issue 3: lowered from 2 to 1)
  const candidates = new Map();
  for (const [name, count] of counts) {
    if (count >= 1) candidates.set(name, count);
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
  // A term is a concept only if it appears in a TRUE definitional pattern (copular + article or specific verb).
  // Does NOT fire for action sentences like "Alice is working on" (that would misclassify persons).
  const definitionRx = new RegExp(
    `\\b(${escaped})\\s+(?:is\\s+(?:a|an|the)\\s+\\w+|means|refers\\s+to|describes|represents|defines?)\\b`,
    "gi"
  );
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

  // --- Chinese person signals ---
  for (const pattern of CHINESE_PERSON_PATTERNS) {
    const rx = new RegExp(pattern.replace("{name}", escaped), "gi");
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      personScore += matches * 2;
      personSignals.push(`"${name}"中文人称信号 (${matches}x)`);
    }
  }

  // --- Chinese project signals ---
  for (const pattern of CHINESE_PROJECT_PATTERNS) {
    const rx = new RegExp(pattern.replace("{name}", escaped), "gi");
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      projectScore += matches * 2;
      projectSignals.push(`"${name}"中文项目信号 (${matches}x)`);
    }
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

  // Issue 3: high-confidence signal-only entities (confidence >= 0.75 regardless of frequency)
  const maxSignalScore = Math.max(ps, pjs, cs);
  const signalConfidence = maxSignalScore >= 2 ? Math.min(0.95, 0.5 + 0.5) : 0;
  if (maxSignalScore >= 2 && signalConfidence >= 0.75) {
    if (ps >= pjs && ps >= cs) {
      return { name, type: "person", confidence: 0.85, frequency, signals: scores.person_signals };
    }
    if (pjs >= ps && pjs >= cs) {
      return { name, type: "project", confidence: 0.85, frequency, signals: scores.project_signals };
    }
    if (cs >= ps && cs >= pjs) {
      return { name, type: "concept", confidence: 0.85, frequency, signals: scores.concept_signals };
    }
  }

  const personRatio = ps / total;
  const projectRatio = pjs / total;
  const conceptRatio = cs / total;

  if (personRatio >= 0.6 && hasMultiplePersonSignals && ps >= 2) {
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
    signals: [
      ...(scores.person_signals || []),
      ...(scores.project_signals || []),
      ...(scores.concept_signals || []),
    ].slice(0, 3),
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
      // Strip trailing punctuation — prevents "developer." from slipping through
      const rawSubject = match[1].trim();
      const rawObject = (match[match.length - 1] || "").trim();
      const subject = rawSubject.replace(/[.,;!?。，；]+$/, "");
      const object  = rawObject.replace(/[.,;!?。，；]+$/,  "");
      if (!subject || !object || subject.length < 3 || object.length < 3) continue;

      // Build predicate from template
      const rawPred2 = (match[2] || "").toLowerCase().replace(/[.,;!?。，；]+$/, "").replace(/\s+/g, "_");
      const predicate = predTemplate
        .replace("{1}", subject.toLowerCase().replace(/\s+/g, "_"))
        .replace("{2}", rawPred2);

      // Avoid stopwords as subject/object (after punctuation stripped)
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

  // Resolve coreferences: map pronouns to canonical names
  const sentences = normalized.split(/[.。!！?]/).filter(s => s.trim().length > 5);
  const corefMap = resolveCoreference(normalized, sentences, candidates);
  if (corefMap.size > 0) {
    // For each pronoun found in facts, replace with canonical name
    for (const triple of triples) {
      if (corefMap.has(triple.subject)) triple.subject = corefMap.get(triple.subject);
      if (corefMap.has(triple.object))  triple.object  = corefMap.get(triple.object);
    }
    for (const entity of entities) {
      if (corefMap.has(entity.name)) entity.resolved_from = entity.name;
      const resolved = corefMap.get(entity.name);
      if (resolved) entity.name = resolved;
    }
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
  if (!record) return { entities: [], facts: [], concepts: [] };
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

export {
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

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isDirectRun) {
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
