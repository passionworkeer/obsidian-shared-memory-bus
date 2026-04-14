---
title: Cross-Platform Setup Guide
description: Platform-specific installation and configuration guides for Windows, macOS, and Linux.
platform: cross-platform
---

# Cross-Platform Setup Guide / 跨平台安装配置指南

This section contains platform-specific setup guides. All guides are **bilingual** (English + Chinese) and **cross-platform compatible**.

---

## Quick Navigation

| Platform | Guide |
|-----------|-------|
| Windows | The primary install path. See `docs/INSTALL.md` and `README.md`. |
| macOS | [macOS Setup Guide](./MACOS_SETUP.md) |
| Linux | [Linux Setup Guide](./LINUX_SETUP.md) |

---

## Universal Prerequisites / 通用前提条件

Before installing on any platform, verify the following:

| Requirement | Windows | macOS | Linux |
|-------------|----------|-------|-------|
| Node.js 18+ | [nodejs.org](https://nodejs.org) | `brew install node` | System package manager or [nvm](https://github.com/nvm-sh/nvm) |
| Python 3.10+ | `python --version` | `python3 --version` | `python3 --version` |
| PowerShell 7+ | `powershell.exe` (built-in) | `pwsh --version` (`brew install powershell`) | `pwsh --version` (`snap install powershell` or [Microsoft repo](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux)) |
| Ports 9331–9338 | Available | Available | Available |

### Verify Prerequisites / 验证前提条件

```powershell
# Windows
node -v
python --version
powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"
```

```bash
# macOS / Linux
node -v
python3 --version
pwsh --version
```

---

## Installation Quick Reference / 安装快速参考

### Windows / Windows 安装

```powershell
# Full install with client wiring
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot <your-project-root>

# Start the shared MCP stack
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\start-default-shared-mcp.ps1

# Verify health
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

### macOS / macOS 安装

```bash
# Full install with client wiring
./scripts/install.sh -WorkspaceRoot <your-project-root>

# Start the shared MCP stack
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh

# Verify health
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

### Linux / Linux 安装

```bash
# Full install with client wiring
./scripts/install.sh -WorkspaceRoot <your-project-root>

# Start the shared MCP stack
~/.ai-memory/shared-mcp/start-default-shared-mcp.sh

# Verify health
~/.ai-memory/shared-mcp/status-shared-mcp.sh
```

---

## Environment Variables Reference / 环境变量参考

| Variable | Description | Windows | macOS / Linux |
|----------|-------------|---------|---------------|
| `AI_MEMORY_STORE` | Store root path | `E:\.ai-memory` | `~/.ai-memory` |
| `AI_MEMORY_PYTHON` | Python interpreter | `python` | `python3` |
| `AI_MEMORY_PWSH` | PowerShell 7 path | N/A | `pwsh` |
| `AI_MEMORY_ROOT` | Installed runtime root | `~/.ai-memory` | `~/.ai-memory` |

For a complete list see `docs/ENVIRONMENT.md`.

---

## Platform-Specific Notes / 平台注意事项

### Windows

- The installer writes `AI_MEMORY_ROOT` and `AI_MEMORY_PYTHON` to the user environment via `[Environment]::SetEnvironmentVariable(..., 'User')`.
- The shared MCP proxy uses VBScript-based watchdog placement in the Startup folder.
- If you see visible Node.js console windows on startup, the installer now applies layered shim resolution + temp-batch cmd.exe fallback to suppress them. Reinstall the runtime if you still see them.
- The `powershell.exe` on Windows is the built-in Windows PowerShell 5.x. For scripts that require PowerShell 7+, use `pwsh`.

### macOS

- `pwsh` is required for install and shared-MCP control scripts. Install via `brew install powershell`.
- Startup registration uses LaunchAgents at `~/Library/LaunchAgents/`.
- The installer generates `~/.ai-memory/activate-ai-memory.sh` and `~/.ai-memory/activate-ai-memory.ps1` for shell activation. Run `source ~/.ai-memory/activate-ai-memory.sh` after install.
- Installed `.sh` wrappers are POSIX `sh` (not Bash-only). They work in `zsh`, `bash`, `fish`, etc.

### Linux

- `pwsh` is required. Install from the [Microsoft package repository](https://learn.microsoft.com/powershell/sowershell-support-lifecycle) for your distro.
- Startup registration prefers `systemd --user` units. Falls back to XDG autostart when `systemctl --user` is unavailable.
- If running under WSL2, treat it as a Linux environment. Ensure the store root path is accessible from WSL.
- The `AI_MEMORY_STORE` default on Linux is `~/.ai-memory`. If your home directory is on a small SSD, set `AI_MEMORY_STORE` to a path on a larger drive.

---

## Shared MCP Ports / 共享 MCP 端口

| Port | Service | Platform |
|------|---------|---------|
| 9331 | `context7` | All |
| 9332 | `fetch` | All |
| 9333 | `time` | All |
| 9334 | `sequential-thinking` | All |
| 9335 | `obsidian` | All |
| 9337 | `playwright` | All |
| 9338 | `memory` | All |

Ensure no other process is using ports 9331–9338 before starting.

---

## Uninstalling / 卸载

```powershell
# Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

```bash
# macOS / Linux
./scripts/uninstall.sh
```
