<!-- SHARED-MEMORY-BUS:START -->
## Shared Memory Bus

- Follow CLAUDE.md for repository-specific conventions and treat this section as the cross-tool memory overlay for OpenCode and GitHub Copilot.
- Before substantive work, read <obsidian-vault>/02-KB/MEMORY.md, <obsidian-vault>/02-KB/WORKING.md, <obsidian-vault>/00-System/ai-memory/generated/GLOBAL-CONTEXT.md, and <obsidian-vault>/00-System/ai-memory/generated/tool-startup/copilot.md.
- Durable writeback targets: <obsidian-vault>/00-System/ai-memory/inbox/opencode.md (OpenCode), <obsidian-vault>/00-System/ai-memory/inbox/copilot.md (GitHub Copilot)
- Current task tracking target: <obsidian-vault>/02-KB/WORKING.md
- For tasks with 2 or more independent slices, default to multi-agent/subagent decomposition.
- Use matching skills from .claude/skills, .agents/skills, skills/, and .agents/skills/ when available.
<!-- SHARED-MEMORY-BUS:END -->

## MCP 接入 / MCP Onboarding

This project shares local MCP servers (HTTP streamable, `127.0.0.1:<port>/mcp`). Register them with any MCP-capable agent in one command:

```bash
node setup-mcp.js                       # all known agents
node setup-mcp.js --target=<agent|all>  # one or several (comma-separated)
node setup-mcp.js --dry-run             # preview, write nothing
node setup-mcp.js --help                # list supported targets
```

Supported targets: `claude`, `cursor`, `kiro`, `windsurf`, `cline`, `roo`, `goose`, `qoder`, `all`. If an agent's config file is absent, the script prints the exact path + JSON/YAML snippet to add manually — it never errors out.

### Shared MCP endpoints

| Server | URL | Purpose |
|--------|-----|---------|
| memory | http://127.0.0.1:9338/mcp | Unified shared memory (search/write, isolated search worker) |
| fetch | http://127.0.0.1:9332/mcp | Stateless URL fetch |
| time | http://127.0.0.1:9333/mcp | Timezone/time utilities |
| context7 | http://127.0.0.1:9331/mcp | Documentation/code search |
| playwright | http://127.0.0.1:9337/mcp | Browser automation (optional) |

Full manifest: `shared-mcp/manifest.json`. Host `127.0.0.1`, path `/mcp`.

### Per-agent notes (one line each)

- **Claude Desktop** — `claude_desktop_config.json`, `mcpServers.<id> = { url }`.
- **Cursor** — `~/.cursor/mcp.json`, `mcpServers.<id> = { url }`.
- **Kiro** — `~/.kiro/settings/mcp.json`, supports `{ url }` for streamable-http.
- **Windsurf** — `~/.codeium/windsurf/mcp_config.json`, `{ url }`.
- **Cline** — VS Code globalStorage `.../saoudrizwan.claude-dev/settings/cline_mcp_settings.json`, `{ url }`.
- **Roo Code** — VS Code globalStorage `.../rooveterinaryinc.roo-cline/settings/mcp_settings.json`, `{ url }`.
- **Goose** — `~/.config/goose/config.yaml` `extensions` block, `type: remote` + `url` (or `goose configure`).
- **Qoder** — on-disk path unverified upstream; script prints a hint, configure via UI "MCP → + Add" if needed.

To add a new agent: append one entry to `AGENT_REGISTRY` in `setup-mcp.js` — nothing else changes.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **obsidian-shared-memory-bus** (7936 symbols, 12938 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/obsidian-shared-memory-bus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/obsidian-shared-memory-bus/clusters` | All functional areas |
| `gitnexus://repo/obsidian-shared-memory-bus/processes` | All execution flows |
| `gitnexus://repo/obsidian-shared-memory-bus/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
