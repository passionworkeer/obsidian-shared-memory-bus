# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| Older tags | Best effort only |

## Reporting a vulnerability

Do not publish exploit details in a normal GitHub issue.

Preferred process:

1. Use GitHub Private Vulnerability Reporting from the repository's **Security** tab when the option is available.
2. Include the affected commit or version, reproduction steps, impact, and any suggested mitigation.
3. Allow the maintainer a reasonable period to reproduce and coordinate a fix before public disclosure.

If private reporting is unavailable, open a public issue containing only a request for a private contact channel. Do not include the vulnerability details, secrets, private memory data, or proof-of-concept payload in that issue.

## Local attack surface

This project exposes local MCP HTTP endpoints. Core services bind to `127.0.0.1` and use the following default ports:

- fetch: 9332
- time: 9333
- split memory: 9338–9341
- monolithic memory compatibility mode: 9338

`AI_MEMORY_BASE_PORT` shifts the complete range. Keep these endpoints on loopback; do not bind them to `0.0.0.0` or expose them through a public reverse proxy without adding authentication and transport security.

The project can register local startup/watchdog behavior through installer scripts. Review installer options before enabling automatic startup. To remove an installation, use the corresponding uninstall/cleanup script when present for your installation method, or remove the generated startup entry and installed files manually. The root `package.json` does not currently provide an `npm run uninstall` command.

## Secrets and remote providers

- Do not commit API keys, tokens, cookies, client configuration containing credentials, or real memory-store contents.
- Prefer environment variables such as `AI_MEMORY_EMBED_API_KEY` over plaintext values in `runtime.json`.
- Restrict local config and store permissions to the current user where practical.
- The default hash embedding path is local. OpenAI-compatible, Gemini, transformer download endpoints, or other remote integrations may transmit text or metadata to third parties. Review provider terms and data handling before enabling them.
- Logs, bug reports, workflow artifacts, and benchmark fixtures must not contain private memory records.

## Dependency and workflow security

- Keep Node.js, Python, PowerShell, and package dependencies patched.
- Pin third-party runtime tools and GitHub Actions where reproducibility or supply-chain risk matters.
- Pull requests from forks must not receive repository secrets.
- Release workflows should publish only from validated tags whose version matches `package.json`.

## Security checklist for maintainers

Before release:

- Run the CI workflow and relevant integration tests.
- Run a secret scan over the diff and generated artifacts.
- Verify local endpoints still bind to loopback.
- Confirm no example configuration contains a real credential or private path.
- Review dependency audit results and document accepted risk.
