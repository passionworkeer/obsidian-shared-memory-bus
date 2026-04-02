# Integration Modes

Use the three integration modes for different jobs. The strongest setup is not "pick one", it is "use each where it fits".

## Recommended Split
- MCP:
  - transport and tool access
  - shared runtime and process deduplication
  - best for `memory`, `obsidian`, `context7`, `fetch`, `time`, `sequential-thinking`, shared `playwright`
- skills:
  - reusable prompting, read order, writeback policy, task decomposition, and host-agnostic workflows
  - best for getting many different agents to behave consistently without rewriting transport
- plugins:
  - host-native lifecycle hooks, settings surfaces, and UI
  - best only when the host app truly needs a native extension point

## What To Use By Default
Start with:
- MCP for runtime access
- skills for behavior and onboarding

Add plugins only if:
- the host cannot read instruction files cleanly
- the host needs native UI or menu actions
- you need app-specific startup hooks that cannot be expressed through config plus skills

## Why This Split Works
- MCP centralizes safe shared processes
- skills stay portable across Codex, Claude Code, OpenCode, Copilot, Cursor, Trae, and future agents
- plugins avoid overloading the memory bus with host-specific code that does not generalize

## Mapping To This Repository
- MCP layer:
  - `shared-mcp/manifest.json`
  - `shared-mcp/start-default-shared-mcp.ps1`
  - `shared-mcp/omni-memory-server.js`
- skill and instruction layer:
  - `docs/NEW-AGENT-INTEGRATION.md`
  - `docs/FAQ.md`
  - repo or global `AGENTS.md`
  - portable shared skills mirrored through the shared-skills flow
- plugin layer:
  - host-specific config files outside the canonical memory store
  - only thin adapters should live here

## Agent Onboarding Rule Of Thumb
- Codex / Claude Code / OpenCode / Cursor / Copilot:
  - MCP plus shared instructions first
- OpenClaw:
  - MCP plus structured task memory first, plugin logic only for OpenClaw-native orchestration needs
- new agents:
  - prove they can read the shared memory bootstrap, call `memory`, and write back durable notes before you consider a plugin
