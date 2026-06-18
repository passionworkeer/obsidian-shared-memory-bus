# I Built A Local Memory Bus For AI Coding Tools

## Title Options

1. I got tired of repeating project context to every AI coding tool
2. What if Codex, Claude Code, Cursor, and Copilot shared one memory?
3. A local-first shared memory layer for AI coding agents

## Opening

If you use more than one AI coding tool, you probably know the pain:

Codex helped you reason through the architecture, but Claude Code does not know that tomorrow. Cursor helps debug a bug, but Copilot does not know which ideas were already rejected. A week later, every tool feels like it is meeting the project for the first time.

Local AI Memory Bus is my attempt to fix that with a local-first shared memory layer.

## The Problem

Most AI coding tools remember in silos. That creates three issues:

- repeated project explanations;
- weak handoff between tools;
- memory locked inside one vendor or app.

## The Solution

Local AI Memory Bus gives multiple tools a shared local memory layer:

1. A canonical `.ai-memory` store on your machine.
2. Shared MCP endpoints for memory, retrieval, and utility services.
3. Hybrid retrieval with BM25 and vector search.
4. A copyable agent pack using `SKILL.md` and `.agents/skills`.

## Architecture

The system is intentionally layered:

- Client layer: Codex, Claude Code, Cursor, Copilot, OpenCode, Trae.
- Transport layer: shared local MCP endpoints.
- Retrieval layer: BM25, dense vectors, hybrid reranking.
- Data layer: local JSONL, generated summaries, knowledge graph, embeddings.
- Agent pack: universal boot protocol and per-tool instructions.

MCP is transport. The local store is the source of truth.

## Why Not Just Use One Tool's Memory?

Single-tool memory is useful, but it stays inside that tool.

This project treats memory as part of your local development environment, not part of one assistant. Codex can pick up facts left by Claude Code. Cursor can search prior OpenCode decisions. Copilot can use the same context through MCP or file fallback.

## Quick Start

Windows:

```powershell
npm install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
```

macOS / Linux:

```bash
npm install
./scripts/install.sh -WorkspaceRoot "$(pwd)"
```

Then point your AI tool at:

```text
SKILL.md
.agents/skills/AGENT_BOOT.md
.agents/skills/codex.md
```

## Best For

This is currently best for power users who:

- use several AI coding tools;
- are comfortable with MCP;
- care about local-first workflows;
- want durable project memory rather than one-off chat history.

## Closing

The more AI coding tools we use, the more important it becomes for memory to belong to the local development environment.

Local AI Memory Bus is a step in that direction: shared, searchable, local, and tool-agnostic.
