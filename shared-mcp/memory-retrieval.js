/**
 * memory-retrieval.js
 *
 * Handles all retrieval-oriented tools:
 *   search_shared_memory
 *   get_memory_records
 *   refine_memory_selection
 *   get_memory_timeline
 *   clear_shared_memory_search_cache
 *   get_entity_info
 *   search_by_entity
 *
 * Exposes a factory: createMemoryRetrieval(params) => { tools, handlers }
 * All state is passed in via params to avoid circular import issues.
 */

import { spawn } from "node:child_process";

const SEARCH_ROUTE_VALUES = new Set(["auto", "mixed", "durable", "task", "recent", "reference"]);

// ---------------------------------------------------------------------------
// Helpers (passed in via params)
// ---------------------------------------------------------------------------

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
      windowsHide: true,
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

async function runSemanticSearchOnce({
  params,
  query,
  mode = "hybrid",
  route = "auto",
  limit = 8,
  tool = "",
  project = "",
  scope = "",
  sourceKind = "",
  workspace = "",
  taskState = "",
  preferSummaries = false,
  includeVerbatim = false,
  snippetWindow = 220,
  maxVerbatimPerResult = 1,
}) {
  const { SEARCH_SCRIPT, VAULT_ROOT, PYTHON_SPAWN_ENV, PYTHON, withPythonArgs } = params;
  const normalizedRoute = SEARCH_ROUTE_VALUES.has(String(route || "").trim().toLowerCase())
    ? String(route || "").trim().toLowerCase()
    : "auto";
  const args = [SEARCH_SCRIPT, "--mode", mode, "--top-k", String(limit), "--json", query];
  if (normalizedRoute) {
    args.push("--route", normalizedRoute);
  }
  if (tool) {
    args.push("--tool", tool);
  }
  if (project) {
    args.push("--project", project);
  }
  if (scope) {
    args.push("--scope", scope);
  }
  if (sourceKind) {
    args.push("--source-kind", sourceKind);
  }
  if (workspace) {
    args.push("--workspace", workspace);
  }
  if (taskState) {
    args.push("--task-state", taskState);
  }
  if (preferSummaries) {
    args.push("--prefer-summaries");
  }
  if (includeVerbatim) {
    args.push("--include-verbatim");
    args.push("--snippet-window", String(snippetWindow));
    args.push("--max-verbatim-per-result", String(maxVerbatimPerResult));
  }

  const result = await spawnProcess(PYTHON.command, withPythonArgs(PYTHON, args), {
    env: {
      ...PYTHON_SPAWN_ENV,
      AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
    },
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `semantic-search-exit-${result.code}`);
  }
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * @param {Object} params
 * @param {Object} params.METRICS                 - Shared metrics object (modified in-place)
 * @param {Function} params.requestSearchWorker   - Server's requestSearchWorker function
 * @param {Function} params.getSearchWorkerHealth - Server's getSearchWorkerHealth function
 * @param {Function} params.clearSearchWorkerCache - Server's clearSearchWorkerCache function
 * @param {Object}  params.SEARCH_SCRIPT           - Absolute path to semantic-search.py
 * @param {string}  params.VAULT_ROOT             - Resolved Obsidian vault root
 * @param {Object}  params.PYTHON                 - Python runtime descriptor {command, argsPrefix, available, version, error}
 * @param {Object}  params.PYTHON_SPAWN_ENV       - Merged env object for spawning Python
 * @param {Function} params.withPythonArgs         - Helper: [pythonExe, ...pythonArgs, ...scriptArgs]
 */
export function createMemoryRetrieval(params) {

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleSearchSharedMemory(args) {
    const query = String(args.query || "").trim();
    if (!query) {
      return errorResult("query is required");
    }
    const mode = String(args.mode || args.strategy || "hybrid");
    const route = String(args.route || "auto");
    const normalizedRoute = SEARCH_ROUTE_VALUES.has(route.trim().toLowerCase())
      ? route.trim().toLowerCase()
      : "auto";
    const limit = Math.max(1, Number(args.limit) || 8);
    const includeVerbatim = Boolean(args.includeVerbatim);
    const snippetWindow = Math.max(80, Math.min(600, Number(args.snippetWindow) || 220));
    const maxVerbatimPerResult = Math.max(1, Math.min(5, Number(args.maxVerbatimPerResult) || 1));

    const searchStartMs = Date.now();
    const normalizedMode = mode.trim().toLowerCase() || "hybrid";

    try {
      const payload = await params.requestSearchWorker(
        {
          action: "search",
          query,
          mode: normalizedMode,
          route: normalizedRoute,
          limit,
          tool: String(args.tool || ""),
          project: String(args.project || ""),
          scope: String(args.scope || ""),
          sourceKind: String(args.sourceKind || ""),
          workspace: String(args.workspace || ""),
          taskState: String(args.taskState || ""),
          preferSummaries: Boolean(args.preferSummaries),
          includeVerbatim,
          snippetWindow,
          maxVerbatimPerResult,
        },
        120000
      );
      return jsonResult(payload);
    } catch (error) {
      // Fall back to one-shot search
      try {
        return jsonResult(
          await runSemanticSearchOnce({
            params,
            query,
            mode: normalizedMode,
            route: normalizedRoute,
            limit,
            tool: String(args.tool || ""),
            project: String(args.project || ""),
            scope: String(args.scope || ""),
            sourceKind: String(args.sourceKind || ""),
            workspace: String(args.workspace || ""),
            taskState: String(args.taskState || ""),
            preferSummaries: Boolean(args.preferSummaries),
            includeVerbatim,
            snippetWindow,
            maxVerbatimPerResult,
          })
        );
      } catch (_fallbackError) {
        if (!params.METRICS.searches_total[normalizedRoute]) {
          params.METRICS.searches_total[normalizedRoute] = {};
        }
        params.METRICS.searches_total[normalizedRoute].error =
          (params.METRICS.searches_total[normalizedRoute].error || 0) + 1;
        throw error;
      }
    } finally {
      const latency = (Date.now() - searchStartMs) / 1000;
      params.METRICS.search_latency_seconds.push(latency);
      if (params.METRICS.search_latency_seconds.length > 100) {
        params.METRICS.search_latency_seconds.shift();
      }
      if (!params.METRICS.searches_total[normalizedRoute]) {
        params.METRICS.searches_total[normalizedRoute] = {};
      }
      if (params.METRICS.searches_total[normalizedRoute].ok === undefined) {
        params.METRICS.searches_total[normalizedRoute].ok =
          (params.METRICS.searches_total[normalizedRoute].ok || 0) + 1;
      }
    }
  }

  async function handleGetMemoryRecords(args) {
    const ids = Array.isArray(args.ids) ? args.ids.map((v) => String(v || "").trim()).filter(Boolean) : [];
    if (ids.length === 0) {
      return errorResult("ids is required and must be a non-empty array");
    }
    const payload = await params.requestSearchWorker({ action: "get_records", ids }, 60000);
    return jsonResult(payload);
  }

  async function handleRefineMemorySelection(args) {
    const ids = Array.isArray(args.ids)
      ? args.ids.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    if (ids.length === 0) {
      return errorResult("ids is required and must be a non-empty array");
    }
    const maxResults = Math.max(1, Number(args.max_results) || 5);
    const query = String(args.query || "").trim();
    if (!query) {
      return errorResult("query is required");
    }

    // 1. Fetch full records via the search worker
    let records;
    try {
      const recordsPayload = await params.requestSearchWorker({ action: "get_records", ids }, 60000);
      records = recordsPayload?.records || [];
    } catch (err) {
      return errorResult(`get_memory_records failed: ${err.message}`);
    }

    if (records.length === 0) {
      return jsonResult({ ok: true, selected: [], reasoning: "No records found for the given IDs." });
    }

    // 2. Build the LLM prompt
    const recordsSection = records
      .map((rec) => {
        const facts = Array.isArray(rec.facts)
          ? rec.facts.map((f) => (typeof f === "string" ? f : JSON.stringify(f))).join("; ")
          : "";
        const concepts = Array.isArray(rec.concepts)
          ? rec.concepts.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("; ")
          : "";
        return [
          `---`,
          `ID: ${rec.id}`,
          `Type: ${rec.type || ""} | Scope: ${rec.scope || ""} | Tool: ${rec.tool || ""}`,
          `Title: ${(rec.title || "").trim()}`,
          `Description: ${(rec.description || "").trim()}`,
          `Content: ${(rec.content || "").trim().slice(0, 2000)}`,
          facts ? `Facts: ${facts}` : "",
          concepts ? `Concepts: ${concepts}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");

    const refinementPrompt = `You are a memory relevance selector. Given a query and a list of memory records, select the top-N most relevant ones.

QUERY: ${query}

MEMORY RECORDS:
${recordsSection}
---

Return a JSON object with:
{
  "selected": [{"id": "...", "reason": "why this is relevant"}, ...],
  "reasoning": "brief explanation of the overall selection strategy"
}

Select at most ${maxResults} records. Prioritize records that directly address the query.
Only include records that are genuinely relevant. Return fewer than max_results if appropriate.`;

    // 3. Resolve LLM API configuration
    const { firstNonEmptyEnv } = params;
    const apiKey =
      firstNonEmptyEnv("OPENAI_API_KEY") ||
      firstNonEmptyEnv("ANTHROPIC_API_KEY") ||
      firstNonEmptyEnv("AI_MEMORY_EMBED_API_KEY") ||
      "";

    if (!apiKey) {
      const fallback = ids.slice(0, maxResults);
      return jsonResult({
        ok: true,
        fallback: true,
        selected: fallback.map((id) => ({ id, reason: "LLM unavailable, returning by original order" })),
        reasoning:
          "No LLM API key configured (checked OPENAI_API_KEY, ANTHROPIC_API_KEY, AI_MEMORY_EMBED_API_KEY). Returned top N by original order.",
      });
    }

    const baseUrl = (firstNonEmptyEnv("AI_MEMORY_EMBED_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = firstNonEmptyEnv("AI_MEMORY_REFINE_MODEL") || "gpt-4o-mini";
    const isAnthropic = Boolean(firstNonEmptyEnv("ANTHROPIC_API_KEY")) && !firstNonEmptyEnv("OPENAI_API_KEY");

    // 4. Call the LLM
    let llmResponse;
    try {
      const body = isAnthropic
        ? {
            model,
            max_tokens: 1024,
            messages: [{ role: "user", content: refinementPrompt }],
          }
        : {
            model,
            max_tokens: 1024,
            temperature: 0.2,
            messages: [{ role: "user", content: refinementPrompt }],
          };

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(isAnthropic
            ? { "x-api-key": apiKey, "anthropic-version": "2023-05-31" }
            : { Authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`LLM API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      llmResponse = isAnthropic
        ? data.content?.[0]?.text || ""
        : data.choices?.[0]?.message?.content || "";
    } catch (err) {
      const fallbackIds = ids.slice(0, maxResults);
      return jsonResult({
        ok: true,
        fallback: true,
        selected: fallbackIds.map((id) => ({ id, reason: `LLM call failed: ${err.message}` })),
        reasoning: `LLM call failed (${err.message}). Returned top N by original order.`,
      });
    }

    // 5. Parse the LLM response
    let parsed = null;
    try {
      const stripped = llmResponse
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      parsed = JSON.parse(stripped);
    } catch {
      const match = llmResponse.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // fall through to error
        }
      }
    }

    if (!parsed || !Array.isArray(parsed.selected) || parsed.selected.length === 0 || !parsed.selected[0]?.id) {
      const fallbackIds = ids.slice(0, maxResults);
      return jsonResult({
        ok: true,
        fallback: true,
        selected: fallbackIds.map((id) => ({ id, reason: "LLM response was not parseable" })),
        reasoning: `LLM returned unparseable response. Returned top N by original order.\n\nRaw: ${llmResponse.slice(0, 300)}`,
      });
    }

    // 6. Validate selected IDs exist in the input set
    const validIdSet = new Set(ids);
    const validSelected = parsed.selected
      .filter((s) => s?.id && validIdSet.has(String(s.id).trim()))
      .slice(0, maxResults)
      .map((s) => ({ id: String(s.id).trim(), reason: String(s.reason || "").trim() }));

    return jsonResult({
      ok: true,
      selected: validSelected,
      reasoning: String(parsed.reasoning || "").trim(),
      llmModel: model,
    });
  }

  async function handleGetMemoryTimeline(args) {
    const anchorId = String(args.anchor_id || "").trim();
    if (!anchorId) {
      return errorResult("anchor_id is required");
    }
    const payload = await params.requestSearchWorker(
      {
        action: "timeline",
        anchor_id: anchorId,
        depth_before: Math.max(0, Number(args.depth_before) || 3),
        depth_after: Math.max(0, Number(args.depth_after) || 3),
      },
      60000
    );
    return jsonResult(payload);
  }

  async function handleClearSharedMemorySearchCache(args) {
    return jsonResult(
      await params.clearSearchWorkerCache({
        includeDataCaches: Boolean(args.includeDataCaches),
      })
    );
  }

  // ── Entity / knowledge-graph handlers ─────────────────────────────────

  function loadKnowledgeGraph() {
    try {
      const { KnowledgeGraph } = require("../../ops/knowledge-graph.js");
      return new KnowledgeGraph({ vaultRoot: params.VAULT_ROOT });
    } catch {
      return null;
    }
  }

  async function handleGetEntityInfo(args) {
    const name = String(args.name || "").trim();
    if (!name) return errorResult("name is required");

    const kg = loadKnowledgeGraph();
    if (!kg) return errorResult("knowledge-graph-unavailable: run build-memory-layers.js first");

    try {
      const entity = kg.getEntity(name);
      if (!entity) {
        return jsonResult({ ok: true, name, found: false, relationships: [] });
      }
      const relationships = kg.queryEntity(name, {
        direction: args.direction || "both",
        asOf: args.as_of || null,
      });
      return jsonResult({ ok: true, found: true, entity, relationships });
    } finally {
      try { kg.close(); } catch {}
    }
  }

  async function handleSearchByEntity(args) {
    const entityQuery = String(args.entity_query || "").trim();
    if (!entityQuery) return errorResult("entity_query is required");

    const kg = loadKnowledgeGraph();
    if (!kg) return errorResult("knowledge-graph-unavailable: run build-memory-layers.js first");

    try {
      // 1. Find matching entities
      const matchedEntities = kg.searchEntities(entityQuery);

      // 2. For each matched entity, get their relationships
      const results = [];
      for (const entity of matchedEntities.slice(0, 10)) {
        const rels = kg.queryEntity(entity.name, { direction: "both" });
        results.push({ entity, relationships: rels });
      }

      // 3. Optionally get the full timeline for top entity
      let timeline = [];
      if (results.length > 0 && args.include_timeline) {
        timeline = kg.timeline(results[0].entity.name).slice(0, 20);
      }

      return jsonResult({
        ok: true,
        query: entityQuery,
        matchedEntities: matchedEntities.length,
        results,
        timeline,
      });
    } finally {
      try { kg.close(); } catch {}
    }
  }

  // ── KG stats ───────────────────────────────────────────────────────────

  async function handleGetKgStats(_args) {
    const kg = loadKnowledgeGraph();
    if (!kg) return errorResult("knowledge-graph-unavailable: run build-memory-layers.js first");
    try {
      const stats = kg.stats();
      // Get entity counts by type via the known type list
      const knownTypes = ["person", "project", "concept", "tool", "org", "location", "unknown"];
      const entitiesByType = {};
      let totalFromTypes = 0;
      for (const t of knownTypes) {
        const rows = kg.getEntitiesByType(t);
        entitiesByType[t] = rows.length;
        totalFromTypes += rows.length;
      }
      // Handle any unknown custom types not in the known list
      if (totalFromTypes < stats.entities) {
        entitiesByType["other"] = stats.entities - totalFromTypes;
      }
      return jsonResult({
        ok: true,
        totalEntities: stats.entities,
        totalRelationships: stats.triples,
        currentFacts: stats.currentFacts,
        expiredFacts: stats.expiredFacts,
        relationshipTypes: stats.relationshipTypes,
        entitiesByType,
      });
    } finally {
      try { kg.close(); } catch {}
    }
  }

  async function handleQueryKg(args) {
    const query = String(args.query || "").trim();
    if (!query) return errorResult("query is required");
    const limit = Math.max(1, Number(args.limit ?? 10) || 10);
    const typeFilter = args.type ? String(args.type).trim() : null;

    const kg = loadKnowledgeGraph();
    if (!kg) return errorResult("knowledge-graph-unavailable: run build-memory-layers.js first");
    try {
      let matched = kg.searchEntities(query, { limit });
      if (typeFilter) {
        matched = matched.filter((e) => e.type === typeFilter);
      }
      const results = [];
      for (const entity of matched.slice(0, limit)) {
        const rels = kg.queryEntity(entity.name, { direction: "both" });
        results.push({ entity, relationships: rels.slice(0, limit) });
      }
      return jsonResult({
        ok: true,
        query,
        typeFilter,
        totalMatched: matched.length,
        results,
      });
    } finally {
      try { kg.close(); } catch {}
    }
  }

  async function handleGetEntities(args) {
    const entityType = String(args.entityType || "").trim();
    if (!entityType) return errorResult("entityType is required");
    const limit = Math.max(1, Number(args.limit ?? 50) || 50);

    const kg = loadKnowledgeGraph();
    if (!kg) return errorResult("knowledge-graph-unavailable: run build-memory-layers.js first");
    try {
      const rows = kg.getEntitiesByType(entityType);
      return jsonResult({
        ok: true,
        entityType,
        total: rows.length,
        entities: rows.slice(0, limit),
      });
    } finally {
      try { kg.close(); } catch {}
    }
  }

  async function handleGetRelationships(args) {
    const entityName = String(args.entityName || "").trim();
    if (!entityName) return errorResult("entityName is required");
    const direction = args.direction || "both";
    const limit = Math.max(1, Number(args.limit ?? 50) || 50);

    const kg = loadKnowledgeGraph();
    if (!kg) return errorResult("knowledge-graph-unavailable: run build-memory-layers.js first");
    try {
      const rels = kg.queryEntity(entityName, { direction });
      return jsonResult({
        ok: true,
        entityName,
        direction,
        total: rels.length,
        relationships: rels.slice(0, limit),
      });
    } finally {
      try { kg.close(); } catch {}
    }
  }

  return {
    handlers: {
      search_shared_memory: handleSearchSharedMemory,
      get_memory_records: handleGetMemoryRecords,
      refine_memory_selection: handleRefineMemorySelection,
      get_memory_timeline: handleGetMemoryTimeline,
      clear_shared_memory_search_cache: handleClearSharedMemorySearchCache,
      get_entity_info: handleGetEntityInfo,
      search_by_entity: handleSearchByEntity,
      get_kg_stats: handleGetKgStats,
      query_kg: handleQueryKg,
      get_entities: handleGetEntities,
      get_relationships: handleGetRelationships,
    },
  };
}
