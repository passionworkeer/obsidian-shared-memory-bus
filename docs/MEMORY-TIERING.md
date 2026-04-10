---
name: MEMORY-TIERING
description: 5-tier memory architecture spec — Event/Working → Session Durable → Project Durable → Shared Durable → Archive
type: spec
version: 2
supersedes: 4-layer (2025)
adr: "002"
---

# Memory Tiering Architecture

## Overview

Memory records live in one of five tiers, each with distinct TTL, embedding behaviour, and promotion rules. All tier transitions are **idempotent** — re-running the same promotion logic on an already-promoted record is a no-op.

---

## 5-Tier Reference Table

| Tier | Name | TTL | Embedding Index | Recommendation Candidate | Primary Trigger |
|------|------|-----|----------------|--------------------------|-----------------|
| 1 | **Event / Working** | 1 day (real-time) | No | No | session-end signal + `confidence ≥ 0.5` |
| 2 | **Session Durable** | session end + 7 days | No | No | `age > 30 d` without confidence → Archive |
| 3 | **Project Durable** | project end + 30 days | **Yes** | **Yes** | cross-session validation (3+ sessions) + `confidence ≥ 0.7` |
| 4 | **Shared Durable** | user=never / feedback=90 d / reference=180 d | **Yes** | **Yes** | TTL expiry OR 60 d no access → Archive |
| 5 | **Archive** | Manual (never auto-deleted) | No (manifest only) | No | Manual or budget-pressure eviction |

---

## Tier 1 — Event / Working

**Role:** Real-time working buffer for the current session. Captures ephemeral facts before they are confirmed or discarded.

### Rules
- TTL = **1 day** from creation (not 7 days — see Q2 fix note below).
- Age alone does **not** trigger Tier 1→2 promotion.
- Promotion trigger: **session-end signal** + `confidence ≥ 0.5`.
- Records older than 1 day with no session-end signal → scanned by `memory-archival.js` for Archive.

### Idempotent Promotion 1→2
```js
// Only promote if not already Tier 2+
if (record.tier !== undefined && record.tier >= 2) return  // no-op

if (session_end_signal === true && confidence >= 0.5) {
  record.tier = 2
  record.lifecycle.promoted_from = 'event'
  record.lifecycle.promotion_count = (record.lifecycle.promotion_count || 0) + 1
}
```

> **Q2 Fix:** Previous design used `age > 7 d` as the Tier 1→2 trigger, which made Tier 1 identical to a "Tier 2 waiting room." The fix separates concerns: Tier 1 is now a true real-time buffer (1 d TTL), Tier 2 is the post-session consolidation layer.

---

## Tier 2 — Session Durable

**Role:** Confirmed session learnings, kept for 7 days after session ends, then evaluated for project-level promotion or Archive.

### Rules
- TTL = **session end + 7 days** (stored in `lifecycle.expires_at`).
- No embedding — kept for agent session context only.
- Not a recommendation candidate (too session-specific).
- Promotion trigger to Tier 3: **3+ independent sessions** reference the same fact + `confidence ≥ 0.7`.

### Idempotent Promotion 2→3
```js
if (record.tier >= 3) return  // no-op

const crossSessionHits = countUniqueSessionsReferencing(record.id)
if (crossSessionHits >= 3 && confidence >= 0.7) {
  record.tier = 3
  record.lifecycle.promoted_from = 'session'
  record.lifecycle.promotion_count = (record.lifecycle.promotion_count || 0) + 1
}
```

---

## Tier 3 — Project Durable

**Role:** Cross-session validated facts scoped to a specific project.

### Rules
- TTL = **project end + 30 days** (project declared "ended" via frontmatter flag or inactivity timeout).
- **Participates in embedding index** — used for recall and recommendation.
- **Recommendation candidate** — included in `maxResults` candidate pools.
- Promotion trigger to Tier 4: same fact appears in multiple projects OR manually flagged by agent.

---

## Tier 4 — Shared Durable

**Role:** Cross-project truths. User preferences, feedback patterns, reference material.

### Rules
- TTL by scope:
  - `user` scope → **never expires** (revocable only)
  - `feedback` scope → **90 days**
  - `reference` scope → **180 days**
- **Participates in embedding index.**
- **Recommendation candidate.**
- Archive trigger: TTL expiry OR 60 days with zero `access_count`.

---

## Tier 5 — Archive

**Role:** Long-term cold storage. Records are preserved but excluded from embedding index to prevent vector-space pollution.

### Rules
- **No embedding index entry** — no vector stored.
- **Audit trail via `archive-manifest.jsonl`** (not tombstone — see Q3 fix).
- Records remain queryable by ID for provenance / audit purposes.
- `memory-archival.js` writes manifest entry; `generate-embeddings.js` marks vectors as `archived=true` on incremental rebuild.

> **Q3 Fix:** The previous tombstone approach required writing a deletion marker into the embedding index, which polluted the vector space. The fix replaces tombstones with a manifest file and an `archived=true` metadata flag on existing vectors.

### archive-manifest.jsonl Schema
```json
{
  "id": "record-id",
  "tier_from": 4,
  "archived_at": "2026-04-10T00:00:00Z",
  "reason": "ttl_expired|access_count_zero|budget_pressure|manual",
  "trigger": "watchdog|dream|manual",
  "archived_by": "memory-archival.js",
  "original_scope": "feedback",
  "original_type": "feedback",
  "content_hash": "sha256:...",
  "line_in_source": "shared-inbox.jsonl:42"
}
```

---

## Embedding Index Rules

| Tier | Stored in Embedding Index | Recommendation Candidate |
|------|--------------------------|--------------------------|
| 1 Event/Working | No | No |
| 2 Session Durable | No | No |
| 3 Project Durable | **Yes** | **Yes** |
| 4 Shared Durable | **Yes** | **Yes** |
| 5 Archive | No (flagged `archived=true` on rebuild) | No |

`generate-embeddings.js --tier-filter project+durable` only indexes Tier 3 and 4 records.

---

## Idempotency Guarantees

All tier transitions use the pattern:
```
if (record.tier >= TARGET_TIER) return  // already promoted, no-op
```

This ensures:
1. Re-running dream consolidation never creates duplicate entries.
2. Watchdog and dream can both evaluate the same record without double-promoting.
3. `memory-archival.js` can be re-triggered mid-run without side effects.

---

## Lifecycle Fields

Every structured record MUST include a `lifecycle` block:

```yaml
lifecycle:
  tier: 2                    # integer 1–5
  expires_at: 2026-04-17T00:00:00Z  # ISO 8601; null = never
  access_count: 0            # incremented on each retrieval hit
  promotion_count: 1         # incremented on each tier promotion
  archived: false            # true when written to archive-manifest.jsonl
```

---

## Retention Policy

See: `templates/.memory/config/retention-policy.json`

| Tier | Default TTL | Archive Rule |
|------|------------|--------------|
| 1 | 1 d | age > 1 d + no session signal → scan for Archive |
| 2 | session + 7 d | age > 30 d without confidence → Archive |
| 3 | project + 30 d | project ended + age > 30 d → Archive |
| 4 | user=never / feedback=90 d / reference=180 d | TTL or access_count=0 for 60 d → Archive |
| 5 | Manual | Never auto-deleted |

---

## Tier Budget Enforcement

`memory-archival.js` enforces per-tier maximums. Exceeding budget triggers budget-pressure Archive (oldest first by `freshness_score`).

| Tier | Max Records | Auto Archive |
|------|------------|--------------|
| 1 Event/Working | 200 | Yes |
| 2 Session Durable | 200 | Yes |
| 3 Project Durable | 100 / project | Yes |
| 4 Shared Durable | 200 / type | Yes |
| 5 Archive | >500 triggers human review | No |

See: `templates/.memory/config/tier-budget.json`
