# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by:

1. **Do not** open a public GitHub issue
2. Email the maintainers directly
3. Allow 48 hours for initial response

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

## Security Best Practices

When using this project:

- Never commit secrets, API keys, or credentials to the repository
- Use environment variables for sensitive configuration
- Regularly update dependencies to receive security patches
- Review the memory store permissions for your use case

## Local Attack Surface

This project runs as a local-first service. Be aware of the following
behaviors before installing:

- **HTTP MCP endpoints (ports 9331–9338) bind to `127.0.0.1` only** and are
  not reachable from the LAN. The `/metrics` endpoint on port `9090` is
  loopback-only as well. CORS is restricted to same-host loopback origins.
- **Windows install registers an auto-start watchdog**
  (`AI Memory Watchdog.vbs` in the user's Startup folder) so the memory
  bus survives reboots. Uninstall via `npm run uninstall` or remove the
  Startup shortcut manually if you do not want persistent startup.
- **API keys (e.g. Gemini) are read from `AI_MEMORY_EMBED_API_KEY` /
  `runtime.json` and passed to the embedded Python worker via stdin**.
  They are never written to logs or the on-disk store.

## Dependencies

This project depends on:
- Node.js (LTS recommended)
- Python 3.11+
- PowerShell 7+ (cross-platform)

Keep these dependencies updated for security patches.
