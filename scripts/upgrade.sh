#!/usr/bin/env sh
# Thin wrapper — delegates to bootstrap.sh without requiring executable bits.
exec sh "$(dirname -- "$0")/bootstrap.sh" upgrade.ps1 "$@"
