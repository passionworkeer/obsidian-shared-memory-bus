// ops/extraction-pipeline.mjs
// ESM extraction pipeline — orchestrates transcript loading, LLM extraction, and record writing

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Dynamically load CJS sibling module
const { resolveStoreRoot, getProjectsRoot } = require("../bus/store-root.js");

// Import ESM dependency modules (must use .mjs extension)
import { buildExtractionPrompt, setUserIdentityContext } from "./extraction-prompt.mjs";
import { parseExtractionXml, meetsQualityBar } from "./extraction-validate.mjs";
import { buildExtractionTranscript, loadTranscript } from "./extract-transcript.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MEMORY_RECORD_SCHEMA_VERSION = 2;
const PENDING_FILE = "extraction-pending.jsonl";
const LLM_TIMEOUT_MS = 60000;

// Environment variables
const LLM_PROVIDER = process.env.AI_MEMORY_LLM_PROVIDER || "openai";
const LLM_MODEL = process.env.AI_MEMORY_LLM_MODEL || "gpt-4o";
const LLM_API_KEY = process.env.OPENAI_API_KEY || "";
const LLM_BASE_URL = process.env.AI_MEMORY_LLM_BASE_URL || "https://api.openai.com/v1";

// ---------------------------------------------------------------------------
// generateId — uses crypto.randomUUID()
// ---------------------------------------------------------------------------
export function generateId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// validateRecord — returns true or an error string
// ---------------------------------------------------------------------------
const VALID_SCOPES = new Set(["user", "project", "feedback", "reference"]);

export function validateRecord(record) {
  if (!record || typeof record !== "object") return "not-an-object";
  const required = ["schemaVersion", "id", "tool", "type", "title", "source", "scope"];
  for (const field of required) {
    if (!record[field]) return `missing-field: ${field}`;
  }
  if (record.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
    return `wrong-schema-version: ${record.schemaVersion}`;
  }
  if (!VALID_SCOPES.has(record.scope)) {
    return `invalid-scope: ${record.scope}`;
  }
  return true;
}

// ---------------------------------------------------------------------------
// LLM API
// ---------------------------------------------------------------------------
async function callLLM(prompt) {
  if (!LLM_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 2048,
  });
  const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body,
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`llm-api-error: ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------
function appendJsonl(filePath, obj) {
  const line = JSON.stringify(obj);
  fs.appendFileSync(filePath, line + "\n", "utf-8");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------
function loadUserIdentityContext(storeRoot) {
  const identityPath = path.join(storeRoot, "user-identity.md");
  if (!fs.existsSync(identityPath)) return "";
  return fs.readFileSync(identityPath, "utf-8");
}

function loadProjectContext(projectJsonlPath) {
  if (!fs.existsSync(projectJsonlPath)) return "";
  const lines = fs.readFileSync(projectJsonlPath, "utf-8")
    .trim().split("\n").filter(Boolean).slice(-5)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (lines.length === 0) return "";
  return "最近项目事实：\n" + lines.map(r =>
    `- [${r.type || "?"}] ${(r.content || r.title || "").slice(0, 150)}`
  ).join("\n");
}

// ---------------------------------------------------------------------------
// Record building
// ---------------------------------------------------------------------------
function buildRecords(parsed, { project, tool, sessionId }) {
  const base = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: generateId(),
    tool,
    session: sessionId,
    project,
    source: "extraction",
    memory_level: "session",
    confidence: parsed.confidence,
  };
  const records = [];
  if (parsed.facts.length > 0 || parsed.decisions.length > 0) {
    records.push({
      ...base,
      type: parsed.session_type,
      title: `会话提取：${parsed.session_type}`,
      content: parsed.decisions.length > 0
        ? "decisions: " + parsed.decisions.join(" | ")
        : parsed.facts[0]?.content || "",
      facts: parsed.facts.map(f => f.content),
      scope: "project",
      concepts: parsed.entities.map(e => e.name),
    });
  }
  for (const fact of parsed.facts.slice(0, 5)) {
    records.push({
      ...base,
      id: generateId(),
      type: fact.type,
      title: fact.content.slice(0, 80),
      content: fact.content,
      scope: VALID_SCOPES.has(fact.scope) ? fact.scope : "project",
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// runExtraction — main entry point
// ---------------------------------------------------------------------------
export async function runExtraction(opts) {
  const {
    transcriptPath,
    project = path.basename(process.cwd()),
    tool = "claude-code",
    sessionId = "",
  } = opts;

  const storeRoot = resolveStoreRoot();
  const projectsRoot = getProjectsRoot(storeRoot);
  const projectJsonlPath = path.join(projectsRoot, `${project}.jsonl`);
  const pendingPath = path.join(storeRoot, PENDING_FILE);
  ensureDir(projectsRoot);

  // Step 1: Build transcript
  let transcript;
  try {
    const { lines } = loadTranscript(transcriptPath);
    transcript = buildExtractionTranscript(lines);
  } catch (err) {
    return { ok: false, error: `transcript-load-failed: ${err.message}` };
  }
  if (!transcript || transcript.length < 100) {
    return { ok: false, error: "transcript-too-short" };
  }

  // Step 2: Build prompt with context
  setUserIdentityContext(loadUserIdentityContext(storeRoot));
  const projectContext = loadProjectContext(projectJsonlPath);
  const prompt = buildExtractionPrompt(transcript, projectContext);

  // Step 3: Call LLM
  let llmResponse;
  try {
    llmResponse = await callLLM(prompt);
  } catch (err) {
    appendJsonl(pendingPath, {
      t: new Date().toISOString(),
      transcript_path: transcriptPath, project, tool,
      session_id: sessionId, failed_reason: err.message,
    });
    return { ok: false, error: `llm-call-failed: ${err.message}`, fallback: "pending" };
  }

  // Step 4: Parse XML
  const parsed = parseExtractionXml(llmResponse);
  if (!meetsQualityBar(parsed, 1)) {
    appendJsonl(pendingPath, {
      t: new Date().toISOString(),
      transcript_path: transcriptPath, project, tool,
      session_id: sessionId,
      llm_response: llmResponse.slice(0, 500),
      parse_errors: parsed.errors,
      facts_count: parsed.facts.length,
    });
    return {
      ok: false, error: "quality-bar-not-met",
      parse_errors: parsed.errors,
      facts_extracted: parsed.facts.length,
      fallback: "pending",
    };
  }

  // Step 5: Build + validate records
  const records = buildRecords(parsed, { project, tool, sessionId });
  const validRecords = records.filter(r => validateRecord(r) === true);
  if (validRecords.length === 0) {
    appendJsonl(pendingPath, {
      t: new Date().toISOString(),
      transcript_path: transcriptPath, project, tool,
      session_id: sessionId,
      llm_response: llmResponse.slice(0, 500),
      failed_reason: "no-valid-records",
    });
    return { ok: false, error: "no-valid-records", fallback: "pending" };
  }

  // Step 6: Write to project.jsonl
  for (const record of validRecords) {
    appendJsonl(projectJsonlPath, record);
  }

  return {
    ok: true,
    records_written: validRecords.length,
    session_type: parsed.session_type,
    confidence: parsed.confidence,
    decisions: parsed.decisions,
    entities: parsed.entities,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, transcriptPath, project = ""] = process.argv;
  if (!transcriptPath) {
    console.error("Usage: node extraction-pipeline.mjs <transcript-path> [project]");
    process.exit(1);
  }
  runExtraction({ transcriptPath, project })
    .then(r => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
