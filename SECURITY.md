# Security Policy

For the detailed security and privacy model, see [`docs/SECURITY.md`](docs/SECURITY.md).

## Reporting A Vulnerability
- Do not post secrets, exploit details, or sensitive logs in a public issue
- If private vulnerability reporting is enabled for the repository, use that path first
- Otherwise open a minimal public issue without exploit details and ask for a private follow-up channel

## Scope
This project is primarily about:
- local-first shared memory and MCP process orchestration
- secret hygiene and path portability
- safe boundaries between shared and isolated services

## Fast Safety Rules
- rotate any credential that was ever committed or exposed
- assume logs may contain sensitive operational context
- treat optional remote providers as opt-in integrations, not safe defaults
