# Security

The canonical security guide for this repository lives in [docs/SECURITY.md](docs/SECURITY.md).

This root file exists so GitHub, issue templates, and contributor-facing links have a stable top-level entry point.

## Quick Rules
- never commit real keys, tokens, cookies, or session files
- use environment variables for secrets
- keep generated logs, caches, reports, and runtime state out of git
- rotate any credential immediately if it was ever committed or exposed

## Full Guide
- [docs/SECURITY.md](docs/SECURITY.md)
