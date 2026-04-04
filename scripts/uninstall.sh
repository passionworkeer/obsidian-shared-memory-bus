#!/usr/bin/env sh
# uninstall.sh — POSIX sh entry point for uninstalling the ai-memory bundle.
# Detects the running OS and delegates to the appropriate uninstall steps.
# On Windows (detected via environment), delegates to uninstall.ps1 via PowerShell.
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PWSH_BIN="${AI_MEMORY_PWSH:-}"

IS_WINDOWS_WRAPPER=0
case "${OS:-}" in
  Windows_NT) IS_WINDOWS_WRAPPER=1 ;;
esac
case "$(uname -s 2>/dev/null || printf '')" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS_WRAPPER=1 ;;
esac

if [ "$IS_WINDOWS_WRAPPER" -eq 1 ]; then
  if [ -z "$PWSH_BIN" ]; then
    PWSH_BIN="powershell.exe"
  fi
  exec "$PWSH_BIN" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/uninstall.ps1" "$@"
fi

# ---------------------------------------------------------------------------
# macOS / Linux uninstall logic
# ---------------------------------------------------------------------------

AI_MEMORY_ROOT="${AI_MEMORY_ROOT:-"$HOME/.ai-memory"}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-"$HOME/.config"}"
AUTOSTART_DIR="$XDG_CONFIG_HOME/autostart"
SYSTEMD_USER_DIR="$XDG_CONFIG_HOME/systemd/user"

# Helper: remove a file or directory if it exists, printing what was done.
remove_if_present() {
    # Usage: remove_if_present "label" "/path/to/item"
    _label="$1"
    _path="$2"
    if [ -e "$_path" ]; then
        printf '[uninstall] Removing %s: %s\n' "$_label" "$_path"
        rm -rf "$_path"
    else
        printf '[uninstall] Not found (skipped): %s\n' "$_path"
    fi
}

printf '==> Stopping services...\n'

# Stop and remove LaunchAgent plists on macOS.
if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    printf '==> Removing macOS LaunchAgent plists...\n'
    for _plist in com.ai-memory.watchdog.plist com.ai-memory.shared-mcp.plist; do
        _plist_path="$LAUNCH_AGENTS_DIR/$_plist"
        if [ -f "$_plist_path" ]; then
            # Unload first so launchd stops managing it immediately.
            launchctl unload "$_plist_path" 2>/dev/null || true
            remove_if_present "LaunchAgent" "$_plist_path"
        else
            printf '[uninstall] Not found (skipped): %s\n' "$_plist_path"
        fi
    done
fi

# Stop launchd agents managed via the old XDG-like path (for users who placed them manually).
if [ -d "$LAUNCH_AGENTS_DIR" ]; then
    for _plist in "$LAUNCH_AGENTS_DIR"/com.ai-memory.*.plist; do
        # Shell glob that expands to the literal pattern if nothing matches — guard against that.
        case "$_plist" in
            "$LAUNCH_AGENTS_DIR/com.ai-memory.*.plist") break ;;
        esac
        launchctl unload "$_plist" 2>/dev/null || true
        remove_if_present "LaunchAgent" "$_plist"
    done
fi

# Remove systemd user services on Linux (if systemctl --user is available).
_systemctl="$(command -v systemctl 2>/dev/null || printf '')"
if [ -n "$_systemctl" ] && [ -d "$SYSTEMD_USER_DIR" ]; then
    printf '==> Removing systemd user services...\n'
    for _svc in ai-memory-watchdog.service ai-memory-shared-mcp.service; do
        _svc_path="$SYSTEMD_USER_DIR/$_svc"
        if [ -f "$_svc_path" ]; then
            # Disable first so it does not restart.
            "$_systemctl" --user disable "$_svc" 2>/dev/null || true
            remove_if_present "systemd service" "$_svc_path"
        fi
    done
    # Reload systemd to pick up changes.
    "$_systemctl" --user daemon-reload 2>/dev/null || true
fi

# Remove XDG autostart .desktop files on Linux (when systemd is unavailable).
if [ -d "$AUTOSTART_DIR" ]; then
    printf '==> Removing XDG autostart entries...\n'
    for _desktop in ai-memory-watchdog.desktop ai-memory-shared-mcp.desktop; do
        remove_if_present "XDG autostart" "$AUTOSTART_DIR/$_desktop"
    done
fi

# ---------------------------------------------------------------------------
# Remove ~/.ai-memory directory
# ---------------------------------------------------------------------------
printf '\n==> Removing ~/.ai-memory directory...\n'
remove_if_present "~/.ai-memory" "$AI_MEMORY_ROOT"

# ---------------------------------------------------------------------------
# Remove environment variables (shell-rc helpers)
# ---------------------------------------------------------------------------
printf '\n==> Cleaning environment variable helpers...\n'

# Remove activation helpers written by install.ps1.
remove_if_present "activation helper (sh)" "$AI_MEMORY_ROOT/activate-ai-memory.sh"
remove_if_present "activation helper (ps1)" "$AI_MEMORY_ROOT/activate-ai-memory.ps1"

# Print a note about manual env-var cleanup for POSIX users (install.ps1 does
# not write User-scope env vars on macOS/Linux — it only creates activation helpers).
printf '\n'
printf 'NOTE: On macOS/Linux, environment variables (AI_MEMORY_ROOT, AI_MEMORY_PYTHON,\n'
printf '      AI_MEMORY_MCP_PYTHON) are carried in the activation helpers above.\n'
printf '      To fully remove them from your shell environment, remove them from\n'
printf '      your ~/.bashrc, ~/.zshrc, or equivalent shell RC file manually.\n'
printf '      The ~/.ai-memory directory has been removed and no services are running.\n'

printf '\n=== Uninstall Complete ===\n'
