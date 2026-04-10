# Deployment Matrix

## Recommended Modes

| Scenario | Supported | Notes |
| --- | --- | --- |
| Single machine, local Obsidian vault | Yes | recommended default |
| Single machine, many agents and clients | Yes | primary target of this project |
| Single machine with optional backup or sync | Yes, carefully | keep sync and memory indexing as separate concerns |
| Windows full control plane | Yes | installer, shared MCP control, watchdog startup, and client wiring validated |
| Windows express / guided / unattended install | Yes | `scripts/install.ps1` supports three composition modes via boolean parameters |
| macOS/Linux portable core | Yes | `pwsh`-based install/start/status/stop wrappers and startup registration ship in the bundle as LaunchAgents, `systemd --user`, or XDG autostart fallbacks; current deepest live validation still happens on Windows |
| Cross-platform onboarding pack | Yes | generated agent packs bundle shared HTTP MCP snippets, a portable skill template, and a thin plugin-adapter contract |
| Multi-device shared vault with extra sync layers | Caution | understand sync conflict behavior first |
| Hosted multi-tenant deployment | No | out of scope for this bundle |

## Reference Shapes

### 1. Single Machine Local Vault

Best default.

- Obsidian vault is local
- shared MCP runs on localhost
- all canonical memory stays on the machine
- optional remote embeddings remain off by default

### 2. Single Machine With Backup Or Sync

Supported, but stay disciplined.

- keep one canonical live vault
- do not stack multiple overlapping sync methods casually
- treat backup and sync as operational layers outside the shared memory design

### 3. Multi-Client On One Machine

This is the main operating mode.

- many local agents talk to one shared MCP layer
- process deduplication reduces repeated local server launches
- Playwright is shared as a process but keeps isolated sessions
- UI-bound tools remain isolated

### 4. Portable Public Template

This repo is intended to be reusable.

- runtime paths are resolved dynamically
- secrets stay in environment variables
- public docs describe the architecture without hardcoding one machine

## Installation Options

| Method | When to Use | Key Features |
|---|---|---|
| **Guided installer (`scripts/install.ps1`)** | Windows users who want one-command setup | Resolves Python, installs deps, registers startup, generates initial layers, optionally wires client integrations |
| **Manual copy** | CI/CD environments or Unix systems without pwsh | Copy flat runtime bundle, run each step individually |
| **Portable bundle** | Trying the system without installing | Run entirely from the project directory; set `AI_MEMORY_ROOT` to the bundle root |

### Guided Installer: Windows Modes

`scripts/install.ps1` is a parameterized PowerShell script, not a UI wizard. Use combinations of its boolean flags to compose the install mode you need:

#### Express Mode (all defaults, one command)

Installs everything, registers startup, wires client integrations — all with default values. Recommended for fresh workstations.

```powershell
.\scripts\install.ps1 -WorkspaceRoot "E:\desktop\Obsidian Vault"
```

```bash
# On Windows/bash, invoke PowerShell:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/install.ps1 \
    -WorkspaceRoot "E:\desktop\Obsidian Vault"
```

#### Guided Mode (selective flags)

Choose exactly which components to install. Use this when you want to keep the installation minimal or skip steps that are already configured.

```powershell
# Skip client integrations (e.g. CI machine)
.\scripts\install.ps1 `
    -WorkspaceRoot "E:\desktop\Obsidian Vault" `
    -ApplyClientIntegrations $false

# Skip Python dependency installation (already installed)
.\scripts\install.ps1 `
    -WorkspaceRoot "E:\desktop\Obsidian Vault" `
    -InstallPythonDeps $false

# Install to a custom location
.\scripts\install.ps1 `
    -TargetRoot "D:\ai-memory" `
    -WorkspaceRoot "E:\desktop\Obsidian Vault" `
    -RegisterStartup $false
```

#### Unattended Mode (no side effects)

Install files, resolve runtime, but do not register startup hooks or persist user environment variables. Ideal for containerized or ephemeral environments.

```powershell
.\scripts\install.ps1 `
    -WorkspaceRoot "E:\desktop\Obsidian Vault" `
    -RegisterStartup $false `
    -PersistUserEnvironment $false `
    -InstallPythonDeps $true `
    -ApplyClientIntegrations $false
```

## Resilience and Reliability Options

| Component | Description | When to Use |
|---|---|---|
| **Watchdog supervisor** (`bus/memory-watchdog-supervisor.ps1`) | Background process that monitors the watchdog worker and auto-restarts it if it crashes or version drifts | Recommended for all Windows installations; enabled by default via the guided installer's `-RegisterStartup` flag |
| **Watchdog daemon** (`bus/memory-watchdog.ps1 -Daemon`) | Background watchdog process on Unix (Linux/macOS); restarts shared MCP on failure | Use `systemd --user` to manage the daemon lifecycle on Unix |
| **Watchdog supervisor (Unix)** | Watches the watchdog worker, restarts if stale or version-drifted | Use alongside `systemd --user` on Linux; use LaunchAgents on macOS |

### Watchdog Supervisor Behavior

On Windows, `memory-watchdog-supervisor.ps1` runs as a hidden background process (launched via a VBS stub in the Start Menu) and polls every **5 seconds** (`-PollSeconds`):

```
Poll → Is the watchdog worker running?
  No  → Has the state file been written in the last 45 seconds?
          Yes → skip
          No  → restart watchdog worker
  Yes → Has the watchdog version file changed?
          Yes → stop and restart
          No  → continue polling
```

This means a crashed watchdog worker is recovered within 5 seconds. A version-upgraded install triggers a clean restart of the worker automatically.

On Unix, the watchdog daemon (`memory-watchdog.ps1 -Daemon -PollSeconds 15`) handles its own restart logic. Use `systemd --user` to supervise the daemon, and the daemon itself supervises the shared MCP.

### Startup Registration

The guided installer registers startup hooks automatically. On Unix you can also manage the daemon directly:

```bash
# Linux: systemd user unit (installed by install.ps1)
systemctl --user enable --now ai-memory-watchdog.service

# macOS: LaunchAgent (installed by install.ps1)
launchctl load ~/Library/LaunchAgents/com.ai-memory.watchdog.plist

# Check status
systemctl --user status ai-memory-watchdog.service   # Linux
launchctl list | grep ai-memory                      # macOS
```

## Anti-Patterns

- Treating shared MCP as one merged agent context
- Hardcoding secrets into startup scripts or manifests
- Using a remote embedding provider by default when local-first behavior is enough
- Forcing desktop-stateful tools into the shared pool without clear isolation guarantees
