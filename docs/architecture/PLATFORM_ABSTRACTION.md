---
title: Platform Abstraction Architecture
description: Cross-platform abstraction design — vault resolution, store roots, Python spawning, and watchdog generation for Windows, macOS, and Linux.
platform: cross-platform
---

# Platform Abstraction Architecture / 平台抽象架构

> English: How the shared memory bus abstracts OS-specific behaviour so the same codebase runs on Windows, macOS, and Linux.
> 中文：共享内存总线如何抽象操作系统特定行为，使同一代码库能在 Windows、macOS 和 Linux 上运行。

## Overview / 概述

The platform abstraction layer lives in `bus/platform/`. It provides a unified JavaScript interface for operations that differ per OS:

- **Vault root resolution** — finding the Obsidian vault from env vars, app config, or standard fallbacks
- **Store root resolution** — choosing the `.ai-memory` data directory
- **Python process spawning** — launching the retrieval worker with the right interpreter and UTF-8 env
- **Watchdog script generation** — producing a recovery script in the platform's native language (VBS on Windows, bash on macOS/Linux)

The three adapters share a common interface (`resolveVaultRoot`, `resolveStoreRoot`, `spawnPython`, `makeWatchdogScript`) while handling OS-specific details internally.

平台抽象层位于 `bus/platform/`，为各操作系统不同的操作提供统一的 JavaScript 接口。

```
bus/platform/
├── index.js        # Platform detection (win32 / darwin / linux)
├── windows.js      # Windows adapter
├── darwin.js       # macOS adapter
└── linux.js        # Linux adapter
```

---

## Platform Detection / 平台检测

`bus/platform/index.js` (simplified):

```javascript
const platform = process.platform; // 'win32' | 'darwin' | 'linux'

let adapter;
if (platform === 'win32')       adapter = require('./windows');
else if (platform === 'darwin') adapter = require('./darwin');
else                            adapter = require('./linux');

module.exports = adapter;
```

Detection is based on Node.js's `process.platform`. The adapter is cached after first call — runtime platform cannot change.

平台检测基于 Node.js 的 `process.platform`，适配器在首次调用后缓存。

---

## Vault Root Resolution / 保险库根目录解析

### Resolution Order / 解析顺序

All three adapters follow the same priority order:

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | `AI_MEMORY_STORE` | Override for store root; also checked as vault candidate |
| 2 | `AI_MEMORY_STORE_ROOT` | Alias for store root |
| 3 | `AI_MEMORY_OBSIDIAN_VAULT` | Explicit vault path |
| 4 | `OBSIDIAN_VAULT_ROOT` | Standard env var |
| 5 | App config | OS-specific Obsidian config file |
| 6 | Standard fallbacks | Platform-specific default paths |

### Windows Config Path / Windows 配置路径

```powershell
# First checks (in order):
$env:APPDATA\obsidian\obsidian.json
$env:LOCALAPPDATA\obsidian\obsidian.json
%USERPROFILE%\AppData\Roaming\obsidian\obsidian.json
```

### macOS Config Path / macOS 配置路径

```bash
~/Library/Application Support/obsidian/obsidian.json
~/.config/obsidian/obsidian.json
```

### Linux Config Path / Linux 配置路径

```bash
~/.config/obsidian/obsidian.json
/etc/xdg/obsidian/obsidian.json
```

### Standard Fallbacks / 标准回退路径

| Platform | Default vault candidates |
|----------|--------------------------|
| Windows | `E:\Obsidian Vault`, `D:\Obsidian Vault`, `%USERPROFILE%\Obsidian Vault` |
| macOS | `~/Obsidian Vault`, `~/Documents/Obsidian Vault`, `~/Desktop/Obsidian Vault` |
| Linux | `~/Obsidian Vault`, `~/Documents/Obsidian Vault`, `~/Desktop/Obsidian Vault` |

If none of the above resolve, the adapter throws `no-obsidian-vault`.

---

## Store Root Resolution / 存储根目录解析

The store root is the canonical data plane — the `.ai-memory` directory.

| Platform | Default | Override env var |
|----------|---------|-----------------|
| Windows | `E:\.ai-memory` | `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` |
| macOS | `~/.ai-memory` | `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` |
| Linux | `~/.ai-memory` | `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` |

On Windows, `bus/platform/windows.js` also implements `detectBestDrive()` which scans drive letters C–Z and picks the drive with the most free space (minimum 2 GB).

---

## Python Process Spawning / Python 进程生成

### Windows — `spawnPython(args, options)`

```javascript
// bus/platform/windows.js
function spawnPython(args, options = {}) {
  return nodeSpawn("python", args, {
    ...options,
    windowsHide: true,          // Suppress visible console window
    env: {
      ...(options.env || process.env),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
}
```

Uses `python` (not `python3`). Sets `windowsHide: true` so the child process does not allocate a visible console window.

### macOS / Linux — `spawnPython(args, options)`

```javascript
// bus/platform/darwin.js / linux.js
function spawnPython(args, options = {}) {
  return nodeSpawn("python3", args, {
    ...options,
    env: {
      ...(options.env || process.env),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
}
```

Uses `python3`. No `windowsHide` needed on POSIX.

---

## Watchdog Script Generation / 看门狗脚本生成

The watchdog monitors the memory-bus process and restarts it if it dies. Each platform generates its script in the platform's native language.

### Windows — VBScript

```vb
' Generated by bus/platform/windows.js
' Writes supervisor PID, loops checking target PID, runs callback if dead.
Option Explicit
Dim pidPath, callbackScript, targetPid
' ...
Do
    WScript.Sleep intervalSec * 1000
    ' Read target PID from pidPath (first non-empty line)
    If Not IsProcessRunning(targetPid) Then
        objShell.Run callbackScript, 0, False  ' hidden window
        Exit Do
    End If
Loop
```

The VBScript is placed in the Windows Startup folder as `AI Memory Watchdog.vbs`. It runs hidden (window style `0`) and invokes the PowerShell callback in the background.

### macOS / Linux — Bash

```bash
#!/bin/bash
# Generated by bus/platform/darwin.js or linux.js
PID_PATH='/tmp/watchdog.pid'
CALLBACK='echo "watchdog recovered"'
INTERVAL=15

echo "$$" > "$PID_PATH"

is_running() {
    local pid="$1"
    kill -0 "$pid" 2>/dev/null
}

while true; do
    sleep "$INTERVAL"
    TARGET_PID=$(sed -n '1p' "$PID_PATH" | tr -d '[:space:]')
    if [ -n "$TARGET_PID" ] && ! is_running "$TARGET_PID"; then
        eval "$CALLBACK" &
        exit 0
    fi
done
```

On macOS the script path is `~/.ai-memory/watchdog-darwin.sh`. On Linux it is `~/.ai-memory/watchdog-linux.sh`.

---

## Adapter Interface / 适配器接口

All three adapters expose the same interface:

```typescript
interface PlatformAdapter {
  name: 'windows' | 'darwin' | 'linux';
  storeRootDefault: string;
  homeEnvVar: string;       // 'USERPROFILE' on Windows, 'HOME' on POSIX
  pathSep: string;          // '\\' on Windows, '/' on POSIX

  executables: {
    python: string;         // 'python' on Windows, 'python3' on POSIX
    node: string;           // 'node'
    powershell: string;     // 'powershell.exe' / 'pwsh' / 'pwsh'
  };

  watchdog: {
    scriptExtension: string; // '.vbs' / '.sh'
    scriptPath: string;
  };

  makeWatchdogScript(pidPath: string, callbackScript: string): string;
  spawnPython(args: string[], options?: object): ChildProcess;
  resolveVaultRoot(options?: { refresh?: boolean }): string;
  resolveStoreRoot(options?: { refresh?: boolean }): string;
  getInboxRoot(storeRoot?: string): string;
  getGeneratedRoot(storeRoot?: string): string;
  getKgRoot(storeRoot?: string): string;
}
```

---

## Key Differences Summary / 关键差异汇总

| Behaviour | Windows | macOS | Linux |
|-----------|---------|-------|-------|
| Store default | `E:\.ai-memory` | `~/.ai-memory` | `~/.ai-memory` |
| Python binary | `python` | `python3` | `python3` |
| Watchdog language | VBScript | Bash | Bash |
| PowerShell | `powershell.exe` | `pwsh` | `pwsh` |
| Watchdog script location | `%APPDATA%\...\Startup\AI Memory Watchdog.vbs` | `~/.ai-memory/watchdog-darwin.sh` | `~/.ai-memory/watchdog-linux.sh` |
| Obsidian config | `%APPDATA%\obsidian\obsidian.json` | `~/Library/Application Support/obsidian/obsidian.json` | `~/.config/obsidian/obsidian.json` |
| Startup registration | Startup folder | LaunchAgent | systemd `--user` or XDG autostart |
| Drive detection | Yes (scans C–Z) | N/A | N/A |

---

## Adding a New Platform / 添加新平台

To add support for a new OS (e.g., FreeBSD):

1. **Create `bus/platform/freebsd.js`** — implement the full `PlatformAdapter` interface:
   - `resolveVaultRoot()` — resolve vault path for FreeBSD config location
   - `resolveStoreRoot()` — default store path
   - `spawnPython()` — `python3` on FreeBSD
   - `makeWatchdogScript()` — generate a shell script for FreeBSD (or use POSIX bash)
   - `executables.powershell` — set to `null` if PowerShell is unavailable, or to `pwsh` if installed via package

2. **Update `bus/platform/index.js`** to require and export the new adapter:
   ```javascript
   } else if (platform === 'freebsd') {
     adapter = require('./freebsd');
   }
   ```

3. **Update `shared-mcp/start-shared-mcp.ps1` and `.sh`** — add any new startup registration logic.

4. **Add CI validation** in `.github/workflows/portable-core.yml` — smoke-test the new platform in CI.

5. **Add platform guide** at `docs/platform/FREEBSD_SETUP.md` following the same bilingual template as `MACOS_SETUP.md` and `LINUX_SETUP.md`.

---

## Testing Across Platforms / 跨平台测试

### Local Smoke Tests / 本地冒烟测试

```powershell
# Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\validate-layout.ps1
```

```bash
# macOS / Linux
./scripts/validate-layout.sh
```

### CI Guardrails / CI 守卫

| Workflow | Purpose | Platforms |
|----------|---------|-----------|
| `.github/workflows/windows-validate.yml` | Windows full validation | Windows only |
| `.github/workflows/portable-core.yml` | Core layout + POSIX smoke | macOS, Linux, Git Bash |

### Manual Verification Checklist / 手动验证清单

- [ ] Vault auto-detection resolves the correct vault
- [ ] Store root defaults to platform-appropriate path
- [ ] `memory_status` returns `watchdog.running: true`
- [ ] `search_shared_memory` returns results (BM25 fallback is always available)
- [ ] Startup hook is registered in the correct location for the platform
- [ ] `.sh` wrappers are POSIX `sh` (not Bash-only) and find `pwsh`
- [ ] Watchdog restarts the bus process after simulated crash
