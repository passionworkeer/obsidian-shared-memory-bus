<!-- SHARED-MEMORY-BUS:START -->
## Shared Obsidian Memory Bus

- Follow README.md plus the docs under `docs/` for repository-specific conventions and treat this section as the cross-tool memory overlay for OpenCode and GitHub Copilot.
- Resolve <obsidian-vault> from AI_MEMORY_OBSIDIAN_VAULT, OBSIDIAN_VAULT_ROOT, or the active vault in Obsidian.
- Before substantive work, read <obsidian-vault>/02-KB/OBSIDIAN.md, <obsidian-vault>/02-KB/MEMORY.md, <obsidian-vault>/02-KB/WORKING.md, <obsidian-vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md, and <obsidian-vault>/00-System/ai-memory/generated/tool-startup/copilot.md.
- Durable writeback targets: <obsidian-vault>/00-System/ai-memory/inbox/opencode.md (OpenCode), <obsidian-vault>/00-System/ai-memory/inbox/copilot.md (GitHub Copilot)
- Current task tracking target: <obsidian-vault>/02-KB/WORKING.md
- For tasks with 2 or more independent slices, default to multi-agent/subagent decomposition.
- Use matching skills from .claude/skills, .agents/skills, skills/, and .agents/skills/ when available.
<!-- SHARED-MEMORY-BUS:END -->
