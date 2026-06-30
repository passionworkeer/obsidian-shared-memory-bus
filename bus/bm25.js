/**
 * bus/bm25.js
 * -----------
 * Pure JS BM25 search (k1=1.5, b=0.75). No npm dependencies.
 * Handles both Latin and CJK text.
 *
 * CROSS-LANGUAGE NOTE: This is the LOCAL fallback BM25 used by ops/mcp tools.
 * The canonical hybrid retrieval path runs in Python (retrieval/search_ranking.py,
 * jieba tokenization). The two implementations are NOT rank-aligned — different
 * tokenizers (JS unigram+bigram vs Python jieba) yield different tf/idf even with
 * matching k1/b. Do not expect identical ordering between this and the Python
 * `bm25`/`hybrid` modes; this module is intentionally a lightweight offline
 * lookup, not a mirror of the Python ranking pipeline.
 *
 * Usage:
 *   import { search } from './bm25.js';
 *   const results = search(docs, query, { topK: 10 });
 *   // docs: Array<{ id: string, text: string }>
 *   // results: Array<{ id: string, score: number }> sorted desc
 */

const K1 = 1.5;
const B  = 0.75;

/**
 * Tokenize text: split Latin by whitespace/punctuation, CJK as unigrams + bigrams.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  const tokens = [];

  // Latin words (lowercase, min length 2)
  const latin = text.toLowerCase().replace(/[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}]/gu, " ");
  for (const w of latin.split(/[\s\W]+/)) {
    if (w.length >= 2) tokens.push(w);
  }

  // CJK: unigrams + bigrams
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]);
  }

  return tokens;
}

/**
 * Score all docs against a query using BM25.
 * @param {Array<{id: string, text: string}>} docs
 * @param {string} query
 * @param {{ topK?: number }} [opts]
 * @returns {Array<{id: string, score: number}>}
 */
function search(docs, query, opts = {}) {
  const { topK = docs.length } = opts;
  if (!docs.length || !query) return [];

  // Build index
  const N = docs.length;
  const df = {};       // term → doc count
  const docTf = {};    // docId → { term → count }
  const dl = {};       // docId → token count
  let totalLen = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc.text || "");
    dl[doc.id] = tokens.length;
    totalLen += tokens.length;
    docTf[doc.id] = {};
    const seen = new Set();
    for (const t of tokens) {
      docTf[doc.id][t] = (docTf[doc.id][t] || 0) + 1;
      if (!seen.has(t)) { df[t] = (df[t] || 0) + 1; seen.add(t); }
    }
  }

  const avgdl = totalLen / N;
  const qTokens = tokenize(query);
  const scores = {};

  for (const term of qTokens) {
    const n_t = df[term] || 0;
    if (n_t === 0) continue;
    const idf = Math.log((N - n_t + 0.5) / (n_t + 0.5) + 1);
    for (const doc of docs) {
      const freq = (docTf[doc.id] || {})[term] || 0;
      if (freq === 0) continue;
      const norm = freq * (K1 + 1) / (freq + K1 * (1 - B + B * dl[doc.id] / avgdl));
      scores[doc.id] = (scores[doc.id] || 0) + idf * norm;
    }
  }

  return Object.entries(scores)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export { tokenize, search };
