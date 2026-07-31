# Contributing to yt

Thank you for contributing. Keep changes reviewable, include regression tests for fixes, and avoid mixing unrelated architecture, documentation, and release changes in one pull request.

## Development requirements

- Node.js 22 or later; the runtime uses the built-in `node:sqlite` module.
- Python 3.10 or later for Python tests and retrieval components.
- PowerShell 7 for PowerShell-based validation and operations.

## Setup

```bash
git clone https://github.com/passionworkeer/obsidian-shared-memory-bus.git
cd obsidian-shared-memory-bus
npm install
```

Optional installer entry points:

```powershell
pwsh -NoProfile -File ./scripts/install.ps1 -WorkspaceRoot .
```

```bash
./scripts/install.sh -WorkspaceRoot .
```

## Checks

Run the checks relevant to your change. Before requesting final review, run as much of the following as your environment supports:

```bash
npm run lint
npm test
npm run test:concurrent
npm run test:integration
npm run test:cross
npm run test:py
npm run test:e2e
```

`npm run test:all` runs a broader combined suite. Some tests require Python, PowerShell, or local services and may not be available in every contributor environment; document anything you could not run in the PR description.

For layout or installer changes:

```powershell
pwsh -NoProfile -File ./scripts/validate-layout.ps1
```

```bash
./scripts/validate-layout.sh
node ops/check/check-memory-integrity.js --strict
```

JavaScript is checked with the root flat ESLint configuration. The repository does not currently enforce Prettier, Black, or isort as CI gates, so do not claim those checks were run unless you ran them explicitly.

## Pull request process

1. Create a focused branch such as `fix/config-port-drift` or `feat/new-memory-tool`.
2. Add or update tests for changed behavior.
3. Run relevant checks and record the results.
4. Use a clear Conventional Commit-style title.
5. Complete the pull request template, including root cause and user impact for fixes.
6. Resolve review threads before merge.
7. Do not merge while required CI checks are failing.

Large architecture changes should first add or update an ADR in [`docs/adr/`](docs/adr/). Prefer several small PRs over one repository-wide rewrite.

## Platform rules

Windows, macOS, and Linux are supported. New cross-platform runtime code should:

- Use the abstraction in `bus/platform/` where one exists.
- Avoid hard-coded user, drive, vault, or workspace paths.
- Use `pwsh` for PowerShell 7 scripts.
- Keep `.sh` scripts POSIX-compatible unless the file explicitly declares Bash.
- Add a Windows or macOS smoke test when changing platform-sensitive behavior.

## Testing expectations

- Unit tests belong in `tests/unit/`.
- Integration flows belong in `tests/integration/`.
- JavaScript/Python behavior equivalence belongs in `tests/cross-language/`.
- End-to-end launcher or client flows belong in `tests/e2e/`.
- A bug fix should include a regression test whenever practical.

Do not maintain hard-coded test totals in documentation. GitHub Actions results are the source of truth.

## Adding or changing MCP services

The core launcher and client configurator must consume the same service plan. Changes to core services should normally update:

- `shared-mcp/port-registry.js`
- `shared-mcp/spawn-plan.js`
- `start.js`
- `setup-mcp.js`
- doctor/status checks
- unit tests
- README endpoint documentation

Optional services documented in `shared-mcp/manifest.json` are not automatically part of the core launcher. Before promoting an optional service to core, document its version pin, startup command, health probe, session-isolation behavior, and failure mode.

## Adding an agent integration

Only add an automatic client writer when its configuration path and schema are documented or reliably verified. Otherwise provide a manual hint and mark the path unverified. Never overwrite malformed client configuration.

## Secret and path hygiene

- Never commit API keys, tokens, cookies, session state, or real private memory data.
- Prefer environment-variable references over plaintext secrets in JSON files.
- Remote embedding backends may transmit memory text to their provider; document that behavior.
- Do not hard-code a contributor's machine path.
- Inspect the staged diff before committing.

## Documentation standards

- Describe current verified behavior, not intended future behavior.
- Distinguish core, optional, and experimental features.
- Do not call a workflow “automatic” when manual setup remains necessary.
- Include the exact supported client name; Claude Desktop and Claude Code are different products.
- Link to existing paths and keep examples executable.
