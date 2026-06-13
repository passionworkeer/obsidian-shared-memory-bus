/**
 * ops/util/cjk-tokenize.js
 * ========================
 * Shared CJK (Chinese, Japanese, Kanji) helpers used by:
 *   - ops/entity/entity-extractor.js  (candidate extraction)
 *   - ops/memory/memory-layers-parse.js (search tokenization)
 *
 * The two callers use different tokenization strategies (boundary-aware
 * candidate extraction vs. regex match) so this module exposes only the
 * primitives they share: the CJK Unicode range and a character predicate.
 * The downstream logic stays in each caller to keep the import graph flat.
 */

export const CJK_REGEX = /[一-鿿]/;

/**
 * Returns true if the given single character is a CJK Unified Ideograph.
 * Accepts a string of length 0 or 1; longer inputs return false.
 *
 * @param {string} ch
 * @returns {boolean}
 */
export function isCjkChar(ch) {
  if (typeof ch !== "string" || ch.length === 0) return false;
  return CJK_REGEX.test(ch);
}

/**
 * Returns the array of single CJK characters in `text`. Whitespace and
 * Latin characters are skipped. Useful for downstream tokenization that
 * wants CJK runs only.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function cjkChars(text) {
  if (!text) return [];
  const out = [];
  for (const ch of String(text)) {
    if (isCjkChar(ch)) out.push(ch);
  }
  return out;
}
