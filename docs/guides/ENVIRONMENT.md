# Environment Variables

This page documents the environment variables the runtime understands. For an installed shared runtime, it is not true anymore that all configuration is driven only by environment variables: `~/.ai-memory/config/runtime.json` is the canonical selector for the active embedding profile/provider/runtime by default.

## Configuration Precedence

- Installed shared runtime: `~/.ai-memory/config/runtime.json` is the canonical source for embedding profile, provider, adapter, model, and base URL selection.
- Environment variables still matter for secrets, bootstrap paths, per-process tuning, and one-off debugging.
- Selection overrides such as `AI_MEMORY_EMBED_PROFILE`, `AI_MEMORY_EMBED_PROVIDER`, `AI_MEMORY_EMBED_ADAPTER`, `AI_MEMORY_EMBED_MODEL`, and `AI_MEMORY_EMBED_BASE_URL` are ignored by the long-running shared `memory` MCP unless `AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES=1`.
- Source-tree direct runs can still resolve runtime config from `AI_MEMORY_RUNTIME_CONFIG_PATH`, `config/runtime.json`, or `templates/config/runtime.json` before install.

## Core Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_ROOT` | No | repo root / runtime root | Runtime files root for direct source-tree runs; legacy launchers may still fall back to it as a store hint |
| `AI_MEMORY_STORE` | No | Auto-detected (best free drive, min 2 GB) | **Canonical root path for shared memory store** — e.g. `E:\.ai-memory`. Overrides auto-detection. |
| `AI_MEMORY_RUNTIME_CONFIG_PATH` | No | Auto-resolved | Explicit runtime config path for source-tree or advanced runs |
| `AI_MEMORY_OBSIDIAN_VAULT` | No | — | **Deprecated.** Previously used to point at an Obsidian vault. The system now uses `AI_MEMORY_STORE` instead. Kept for backward compatibility only. |
| `AI_MEMORY_WATCHDOG_ENABLED` | No | `1` (enabled) | Set to `0` to disable the background watchdog |
| `AI_MEMORY_BASE_PORT` | No | `9330` | Base port; manifest ports are shifted by offset (memory defaults to basePort+8 = 9338) |
| `AI_MEMORY_PROFILE_SYNC` | No | `false` | Enable profile sync on startup |

## Embedding Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AI_MEMORY_EMBED_PROFILE` | No | `runtime.json` active profile | Optional per-process profile override; ignored by the shared runtime unless env overrides are enabled |
| `AI_MEMORY_EMBED_PROVIDER` | No | `runtime.json` active provider | Optional per-process provider override; ignored by the shared runtime unless env overrides are enabled |
| `AI_MEMORY_EMBED_ADAPTER` | No | `runtime.json` resolved adapter | Optional per-process adapter override; ignored by the shared runtime unless env overrides are enabled |
| `AI_MEMORY_EMBED_MODEL` | No | `runtime.json` resolved model | Optional per-process model override; ignored by the shared runtime unless env overrides are enabled |
| `AI_MEMORY_EMBED_BASE_URL` | No | `runtime.json` resolved base URL | Optional per-process base URL override; ignored by the shared runtime unless env overrides are enabled |
| `AI_MEMORY_EMBED_API_KEY` | No | (none) | API key secret for remote embeddings |
| `AI_MEMORY_EMBED_API_KEY_ENV` | No | (from runtime/provider) | Env var name containing the remote embedding API key |
| `AI_MEMORY_EMBED_TIMEOUT_MS` | No | `120000` | Embedding request timeout in ms |
| `AI_MEMORY_EMBED_REQUEST_DELAY_MS` | No | `0` | Delay between embedding requests |
| `AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES` | No | `0` | Set to `1` only when you intentionally want selection env vars to override `runtime.json` |

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
# Set your shared memory store root
$env:AI_MEMORY_STORE = "E:\.ai-memory"

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
