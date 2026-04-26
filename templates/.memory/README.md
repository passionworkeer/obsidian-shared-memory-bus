---
name: README
description: Agent integration guide for ADR-002 memory system
type: reference
adr: "002"
version: 1
---

# Agent Integration Guide — ADR-002

## Memory Types

| Type | Frontmatter `durable_type` | TTL |
|------|--------------------------|-----|
| User preference/constraint | `user` | Never (null) |
| Feedback (what worked/didn't) | `feedback` | 90 days |
| Project goal/initiative | `project` | Project end + 30d |
| External pointer | `reference` | 180 days |
| Session summary | `session` | 7 days (ephemeral) |

## Writing a Memory

```markdown
---
name: redis-connection-pool-tuning
description: Reduced Redis pool size from 50 to 20 after observing connection exhaustion under load
type: feedback
durable_type: feedback
content_hash: sha256:abc123...
promotion:
  version: 1
  durable_type: feedback
  key: redis-connection-pool-tuning
  reason: Repeatedly validated across multiple incidents
  source_type: consolidation
  source_confidence: 0.9
  promoted_at: 2026-04-03T00:00:00Z
provenance:
  consolidation_pass: 1
lifecycle:
  expires_at: 2026-07-02T00:00:00Z
  access_count: 0
  promotion_count: 1
---

# Redis Connection Pool Tuning

Observed connection exhaustion under sustained load...
```

## Retrieval

Use the MCP `search_memory` tool (via `omni-memory-server.js`) for hybrid search.

## Promotion Contract

Memories promoted via consolidation get v2 frontmatter. Session-layer memories remain ephemeral until explicitly promoted.

## Memory Tiering (5-Tier Architecture)

The system uses a 5-tier architecture. See `<repo-root>/docs/MEMORY-TIERING.md`.

| Tier | Name | Embedding | Notes |
|------|------|-----------|-------|
| 1 | Event/Working | No | 1d TTL; session-end + confidence≥0.5 → Tier2 |
| 2 | Session Durable | No | session+7d TTL; age>30d → Archive |
| 3 | Project Durable | **Yes** | project+30d TTL; cross-session validation |
| 4 | Shared Durable | **Yes** | user=never/feedback=90d/reference=180d |
| 5 | Archive | No | `archive-manifest.jsonl` replaces tombstone |

Only Tier 3 and Tier 4 are stored in the embedding index. Archive records are tracked in `00-System/ai-memory/archived/archive-manifest.jsonl` to avoid polluting the vector space.

## Token Budget

Per-tier record limits and eviction rules are defined in `<repo-root>/templates/.memory/config/tier-budget.json`. The `ops/memory-archival.js` enforces these budgets automatically.

## Retrieval Modes

Adaptive retrieval modes (cold-start, three-mode switching, recall signals) are documented in `<repo-root>/docs/MEMORY-TIERING.md`.

