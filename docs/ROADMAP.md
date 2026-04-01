# Roadmap

## v0.2 (Next Release — target: Q2 2026)
- [ ] Version-pin all external MCP dependencies in manifest.json (owner: TBD)
- [ ] Add uncaughtException handlers to all daemons
- [ ] Replace bare `catch {}` with logged error collection
- [ ] Fix vault path silent fallback (throw instead of non-existent path)

## v0.3 (Next Quarter — target: Q3 2026)
- [ ] Shared retrieval core module (extract FNV/hash logic from JS+Python)
- [ ] Add caching layer to `retrieval/semantic-search.py` (30s TTL)
- [ ] Windows Service registration for watchdog
- [ ] Retention policy for structured/*.jsonl

## Backlog
- Prometheus metrics endpoint
- Slack/webhook alerting for watchdog failures
- Tutorial document (30-min getting-started guide)
- Offline install support

## Explicit Non-Goals
- Turning this repo into a hosted SaaS
- Claiming that every MCP should be shared
- Replacing backup strategy with memory indexing
- Pretending all agent sessions are one unified context
