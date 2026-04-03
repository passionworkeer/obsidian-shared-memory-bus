# Reference

Technical reference documentation for the shared memory bus.

## Guides

| Document | Description |
|----------|-------------|
| [`QUICKSTART.md`](QUICKSTART.md) | 5-step, 30-minute getting-started guide |

## Architecture

| Document | Description |
|----------|-------------|
| [`DATA-FLOW.md`](DATA-FLOW.md) | End-to-end data flow, write/read paths, cross-language call chains |
| [`CROSS-LANGUAGE-MAP.md`](CROSS-LANGUAGE-MAP.md) | Which language owns which module, cross-layer calling conventions, schema version contract |
| [`PERFORMANCE.md`](PERFORMANCE.md) | Retrieval latency, scale limits, BM25 vs dense vs hybrid benchmarks |

## Integration

| Document | Description |
|----------|-------------|
| [`MCP-TOOLS.md`](MCP-TOOLS.md) | All MCP tool definitions, input/output schemas, timeout and cache behavior |
| [`MCP-TOOLS.schema.json`](MCP-TOOLS.schema.json) | Machine-readable JSON Schema (Draft-07) for MCP tool inputs/outputs |

## Operations

| Document | Description |
|----------|-------------|
| [`OBSERVABILITY.md`](OBSERVABILITY.md) | Log format, key metrics, health checks, alert thresholds, error taxonomy |

## External References

The following documents live in the parent `docs/` folder:

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — System architecture overview
- [`OPERATIONS.md`](../OPERATIONS.md) — Day-to-day management commands
- [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) — Common issues and fixes
- [`ADR-002-unified-memory-architecture-v2.md`](../adr/ADR-002-unified-memory-architecture-v2.md) — ADR-002 design decision record
- [`MEMORY-ARCHITECTURE-CRITIQUE.md`](../MEMORY-ARCHITECTURE-CRITIQUE.md) — Known limitations and design debt
