# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| Older tags | Best effort only |

## Reporting a vulnerability

Do not publish exploit details in a normal GitHub issue. Use GitHub Private Vulnerability Reporting from the repository's Security tab when available. Include the affected commit, reproduction steps, impact and suggested mitigation. If private reporting is unavailable, open only a request for a private contact channel; do not include vulnerability details, secrets, private memory data or proof-of-concept payloads.

## Local attack surface

This project exposes local MCP HTTP endpoints. Core services bind to loopback by default:

- fetch: 9332
- time: 9333
- split memory: 9338–9341
- monolithic memory compatibility mode: 9338

`AI_MEMORY_BASE_PORT` shifts the complete range. Keep source installs on `AI_MEMORY_BIND_HOST=127.0.0.1`. Docker may bind to `0.0.0.0` inside the container while Compose publishes the ports on host loopback.

The proxy rejects non-loopback Host headers to reduce DNS-rebinding exposure. This is not a substitute for operating-system user isolation, authentication or transport security when exposing a service beyond the local machine.

## Memory data

The canonical memory store can contain project context and user-specific information. Do not write passwords, API keys, session cookies, private keys, access tokens or raw sensitive transcripts into memory records.

Use filesystem permissions appropriate to the machine. On POSIX, runtime configuration is persisted with mode `0600`. On Windows, keep the memory store inside a per-user directory whose ACL grants access only to the current user and trusted administrators; do not place it in a broadly shared folder.

## Embedding API keys

Runtime JSON supports `apiKeyEnv`, not plaintext credentials. Put the environment-variable name in `runtime.json` and store the real value in the process or user environment.

Plaintext `apiKey` fields are ignored during runtime resolution and removed whenever configuration is persisted. Existing installations can migrate without printing the secret:

```bash
npm run migrate:runtime-secrets -- --dry-run
npm run migrate:runtime-secrets -- --api-key-env AI_MEMORY_EMBED_API_KEY
```

Use `--root <memory-store>` when migrating a store other than the resolved default. The migration preserves an existing `apiKeyEnv`; otherwise it replaces each removed plaintext key with the supplied environment-variable name. Output contains only paths, counts and the environment-variable name, never the credential value.

After migration, set the corresponding environment variable and rebuild the embedding index if provider identity, model or base URL changed.

## Remote providers

The default hash embedding path is local. OpenAI-compatible, Gemini, transformer download endpoints and other remote integrations may transmit text or metadata to third parties. Review provider terms and data handling before enabling them.

Logs, bug reports, workflow artifacts and benchmark fixtures must not contain private memory records. Runtime summaries expose only whether a key is configured; they must never include the value.

## Dependency and workflow security

- Keep Node.js, Python, PowerShell and package dependencies patched.
- Production fallback commands are version-pinned; update them through reviewed pull requests with smoke tests rather than using `@latest`.
- Pull requests from forks must not receive repository secrets.
- Release workflows should publish only from validated tags whose version matches `package.json`.

## Security checklist for maintainers

Before release:

- Run CI and relevant integration tests.
- Run a secret scan over the diff and generated artifacts.
- Verify local endpoints still bind to loopback.
- Confirm no example configuration contains a real credential or private path.
- Review dependency audit results and document accepted risk.
