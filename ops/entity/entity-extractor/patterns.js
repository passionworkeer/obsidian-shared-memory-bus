// ops/entity/entity-extractor/patterns.js
//
// Shared constants for entity extraction: person/project signal patterns
// (English + Chinese) and the coreference map used to resolve pronouns to
// canonical entity names. Stopwords live in ../stopwords/index.js — see
// that module for the per-category data files (english, programming,
// prose, chinese) that this barrel re-aggregates.

import { STOPWORDS } from "../stopwords/index.js";

export { STOPWORDS };

// Person signals — things people say/do (formatted strings, {name} replaced at runtime)
export const PERSON_VERB_PATTERNS = [
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
export const PROJECT_VERB_PATTERNS = [
  "building {name}", "built {name}", "ship {name}", "shipped {name}",
  "deploy {name}", "deployed {name}", "install {name}", "installed {name}",
  "the {name} architecture", "the {name} system", "the {name} pipeline",
  "{name} v", "{name} v1", "{name} v2", "the {name} repo",
  "{name}.py", "{name}.js", "{name}.ts", "{name}.go",
  "{name}-core", "{name}-local", "{name}-server",
  "pip install {name}", "npm install {name}",
];

// Chinese person signals — patterns indicating a named person (2-char CJK name placeholder)
export const CHINESE_PERSON_PATTERNS = [
  "{name}说", "{name}告诉", "{name}问", "{name}回答", "{name}写道",
  "{name}觉得", "{name}相信", "{name}想", "{name}知道",
  "{name}决定", "{name}喜欢", "喂{name}", "嗨{name}", "你好{name}",
  "{name}正在", "{name}在用", "{name}用的是",
  "{name}在", "{name}在", "{name}做了", "{name}做的",
  "{name}也是", "{name}也很", "{name}也帮",
];

// Chinese project signals — patterns indicating a named project/tool
export const CHINESE_PROJECT_PATTERNS = [
  "用{name}", "使用{name}", "{name}项目", "{name}系统", "{name}架构",
  "{name}版本", "{name} v", "{name}.py", "{name}.js",
  "装了{name}", "安装了{name}", "部署{name}",
];

// Relationship predicate extraction patterns
// Matches patterns like: "Alice is the author of X" → { subject: "Alice", predicate: "is_author_of", object: "X" }
// Uses [^\s,，；;]+ to capture both Latin words and CJK characters
export const RELATIONSHIP_PATTERNS = [
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
export const COREFERENCE_MAP = new Map([
  ["she", null], ["her", null], ["hers", null],   // → resolve from context
  ["he", null], ["him", null], ["his", null],
  ["they", null], ["them", null],
  ["it", null], ["this", null],
]);

// Characters that never appear in Chinese personal names (grammar particles / demonstratives).
export const CHINESE_NON_NAME_CHARS = new Set(["这", "那", "的", "了", "在", "和", "与", "或", "有", "为", "之", "乎", "者", "也", "就", "都", "而", "且", "但", "把", "被", "让", "从", "到", "对", "于", "上", "下", "中", "内", "外", "前", "后", "里", "呢", "啊", "吧", "呀", "吗", "么"]);