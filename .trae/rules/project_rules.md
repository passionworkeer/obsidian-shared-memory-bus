# Trae Project Shared Memory Overlay

Project root: <repo-root>

This file complements ~/.trae/user_rules.md for this workspace.

Canonical store: `.ai-memory/` (no Obsidian dependency).
Resolve `<store-root>` from AI_MEMORY_STORE, AI_MEMORY_STORE_ROOT, AI_MEMORY_ROOT/.ai-memory, or auto-detect.

## Read Order
1. ~/.trae/user_rules.md  ← 先读全局规则
2. <store-root>/CONTEXT.md  ← auto-generated summary
3. <store-root>/inbox/claude-code.md  ← 其他 agent 的记忆
4. <store-root>/inbox/codex.md
5. <store-root>/inbox/opencode.md
6. <store-root>/inbox/trae.md  ← 自己的记忆

**Universal Rule**: Read ALL inbox files — not just your own.

**MCP fallback**: If memory MCP is available (port 9338), use `memory_boot` for richer context.

## Writeback Policy
- Cross-project durable facts go to <store-root>/inbox/trae.md
- Project facts go to <store-root>/projects/<project>.jsonl (via Stop Hook auto-extraction)
- Manual fallback: write to <store-root>/inbox/trae.md
- Never store secrets, raw tokens, or credentials
