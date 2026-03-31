# Contributing

Thanks for helping improve this project.

## Before You Start
- This repo is Windows-first
- `Node.js` and `npm` should be available on `PATH`
- `PowerShell` should be able to run local scripts with `-ExecutionPolicy Bypass`
- `uv` is recommended if you want to exercise the shared `fetch` and `time` MCP services

## Local Development Loop
1. Read [`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/SECURITY.md`](docs/SECURITY.md)
2. Install the bundle locally:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

3. Start the shared stack:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1
```

4. Run the basic validation story:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\run-shared-stack-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 3 -RunCliChecks
```

## Good First Contributions
- Improve docs and onboarding clarity
- Add support for a new agent integration
- Improve validation or troubleshooting coverage
- Strengthen secret hygiene or portability

## Adding A New Shared MCP
Use shared HTTP only if the service is actually safe to centralize.

Before proposing a new shared MCP, document:
- whether it is stateless or session-isolated
- whether it touches desktop UI or global mutable state
- how it should be health-checked
- what the failure mode looks like under many concurrent clients

Update at least these files when appropriate:
- `shared-mcp/manifest.json`
- `shared-mcp/start-shared-mcp.ps1`
- `shared-mcp/status-shared-mcp.ps1`
- `docs/ARCHITECTURE.md`
- `docs/MCP-DEDUP.md`
- `docs/TROUBLESHOOTING.md`

## Adding A New Agent Integration
Follow [`docs/NEW-AGENT-INTEGRATION.md`](docs/NEW-AGENT-INTEGRATION.md).

At minimum, document:
- how the agent reads shared memory
- how it writes durable memory back
- whether it should use shared or isolated MCPs
- how skills or prompts are made portable

## Secret And Path Hygiene
- Never commit real keys, tokens, cookies, or session state
- Never hardcode one specific user profile path or vault path into public runtime files
- Use environment variables for secrets
- Use runtime discovery or installer-written paths for machine-specific locations

## Before Opening A Pull Request
- Run the basic validation commands above
- Check that new docs match actual script behavior
- Rescan for secrets and accidental personal paths
- Keep changes focused; split unrelated work into separate PRs when possible

## Documentation Standard
- Prefer direct operational language
- Be explicit about what is shared, what is isolated, and why
- Avoid overclaiming: process sharing is not the same as shared agent context
