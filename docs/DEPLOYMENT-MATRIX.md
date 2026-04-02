# Deployment Matrix

## Recommended Modes
| Scenario | Supported | Notes |
| --- | --- | --- |
| Single machine, local Obsidian vault | Yes | recommended default |
| Single machine, many agents and clients | Yes | primary target of this project |
| Single machine with optional backup or sync | Yes, carefully | keep sync and memory indexing as separate concerns |
| Windows full control plane | Yes | installer, shared MCP control, watchdog startup, and client wiring validated |
| macOS/Linux portable core | Yes, partial | core memory generation, dream, embeddings, and retrieval are validated; installer/startup remain Windows-first |
| Cross-platform onboarding pack | Yes | generated agent packs bundle shared HTTP MCP snippets, a portable skill template, and a thin plugin-adapter contract |
| Multi-device shared vault with extra sync layers | Caution | understand sync conflict behavior first |
| Hosted multi-tenant deployment | No | out of scope for this bundle |

## Reference Shapes

### 1. Single Machine Local Vault
Best default.

- Obsidian vault is local
- shared MCP runs on localhost
- all canonical memory stays on the machine
- optional remote embeddings remain off by default

### 2. Single Machine With Backup Or Sync
Supported, but stay disciplined.

- keep one canonical live vault
- do not stack multiple overlapping sync methods casually
- treat backup and sync as operational layers outside the shared memory design

### 3. Multi-Client On One Machine
This is the main operating mode.

- many local agents talk to one shared MCP layer
- process deduplication reduces repeated local server launches
- Playwright is shared as a process but keeps isolated sessions
- UI-bound tools remain isolated

### 4. Portable Public Template
This repo is intended to be reusable.

- runtime paths are resolved dynamically
- secrets stay in environment variables
- public docs describe the architecture without hardcoding one machine

## Anti-Patterns
- Treating shared MCP as one merged agent context
- Hardcoding secrets into startup scripts or manifests
- Using a remote embedding provider by default when local-first behavior is enough
- Forcing desktop-stateful tools into the shared pool without clear isolation guarantees
