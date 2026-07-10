// ops/entity/stopwords/english.js
//
// English-language stopwords: pronouns, articles, auxiliary verbs, common
// adverbs, and generic demonstratives. Used by entity-extractor to filter
// out non-entity tokens during candidate generation.

export const ENGLISH_STOPWORDS = [
  // Pronouns / articles
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by", "as",
  "is", "was", "are", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "shall", "can", "this", "that",
  "these", "those", "it", "its", "they", "them", "their", "we", "our", "you", "your", "i", "my", "me",
  "he", "she", "his", "her", "who", "what", "when", "where", "why", "how", "which",
  "if", "then", "so", "not", "no", "yes", "ok", "okay", "just", "really", "very", "also",
  "already", "still", "even", "only", "here", "there", "now", "too", "up", "out", "about",
  "like", "true", "false", "none", "new", "old",
  "all", "any", "some", "every", "each", "more", "less", "next", "last", "first", "second",
  // Greetings / filler
  "hey", "hi", "hello", "thanks", "thank", "right",
];
