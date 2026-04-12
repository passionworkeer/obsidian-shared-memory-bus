# System Architecture Overview

> English: A high-level description of the shared memory bus architecture.
> 中文：共享内存总线架构高层概述。

## High-Level Design

The system follows a **layered plane architecture** with four distinct planes:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Integration Layer                     │
│         (Claude Code · Codex · OpenCode · Cursor · Copilot)      │
└──────────────────────────┬────────────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────────┐
│                   Transport & Control Plane                       │
│   Shared MCP HTTP Endpoints (9331-9338) · Watchdog · Installers  │
│   Start/Stop/Status scripts · Process deduplication              │
└──────────────────────────┬────────────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────────┐
│                    Retrieval & Search Plane                       │
│   BM25 (rank-bm25) · Dense vectors (hashing-v1) · Hybrid rerank │
│   Python retrieval worker · Embedding runtime registry            │
└──────────────────────────┬────────────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────────┐
│                      Bridge & Sync Plane                           │
│   claude-mem sync · OpenClaw blackboard bridge · Onboarding packs │
│   HANDOFF pack builder · AUTO-DREAM consolidator                  │
└──────────────────────────┬────────────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────────┐
│                    Canonical Data Plane                            │
│         Local .ai-memory store (pure JSONL + SQLite WAL)          │
│   structured/*.jsonl · kg/*.sqlite3 · generated/*.md · inbox/     │
└─────────────────────────────────────────────────────────────────┘
```

## Key Design Principles

1. **Canonical data outranks transport** — the local `.ai-memory` store is the source of truth. MCP is a transport layer, not a database.
2. **Safe-to-share vs. session-isolated** — services like `memory`, `context7`, `fetch` are shared; services like `playwright` share the process but isolate sessions per client.
3. **Portable by default** — no hardcoded machine paths; vault and store roots are resolved at runtime from environment variables or standard fallbacks.
4. **PII-safe** — the bridge plane handles redaction before durable writeback.
5. **Field-level embeddings** — v2 architecture uses chunk-level embeddings with typed promotion metadata, not document-level.

## Directory Structure

```
obsidian-shared-memory-bus/
├── bus/                     # Core bus runtime (PowerShell scripts)
│   ├── memory-bus.ps1       # Memory write/filter/distribute engine
│   ├── memory-watchdog.ps1   # Background sync watchdog
│   ├── register-agent.ps1    # Agent registration hook
│   ├── generate-embeddings.js
│   └── platform/            # Cross-platform abstraction
│       ├── index.js         # Platform detection (win32/darwin/linux)
│       ├── watchdog.ps1     # Platform-specific watchdog launcher
│       └── watchdog.sh      # POSIX watchdog launcher
├── shared-mcp/              # Shared MCP transport layer
│   ├── omni-memory-server.js # Main MCP server entry
│   ├── manifest.json        # Server manifest with mode=shared/isolated
│   ├── singleton-stdio-mcp-proxy.mjs  # Process deduplication proxy
│   ├── playwright-stdio-proxy.js      # Playwright session proxy
│   ├── python-runtime.cjs   # Python runtime resolver (ESM compat)
│   ├── start-shared-mcp.ps1  # Windows MCP start script
│   ├── start-shared-mcp.sh   # POSIX MCP start script
│   ├── start-default-shared-mcp.ps1  # Default stack launcher (Win)
│   ├── start-default-shared-mcp.sh   # Default stack launcher (POSIX)
│   ├── stop-shared-mcp.ps1 / .sh
│   ├── status-shared-mcp.ps1 / .sh
│   └── package.json
├── ops/                     # Operations tooling
│   ├── build-memory-layers.js       # Layered memory generator
│   ├── build-handoff-pack.js         # HANDOFF pack builder
│   ├── check-memory-integrity.js     # Contract validator
│   ├── run-memory-dream.ps1          # AUTO-DREAM consolidator
│   ├── install-client-integrations.ps1
│   ├── verify-client-integrations.ps1
│   └── stress-test-concurrent.js
├── retrieval/               # Search and embedding layer
│   ├── semantic-search.py   # BM25 + dense hybrid retrieval
│   ├── semantic-search.js   # JS wrapper around Python search
│   ├── benchmark-*.py
│   └── probe-models.py
├── scripts/                 # Cross-platform install scripts
│   ├── install.ps1 / install.sh
│   └── validate-layout.ps1 / validate-layout.sh
├── docs/                    # Documentation
│   ├── architecture/         # Architecture decision records
│   │   ├── OVERVIEW.md      # This file
│   │   └── ADR-*.md         # Architecture Decision Records
│   ├── ARCHITECTURE.md      # Detailed architecture doc
│   ├── INSTALL.md           # Installation guide
│   ├── OPERATIONS.md        # Operational runbook
│   ├── FAQ.md
│   ├── TROUBLESHOOTING.md
│   ├── RELEASING.md
│   └── reference/
├── tests/                   # Test suite
│   ├── unit/js/
│   ├── unit/py/
│   ├── integration/js/
│   └── cross-language/
├── templates/               # Reusable template skeletons
│   └── agents/             # Per-agent starter kits
│       ├── portable-skill/
│       └── thin-plugin/
├── types/                   # Shared TypeScript/JavaScript types
├── hooks/                   # Git hooks for hygiene and context refresh
├── docs/adr/                # Architecture Decision Records
│   └── ADR-002-unified-memory-architecture-v2.md
└── SKILL.md                 # Root universal skill entry point
```

## Data Flow

```
Agent Session Start
        │
        ▼
memory_wake_up ──► Compact layered pack (identity/essential/recent/retrieve)
        │
        ▼
search_shared_memory ──► BM25 + dense hybrid retrieval
        │                (Python retrieval worker / hashing-v1 offline)
        ▼
structured/*.jsonl ←─── watchdog sync + bridge plane writeback
        │
        ├──► kg/knowledge-graph.sqlite3 (entity triples)
        │
        └──► generated/*.md (HANDOFF · AUTO-DREAM · MEMORY-LAYERS)
```

### MCP Tool Flow

```
Client tool call
       │
       ▼
singleton-stdio-mcp-proxy.mjs
  (checks existing listener, proxies or spawns)
       │
       ▼
omni-memory-server.js
  │
  ├──► memory_wake_up         ──► Canonical store → layered pack
  ├──► search_shared_memory   ──► Retrieval worker → ranked results
  ├──► memory_status          ──► Integrity + runtime state
  ├──► memory_boot / memory_query ──► KG query
  ├──► obsidian_* tools       ──► Obsidian vault direct access
  ├──► fetch / time           ──► Shared utility services
  └──► context7 / sequential-thinking ──► Reasoning augmentation
```

## Platform Adaptation

The platform abstraction lives in `bus/platform/`:

| Layer | Windows | macOS | Linux |
|-------|---------|-------|-------|
| Script runner | `powershell.exe` | `bash` / `pwsh` | `bash` / `pwsh` |
| Watchdog | `.ps1` | `.sh` | `.sh` |
| Background launch | `Start-Process -WindowStyle Hidden` | POSIX `&` / `nohup` | POSIX `&` / `nohup` |
| Startup registration | Startup folder + scheduled task | LaunchAgents | systemd `--user` or XDG autostart |
| Shared MCP status | `.ps1` | `.sh` | `.sh` |

The `scripts/install.sh` and `scripts/install.ps1` write platform-specific wrappers into `~/.ai-memory/`. The source tree stays grouped by responsibility; the installed runtime stays intentionally flat.

## Shared MCP Architecture

The manifest (`shared-mcp/manifest.json`) classifies each MCP service:

```json
{
  "memory":   { "mode": "shared",  "port": 9338 },
  "obsidian": { "mode": "shared",  "port": 9335 },
  "playwright": { "mode": "isolated", "port": 9337 },
  "pencil":   { "mode": "isolated", "port": null  }
}
```

- **shared**: One process, all clients. Deduplicated by `singleton-stdio-mcp-proxy.mjs`.
- **isolated**: Shared process, session-isolated (e.g., Playwright per-client browser context).
- **standalone**: Never proxied (e.g., `pencil` for UI-bound tools).

The proxy resolves the actual stdio launcher (npm-style / exe+script / bare-script) so Windows startup avoids spawning visible Node.js console windows.

## 5-Tier Memory Lifecycle

| Tier | Name | Lifetime | Embeddings | Notes |
|------|------|----------|------------|-------|
| L0 | Event | Per tool call | No | Raw observations |
| L1 | Session | Per agent session | No | Structured summaries |
| L2 | Project | Per project lifetime | Yes (field-level) | Key facts + decisions |
| L3 | Durable | Explicit promotion | Yes | Typed (`user/feedback/project/reference`) |
| L4 | Archive | Long-term reference | No (manifest only) | Tombstoned, not deleted |

See [`docs/MEMORY-TIERING.md`](../MEMORY-TIERING.md) for full details.

## ADR Index

- [ADR-002: Unified Memory Architecture v2](../adr/ADR-002-unified-memory-architecture-v2.md) — current active ADR; covers SQLite chunk schema, FTS5+BM25 Phase 1 index, typed promotion contract, embedding cache, MMR reranking, and session-end compaction.
