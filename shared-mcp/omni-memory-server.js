import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import sqlite3Module from "sqlite3";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const sqlite3 = sqlite3Module.verbose ? sqlite3Module.verbose() : sqlite3Module;
const USER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT || path.resolve(__dirname, "..");
const PYTHON = process.env.AI_MEMORY_PYTHON || "python";
const SEARCH_SCRIPT = path.join(AI_MEMORY_ROOT, "semantic-search.py");
const EMBEDDINGS_SCRIPT = path.join(AI_MEMORY_ROOT, "generate-embeddings.js");
const WATCHDOG_STATE_PATH = path.join(AI_MEMORY_ROOT, "watchdog-state.json");
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, ".openclaw");
const BLACKBOARD_DB_PATH =
  process.env.OPENCLAW_BLACKBOARD_DB || path.join(OPENCLAW_HOME, "workspace", "ai-shrimp", "blackboard", "tasks.db");

function resolveVaultRoot() {
  for (const envKey of ["AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"]) {
    const candidate = (process.env[envKey] || "").trim();
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const defaults = [
    "E:/desktop/Obsidian Vault",
    path.join(USER_HOME, "Documents", "Obsidian Vault"),
  ];
  const found = defaults.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `no-obsidian-vault: Tried [${defaults.join(", ")}]. ` +
      `Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT to your vault path.`
    );
  }
  return found;
}

const VAULT_ROOT = resolveVaultRoot();
const EMBEDDINGS_INDEX_PATH = path.join(VAULT_ROOT, "00-System", "ai-memory", "embeddings", "index.jsonl");
const CLAUDE_MEM_BASE = (process.env.CLAUDE_MEM_BASE || "http://127.0.0.1:37778").replace(/\/+$/, "");

const server = new Server(
  {
    name: "omni-memory-mesh",
    version: "3.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Uncaught exception handlers — crash loudly with useful log
process.on('uncaughtException', (err) => {
  console.error('[omni-memory] uncaughtException:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[omni-memory] unhandledRejection:', reason);
});

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }, null, 2) }],
    isError: true,
  };
}

function spawnProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code || 0, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

async function getClaudeMemHealth() {
  try {
    const response = await fetch(`${CLAUDE_MEM_BASE}/api/health`);
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function readWatchdogState() {
  if (!fs.existsSync(WATCHDOG_STATE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(WATCHDOG_STATE_PATH, "utf8"));
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function readEmbeddingsSummary() {
  if (!fs.existsSync(EMBEDDINGS_INDEX_PATH)) {
    return {
      exists: false,
      path: EMBEDDINGS_INDEX_PATH,
      count: 0,
      tools: {},
    };
  }

  const tools = {};
  let count = 0;
  const lines = fs.readFileSync(EMBEDDINGS_INDEX_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      count += 1;
      const tool = record.tool || "unknown";
      tools[tool] = (tools[tool] || 0) + 1;
    } catch (err) {
      // Ignore malformed lines and keep reporting readable data.
      console.error(`[omni-memory-server] JSON parse error in embeddings index (skipping line): ${err.message}`);
    }
  }

  const stat = fs.statSync(EMBEDDINGS_INDEX_PATH);
  return {
    exists: true,
    path: EMBEDDINGS_INDEX_PATH,
    count,
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    tools,
  };
}

async function runSemanticSearch({ query, mode = "hybrid", limit = 8 }) {
  if (!fs.existsSync(SEARCH_SCRIPT)) {
    throw new Error(`search-script-missing: ${SEARCH_SCRIPT}`);
  }

  const args = [SEARCH_SCRIPT, "--mode", mode, "--top-k", String(limit), "--json", query];
  const result = await spawnProcess(PYTHON, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `semantic-search-exit-${result.code}`);
  }
  return JSON.parse(result.stdout);
}

async function rebuildEmbeddings({ force = false }) {
  if (!fs.existsSync(EMBEDDINGS_SCRIPT)) {
    throw new Error(`embeddings-script-missing: ${EMBEDDINGS_SCRIPT}`);
  }

  const args = [EMBEDDINGS_SCRIPT];
  if (force) {
    args.push("--force");
  }

  const result = await spawnProcess(process.execPath, args, {
    env: {
      ...process.env,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `embeddings-exit-${result.code}`);
  }

  return {
    ok: true,
    command: `${process.execPath} ${args.join(" ")}`,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    summary: readEmbeddingsSummary(),
  };
}

function queryBlackboard({ limit = 10, states = [], state = "" }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(BLACKBOARD_DB_PATH)) {
      resolve({ ok: false, error: `blackboard-db-missing: ${BLACKBOARD_DB_PATH}` });
      return;
    }

    let db;
    try {
      db = new sqlite3.Database(BLACKBOARD_DB_PATH, sqlite3.OPEN_READONLY);
    } catch (error) {
      resolve({ ok: false, error: String(error) });
      return;
    }
    const normalizedStates = Array.isArray(states)
      ? states.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean)
      : [];
    if (normalizedStates.length === 0 && String(state || "").trim()) {
      normalizedStates.push(String(state).trim().toUpperCase());
    }
    const whereClause =
      normalizedStates.length > 0 ? ` WHERE state IN (${normalizedStates.map(() => "?").join(",")})` : "";
    const sql = `SELECT id, repo, issue_number, issue_title, state, assigned_agent, processor, updated_at FROM tasks${whereClause} ORDER BY updated_at DESC LIMIT ?`;
    const params = [...normalizedStates, Math.max(1, Number(limit) || 10)];

    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve({ ok: true, rows });
    });
  });
}

function insertBlackboardTask({ repo, issue_number, assigned_agent = "intel", issue_title = "" }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(BLACKBOARD_DB_PATH)) {
      resolve({ ok: false, error: `blackboard-db-missing: ${BLACKBOARD_DB_PATH}` });
      return;
    }

    const db = new sqlite3.Database(BLACKBOARD_DB_PATH);
    const sql =
      "INSERT INTO tasks (repo, issue_number, assigned_agent, issue_title, state) VALUES (?, ?, ?, ?, 'PENDING')";
    const params = [
      repo,
      Number(issue_number),
      assigned_agent || "intel",
      issue_title || `${repo}#${issue_number}`,
    ];

    db.run(sql, params, function onInsert(error) {
      db.close();
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve({ ok: true, insertedId: this.lastID });
    });
  });
}

async function queryClaudeMem({ query, limit = 5 }) {
  const url = `${CLAUDE_MEM_BASE}/api/search?query=${encodeURIComponent(query)}&limit=${Math.max(
    1,
    Number(limit) || 5
  )}`;
  const response = await fetch(url);
  return await response.json();
}

async function insertClaudeMem({ content, metadata = {} }) {
  const response = await fetch(`${CLAUDE_MEM_BASE}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, metadata }),
  });
  return await response.json();
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_status",
      description:
        "Inspect the shared memory stack health: watchdog state, embeddings index summary, and claude-mem health.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_shared_memory",
      description:
        "Search the canonical shared Obsidian memory bus across Codex, Claude Code, OpenCode, Copilot, Cursor, Trae, and OpenClaw. Defaults to hybrid retrieval and falls back to BM25 when dense embeddings are unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          mode: {
            type: "string",
            enum: ["bm25", "dense", "hybrid", "auto"],
            default: "hybrid",
            description: "Retrieval mode. hybrid is recommended.",
          },
          strategy: {
            type: "string",
            enum: ["bm25", "dense", "hybrid", "auto"],
            description: "Alias for mode.",
          },
          limit: { type: "number", default: 8, description: "Maximum number of results." },
        },
        required: ["query"],
      },
    },
    {
      name: "rebuild_memory_embeddings",
      description: "Rebuild the dense embeddings index from shared Obsidian structured memory.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", default: false, description: "Re-embed even unchanged records." },
        },
      },
    },
    {
      name: "rebuild_shared_embeddings",
      description: "Alias for rebuild_memory_embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          force: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "query_claude_mem",
      description:
        "Query the local claude-mem semantic memory API directly. Use search_shared_memory for the canonical cross-tool shared layer.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic query." },
          limit: { type: "number", default: 5, description: "Maximum number of results." },
        },
        required: ["query"],
      },
    },
    {
      name: "insert_claude_mem",
      description: "Insert a new item into the local claude-mem store.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content to insert." },
          metadata: { type: "object", description: "Optional metadata." },
        },
        required: ["content"],
      },
    },
    {
      name: "get_blackboard_tasks",
      description: "Read recent OpenClaw blackboard tasks from the shared AI Shrimp SQLite blackboard.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", default: 10, description: "Maximum rows to return." },
          state: { type: "string", description: "Optional single state filter." },
          states: {
            type: "array",
            items: { type: "string" },
            description: "Optional task states to filter, e.g. ['PENDING', 'ACTIVE']",
          },
        },
      },
    },
    {
      name: "write_blackboard_task",
      description: "Insert a new task into the OpenClaw blackboard.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository name, e.g. browser-use/browser-use." },
          issue_number: { type: "number", description: "Issue number." },
          assigned_agent: {
            type: "string",
            default: "intel",
            description: "OpenClaw agent lane, usually intel or developer.",
          },
          issue_title: { type: "string", description: "Optional issue title." },
        },
        required: ["repo", "issue_number"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments || {};

  try {
    if (name === "memory_status") {
      return jsonResult({
        ok: true,
        generatedAt: new Date().toISOString(),
        watchdog: readWatchdogState(),
        embeddings: readEmbeddingsSummary(),
        claudeMem: await getClaudeMemHealth(),
      });
    }

    if (name === "search_shared_memory") {
      const query = String(args.query || "").trim();
      if (!query) {
        return errorResult("query is required");
      }
      const payload = await runSemanticSearch({
        query,
        mode: String(args.mode || args.strategy || "hybrid"),
        limit: Math.max(1, Number(args.limit) || 8),
      });
      return jsonResult(payload);
    }

    if (name === "rebuild_memory_embeddings" || name === "rebuild_shared_embeddings") {
      const payload = await rebuildEmbeddings({ force: Boolean(args.force) });
      return jsonResult(payload);
    }

    if (name === "query_claude_mem") {
      const query = String(args.query || "").trim();
      if (!query) {
        return errorResult("query is required");
      }
      return jsonResult({
        ok: true,
        query,
        response: await queryClaudeMem({
          query,
          limit: Math.max(1, Number(args.limit) || 5),
        }),
      });
    }

    if (name === "insert_claude_mem") {
      const content = String(args.content || "").trim();
      if (!content) {
        return errorResult("content is required");
      }
      return jsonResult({
        ok: true,
        response: await insertClaudeMem({
          content,
          metadata: args.metadata || {},
        }),
      });
    }

    if (name === "get_blackboard_tasks") {
      return jsonResult(
        await queryBlackboard({
          limit: Math.max(1, Number(args.limit) || 10),
          state: String(args.state || ""),
          states: args.states || [],
        })
      );
    }

    if (name === "write_blackboard_task") {
      const repo = String(args.repo || "").trim();
      const issueNumber = Number(args.issue_number);
      if (!repo || !Number.isFinite(issueNumber)) {
        return errorResult("repo and issue_number are required");
      }
      return jsonResult(
        await insertBlackboardTask({
          repo,
          issue_number: issueNumber,
          assigned_agent: String(args.assigned_agent || "intel"),
          issue_title: String(args.issue_title || ""),
        })
      );
    }

    return errorResult(`tool-not-found: ${name}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
