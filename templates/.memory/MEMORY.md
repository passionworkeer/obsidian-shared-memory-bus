---
name: MEMORY
description: Obsidian shared memory index — see subdirectories for typed memories
type: index
adr: "002"
version: 1
---

# Shared Memory Index

This directory is the canonical store for all agent memory in the obsidian-shared-memory-bus system.

## Structure

| Directory | Purpose |
|-----------|---------|
| `user/` | User profiles, preferences, constraints |
| `feedback/` | Feedback memories (what worked, what didn't) |
| `project/` | Project context, goals, active initiatives |
| `reference/` | External pointers (URLs, Linear projects, Slack channels) |
| `sessions/` | Session transcripts, indexed by date |
| `archived/` | Expired or superseded memories |

## Configuration

- `.config/retrieval.json` — Hybrid search weights, MMR, temporal decay
- `.config/retention-policy.json` — TTL policy by memory type

## Index

Individual memories are stored as `.md` files with typed frontmatter. See `TEMPLATE.md` for the required schema.

<!-- AUTO_INDEX -->
