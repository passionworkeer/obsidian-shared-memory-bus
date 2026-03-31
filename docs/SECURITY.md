# Security

## Public Repo Rules
- Never commit real API keys, tokens, cookies, or session files
- Never commit machine-specific secrets in `manifest.json`, startup scripts, or reports
- Supply secrets through environment variables only

## Expected Environment Variables
- `MINIMAX_API_KEY`
- `MINIMAX_API_HOST`
- `MINIMAX_MCP_COMMAND` when the MiniMax executable is not already on `PATH`
- `AI_MEMORY_EMBED_BACKEND`
- `AI_MEMORY_EMBED_BASE_URL`
- `AI_MEMORY_EMBED_API_KEY`
- `AI_MEMORY_EMBED_MODEL`
- `AI_MEMORY_OBSIDIAN_VAULT` or `OBSIDIAN_VAULT_ROOT` when auto-detection is not enough

## Path Hygiene
- Runtime scripts now auto-detect the active Obsidian vault from `obsidian.json`
- The bundle installs under `%USERPROFILE%\.ai-memory`
- Public docs may mention example paths, but the runtime should not depend on one specific username or drive letter

## Before Publishing
Run a quick scan for:
- `sk-`
- `gho_`, `ghp_`, `github_pat_`
- `ms-`
- `MINIMAX_API_KEY=`
- `api_key=`
- hardcoded user profile paths

## Operational Advice
- Keep `shared-mcp/logs/`, `shared-mcp/state.json`, caches, and generated reports out of git
- Rotate any credential immediately if it was ever committed, even briefly
- Prefer test or low-scope keys for optional remote embeddings
