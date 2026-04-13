<!-- SHARED-MEMORY-BUS:START -->
## Shared Memory Bus (v2)

- Canonical store: `E:\.ai-memory\` (Windows) / `~/.ai-memory/` (macOS/Linux)
- **MCP-capable** (port 9338): call `memory_boot(project="obsidian-shared-memory-bus")` at session start
- **Passive / no MCP**: read `E:\.ai-memory\CONTEXT.md` before substantive work
- Durable writeback: `E:\.ai-memory\inbox\copilot.md`
- For tasks with 2+ independent slices, prefer subagents or separate execution waves
<!-- SHARED-MEMORY-BUS:END -->
