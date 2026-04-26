# Contributing to Obsidian Shared Memory Bus

Thank you for helping improve this project. This guide covers everything you need to get started.

## Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/passionworkeer/obsidian-shared-memory-bus
cd obsidian-shared-memory-bus
npm install
```

**Windows:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot .
```

**macOS / Linux:**
```bash
./scripts/install.sh -WorkspaceRoot .
```

### 2. Run Tests

```bash
# All tests (unit + integration)
npm test

# JS unit tests only
npm run test

# Python unit tests only
npm run test:py

# Cross-language equivalence tests
npm run test:cross

# Integration tests only
npm run test:integration

# Full test suite (JS + Python + cross-language)
npm run test:all
```

### 3. Code Style

```bash
# Lint
npm run lint

# Auto-fix lint issues
npm run lint:fix
```

- **JavaScript**: ESLint + Prettier (configured in `shared-mcp/`)
- **Python**: Black + isort (configured in `retrieval/` and `ops/`)
- **PowerShell**: Follows the style in existing `.ps1` scripts
- **Shell scripts**: POSIX `sh` compatible (not Bash-only)

### 4. Validate Layout After Changes

If you modified file layout, install behavior, or startup entrypoints:

**Windows:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
```

**macOS / Linux:**
```bash
./scripts/validate-layout.sh
```

Also run integrity checks:
```bash
node ops/check-memory-integrity.js --strict
```

## Pull Request Process

1. **Fork** the repository and create a branch:
   ```bash
   git checkout -b feat/my-feature
   # or
   git checkout -b fix/my-bug
   ```

2. **Write tests** for new behavior (see Testing Requirements below).

3. **Run the full test suite** and lint:
   ```bash
   npm run test:all && npm run lint
   ```

4. **Run the validation scripts** to ensure layout integrity:
   ```bash
   # Linux/macOS
   ./scripts/validate-layout.sh && node ops/check-memory-integrity.js --strict
   ```

5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add memory_wake_up MCP tool
   fix: resolve orphaned process cleanup on Windows
   docs: clarify vault path resolution order
   ```

6. **Open a Pull Request** with the [PR template](.github/pull_request_template.md) filled in.

7. A maintainer will review. Address feedback by pushing new commits to your branch.

## Architecture Decisions

Major architectural decisions are documented as ADRs in [`docs/adr/`](docs/adr/):

- [ADR-002: Unified Memory Architecture v2](docs/adr/ADR-002-unified-memory-architecture-v2.md) — current active ADR covering SQLite chunk schema, FTS5+BM25, typed promotion, and MMR reranking.

Before proposing significant changes, check existing ADRs to understand the rationale behind current design choices.

## Platform Support Policy

This project supports **Windows, macOS, and Linux** as first-class platforms. Each platform is validated at multiple layers:

| Layer | Windows | macOS | Linux |
|-------|---------|-------|-------|
| Minimum PowerShell | 5.1 (Windows PowerShell) | 7+ (`pwsh`) | 7+ (`pwsh`) |
| Minimum Node.js | 18+ | 18+ | 18+ |
| Script runner | `powershell.exe` | `bash` / `pwsh` | `bash` / `pwsh` |
| Watchdog | `.ps1` | `.sh` | `.sh` |
| Startup registration | Startup folder | LaunchAgents | systemd `--user` / XDG autostart |

**Cross-platform rules:**
- All shell scripts must be POSIX `sh` compatible (no Bash-only features like `[[ ]]` or `==` string comparison without quotes).
- PowerShell scripts must support both `powershell.exe` (Windows PowerShell 5.1) and `pwsh` (PowerShell 7+).
- Use the platform abstraction in `bus/platform/` for platform-specific logic.
- Never hardcode machine-specific paths (e.g., `C:\Users\name\`). Use environment variables.

## Testing Requirements

- **Unit tests**: Cover individual functions and utilities in `tests/unit/`
- **Integration tests**: Cover end-to-end flows in `tests/integration/`
- **Cross-language tests**: Verify JS/Python equivalence in `tests/cross-language/`

All new features should include tests. Bug fixes should include a regression test.

## Good First Contributions

- Improve docs and onboarding clarity
- Add support for a new agent integration
- Improve validation or troubleshooting coverage
- Strengthen secret hygiene or portability
- Add unit or integration tests

## Adding A New Shared MCP

Use shared HTTP only if the service is actually safe to centralize.

Before proposing a new shared MCP, document:
- whether it is stateless or session-isolated
- whether it touches desktop UI or global mutable state
- how it should be health-checked
- what the failure mode looks like under many concurrent clients

Update at minimum:
- `shared-mcp/manifest.json`
- `shared-mcp/start-shared-mcp.ps1` / `shared-mcp/start-shared-mcp.sh`
- `shared-mcp/status-shared-mcp.ps1` / `shared-mcp/status-shared-mcp.sh`
- `shared-mcp/stop-shared-mcp.ps1` / `shared-mcp/stop-shared-mcp.sh`
- `docs/ARCHITECTURE.md`
- `docs/OPERATIONS.md`

## Adding A New Agent Integration

See [`templates/agents/`](./templates/agents/README.md) for per-agent integration templates.

## Secret And Path Hygiene

- Never commit real keys, tokens, cookies, or session state
- Never hardcode one specific user profile path or vault path into public runtime files
- Use environment variables for secrets
- Use runtime discovery or installer-written paths for machine-specific locations
- Before opening a PR: run `git log` to verify no accidental credential commits

## Documentation Standards

- Prefer direct operational language
- Be explicit about what is shared, what is isolated, and why
- Avoid overclaiming: process sharing is not the same as shared agent context
- When describing platform-specific behavior, note the platform explicitly
