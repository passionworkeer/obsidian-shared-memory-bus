---
name: shared-memory-portable
description: Portable shared-memory bootstrap for a new AI host. Use when an agent, CLI, editor extension, or app can read a skill, rule, or instruction file and should join the shared memory bus with the canonical read order, durable writeback rules, safe shared MCP endpoints, and default multi-agent decomposition guidance.

# Portable Skill Template — Gateway to Universal Skill

This template is a **legacy gateway**. For the canonical unified entry point, see the root `SKILL.md` in the obsidian-shared-memory-bus repository root.

## Root SKILL.md Contents (Reference)

```markdown
# AI Memory Bus — Universal Skill

## 5-Step Quick Start
1. Read: <store-root>/CONTEXT.md (auto-generated summary)
2. (optional) Call memory_boot MCP on port 9338
3. Write durable: <store-root>/inbox/<agent>.md
4. Auto-extraction via Stop Hook preferred
5. Use shared MCP: memory(9338), obsidian(9335), context7(9331), fetch(9332), time(9333)

## Unified Memory Read Protocol
- memory_boot MCP as fast alternative to file reading
- Returns: global.md + project facts (~2000 tokens)

## Unified Memory Write Protocol
- Cross-project durable: inbox/<agent>.md
- Project facts: projects/<project>.jsonl (via Stop Hook auto-extraction)
- Manual fallback: inbox/<agent>.md
- Never write secrets

## Store Path Resolution Check
必须能解析 <store-root>，否则立即报错退出。支持：
AI_MEMORY_STORE > AI_MEMORY_STORE_ROOT > AI_MEMORY_ROOT/.ai-memory > auto-detect > platform default。

## Agent-Specific Integration
→ <repo-root>/.agents/skills/  (claude-code, codex, openclaw, trae, cursor, copilot)

## Memory Tiering Quick Ref（5 层）
→ <repo-root>/docs/MEMORY-TIERING.md
只有 Tier3（Project Durable）和 Tier4（Shared Durable）参与 embedding 索引。
Archive 用 archive-manifest.jsonl 代替 tombstone，不污染向量空间。

## Git Hook Integration
→ <repo-root>/docs/GIT-HOOKS-INTEGRATION.md
```

## Read Order

Read this file before substantive work:

1. `<store-root>/CONTEXT.md` (auto-generated summary)
2. For richer context: call `memory_boot(project="<project-name>")`

## Durable Writeback

- Cross-project durable facts go to `<store-root>/inbox/<host>.md`
- Project-specific durable facts via Stop Hook auto-extraction to `<store-root>/projects/<project>.jsonl`
- Manual fallback: write directly to `inbox/<agent>.md`
- Never write secrets, raw credentials, or tokens into shared memory

## Shared MCP Default Set

Prefer the shared HTTP endpoints for:

- `memory` (port 9338)
- `obsidian` (port 9335) — optional, no Obsidian dependency
- `context7` (port 9331)
- `fetch` (port 9332)
- `time` (port 9333)
- `sequential-thinking` (port 9334)

Add `playwright` only when the host really needs browser automation.

## Multi-Agent Default

When a task has 2 or more independent slices, default to subagent or multi-agent decomposition.

## Isolation Rule

- Keep desktop-UI-bound tools isolated.
- Do not assume every MCP should be shared.
- Treat the `.ai-memory` store as the canonical long-term store (no Obsidian dependency).
