# Trae Project Shared Memory Overlay

Project root: <repo-root>

This file complements ~/.trae/user_rules.md for this workspace.

Resolve <obsidian-vault> from AI_MEMORY_OBSIDIAN_VAULT, OBSIDIAN_VAULT_ROOT, or the active vault in Obsidian.

## Read Order
1. ~/.trae/user_rules.md
2. <obsidian-vault>/02-KB/OBSIDIAN.md
3. <obsidian-vault>/02-KB/MEMORY.md
4. <obsidian-vault>/02-KB/WORKING.md
5. <obsidian-vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md
6. <obsidian-vault>/00-System/ai-memory/generated/tool-startup/trae.md

## Writeback Policy
- Cross-project durable facts go to <obsidian-vault>/00-System/ai-memory/inbox/trae.md
- Current task progress goes to <obsidian-vault>/02-KB/WORKING.md
- Project-specific durable conclusions belong in the relevant Obsidian project note
- Never store secrets, raw tokens, or credentials
