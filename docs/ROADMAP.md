# Roadmap

## v0.2 (Next Release - target: Q2 2026)
- [x] Add rerank after `bm25 + dense` hybrid retrieval
- [x] Add typed durable promotion metadata and typed dream promotion/refresh queues
- [ ] Add conflict-safe blackboard event log or lease semantics
- [ ] Promote the current typed dream pass into a stronger consolidation pipeline with dedupe, conflict handling, and promotion scoring
- [ ] Add an evaluation harness for query-route weights, candidate pruning, and ranking regression checks
- [ ] Import richer Claude compact/session boundary data instead of only snapshot-style session notes

## v0.3 (Next Quarter - target: Q3 2026)
- [ ] Shared retrieval core module to remove duplicated hash logic from JS and Python
- [ ] Add stronger retention and compaction policy for `structured/*.jsonl`
- [ ] Windows Service registration for the watchdog
- [ ] Broader live acceptance parity beyond the current Windows-heavy validation depth

## Backlog
- Prometheus metrics endpoint
- Slack or webhook alerting for watchdog failures
- Tutorial document with a 30-minute getting-started flow
- Offline install support

## Explicit Non-Goals
- Turning this repo into a hosted SaaS
- Claiming that every MCP should be shared
- Replacing backup strategy with memory indexing
- Pretending all agent sessions are one unified context
