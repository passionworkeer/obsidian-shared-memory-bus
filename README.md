# Obsidian Shared AI Memory Bus

Portable Windows bundle for building a shared, Obsidian-backed memory layer across multiple AI tools such as Codex, Claude Code, OpenCode, Cursor, Copilot, Trae, and OpenClaw.

This repository packages the architecture, runtime scripts, shared MCP server, onboarding helpers, verification tools, and optional embedding utilities used to run a cross-tool memory bus on one machine.

## What This Gives You
- One canonical long-term memory store in Obsidian
- One shared `memory` MCP service instead of per-agent local memory processes
- Shared `obsidian` MCP for direct note reads and writes
- One shared `playwright` MCP backend so multi-agent browser tasks stop spawning one local Playwright server per client
- Background watchdog sync from tool-native memory into structured shared memory
- Hybrid retrieval with `bm25`, offline dense `hashing-v1`, and optional remote embeddings
- Pressure-test and verification tooling for multi-agent setups

## High-Level Flow
1. Install the bundle into `%USERPROFILE%\.ai-memory`
2. Point it at your Obsidian vault
3. Start the shared MCP stack
4. Wire clients to shared HTTP MCP endpoints
5. Let the watchdog keep shared memory fresh
6. Verify with pressure tests before heavy multi-agent use

## Included
- Core runtime:
  - `memory-bus.ps1`
  - `memory-watchdog.ps1`
  - `run-minimax-mcp.ps1`
  - `run-obsidian-mcp.ps1`
  - `register-agent.ps1`
  - `install-client-integrations.ps1`
  - `sync-shared-skills.ps1`
  - `verify-client-integrations.ps1`
  - `run-shared-stack-pressure-test.ps1`
- Shared memory indexing and retrieval:
  - `generate-embeddings.js`
  - `semantic-search.py`
  - `semantic-search.js`
  - `probe-embedding-models.py`
  - `benchmark-embedding-backends.py`
- Sync bridges:
  - `sync-claudemem-to-obsidian.ps1`
  - `sync-openclaw-to-obsidian.js`
  - `obsidian-blackboard-daemon.js`
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

## Install
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer writes `AI_MEMORY_ROOT` into your user environment so shared MCP commands can locate the installed runtime without hardcoded machine-specific paths.

## Minimal Quick Start
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Then wire supported clients:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\install-client-integrations.ps1 -WorkspaceRoot <your-project-root>
```

Then verify:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
```

Then pressure test:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\run-shared-stack-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

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

See:
- [`docs/INSTALL.md`](docs/INSTALL.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/FILES.md`](docs/FILES.md)
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- [`docs/SECURITY.md`](docs/SECURITY.md)
- [`LICENSE`](LICENSE)
