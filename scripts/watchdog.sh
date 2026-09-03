#!/usr/bin/env bash
# AI Memory Bus Watchdog Supervisor
# Usage: ./watchdog.sh <pid_file> <callback_exe> [callback_args...]
#
# POSIX bash watchdog — works on Windows (Git Bash / WSL), macOS, and Linux.
#
# Security (S-HIGH-1): 不再接收字符串 callback,而是 exe + args,
# 运行时 exec "$exe" "${args[@]}" 避免 bash -c 字符串执行。

set -euo pipefail

PID_FILE="${1:?Usage: $0 <pid_file> <callback_exe> [args...]}"
CALLBACK_EXE="${2:?Usage: $0 <pid_file> <callback_exe> [args...]}"
shift 2
CALLBACK_ARGS=("$@")
INTERVAL="${WATCHDOG_INTERVAL:-15}"
# Guard against busy-loop: WATCHDOG_INTERVAL=0 (or non-numeric) would make
# `sleep 0` spin, pinning a CPU core. Clamp to a sane floor.
case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=15 ;;
esac
[ "$INTERVAL" -lt 5 ] && INTERVAL=15
MAX_RESTARTS="${WATCHDOG_MAX_RESTARTS:-3}"
RESTART_COUNT=0

log() { echo "[watchdog] $(date -Iseconds) $*" >&2; }

is_running() {
    local pid="$1"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

while true; do
    sleep "$INTERVAL"

    if [ -f "$PID_FILE" ]; then
        PID=$(sed -n '1p' "$PID_FILE" | tr -d '[:space:]')
        if ! is_running "$PID"; then
            log "Process $PID died (restart $((RESTART_COUNT+1))/$MAX_RESTARTS)"
            RESTART_COUNT=$((RESTART_COUNT+1))
            if [ $RESTART_COUNT -gt $MAX_RESTARTS ]; then
                log "Max restarts reached, giving up"
                exit 1
            fi
            "$CALLBACK_EXE" "${CALLBACK_ARGS[@]}" &
            log "Callback invoked: $CALLBACK_EXE ${CALLBACK_ARGS[*]}"
        fi
    fi
done
