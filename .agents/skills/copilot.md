---
name: copilot-shared-memory
description: GitHub Copilot optimized integration for the Obsidian shared memory bus
agent: copilot
version: 1.0.0
generated-from: SKILL.md
---

# GitHub Copilot — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with GitHub Copilot-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## GitHub Copilot Skill Metadata

```yaml
name: copilot-shared-memory
agent: copilot
mcp_server: memory (port 9338)
mcp_server: obsidian (port 9335)
mcp_server: context7 (port 9331)
mcp_server: fetch (port 9332)
mcp_server: time (port 9333)
```

---

## Vault Path Resolution

**Resolution order:**
1. `AI_MEMORY_OBSIDIAN_VAULT` environment variable
2. `OBSIDIAN_VAULT_ROOT` environment variable
3. Obsidian app config detection
4. Default fallback

**Important limitation**: GitHub Copilot operates per-file or per-commit with no native session memory system. Memory integration relies entirely on MCP calls and direct file writes. There is no environment variable injection capability in Copilot sessions.

**Vault Resolution (Fallback Strategy)**

Copilot cannot inject environment variables. Use a two-step fallback:

### Step 1: Try MCP discovery
Call the `obsidian` MCP tool to discover the vault root:
```
Tool: list_directory
path: /
```
Look for `00-System/ai-memory/` to identify the vault root from MCP results.

### Step 2: If MCP discovery fails
The vault root must be provided by the user or detected from the repo structure.
Copilot typically runs in a project context — check if the repo is inside the Obsidian vault:
```
Is <repo-root> a subdirectory of <default-vault-path>?
If yes: use that vault root.
If no: use the configured vault root from the repo's .github/copilot-instructions.md.
```

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/copilot.md` and exit with error.

---

## Startup Behavior

Copilot has no session memory. At the start of each significant coding session:

```
Tool: search_shared_memory
max_results: 3
route: reference   (prioritize external links, paths, docs)
```

For cross-project context:
```
Tool: memory_wake_up
max_items: 3
prefer_summaries: true
```

---

## MCP Configuration

```json
{
  "mcpServers": {
    "memory": {
      "transport": "http",
      "url": "http://127.0.0.1:9338/mcp"
    },
    "obsidian": {
      "transport": "http",
      "url": "http://127.0.0.1:9335/mcp"
    },
    "context7": {
      "transport": "http",
      "url": "http://127.0.0.1:9331/mcp"
    },
    "fetch": {
      "transport": "http",
      "url": "http://127.0.0.1:9332/mcp"
    },
    "time": {
      "transport": "http",
      "url": "http://127.0.0.1:9333/mcp"
    }
  }
}
```

---

## Rule File Setup

Add to `.github/copilot-instructions.md` (or equivalent):

```markdown
## Shared Memory Bus

This project uses the Obsidian shared memory bus. See <repo-root>/SKILL.md for integration details.

Vault root: (set manually or leave blank if AI_MEMORY_OBSIDIAN_VAULT is configured in the shell environment)

Memory inbox: <vault-root>/00-System/ai-memory/inbox/copilot.md
```

---

## Memory Write Targets

### Cross-Project Durable (Shared Inbox)
```
<obsidian-vault>/00-System/ai-memory/inbox/copilot.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: copilot` block.

---

## Token Budget

Copilot has the most constrained token budget. Follow these rules strictly:

- **Per-file editing**: Do NOT call `memory_wake_up` on every keystroke. Call only at session start or when switching to a new significant task.
- **Retrieval limit**: `search_shared_memory max_results=3` maximum per call
- **Preferred route**: `route=reference` (finds paths, links, docs — most actionable for Copilot)
- **Budget cap**: Memory calls must not exceed 5% of available context

**Rule: If in doubt, skip memory retrieval rather than risk context overflow.**

---

## Vault Path Resolution Check

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

Copilot cannot run shell commands or check environment variables directly. Manual configuration required: set the vault root in `.github/copilot-instructions.md`. If no vault is configured: write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/copilot.md`.
