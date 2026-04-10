---
name: shared-memory-portable
description: Portable shared-memory bootstrap for a new AI host. Use when an agent, CLI, editor extension, or app can read a skill, rule, or instruction file and should join the shared Obsidian memory bus with the canonical read order, durable writeback rules, safe shared MCP endpoints, and default multi-agent decomposition guidance.

# Portable Skill Template — Gateway to Universal Skill

This template is a **legacy gateway**. For the canonical unified entry point, see the root `SKILL.md` in the obsidian-shared-memory-bus repository root.

## Root SKILL.md Contents (Reference)

```markdown
# Obsidian Shared Memory Bus — Universal Skill

## 5-Step Quick Start
1. Read: <obsidian-vault>/02-KB/OBSIDIAN.md → MEMORY.md → WORKING.md → GLOBAL-CONTEXT.md
2. (可选) Call memory_wake_up MCP on port 9338
3. Write durable: <obsidian-vault>/00-System/ai-memory/inbox/<agent>.md
4. Track task: <obsidian-vault>/02-KB/WORKING.md（按 ## Agent: 分隔写入）
5. Use shared MCP: memory(9338), obsidian(9335), context7(9331), fetch(9332), time(9333)

## Unified Memory Read Protocol
- memory_wake_up MCP as fast alternative to file reading
- Generation chain: GLOBAL-CONTEXT → AUTO-DREAM → HANDOFF

## Unified Memory Write Protocol
- Cross-project durable: inbox/<agent>.md
- Active task: 02-KB/WORKING.md (per ## Agent: section)
- Project-specific: project note
- Never write secrets

## Vault Path Resolution Check
必须能解析 <obsidian-vault>，否则立即报错退出。支持：
AI_MEMORY_OBSIDIAN_VAULT > OBSIDIAN_VAULT_ROOT > Obsidian config。
不支持环境变量注入的 agent：通过 MCP obsidian 工具动态获取 vault 根目录。

## Agent-Specific Integration
→ <repo-root>/.agents/skills/  (claude-code, codex, openclaw, trae, cursor, copilot)

## Memory Tiering Quick Ref（5 层）
→ <repo-root>/docs/MEMORY-TIERING.md
只有 Tier3（Project Durable）和 Tier4（Shared Durable）参与 embedding 索引。
Archive 用 archive-manifest.jsonl 代替 tombstone，不污染向量空间。

## Git Hook Integration
→ <repo-root>/docs/GIT-HOOKS-INTEGRATION.md
```

## Legacy Read Order (Deprecated — use SKILL.md above)

Read these files before substantive work:

1. `<obsidian-vault>/02-KB/OBSIDIAN.md`
2. `<obsidian-vault>/02-KB/MEMORY.md`
3. `<obsidian-vault>/02-KB/WORKING.md`
4. `<obsidian-vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md`

## Durable Writeback

- Cross-project durable facts go to `<obsidian-vault>/00-System/ai-memory/inbox/<host>.md`
- Current-task state goes to `<obsidian-vault>/02-KB/WORKING.md`
- Project-specific durable facts go to the relevant project note
- Never write secrets, raw credentials, or tokens into shared memory

## Shared MCP Default Set

Prefer the shared HTTP endpoints for:

- `memory`
- `obsidian`
- `context7`
- `fetch`
- `time`
- `sequential-thinking`

Add `playwright` only when the host really needs browser automation.

## Multi-Agent Default

When a task has 2 or more independent slices, default to subagent or multi-agent decomposition.

## Isolation Rule

- Keep desktop-UI-bound tools isolated.
- Do not assume every MCP should be shared.
- Treat the Obsidian vault as the canonical long-term store.
