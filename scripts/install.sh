#!/usr/bin/env sh
# Thin wrapper — delegates to bootstrap.sh
exec "$(dirname -- "$0")/bootstrap.sh" install.ps1 "$@"
