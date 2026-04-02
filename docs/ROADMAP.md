# Roadmap

## v0.2 (Next Release - target: Q2 2026)
- [ ] Add rerank after `bm25 + dense` hybrid retrieval
- [ ] Add conflict-safe blackboard event log or lease semantics
- [ ] Promote the current dream pass into a stronger consolidation pipeline with dedupe and promotion scoring
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
