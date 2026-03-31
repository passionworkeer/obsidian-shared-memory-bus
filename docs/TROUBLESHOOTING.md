# Troubleshooting

## Installer Fails Immediately

Check these first:
- `Node.js` is installed and `npm` is on `PATH`
- `powershell.exe` can run local scripts with `-ExecutionPolicy Bypass`
- the target install path is writable

Quick checks:

```powershell
node -v
npm -v
```

## Obsidian MCP Does Not Start

`run-obsidian-mcp.ps1` looks for the vault in this order:
1. `AI_MEMORY_OBSIDIAN_VAULT`
2. `OBSIDIAN_VAULT_ROOT`
3. the active or most recent vault in `%APPDATA%\obsidian\obsidian.json`
4. `%USERPROFILE%\Documents\Obsidian Vault`

If auto-detection is wrong, set it explicitly:

```powershell
[Environment]::SetEnvironmentVariable("AI_MEMORY_OBSIDIAN_VAULT", "D:\Your\Vault", "User")
```

## MiniMax MCP Does Not Start

Make sure these exist:
- `MINIMAX_API_KEY`
- `MINIMAX_API_HOST` or let it default to `https://api.minimax.chat`
- `minimax-coding-plan-mcp` on `PATH`

If the executable is installed somewhere unusual:

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_MCP_COMMAND", "C:\path\to\minimax-coding-plan-mcp.exe", "User")
```

## Shared MCP Ports Are Already In Use

Inspect shared listeners:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\status-shared-mcp.ps1
```

Force a clean restart:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\shared-mcp\start-default-shared-mcp.ps1 -ForceRestart
```

## Verify Before Heavy Multi-Agent Use

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\verify-client-integrations.ps1 -WorkspaceRoot <your-project-root> -RunCliChecks
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\.ai-memory\run-shared-stack-pressure-test.ps1 -WorkspaceRoot <your-project-root> -Waves 5 -RunCliChecks
```

Good signs:
- one listener per shared port
- stable PIDs across waves
- `memory` and `obsidian` MCP endpoints stay healthy

## `npm audit` Shows Vulnerabilities

At the moment, the remaining audit warnings are in third-party dependencies under the `sqlite3` tree. They are not secret leaks from this repository.

Practical guidance:
- keep the repo clean and secret-free
- prefer local trusted installs
- upgrade dependencies in a controlled pass rather than using `npm audit fix --force` blindly
