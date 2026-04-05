# Uninstall Guide

## Quick Uninstall

### Windows
```powershell
# Stop all running services
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\shared-mcp\stop-shared-mcp.ps1

# Run uninstaller
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1

# Remove residual files (optional)
Remove-Item -Recurse -Force $env:LOCALAPPDATA\ai-memory -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:USERPROFILE\.ai-memory" -ErrorAction SilentlyContinue
```

### macOS/Linux
```bash
# Stop all running services
~/.ai-memory/shared-mcp/stop-shared-mcp.sh

# Run uninstaller
./scripts/uninstall.sh

# Remove residual files (optional)
rm -rf ~/.ai-memory
```

## What Gets Installed

The installer creates these artifacts:

| Location | What | How to remove |
|----------|------|---------------|
| `~/.ai-memory/` | Flat runtime (scripts, configs, state) | Delete entire directory |
| `~/.ai-memory/install-manifest.json` | Install record | Deleted with above |
| Startup hooks (Windows) | `~/.ai-memory/start-ai-memory.vbs` in Startup folder | Delete the `.vbs` file |
| Startup hooks (macOS) | `~/Library/LaunchAgents/ai-memory.plist` | `launchctl unload ~/Library/LaunchAgents/ai-memory.plist` then delete |
| Startup hooks (Linux) | `~/.config/systemd/user/ai-memory.service` or `~/.config/autostart/ai-memory.desktop` | Disable and delete |
| Client configs | `~/.config/cursor/mcp.json`, `~/.claude/rules/`, etc. | Manually remove shared MCP entries from each file |
| Workspace overlays | `.cursor/mcp.json`, `.vscode/mcp.json`, etc. in your project | Delete the MCP config sections pointing to `localhost:933*` |
| System env | `AI_MEMORY_ROOT`, `AI_MEMORY_OBSIDIAN_VAULT` | Remove from your shell profile or system environment |

## What Gets Left Behind

These are intentionally NOT removed by uninstall — your data:

| Location | What | Remove manually? |
|----------|------|-----------------|
| `<vault>/00-System/ai-memory/` | Structured memory, generated artifacts | Only if you want a clean slate |
| `<vault>/02-KB/OBSIDIAN.md` | Created if not existing | Safe to delete if not used elsewhere |
| `<vault>/02-KB/MEMORY.md` | Created if not existing | Safe to delete if not used elsewhere |
| `<vault>/02-KB/WORKING.md` | Created if not existing | Safe to delete if not used elsewhere |
| `<vault>/00-System/ai-memory/inbox/` | Per-tool inbox notes | Only if you want to clear inbox |

## Complete Clean Slate

To remove everything including all memory data:

```powershell
# 1. Uninstall the runtime
.\scripts\uninstall.ps1

# 2. Remove vault memory artifacts (WARNING: destroys memory)
Remove-Item -Recurse -Force "D:\Your\Vault\00-System\ai-memory"

# 3. Remove client MCP configs
Remove-Item -Force "$env:USERPROFILE\.cursor\mcp.json" -ErrorAction SilentlyContinue
# ... repeat for each client
```

## Troubleshooting Uninstall

**Uninstall script fails?**
- Check if any `ai-memory` processes are still running: `Get-Process | Where-Object {$_.Name -like "*ai-memory*"}`
- Kill them manually: `Stop-Process -Name "ai-memory*" -Force`

**Startup hook won't go away?**
- Windows: Delete `~/.ai-memory/start-ai-memory.vbs` from the Startup folder (`shell:startup`)
- macOS: `launchctl unload ~/Library/LaunchAgents/ai-memory.plist`
- Linux: `systemctl --user disable ai-memory`

**Port 9331-9338 still in use?**
- After uninstall, if ports are still blocked: `netstat -ano | findstr "9331"` to find the process
