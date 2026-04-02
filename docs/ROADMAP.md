# Roadmap

## v0.2 (Next Release - target: Q2 2026)
- [x] Add rerank after `bm25 + dense` hybrid retrieval
  - Implemented in `retrieval/semantic-search.py` — hybrid mode with configurable weights
- [x] Add typed durable promotion metadata and typed dream promotion/refresh queues
  - Implemented in `ops/build-memory-layers.js` and `ops/run-memory-dream.ps1`
  - Frontmatter schema: `metadata.promotion.{version, durable_type, key, reason, source_type, source_confidence}`
- [ ] Add conflict-safe blackboard event log or lease semantics
  - FAQ updated to clarify: Phase 3 lock protects consolidation; blackboard events still use last-write-wins
  - Status: not yet implemented, remains open
- [ ] Promote the current typed dream pass into a stronger consolidation pipeline with dedupe, conflict handling, and promotion scoring
  - Partial: typed promotion metadata exists, dedupe via content_hash, conflict_with field
  - Status: in progress, promotion scoring not yet calibrated
- [ ] Add an evaluation harness for query-route weights, candidate pruning, and ranking regression checks
  - `retrieval/benchmark-architecture.py` exists as a smoke harness
  - Status: not yet a full evaluation suite with regression tracking
- [ ] Import richer Claude compact/session boundary data instead of only snapshot-style session notes
  - Partial: session-memory.jsonl captures structured session events
  - Status: in progress, chunk-manifest format not yet fully implemented

## v0.3 (Next Quarter - target: Q3 2026)
- [ ] Shared retrieval core module to remove duplicated hash logic from JS and Python
- [ ] Add stronger retention and compaction policy for `structured/*.jsonl`
- [ ] Windows Service registration for the watchdog
- [ ] Broader live acceptance parity beyond the current Windows-heavy validation depth

## Backlog
- Prometheus metrics endpoint (`GET /metrics` on shared MCP port)
- Slack or webhook alerting for watchdog failures
- [x] Tutorial document with a 30-minute getting-started flow
  - Implemented in `docs/reference/QUICKSTART.md`
- Offline install support

## Explicit Non-Goals
- Turning this repo into a hosted SaaS
- Claiming that every MCP should be shared
- Replacing backup strategy with memory indexing
- Pretending all agent sessions are one unified context
