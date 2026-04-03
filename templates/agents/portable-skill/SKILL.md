---
name: shared-memory-portable
description: Portable shared-memory bootstrap for a new AI host. Use when an agent, CLI, editor extension, or app can read a skill, rule, or instruction file and should join the shared Obsidian memory bus with the canonical read order, durable writeback rules, safe shared MCP endpoints, and default multi-agent decomposition guidance.
---

# Shared Memory Portable Skill Template

Follow this template when adapting a new host to the shared memory bus.

## Read Order

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
