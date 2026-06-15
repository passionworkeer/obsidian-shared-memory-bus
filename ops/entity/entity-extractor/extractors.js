// ops/entity/entity-extractor/extractors.js
//
// Pure extraction functions: candidate enumeration (English proper nouns +
// CJK 2-4 char tokens), per-candidate scoring, classification into
// person/project/concept, relationship triple extraction, and pronoun
// coreference resolution.

import { isCjkChar } from "../../util/cjk-tokenize.js";
import {
  CHINESE_NON_NAME_CHARS,
  CHINESE_PERSON_PATTERNS,
  CHINESE_PROJECT_PATTERNS,
  COREFERENCE_MAP,
  PERSON_VERB_PATTERNS,
  PROJECT_VERB_PATTERNS,
  RELATIONSHIP_PATTERNS,
  STOPWORDS,
} from "./patterns.js";

/**
 * Resolve pronouns to their likely antecedents using co-occurrence scoring.
 * @param {string} text - normalized text
 * @param {string[]} sentences - text split by sentence boundaries
 * @param {Map<string, number>} candidates - map of canonical entity names → frequency
 * @returns {Map<string, string>} resolved pronouns → canonical entity name
 */
export function resolveCoreference(text, sentences, candidates) {
  const resolved = new Map();
  if (candidates.size === 0) return resolved;

  // Split into sentences (Chinese 。 or English .)
  const sentBounds = [];
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
export function extractCandidates(text) {
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
  // (computed but not merged into `counts` — kept for the anchor-based extractors below.)
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

  // Anchor-based Chinese name extraction (pattern-triggered; may appear only once)
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
export function scoreEntity(name, text, _lines) {
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
export function classifyEntity(name, frequency, scores) {
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
export function extractRelationships(text) {
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