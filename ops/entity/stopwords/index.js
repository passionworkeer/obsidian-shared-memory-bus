// ops/entity/stopwords/index.js
//
// Barrel for entity-extractor stopwords. Aggregates the per-category lists
// (english, programming, prose, chinese) into the single Set the rest of
// the extractor code consumes. Splitting the data from the algorithm
// keeps patterns.js focused on extraction heuristics and lets editors
// review stopword additions in domain-scoped files.

import { ENGLISH_STOPWORDS } from "./english.js";
import { PROGRAMMING_STOPWORDS } from "./programming.js";
import { PROSE_STOPWORDS } from "./prose.js";
import { CHINESE_STOPWORDS } from "./chinese.js";

/** @type {Set<string>} */
export const STOPWORDS = new Set([
  ...ENGLISH_STOPWORDS,
  ...PROGRAMMING_STOPWORDS,
  ...PROSE_STOPWORDS,
  ...CHINESE_STOPWORDS,
]);

export {
  ENGLISH_STOPWORDS,
  PROGRAMMING_STOPWORDS,
  PROSE_STOPWORDS,
  CHINESE_STOPWORDS,
};
