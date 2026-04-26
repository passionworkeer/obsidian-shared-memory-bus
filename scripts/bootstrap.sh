#!/usr/bin/env sh
# Unified bootstrapper: routes to the appropriate PowerShell install script.
# Usage: ./bootstrap.sh <script-name> [args...]
# Examples:
#   ./bootstrap.sh install.ps1
#   ./bootstrap.sh upgrade.ps1
#   ./bootstrap.sh install-client-integrations.ps1

set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PWSH_BIN="${AI_MEMORY_PWSH:-}"

if [ -z "$1" ]; then
  echo "Usage: $0 <script-name> [args...]" >&2
  exit 1
fi
SCRIPT_NAME="$1"
shift

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
  exec "$PWSH_BIN" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/$SCRIPT_NAME" "$@"
fi

if [ -z "$PWSH_BIN" ]; then
  PWSH_BIN="pwsh"
fi

exec "$PWSH_BIN" -NoProfile -File "$SCRIPT_DIR/$SCRIPT_NAME" "$@"
