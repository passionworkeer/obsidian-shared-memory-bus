// ops/entity/stopwords/chinese.js
//
// Chinese (Mandarin) function words: particles, prepositions, pronouns,
// and common discourse markers. Set is intentionally broad — these tokens
// are noise in entity extraction regardless of domain.

export const CHINESE_STOPWORDS = [
  "的", "是", "在", "有", "我", "你", "他", "她", "它", "了", "和", "与", "及", "或", "不",
  "这", "那", "也", "还", "又", "就", "但", "而", "则", "因", "所", "以", "为", "于",
  "上", "下", "中", "后", "前", "里", "外", "之", "其", "并",
  "觉", "得", "能", "会", "可", "要", "想", "说", "看", "来", "去", "用",
  "把", "被", "让", "给", "向", "往",
  "prefer", "prefers",
];
