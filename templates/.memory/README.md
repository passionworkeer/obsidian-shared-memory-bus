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
