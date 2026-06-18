# Local AI Memory Bus Quick Start

> Share one local memory layer across Codex, Claude Code, Cursor, Copilot, OpenCode, Trae, and other AI coding tools.

## Who It Is For

Use this if you often repeat the same project context to different AI coding tools:

- what the project does;
- what the current task is;
- which decisions were already made;
- which mistakes should not be repeated.

## 30-Second Explanation

Local AI Memory Bus does three things:

1. Stores durable memory in a local `.ai-memory` store.
2. Exposes shared MCP endpoints so multiple AI tools can read and search it.
3. Provides agent skill/rule files so every tool can join the same memory protocol.

## Install

Windows:

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

macOS / Linux:

```bash
npm install
./scripts/install.sh -WorkspaceRoot "$(pwd)"
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

## Join From An AI Tool

Ask your AI tool to read:

```text
SKILL.md
.agents/skills/AGENT_BOOT.md
.agents/skills/<tool>.md
```

Examples:

```text
.agents/skills/codex.md
.agents/skills/claude-code.md
.agents/skills/copilot.md
```

## Verify

Check the store:

```bash
node scripts/store-detect.js
```

Check MCP:

```text
memory_status()
```

If MCP is unavailable, agents can still read:

```text
<store>/generated/GLOBAL-CONTEXT.md
<store>/generated/L0-bootstrap.md
```

## One-Line Pitch

Local AI Memory Bus is a local-first shared memory layer that lets multiple AI coding tools share context, retrieve past decisions, and hand off work across tools.

## Next

- Universal entry: `SKILL.md`
- Architecture: `docs/ARCHITECTURE.md`
- Launch post draft: `docs/promotion/POST.en.md`
- Video storyboard: `docs/promotion/VIDEO-STORYBOARD.en.md`
