# English Short Video Storyboard: Shared Memory For AI Coding Tools

## Version A: 60 Seconds

### 0-5s: Pain

Visual: Codex, Claude Code, Cursor, and Copilot windows all asking for the same project context again.

Voiceover:

> The more AI coding tools you use, the more often you repeat yourself.

### 5-15s: Problem

Visual: One project split into four isolated memory islands.

Voiceover:

> Codex helped with the architecture. Claude Code does not know it. Cursor debugged the issue. Copilot has no idea.

### 15-30s: Solution

Visual: All tools connect to one local memory bus.

Voiceover:

> Local AI Memory Bus lets multiple AI coding tools share one local memory layer.

### 30-45s: Architecture

Visual: AI Clients → Shared MCP → Hybrid Retrieval → `.ai-memory` Store.

Voiceover:

> The store is local. MCP is the transport. Retrieval combines BM25 and vector search.

### 45-55s: Demo

Visual: Codex writes a decision, Claude Code retrieves it, Copilot reads the same context.

Voiceover:

> One tool leaves the trail. The next tool continues the work.

### 55-60s: Close

Visual: Hero image or project mark.

Voiceover:

> Memory should belong to your development environment, not one assistant.

## On-Screen Captions

- Shared memory for AI coding tools
- Local-first, no SaaS lock-in
- Shared MCP endpoints
- BM25 + vector hybrid retrieval
- Codex / Claude Code / Cursor / Copilot
