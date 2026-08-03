---
title: MCP Tool API Reference
description: Current split-service inventory for all shared-memory MCP tools.
platform: cross-platform
---

# MCP Tool API Reference / MCP 工具 API 参考

The memory runtime is split across four HTTP MCP endpoints by default. The exact machine-readable input schema is returned by MCP `tools/list` and is defined in `shared-mcp/memory-tools.js`. Service membership is defined in `shared-mcp/tool-registry.js`.

不要再把 9338 当作包含全部工具的单体服务。默认拓扑如下：

| Service | Endpoint | Responsibility |
| --- | --- | --- |
| `memory-retrieval` | `http://127.0.0.1:9338/mcp` | Read-only status, bootstrap, retrieval and timeline tools |
| `memory-bridge` | `http://127.0.0.1:9339/mcp` | Claude Mem, OpenClaw blackboard and derived-layer bridges |
| `memory-dream` | `http://127.0.0.1:9340/mcp` | Embedding rebuild and memory consolidation |
| `memory-mgmt` | `http://127.0.0.1:9341/mcp` | Canonical writes, runtime selection and knowledge-graph management |

Legacy monolithic mode remains available with `AI_MEMORY_SERVER_MODE=monolithic` or `all`, but split mode is the default.

## Retrieval service — 9338

| Tool | Main inputs | Purpose |
| --- | --- | --- |
| `memory_status` | none | Inspect runtime, integrity, search worker and embedding-index health |
| `get_memory_overview` | `workspace_root`, `include_stats` | Project-level memory overview |
| `memory_wake_up` | `workspace_root`, `max_items`, `include_recent_activity` | Compact session bootstrap pack |
| `search_shared_memory` | `query`, `mode`, `route`, `limit`, filters, snippet options | Canonical hybrid retrieval |
| `get_memory_records` | `ids` | Fetch full structured records by ID |
| `refine_memory_selection` | `query`, `ids`, `max_results` | Select the most relevant records from a candidate set |
| `get_memory_timeline` | `anchor_id`, `depth_before`, `depth_after` | Navigate chronologically around one record |
| `clear_shared_memory_search_cache` | `includeDataCaches` | Clear search-worker caches |
| `get_entity_info` | `name`, `direction`, `as_of` | Inspect one entity and its relationships |
| `search_by_entity` | `entity_query`, `include_timeline` | Find entities and related memory |
| `memory_boot` | `project`, `cwd`, `top_k` | Legacy-compatible compact project context |
| `memory_search` | `query`, `project`, `cwd`, `top_k` | Legacy-compatible project BM25 search |
| `memory_query` | `query`, `depth`, `project`, `cwd`, `top_k` | Legacy-compatible compact/full query result |

### Primary retrieval call

`search_shared_memory` requires `query`. Important options:

| Parameter | Values / default |
| --- | --- |
| `mode` | `bm25`, `dense`, `hybrid`, `auto`; default `hybrid` |
| `route` | `auto`, `mixed`, `durable`, `task`, `recent`, `reference`; default `auto` |
| `limit` | default `8` |
| `tool`, `project`, `scope`, `sourceKind`, `workspace`, `taskState` | optional filters |
| `preferSummaries` | default `false` |
| `includeVerbatim` | default `false` |
| `snippetWindow` | default `220` |
| `maxVerbatimPerResult` | default `1` |

`memory_wake_up` accepts `workspace_root`; it does not accept a `project` parameter. `memory_boot` is the compatibility tool that accepts `project`.

## Bridge service — 9339

| Tool | Main inputs | Purpose |
| --- | --- | --- |
| `query_claude_mem` | `query`, `limit` | Query the local Claude Mem bridge |
| `insert_claude_mem` | `content`, `metadata` | Insert into Claude Mem compatibility storage |
| `get_blackboard_tasks` | `limit`, `state`, `states` | Read OpenClaw blackboard tasks |
| `write_blackboard_task` | `repo`, `issue_number`, `assigned_agent`, `issue_title` | Create an OpenClaw blackboard task |
| `build_handoff_pack` | none | Build the bounded handoff artifact |
| `rebuild_memory_layers` | none | Rebuild derived structured-memory layers |

## Dream service — 9340

| Tool | Main inputs | Purpose |
| --- | --- | --- |
| `run_memory_dream` | `force` | Run one consolidation/promotion pass |
| `rebuild_memory_embeddings` | `force` | Rebuild the dense embedding index |
| `rebuild_shared_embeddings` | `force` | Alias for `rebuild_memory_embeddings` |

## Management service — 9341

| Tool | Main inputs | Purpose |
| --- | --- | --- |
| `memory_write` | `agent_id`, `project`, `cwd`, `facts` | Write schema-valid V2 records into canonical structured memory |
| `list_embedding_runtimes` | none | Inspect providers, profiles and index compatibility |
| `set_embedding_runtime` | `profile`, `provider`, `clearProfile`, `clearProvider` | Persist the selected embedding runtime |
| `get_kg_stats` | none | Return knowledge-graph statistics |
| `query_kg` | `query`, `type`, `limit` | Search knowledge-graph entities and relationships |
| `get_entities` | `entityType`, `limit` | List entities by type |
| `get_relationships` | entity/relationship filters from `tools/list` | List graph relationships |

### Canonical write behavior

`memory_write` requires a non-empty `facts` array. Each fact requires non-empty `content`; optional fields include `title`, `tool`, `type`, `scope`, `memory_level`, `confidence`, `facts`, `decisions`, `entities`, `metadata`, `session_id` and `session_type`.

Successful writes create:

- a V2 canonical record in `<store>/structured/shared-inbox.jsonl`;
- a same-ID compatibility projection in `<store>/projects/<project>.jsonl`.

The canonical record includes `schemaVersion`, `id`, `tool`, `type`, `title`, `source`, `scope`, `memory_level`, `visibility`, `source_kind`, `content_hash` and timestamp fields. `memory_write` is intentionally not exposed by the read-only retrieval service.

## Runtime configuration and secrets

The writable runtime configuration is `<store>/config/runtime.json`, unless `AI_MEMORY_RUNTIME_CONFIG_PATH` is explicitly set. `templates/config/runtime.json` is read-only seed data and is never a write target.

Do not put `apiKey` in runtime JSON. Plaintext keys are ignored and removed on the next persisted update. Configure `apiKeyEnv` and place the real secret in that environment variable, or use `AI_MEMORY_EMBED_API_KEY`.

After changing adapter, model or base URL, check `memory_status.embeddingIndexState`. Rebuild embeddings when `rebuildRequired` is true.

## Errors and transport

All tools return MCP text content containing JSON. Tool failures set `isError: true` and include an `error` string. Calling a tool on the wrong split endpoint returns `tool-not-found`.

For exact schemas and defaults, call `tools/list` against the target endpoint. Documentation CI verifies that every registered tool appears in this file, but `memory-tools.js` remains the executable source of truth.
