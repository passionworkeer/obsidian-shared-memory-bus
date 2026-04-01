# Obsidian Shared AI Memory Bus

Portable Windows-first bundle for building a local-first, Obsidian-backed shared memory layer across multiple AI tools such as Codex, Claude Code, OpenCode, Cursor, Copilot, Trae, and OpenClaw.

This repository packages the architecture, runtime scripts, shared MCP services, onboarding helpers, verification tools, and optional embedding utilities used to run a cross-tool memory bus on one machine.

## Project Status
- Ready for real local use on Windows
- Local-first by default, with optional remote embeddings
- Best suited for one machine hosting many agents and tools
- Public template-quality bundle, but still opinionated and evolving

## What This Is
- A reusable local memory bus template for multi-agent setups
- A process-deduplicated shared MCP stack for safe-to-share services
- A canonical Obsidian-backed memory layer with hybrid retrieval

## What This Is Not
- Not a hosted SaaS
- Not a single merged super-context for every agent
- Not a guarantee that every MCP should or can be shared
- Not a replacement for backup or sync hygiene in your Obsidian vault

## What This Gives You
- One canonical long-term memory store in Obsidian
- One shared `memory` MCP service instead of per-agent local memory processes
- Shared `obsidian` MCP for direct note reads and writes
- One shared `playwright` MCP backend so multi-agent browser tasks stop spawning one local Playwright server per client
- Background watchdog sync from tool-native memory into structured shared memory
- Hybrid retrieval with `bm25`, offline dense `hashing-v1`, and optional remote embeddings
- Pressure-test and verification tooling for multi-agent setups

## Who This Is For
- People running multiple local AI agents on one Windows machine
- Setups where Obsidian should be the durable source of truth
- Users who want shared retrieval without blindly sharing every tool process

## Who This Is Not For
- Fully managed cloud deployments
- Zero-touch cross-device sync stacks with no local operator
- Setups that need every desktop/UI-bound tool to be globally shared

## System Overview
```mermaid
flowchart LR
    subgraph Clients["AI Clients"]
        Codex["Codex"]
        Claude["Claude Code"]
        OpenCode["OpenCode"]
        Others["Cursor / Copilot / Trae / Others"]
        OpenClaw["OpenClaw"]
    end

    subgraph Shared["Shared MCP Layer"]
        Memory["memory :9338"]
        Obsidian["obsidian :9335"]
        Utils["context7 / fetch / time / sequential-thinking"]
        Playwright["playwright :9337 (shared process, isolated sessions)"]
    end

    subgraph Runtime["Local Runtime"]
        Watchdog["bus/memory-watchdog.ps1"]
        Bus["bus/memory-bus.ps1"]
        Search["bm25 + dense + hybrid retrieval"]
    end

    subgraph Vault["Canonical Store"]
        ObsidianVault["Obsidian Vault"]
        Structured["structured/*.jsonl"]
        Inbox["tool inboxes / generated context"]
    end

    Clients --> Shared
    Shared --> Search
    Runtime --> Search
    Watchdog --> Bus
    Bus --> Structured
    Bus --> Inbox
    Search --> Structured
    Obsidian --> ObsidianVault
    Bus --> ObsidianVault
    OpenClaw --> Structured
```

## High-Level Flow
1. Install the bundle into `%USERPROFILE%\.ai-memory`
2. Point it at your Obsidian vault
3. Start the shared MCP stack
4. Wire clients to shared HTTP MCP endpoints
5. Let the watchdog keep shared memory fresh
6. Verify with pressure tests before heavy multi-agent use

## Trust Boundaries
- Shared:
  `memory`, `obsidian`, `context7`, `fetch`, `time`, `sequential-thinking`
- Shared process, but session-isolated:
  `playwright`
- Intentionally isolated:
  `pencil` and other UI-bound desktop tools

Shared MCP deduplicates processes. It does not merge all agent state into one conversation. Each client still has its own session lifecycle and tool calls.

## Support Matrix
| Target | Status | Notes |
| --- | --- | --- |
| Codex | First-class | Shared MCP and Obsidian workflow are validated |
| Claude Code | First-class | Shared MCP and claude-mem bridge are validated |
| OpenCode | First-class | Shared MCP and memory recall are validated |
| OpenClaw | Supported | Synced through structured memory and blackboard bridge |
| Cursor | Supported | MCP config wiring supported |
| VS Code / GitHub Copilot | Supported | Config wiring and snapshot import supported |
| Trae | Portable target | Use the new-agent integration guide |
| Other MCP-capable agents | Portable target | Prefer the onboarding flow in `docs/NEW-AGENT-INTEGRATION.md` |

## Included
- Core bus runtime (`bus/`):
  - `bus/memory-bus.ps1`
  - `bus/memory-watchdog.ps1`
  - `bus/register-agent.ps1`
  - `bus/generate-embeddings.js`
- Operations (`ops/`):
  - `ops/run-obsidian-mcp.ps1`
  - `ops/run-minimax-mcp.ps1`
  - `ops/verify-integrations.ps1`
  - `ops/verify-client-integrations.ps1`
  - `ops/sync-shared-skills.ps1`
  - `ops/run-pressure-test.ps1`
  - `ops/cleanup-inbox.ps1`
  - `ops/repair-codex-runtime.ps1`
  - `ops/sync-claudemem-to-obsidian.ps1`
  - `ops/sync-openclaw-to-obsidian.js`
  - `ops/obsidian-blackboard-daemon.js`
- Retrieval and embeddings (`retrieval/`):
  - `retrieval/semantic-search.py`
  - `retrieval/semantic-search.js`
  - `retrieval/probe-models.py`
  - `retrieval/benchmark-backends.py`
- Shared MCP runtime under `shared-mcp/`:
  - `omni-memory-server.js`
  - `manifest.json`
  - `start-shared-mcp.ps1`
  - `start-default-shared-mcp.ps1`
  - `stop-shared-mcp.ps1`
  - `status-shared-mcp.ps1`
  - `write-config-snippets.ps1`
  - `singleton-stdio-mcp-proxy.mjs`
  - `playwright-stdio-proxy.js`
  - `package.json`

## Shared MCP Defaults
Started by `shared-mcp/start-default-shared-mcp.ps1`:
- `context7`
- `fetch`
- `time`
- `sequential-thinking`
- `obsidian`
- `memory`
- `playwright`
- `MiniMax` only when `MINIMAX_API_HOST` and `MINIMAX_API_KEY` are present

Still isolated:
- `pencil`

The manifest keeps `playwright` marked as an optional server so advanced users can opt out or manage it separately, but the default starter opts into it because duplicated local Playwright MCP launches are usually the biggest process multiplier in multi-agent workflows.

## Verification Story
- Shared MCP services for `context7`, `fetch`, `time`, `sequential-thinking`, `obsidian`, `MiniMax`, and `memory` were validated on `9331-9336` and `9338`
- The shared Playwright backend was validated on `9337` with real MCP `initialize`, `tools/list`, `browser_navigate`, and `browser_snapshot` calls
- Multi-wave pressure tests passed with stable shared listener PIDs
- Client integration checks were validated for Codex, Claude Code, OpenCode, Cursor, and VS Code/Copilot paths

See `docs/VALIDATION.md` for the current test story and reproduction flow.

## Install
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer writes `AI_MEMORY_ROOT` into your user environment so shared MCP commands can locate the installed runtime without hardcoded machine-specific paths.

## Minimal Quick Start

> **What is `<your-project-root>`?** It is the directory where your AI agent's config files live. For Claude Code, this is your `.claude/` directory. For Codex, it is your `.codex/` directory. For other agents, point it at the directory where that agent stores its settings. The scripts will write per-agent MCP config snippets into a `mcp configs/` subdirectory there — they will not modify your existing settings directly.

> **Prerequisites**: An Obsidian vault already exists with at least the `00-System/ai-memory/` directory structure. If your vault is empty or on a different drive, set `AI_MEMORY_OBSIDIAN_VAULT` to its root path before running.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Then wire supported clients:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-integrations.ps1 -WorkspaceRoot <your-project-root>
```

Then verify:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Then pressure test:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\ops\run-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

**What to expect**: The pressure test runs 5 waves of concurrent MCP health checks against all shared endpoints (9331-9338). "passed" means every wave returned the expected responses with no crashes or duplicate PIDs. If you see failures, see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) or the operational FAQ in [`docs/FAQ.md`](docs/FAQ.md).

## Optional Remote Embeddings
The default dense retrieval backend is offline `hashing-v1`.

If you want to test an OpenAI-compatible embedding API, set:
```powershell
$env:AI_MEMORY_EMBED_BACKEND = "openai"
$env:AI_MEMORY_EMBED_BASE_URL = "https://your-openai-compatible-endpoint/v1"
$env:AI_MEMORY_EMBED_API_KEY = "<your-key>"
$env:AI_MEMORY_EMBED_MODEL = "<your-model-id>"
```

Use the included probe and benchmark scripts before doing any full reindex.

## Security
- No tokens or API keys are intentionally stored in this repository
- Secrets must be supplied through user or machine environment variables
- Machine-specific absolute paths are resolved dynamically at install or runtime
- Before publishing a fork, rescan for accidental credentials in configs or reports

## Docs
- [`docs/INSTALL.md`](docs/INSTALL.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/DEPLOYMENT-MATRIX.md`](docs/DEPLOYMENT-MATRIX.md)
- [`docs/FILES.md`](docs/FILES.md)
- [`docs/FAQ.md`](docs/FAQ.md)
- [`docs/NEW-AGENT-INTEGRATION.md`](docs/NEW-AGENT-INTEGRATION.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/RELEASING.md`](docs/RELEASING.md)
- [`docs/ROADMAP.md`](docs/ROADMAP.md)
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`docs/VALIDATION.md`](docs/VALIDATION.md)

## Community
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`SUPPORT.md`](SUPPORT.md)
- [`LICENSE`](LICENSE)
