# Git Hooks Integration

This document describes how git hooks automate agent registration and memory refresh
for all agents sharing the obsidian-shared-memory-bus.

## Overview

Three git hooks are used:

| Hook | Trigger | Purpose |
|------|---------|---------|
| `pre-commit` | Before every commit | Agent registration + fast inbox cleanup |
| `post-checkout` | After every checkout | Refresh GLOBAL-CONTEXT if stale; detect new agent skills |
| `post-merge` | After every `git pull` | Trigger memory rebuild if structured layers changed |

**All hooks are non-blocking**: they always exit with code 0, even if operations fail.
Hook failures never block git operations.

---

## Hook Architecture

### Windows vs POSIX

On Windows, Git calls hooks via `git.exe` which looks for files without extensions.
PowerShell scripts (`.ps1`) are not automatically recognized.

**Solution**: Each hook is installed as a **POSIX `.sh` shim** that calls the PowerShell script:

```sh
#!/bin/sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(dirname "$0")/pre-commit-hook.ps1" "$@"
exit 0
```

The shim is always POSIX-compliant (`sh`, not `bash`) for maximum compatibility
across Git for Windows (MSYS2/MinGW), macOS, and Linux.

**Installation**: Run `scripts/install-git-hooks.ps1` (called automatically by `scripts/install.ps1`).

---

## `pre-commit` Hook

**File**: `.git/hooks/pre-commit.sh` → `ops/pre-commit-hook.ps1`

### What it does

1. **Detect active agent**: Inspects environment (`AGENT_NAME`, `Claude-Code`, `OPENCLAW`, `CODEX`, etc.) and process tree to identify which agent is running
2. **Register agent**: Appends a timestamped entry to `00-System/ai-memory/structured/agent-registrations.jsonl`
3. **Fast inbox cleanup**: Calls `ops/cleanup-inbox.ps1 --smoke` to remove entries older than 30 days (fast mode, non-blocking)

### Agent registration format

```jsonl
{"agent":"claude-code","event":"pre-commit","repo":"<repo-root>","t":"2026-04-10T12:00:00Z"}
```

### Non-blocking guarantee

```sh
exit 0  # Always succeeds, even if PowerShell script fails
```

---

## `post-checkout` Hook

**File**: `.git/hooks/post-checkout.sh` → `ops/post-checkout-hook.ps1`

### What it does

1. **Detect stale GLOBAL-CONTEXT**: Compares `GLOBAL-CONTEXT.md`'s `sourceStructuredSignature` against the current structured layer hash
2. **Trigger memory rebuild**: If stale, spawns `ops/build-memory-layers.js` asynchronously (background, non-blocking)
3. **Detect new agent skills**: Scans `.agents/skills/` for new `.md` files not present in the last checkout; logs discovery

### Staleness check logic

```
if (GLOBAL-CONTEXT.sourceStructuredSignature != currentStructuredSignature):
    trigger ops/build-memory-layers.js (background)
```

### Non-blocking guarantee

The rebuild runs as a background job (`Start-Job` on PowerShell) or `nohup` subprocess.

---

## `post-merge` Hook

**File**: `.git/hooks/post-merge.sh` → `ops/post-merge-hook.ps1`

### What it does

1. **Detect structured layer changes**: After pull, checks if any JSONL files in `00-System/ai-memory/structured/` changed
2. **Trigger dream consolidation**: If layers changed, triggers `ops/run-memory-dream.ps1 -Writeback` (with `--SkipArchive` for speed)
3. **Signal watchdog**: Writes a signal file `00-System/ai-memory/.watchdog/signal-memory-refresh.txt` to tell the watchdog that a pull has occurred

### Signal file format

```
# Written by post-merge hook at 2026-04-10T12:00:00Z
# Triggered by: pre-commit hook
MERGE_TS=2026-04-10T12:00:00Z
```

---

## Installation

### Automatic (recommended)

```powershell
# Part of scripts/install.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1 -WorkspaceRoot .
```

### Manual

```powershell
# Install hooks to .git/hooks/
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1 -WorkspaceRoot . -Force
```

### What gets installed

```
.git/hooks/
  pre-commit           (POSIX shim → pre-commit-hook.ps1)
  post-checkout        (POSIX shim → post-checkout-hook.ps1)
  post-merge          (POSIX shim → post-merge-hook.ps1)
  pre-commit-hook.ps1
  post-checkout-hook.ps1
  post-merge-hook.ps1
```

---

## Security

- **No secrets**: Hooks never read or write credentials, tokens, or API keys
- **No network calls**: Hooks operate only on local files
- **Non-blocking**: Hook failures never affect git operations
- **Opt-out**: To disable hooks for a specific agent, add the agent name to `SKILL.md`'s opt-out list or remove the hook files from `.git/hooks/`
- **Read-only by default**: All hooks operate on their own signal/state files, not on agent memory directly

---

## Hook Parameter Reference

| Hook | Parameters | Notes |
|------|-----------|-------|
| `pre-commit` | (none) | Runs before every commit regardless of files changed |
| `post-checkout` | `$1` = previous HEAD, `$2` = new HEAD, `$3` = flag (1=branch, 0=file) | Only triggers rebuild on branch checkout (flag=1) |
| `post-merge` | (none) | Runs after every merge including fast-forward merges |

---

## Troubleshooting

### Hook not firing
- Check that `.git/hooks/pre-commit` is executable: `chmod +x .git/hooks/pre-commit`
- On Windows with Git Bash: hooks should work automatically
- On Windows without Git Bash: ensure `sh.exe` is in PATH or use `scripts/install-git-hooks.ps1`

### Hook blocking commits
- Hooks are designed to never block. If they do, check that the shim files contain `exit 0`
- To disable temporarily: rename `.git/hooks/pre-commit` to `pre-commit.disabled`

### PowerShell script errors
- Errors are logged to the PowerShell error stream but do not affect hook exit code
- Run the PowerShell script manually to see detailed errors:
  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops/pre-commit-hook.ps1
  ```

---

## Files Reference

| File | Purpose |
|------|---------|
| `scripts/install-git-hooks.ps1` | Installs shims + PS1 scripts to `.git/hooks/` |
| `ops/pre-commit-hook.ps1` | Agent registration + fast inbox cleanup |
| `ops/post-checkout-hook.ps1` | GLOBAL-CONTEXT refresh + new agent detection |
| `ops/post-merge-hook.ps1` | Memory rebuild + watchdog signal |
