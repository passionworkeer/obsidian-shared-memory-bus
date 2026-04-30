/**
 * Test fixtures - sample data for testing
 */

/**
 * Sample memory records for testing
 */
const SAMPLE_MEMORY_RECORDS = [
  {
    id: "rec-001",
    title: "用户偏好中文回复",
    content: "用户更喜欢使用中文回复，除非用户明确要求使用英文。",
    tool: "claude-code",
    scope: "user",
    type: "note",
    confidence: 0.85,
    t: new Date(Date.now() - 1000).toISOString(),
    freshness: "hot",
  },
  {
    id: "rec-002",
    title: "API authentication implementation",
    content: "Working on OAuth2 authentication for the REST API endpoints.",
    tool: "claude-code",
    scope: "project",
    type: "note",
    confidence: 0.75,
    t: new Date(Date.now() - 3600000).toISOString(),
    freshness: "hot",
  },
  {
    id: "rec-003",
    title: "Database schema update",
    content: "Users table needs additional fields for user preferences and settings.",
    tool: "openclaw",
    scope: "project",
    type: "task",
    confidence: 0.8,
    t: new Date(Date.now() - 86400000).toISOString(),
    freshness: "warm",
  },
];

/**
 * Sample entity extraction test data
 */
const ENTITY_EXTRACTION_FIXTURES = {
  chinese: {
    text: "王明正在开发Obsidian插件系统，李华负责前端界面设计。",
    expectedPersons: ["王明", "李华"],
    expectedProjects: ["Obsidian插件系统"],
  },
  english: {
    text: "John is working on the backend API, while Sarah manages the frontend interface.",
    expectedPersons: ["John", "Sarah"],
    expectedProjects: [],
  },
  mixed: {
    text: "Zhang Wei and Alice are collaborating on the multi-agent memory system.",
    expectedPersons: ["Zhang Wei", "Alice"],
    expectedProjects: [],
  },
  empty: {
    text: "",
    expectedPersons: [],
    expectedProjects: [],
  },
  null_content: {
    text: null,
    expectedPersons: [],
    expectedProjects: [],
  },
};

/**
 * Sample structured records for entity extraction
 */
const SAMPLE_RECORDS_WITH_ENTITIES = [
  {
    id: "ent-rec-001",
    title: "王明的开发进度",
    content: "王明正在开发entity extraction模块，计划本周完成基础功能。",
    tool: "claude-code",
    scope: "project",
    type: "task",
    confidence: 0.9,
    t: new Date(Date.now() - 2000).toISOString(),
  },
  {
    id: "ent-rec-002",
    title: "User Preferences Project",
    content: "Alice and Bob are working on the user preferences feature.",
    tool: "openclaw",
    scope: "project",
    type: "task",
    confidence: 0.85,
    t: new Date(Date.now() - 4000).toISOString(),
  },
];

/**
 * Sample runtime config for testing
 */
const SAMPLE_RUNTIME_CONFIG = {
  embedding: {
    backend: "openai",
    modelName: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  memory: {
    maxAgeDays: 90,
    tierBudgets: {
      1: { max: 200 },
      2: { max: 200 },
      3: { max: 100 },
      4: { max: 200 },
      5: { max: 500 },
    },
  },
  agents: {
    claudeCode: {
      enabled: true,
    },
    openclaw: {
      enabled: false,
    },
  },
};

/**
 * Sample content for normalization tests
 */
const NORMALIZATION_FIXTURES = {
  bom: {
    input: "﻿Hello World",
    expected: "Hello World",
  },
  spaces: {
    input: "  hello   world  ",
    expected: "hello world",
  },
  tabs: {
    input: "hello\tworld",
    expected: "hello world",
  },
  newlines: {
    input: "hello\n\nworld",
    expected: "hello world",
  },
  mixed: {
    input: "﻿  Hello   World\n\nGood  \t  Morning  ",
    expected: "Hello World Good Morning",
  },
  null_input: {
    input: null,
    expected: "",
  },
  undefined_input: {
    input: undefined,
    expected: "",
  },
  empty_string: {
    input: "",
    expected: "",
  },
};

/**
 * Sample freshness values and expected results
 */
const FRESHNESS_FIXTURES = [
  { label: "hot - 5 minutes ago", ageMs: 5 * 60 * 1000, expected: "hot" },
  { label: "hot - 6 hours ago", ageMs: 6 * 60 * 60 * 1000, expected: "hot" },
  { label: "warm - 3 days ago", ageMs: 3 * 24 * 60 * 60 * 1000, expected: "warm" },
  { label: "cold - 2 weeks ago", ageMs: 14 * 24 * 60 * 60 * 1000, expected: "cold" },
  { label: "unknown - null", ageMs: null, expected: "unknown" },
  { label: "unknown - invalid date", ageMs: "invalid", expected: "unknown" },
];

export {
  SAMPLE_MEMORY_RECORDS,
  ENTITY_EXTRACTION_FIXTURES,
  SAMPLE_RECORDS_WITH_ENTITIES,
  SAMPLE_RUNTIME_CONFIG,
  NORMALIZATION_FIXTURES,
  FRESHNESS_FIXTURES,
};
