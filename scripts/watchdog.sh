#!/usr/bin/env bash
# AI Memory Bus Watchdog Supervisor
# Usage: ./watchdog.sh <pid_file> <callback_script_or_command>
#
# POSIX bash watchdog — works on Windows (Git Bash / WSL), macOS, and Linux.

set -euo pipefail

PID_FILE="${1:?Usage: $0 <pid_file> <callback>}"
CALLBACK="${2:?Usage: $0 <pid_file> <callback>}"
INTERVAL="${WATCHDOG_INTERVAL:-15}"
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
            bash -c "$CALLBACK" &
            log "Callback invoked"
        fi
    fi
done
