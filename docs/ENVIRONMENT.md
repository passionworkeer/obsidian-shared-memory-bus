# Environment Variables

All configuration is done through environment variables. This page is the single source of truth for every variable the system uses.

## Core Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_ROOT` | No | `~/.ai-memory` (installed) or repo root | Where the runtime files live |
| `AI_MEMORY_OBSIDIAN_VAULT` | No | Auto-detected | Path to your Obsidian vault root |
| `AI_MEMORY_WATCHDOG_ENABLED` | No | `1` (enabled) | Set to `0` to disable the background watchdog |
| `AI_MEMORY_BASE_PORT` | No | `9330` | Base port; servers use basePort+N (memory=9338) |
| `AI_MEMORY_PROFILE_SYNC` | No | `false` | Enable profile sync on startup |

## Embedding Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_EMBED_PROFILE` | No | `hash-local` | Provider profile name |
| `AI_MEMORY_EMBED_PROVIDER` | No | (from profile) | Override embedding provider |
| `AI_MEMORY_EMBED_ADAPTER` | No | `hash` | Adapter: `hash`, `transformer`, `openai-compatible` |
| `AI_MEMORY_EMBED_MODEL` | No | (from adapter) | Model name for remote embeddings |
| `AI_MEMORY_EMBED_BASE_URL` | No | (from adapter) | API base URL for OpenAI-compatible embeddings |
| `AI_MEMORY_EMBED_API_KEY` | No | (from adapter) | API key for OpenAI-compatible embeddings |
| `AI_MEMORY_EMBED_API_KEY_ENV` | No | (from adapter) | Env var name containing API key |
| `AI_MEMORY_EMBED_TIMEOUT_MS` | No | `120000` | Embedding request timeout in ms |
| `AI_MEMORY_EMBED_REQUEST_DELAY_MS` | No | `0` | Delay between embedding requests |
| `AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES` | No | `0` | Set to `1` to allow env vars to override runtime.json |

## Metrics Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_METRICS_PORT` | No | `9090` | Port for Prometheus metrics endpoint |
| `AI_MEMORY_METRICS_TOKEN` | No | (none) | Bearer token for `/metrics` auth — if set, requests require `Authorization: Bearer <token>` |

## Python / Runtime Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_PYTHON` | No | Auto-detected | Path to Python executable |
| `AI_MEMORY_PWSH` | No | `powershell.exe` | PowerShell executable path |
| `PYTHONUTF8` | No | `1` | Enable UTF-8 mode for Python |

## Advanced / Debug

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_DRY_RUN` | No | `0` | Set to `1` for dry-run mode |
| `AI_MEMORY_DEBUG` | No | `0` | Enable debug trace logging |

## Quick Reference

```powershell
# Set your vault path
$env:AI_MEMORY_OBSIDIAN_VAULT = "D:\Your\Vault"

# Disable background watchdog (use manual sync only)
$env:AI_MEMORY_WATCHDOG_ENABLED = "0"

# Use OpenAI embeddings
$env:AI_MEMORY_EMBED_ADAPTER = "openai-compatible"
$env:AI_MEMORY_EMBED_BASE_URL = "https://api.openai.com/v1"
$env:AI_MEMORY_EMBED_API_KEY_ENV = "OPENAI_API_KEY"
$env:AI_MEMORY_EMBED_MODEL = "text-embedding-3-small"

# Use local HuggingFace embeddings
$env:AI_MEMORY_EMBED_ADAPTER = "transformer"
$env:AI_MEMORY_EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
```
