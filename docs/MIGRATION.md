# Migration Guide

## Version Contract

This project uses semantic versioning (semver). The version contract guarantees:
- **Patch** (x.y.Z): Bug fixes, no API changes
- **Minor** (x.Y.z): New features, backward compatible
- **Major** (X.y.z): Breaking changes

## Breaking Changes

### v2.x → v3.0.0
- `memory-bus.ps1` now uses structured JSONL for memory records
- Embeddings index schema changed (v1 → v2); run `generate-embeddings` after upgrade
- MCP server requires Node.js 18+

## Clean Install

1. Stop all memory bus services
2. Delete `~/.ai-memory/`
3. Run install script fresh

## Preserving Memory Data

Before reinstall, back up:
- `~/.ai-memory/structured/*.jsonl` — memory records
- Vault notes under `<obsidian-vault>/00-System/ai-memory/`

## After Reinstall

```powershell
# Rebuild embeddings index
node ops/generate-embeddings.js

# Regenerate memory layers
node ops/build-memory-layers.js

# Verify integrity
node ops/check-memory-integrity.js --strict
```
