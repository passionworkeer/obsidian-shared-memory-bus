/**
 * memory-tools.js
 * Single source of truth for all MCP tool definitions.
 * The tool list here MUST remain functionally identical to what was
 * previously inlined in omni-memory-server.js.
 */

export const TOOLS = [
  {
    name: "memory_status",
    description:
      "Inspect the shared memory stack health: watchdog state, contract/integrity status, embeddings index summary, and claude-mem health.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_memory_overview",
    description:
      "Get a project-level memory overview for the current workspace. Returns project context, active tasks, recent memory activity, and memory system health. Use this at the start of a session to understand what the shared memory system already knows.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: {
          type: "string",
          description:
            "Optional workspace path. If omitted, uses AI_MEMORY_OBSIDIAN_VAULT or the canonical vault root.",
        },
        include_stats: {
          type: "boolean",
          default: true,
          description:
            "Include memory statistics (record counts, freshness distribution).",
        },
      },
    },
  },
  {
    name: "memory_wake_up",
    description:
      "Build a very small session bootstrap pack from the canonical shared memory bus. Use this when you want a compact wake-up context before doing deeper searches.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_root: {
          type: "string",
          description:
            "Optional workspace or vault path. If omitted, uses the canonical shared Obsidian vault.",
        },
        max_items: {
          type: "number",
          default: 3,
          description:
            "Maximum items to keep per compact section such as next steps, blockers, and recent threads.",
        },
        include_recent_activity: {
          type: "boolean",
          default: true,
          description:
            "Include a few recent session/task items in addition to durable anchors and handoff data.",
        },
      },
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
        route: {
          type: "string",
          enum: ["auto", "mixed", "durable", "task", "recent", "reference"],
          default: "auto",
          description: "Optional query routing profile. auto infers the best layer mix from the query intent.",
        },
        limit: { type: "number", default: 8, description: "Maximum number of results." },
        tool: { type: "string", description: "Optional exact tool filter." },
        project: { type: "string", description: "Optional project/workspace substring filter." },
        scope: { type: "string", description: "Optional scope filter such as user, feedback, project, task, run, or summary." },
        sourceKind: { type: "string", description: "Optional source kind filter such as session, writeback, cron, run, or blackboard." },
        workspace: { type: "string", description: "Optional workspace filter." },
        taskState: { type: "string", description: "Optional task state filter." },
        preferSummaries: { type: "boolean", default: false, description: "Boost session/summary records slightly in ranking." },
        includeVerbatim: {
          type: "boolean",
          default: false,
          description: "When true, attach query-aware exact snippet windows from the matched record text.",
        },
        snippetWindow: {
          type: "number",
          default: 220,
          description: "Approximate character window to keep around each exact snippet match.",
        },
        maxVerbatimPerResult: {
          type: "number",
          default: 1,
          description: "Maximum exact snippet windows to return per result when includeVerbatim is enabled.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memory_records",
    description:
      "Fetch full structured records by ID from the canonical shared Obsidian memory bus. Returns all available fields including content, facts, concepts, files_read, files_modified, scope, memory_level, freshness, and confidence.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of record IDs to fetch.",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "refine_memory_selection",
    description:
      "Given a query and a list of memory record IDs, use an LLM to select the most relevant subset. Use this after get_memory_records returns too many results and you need the top-N most relevant to your current task.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The current task or question context" },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of memory record IDs to refine from (from get_memory_records)",
          maxItems: 50,
        },
        max_results: {
          type: "number",
          default: 5,
          description: "Maximum number of records to return (default 5)",
        },
      },
      required: ["query", "ids"],
    },
  },
  {
    name: "get_memory_timeline",
    description:
      "Given an anchor record ID, return chronologically interleaved nearby records. Useful for navigating backward and forward from a known record.",
    inputSchema: {
      type: "object",
      properties: {
        anchor_id: { type: "string", description: "The anchor record ID." },
        depth_before: { type: "number", default: 3, description: "Number of records to return before the anchor." },
        depth_after: { type: "number", default: 3, description: "Number of records to return after the anchor." },
      },
      required: ["anchor_id"],
    },
  },
  {
    name: "clear_shared_memory_search_cache",
    description:
      "Clear the persistent shared retrieval worker's in-memory search caches. Optionally also clear loaded entry/index data so the next query fully reloads state from disk.",
    inputSchema: {
      type: "object",
      properties: {
        includeDataCaches: {
          type: "boolean",
          default: false,
          description: "When true, also drop the loaded entries and embeddings index caches in addition to query/BM25/result caches.",
        },
      },
    },
  },
  {
    name: "get_entity_info",
    description:
      "Query the knowledge graph for an entity's relationships and metadata. Use this to find what is known about a specific person, project, tool, or concept across all memory records.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Entity name to look up (e.g. 'Alice', 'MemPalace', 'ChromaDB').",
        },
        direction: {
          type: "string",
          default: "both",
          description: "Relationship direction: 'outgoing' (entity → ?), 'incoming' (? → entity), or 'both'.",
          enum: ["outgoing", "incoming", "both"],
        },
        as_of: {
          type: "string",
          description: "Optional date (YYYY-MM-DD) — return only facts that were true at that time.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "search_by_entity",
    description:
      "Search the knowledge graph for entities matching a name query, then return their relationships and optionally a timeline. Use this to explore connections between people, projects, and concepts across your memory.",
    inputSchema: {
      type: "object",
      properties: {
        entity_query: {
          type: "string",
          description: "Partial or full name to search for in the entity index.",
        },
        include_timeline: {
          type: "boolean",
          default: false,
          description: "When true, also return a chronological timeline for the top matched entity.",
        },
      },
      required: ["entity_query"],
    },
  },
  {
    name: "list_embedding_runtimes",
    description:
      "List the configured embedding defaults, providers, and profiles, along with the currently resolved active runtime and whether the dense index is aligned or needs a rebuild.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "set_embedding_runtime",
    description:
      "Activate an embedding profile or provider in the runtime config. Returns the updated runtime selection and whether the dense embeddings index now needs a rebuild.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Configured embedding profile name to activate." },
        provider: { type: "string", description: "Configured provider name to activate directly." },
        clearProfile: { type: "boolean", default: false, description: "Clear the persisted activeProfile selection." },
        clearProvider: { type: "boolean", default: false, description: "Clear the persisted activeProvider selection." },
      },
    },
  },
  {
    name: "rebuild_memory_layers",
    description:
      "Rebuild derived shared memory layers such as shared inbox records, session-layer records, and shared event records.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "build_handoff_pack",
    description:
      "Build a bounded handoff pack with current goal, done, next, blocked, files, open threads, and tool invariants.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run_memory_dream",
    description:
      "Run one memory dream consolidation pass over durable, session, and task layers to refresh AUTO-DREAM summaries.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", default: false, description: "Force a dream pass even when gates would normally skip." },
      },
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
  {
    name: "get_kg_stats",
    description:
      "Get knowledge graph statistics: total entities, total relationships, and entity counts broken down by type.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "query_kg",
    description:
      "Search the knowledge graph by entity name. Returns matching entities with their relationships and confidence scores. Use this to explore connections between people, projects, concepts, and tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Entity name (partial or full) to search for.",
        },
        type: {
          type: "string",
          description: "Optional entity type filter: 'person', 'project', 'concept', 'org', 'location'.",
          enum: ["person", "project", "concept", "org", "location"],
        },
        limit: {
          type: "number",
          default: 10,
          description: "Maximum number of matching entities to return.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_entities",
    description:
      "Get all entities of a specific type from the knowledge graph. Useful for listing all people, projects, concepts, etc.",
    inputSchema: {
      type: "object",
      properties: {
        entityType: {
          type: "string",
          description: "Entity type: 'person', 'project', 'concept', 'tool', 'org', 'location', or 'unknown'.",
        },
        limit: {
          type: "number",
          default: 50,
          description: "Maximum number of entities to return.",
        },
      },
      required: ["entityType"],
    },
  },
  {
    name: "get_relationships",
    description:
      "Get all relationships (incoming and outgoing) for an entity in the knowledge graph.",
    inputSchema: {
      type: "object",
      properties: {
        entityName: {
          type: "string",
          description: "Entity name to look up.",
        },
        direction: {
          type: "string",
          default: "both",
          description: "Relationship direction: 'outgoing', 'incoming', or 'both'.",
          enum: ["outgoing", "incoming", "both"],
        },
        limit: {
          type: "number",
          default: 50,
          description: "Maximum number of relationships to return.",
        },
      },
      required: ["entityName"],
    },
  },
];
