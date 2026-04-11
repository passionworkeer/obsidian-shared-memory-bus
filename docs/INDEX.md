# Documentation Index

## Getting Started
- [INSTALL.md](./INSTALL.md) — Installation and setup
- [reference/QUICKSTART.md](./reference/QUICKSTART.md) — 5-step, 30-minute getting-started guide
- [ADDING-CLIENT.md](./ADDING-CLIENT.md) — Connect another AI tool to shared memory
- [NEW-AGENT-INTEGRATION.md](./NEW-AGENT-INTEGRATION.md) — Onboard a new agent

## Architecture
- [ARCHITECTURE.md](./ARCHITECTURE.md) — System architecture overview
- [MEMORY-ARCHITECTURE-CRITIQUE.md](./MEMORY-ARCHITECTURE-CRITIQUE.md) — Known limitations and design debt
- [MEMORY-TIERING.md](./MEMORY-TIERING.md) — 5-tier memory architecture specification
- [RECOMMENDATION-TIER.md](./RECOMMENDATION-TIER.md) — Adaptive retrieval modes, cold-start rules, recall signal accumulation

## External Reference
- [MEMPALACE-ARCHITECTURE.md](./MEMPALACE-ARCHITECTURE.md) — MemPalace memory framework deep-dive
- [claude-mem-architecture.md](./claude-mem-architecture.md) — claude-mem architecture analysis

## Operations
- [OPERATIONS.md](./OPERATIONS.md) — Day-to-day management commands
- [DEPLOYMENT-MATRIX.md](./DEPLOYMENT-MATRIX.md) — Deployment configurations
- [ENVIRONMENT.md](./ENVIRONMENT.md) — All environment variables reference
- [GIT-HOOKS-INTEGRATION.md](./GIT-HOOKS-INTEGRATION.md) — Windows/POSIX git hooks for automatic hygiene and context refresh

## Troubleshooting
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Common issues and fixes
- [FAQ.md](./FAQ.md) — Frequently asked questions
- [ERROR_CODES.md](./ERROR_CODES.md) — Error code reference
- [VALIDATION.md](./VALIDATION.md) — Validation procedures
- [MIGRATION.md](./MIGRATION.md) — Migration between versions
- [SECURITY.md](./SECURITY.md) — Security policy and vulnerability reporting
- [UNINSTALL.md](./UNINSTALL.md) — How to remove the memory bus

## Development
- [RELEASING.md](./RELEASING.md) — Release process
- [adr/ADR-002-unified-memory-architecture-v2.md](./adr/ADR-002-unified-memory-architecture-v2.md) — Architecture decision record: unified memory v2

## Reference
- [reference/MCP-TOOLS.md](./reference/MCP-TOOLS.md) — All MCP tool definitions, input/output schemas, timeout and cache behavior
- [reference/MCP-TOOLS.schema.json](./reference/MCP-TOOLS.schema.json) — Machine-readable JSON Schema (Draft-07) for MCP tool inputs/outputs
- [reference/DATA-FLOW.md](./reference/DATA-FLOW.md) — End-to-end data flow, write/read paths, cross-language call chains
- [reference/CROSS-LANGUAGE-MAP.md](./reference/CROSS-LANGUAGE-MAP.md) — Which language owns which module, cross-layer calling conventions, schema version contract
- [reference/PERFORMANCE.md](./reference/PERFORMANCE.md) — Retrieval latency, scale limits, BM25 vs dense vs hybrid benchmarks
- [reference/OBSERVABILITY.md](./reference/OBSERVABILITY.md) — Log format, key metrics, health checks, alert thresholds, error taxonomy
