#!/usr/bin/env sh
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
  exec "$PWSH_BIN" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/install.ps1" "$@"
fi

if [ -z "$PWSH_BIN" ]; then
  PWSH_BIN="pwsh"
fi

exec "$PWSH_BIN" -NoProfile -File "$SCRIPT_DIR/install.ps1" "$@"
