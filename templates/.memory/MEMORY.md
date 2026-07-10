---
name: MEMORY
description: Obsidian shared memory index — see subdirectories for typed memories
type: index
adr: "002"
version: 1
---

# Shared Memory Index

This directory is the canonical store for all agent memory in the yt system.

## Structure

| Directory | Purpose | Tier |
|-----------|---------|------|
| `user/` | User profiles, preferences, constraints | 4 (Shared Durable) |
| `feedback/` | Feedback memories (what worked, what didn't) | 4 (Shared Durable) |
| `project/` | Project context, goals, active initiatives | 3 (Project Durable) |
| `reference/` | External pointers (URLs, Linear projects, Slack channels) | 4 (Shared Durable) |
| `sessions/` | Session transcripts, indexed by date | 2 (Session Durable) |
| `event/` | Real-time event buffer (working memory) | 1 (Event/Working) |
| `archived/` | Expired or superseded memories | 5 (Archive) |

## 5-Tier Memory Architecture

| Tier | Name | TTL | Embedding | Promotion Trigger |
|------|------|-----|-----------|-------------------|
| 1 | Event/Working | 1d | No | session-end signal + confidence≥0.5 → Tier2 |
| 2 | Session Durable | session+7d | No | age>30d no confidence → Archive |
| 3 | Project Durable | project+30d | **Yes** | cross 3+ session validation + confidence≥0.7 |
| 4 | Shared Durable | user=never/feedback=90d/reference=180d | **Yes** | TTL expiry OR 60d cold access → Archive |
| 5 | Archive | manual | No | manifest instead of tombstone |

Only Tier 3 and Tier 4 records are stored in the embedding index.
Archive records are tracked in `archive-manifest.jsonl` (no tombstone in vector space).

See `<repo-root>/docs/MEMORY-TIERING.md` for the full specification.

## Configuration

- `.config/retrieval.json` — Hybrid search weights, MMR, temporal decay
- `.config/retention-policy.json` — TTL policy by memory type

## Index

Individual memories are stored as `.md` files with typed frontmatter. See `TEMPLATE.md` for the required schema.

<!-- AUTO_INDEX -->
