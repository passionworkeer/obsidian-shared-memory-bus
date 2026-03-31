# Security

## Public Repo Rules
- Never commit real API keys, tokens, cookies, or session files
- Never commit machine-specific secrets in `manifest.json`, startup scripts, or reports
- Supply secrets through environment variables only

## What Data Is Stored
- Obsidian notes remain the canonical durable store
- structured memory is written under the Obsidian memory directories
- generated onboarding context, imported snapshots, and tool inboxes are derived artifacts
- local runtime state such as `shared-mcp/state.json` and logs is operational metadata, not canonical memory

## What Leaves The Machine
- nothing in the default local-first setup needs to leave the machine for memory retrieval
- optional remote embedding providers send only the text you choose to index or query against those providers
- external MCPs or third-party APIs follow their own network behavior and should be treated as optional dependencies

## Optional Remote Dependencies
- OpenAI-compatible embedding APIs are optional
- MiniMax is optional
- any extra sync, backup, or hosted MCP service should be evaluated separately from the base local-first architecture

## Safe Defaults
- default dense retrieval uses offline `hashing-v1`
- canonical memory stays in a local Obsidian vault
- shared MCP is limited to services that are safe to centralize
- UI-bound desktop tools stay isolated
- secrets are expected in environment variables, not committed config

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

## Privacy And Threat Model Notes
- shared MCP reduces duplicated local processes; it does not make all agent sessions equivalent
- Playwright is shared as a process, but browser sessions remain isolated
- Obsidian sync and backup are separate operational choices; avoid stacking multiple sync methods on the same live vault without understanding conflict risk
- if a secret was ever committed or exposed in logs, rotate it immediately even if the repo was later cleaned

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
