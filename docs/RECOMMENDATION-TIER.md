---
name: RECOMMENDATION-TIER
description: Adaptive retrieval modes — cold-start rules, 3-mode switching, recall signal accumulation
type: spec
version: 2
adr: "002"
---

# Recommendation Tier — Adaptive Retrieval Modes

## Overview

Retrieval operates in one of three modes. The mode is selected dynamically based on Hit@3 history, query characteristics, and cold-start state. This replaces the prior static hybrid approach.

---

## Cold-Start Rules (Q7 Fix)

**Problem:** Without prior Hit@3 data the system would default to Exploration (wide candidate pool), which wastes tokens on queries that don't need it.

**Fix: Default to Exploitation during cold-start.**

- **Cold-start period:** First 100 retrieval calls (`retrieval-stats.json` tracks `total_calls`)
- **Cold-start default:** `Exploitation` mode (standard parameters, no candidate expansion)
- **Exploration** only triggers on explicit signals (not by default):

| Signal | Description | Trigger |
|--------|-------------|---------|
| `query_length < 5 tokens` | Very short / ambiguous query | Exploration |
| `query contains fuzzy char (* ? ~)` | Wildcard or partial match | Exploration |
| First retrieval of a scope category | No history for this scope yet | Exploration |
| `Hit@3 < 0.5` (post-cold-start) | Recent recall failures | Exploration |

> After 100 calls, real `Hit@3` metrics take over.

---

## Three Adaptive Modes

| Mode | Trigger | maxResults | minScore | Diversity |
|------|---------|-----------|----------|-----------|
| **Exploration** | Hit@3 < 0.5 OR cold-start signal | 8 | 0.25 | High |
| **Exploitation** | Hit@3 0.5–0.75 OR cold-start default | 5 | 0.35 | Standard |
| **Confidence** | Hit@3 ≥ 0.75 | 3 | 0.50 | Low |

---

## Mode Switching Logic

```
IF cold_start (total_calls < 100):
  → Exploitation (default)

ELSE:
  hit3 = retrieval_stats.hit_at_3   # rolling Hit@3

  IF hit3 >= 0.75:
    → Confidence
  ELSE IF hit3 >= 0.5:
    → Exploitation
  ELSE:
    → Exploration
```

**Note:** Per-route Hit@3 is tracked separately (`routes.durable.hit_at_3`, `routes.task.hit_at_3`, etc.) so mode switching is route-specific.

---

## Recall Signal Accumulation

Agents confirm memories are useful by sending a `recall_signal`. When accumulated, this flags records for Tier 3→4 promotion.

```
signal_count >= 3 AND retrieval_score >= 0.65
  → Flag record as Tier 3→4 promotion candidate
  → Write to promotion queue
```

`eval-routing.py` writes `retrieval-stats.json` per route:
```json
{
  "total_calls": 247,
  "routes": {
    "durable": { "hit_at_3": 0.71, "total_calls": 180 },
    "task":    { "hit_at_3": 0.55, "total_calls": 67 }
  },
  "recall_signals": { "record-id-123": { "count": 3, "avg_score": 0.72 } }
}
```

---

## Embedding Index Participation

Only Tier 3 and Tier 4 records are stored in the embedding index. This is enforced by `generate-embeddings.js --tier-filter project+durable`.

| Tier | Embedding | Recommendation Candidate | Notes |
|------|-----------|--------------------------|-------|
| 1 Event/Working | No | No | Real-time buffer, 1d TTL |
| 2 Session Durable | No | No | Post-session consolidation |
| 3 Project Durable | **Yes** | **Yes** | Only embedded tier |
| 4 Shared Durable | **Yes** | **Yes** | Shared across projects |
| 5 Archive | No | No | `archived=true` marker in index |

---

## Tier 3→4 Promotion via Recall

Records are promoted from Tier 3 to Tier 4 via recall signals, not by time:

1. Agent calls `search_shared_memory` and marks result as useful
2. `recall_signal.count++` for that record ID
3. When `count >= 3 AND avg_score >= 0.65`:
   - `memory-archival.js` marks record for Tier 4 promotion
   - `lifecycle.tier` updated to `4`
   - `lifecycle.expires_at` set per scope TTL (user=null, feedback=90d, reference=180d)

---

## Configuration

See `templates/.memory/config/retrieval.json` for route profiles, weights, and decay settings.

See `retrieval/eval-routing.py` for the evaluation harness that computes Hit@3 per route.

---

## Idempotency

All mode decisions are based on immutable stats (`retrieval-stats.json` appends, never rewrites history). Re-running routing with the same stats always produces the same mode.
