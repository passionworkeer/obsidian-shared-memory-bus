"""
metrics_exporter: lightweight Prometheus metrics exporter for the search worker.

Runs on port 9091 (separate from the Node.js metrics server on 9090 so the
Python and Node.js metric namespaces stay isolated).

Exposes:
  /metrics   — Prometheus text format
  /health    — JSON {status: "ok", uptime: seconds}

Metrics:
  search_latency_seconds    histogram
  cache_hits_total          counter
  cache_misses_total         counter
  worker_restarts_total      counter
  active_requests_gauge      gauge

The exporter is intentionally non-blocking — metric updates are collected in
thread-safe counters and only serialized on demand at /metrics time.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Dict

# ---------------------------------------------------------------------------
# Metric containers (process-wide, updated by search_server.py via globals)
# ---------------------------------------------------------------------------

# Thread-safe counters via threading.Lock
_METRICS_LOCK = threading.Lock()

_SEARCH_LATENCY_BUCKETS = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 10.0
]

# {bucket_label: count}
_LATENCY_HISTOGRAM: Dict[str, float] = {f"<={b}": 0.0 for b in _SEARCH_LATENCY_BUCKETS}
_LATENCY_HISTOGRAM["+Inf"] = 0.0

# Counters
_CACHE_HITS   = 0.0
_CACHE_MISSES  = 0.0
_WORKER_RESTARTS = 0.0

# Gauges
_ACTIVE_REQUESTS = 0

# Start time for uptime calculation
_START_TIME = time.monotonic()


# ---------------------------------------------------------------------------
# Public metric update functions (called from search_server.py)
# ---------------------------------------------------------------------------

def record_search_latency(seconds: float) -> None:
    """Record a search latency observation in seconds."""
    if not isinstance(seconds, (int, float)) or seconds < 0:
        return
    with _METRICS_LOCK:
        for bound in _SEARCH_LATENCY_BUCKETS:
            if seconds <= bound:
                label = f"<={bound}"
                _LATENCY_HISTOGRAM[label] += 1
                break
        _LATENCY_HISTOGRAM["+Inf"] += 1


def increment_cache_hits(count: int = 1) -> None:
    """Increment cache hits counter."""
    if count > 0:
        with _METRICS_LOCK:
            global _CACHE_HITS
            _CACHE_HITS += count


def increment_cache_misses(count: int = 1) -> None:
    """Increment cache misses counter."""
    if count > 0:
        with _METRICS_LOCK:
            global _CACHE_MISSES
            _CACHE_MISSES += count


def increment_worker_restarts(count: int = 1) -> None:
    """Increment worker restarts counter."""
    if count > 0:
        with _METRICS_LOCK:
            global _WORKER_RESTARTS
            _WORKER_RESTARTS += count


def increment_active_requests(delta: int) -> None:
    """Increment (delta > 0) or decrement (delta < 0) active requests gauge."""
    with _METRICS_LOCK:
        global _ACTIVE_REQUESTS
        _ACTIVE_REQUESTS = max(0, _ACTIVE_REQUESTS + delta)


def reset_counters() -> None:
    """Reset all counters to zero (useful for testing)."""
    global _CACHE_HITS, _CACHE_MISSES, _WORKER_RESTARTS
    with _METRICS_LOCK:
        _CACHE_HITS = 0.0
        _CACHE_MISSES = 0.0
        _WORKER_RESTARTS = 0.0
        for key in _LATENCY_HISTOGRAM:
            _LATENCY_HISTOGRAM[key] = 0.0


# ---------------------------------------------------------------------------
# Prometheus text format helpers
# ---------------------------------------------------------------------------

def _escape_label(s: str) -> str:
    """Escape double-quotes and backslashes in Prometheus label values."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _format_histogram(name: str, help_text: str, documentation: Dict[str, float]) -> str:
    """Format a Prometheus histogram in text format."""
    lines = [f"# HELP {name} {help_text}", f"# TYPE {name} histogram"]
    buckets_out = []
    cumulative = 0.0
    sorted_keys = sorted(
        [k for k in documentation if k != "+Inf"],
        key=lambda b: float(b.replace("<= ", "").replace("<=", ""))
    )
    for key in sorted_keys:
        cumulative += documentation[key]
        buckets_out.append(f'{name}_bucket{{le="{_escape_label(key)}"}} {cumulative}')
    buckets_out.append(f'{name}_bucket{{le="+Inf"}} {documentation.get("+Inf", 0.0)}')
    buckets_out.append(f"{name}_sum 0.0")  # search_server.py records in seconds
    buckets_out.append(f"{name}_count {documentation.get('+Inf', 0.0)}")
    return "\n".join(lines + buckets_out)


def _format_counter(name: str, help_text: str, value: float) -> str:
    """Format a Prometheus counter in text format."""
    return "\n".join([
        f"# HELP {name} {help_text}",
        f"# TYPE {name} counter",
        f"{name} {value}",
    ])


def _format_gauge(name: str, help_text: str, value: int) -> str:
    """Format a Prometheus gauge in text format."""
    return "\n".join([
        f"# HELP {name} {help_text}",
        f"# TYPE {name} gauge",
        f"{name} {value}",
    ])


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

_PORT = int(os.environ.get("AI_MEMORY_PY_METRICS_PORT", "9091"))


class _MetricsHandler(BaseHTTPRequestHandler):
    """Handles /metrics and /health endpoints."""

    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/metrics":
            self._serve_metrics()
        elif self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "uptime": round(time.monotonic() - _START_TIME, 3),
                "pid": os.getpid(),
                "active_requests": _ACTIVE_REQUESTS,
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_HEAD(self) -> None:
        """Support HEAD requests for /metrics and /health."""
        if self.path in ("/metrics", "/health"):
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def _serve_metrics(self) -> None:
        with _METRICS_LOCK:
            lines = [
                _format_counter(
                    "memory_search_cache_hits_total",
                    "Total number of search cache hits in the Python search worker",
                    _CACHE_HITS,
                ),
                "",
                _format_counter(
                    "memory_search_cache_misses_total",
                    "Total number of search cache misses in the Python search worker",
                    _CACHE_MISSES,
                ),
                "",
                _format_counter(
                    "memory_search_worker_restarts_total",
                    "Total number of search worker restart events",
                    _WORKER_RESTARTS,
                ),
                "",
                _format_gauge(
                    "memory_search_active_requests",
                    "Number of search requests currently being processed",
                    _ACTIVE_REQUESTS,
                ),
                "",
                _format_histogram(
                    "memory_search_latency_seconds",
                    "Search request latency in seconds (histogram)",
                    dict(_LATENCY_HISTOGRAM),
                ),
                "",
            ]

        body = "\n".join(lines).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        """Suppress default HTTP logging — all output goes to stderr."""
        sys.stderr.write(f"[metrics-exporter] {format % args}\n")


def start_metrics_exporter() -> HTTPServer:
    """Start the Prometheus exporter HTTP server and return it."""
    server = HTTPServer(("127.0.0.1", _PORT), _MetricsHandler)
    server.daemon_threads = True  # Don't block process exit
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="metrics-exporter")
    thread.start()
    sys.stderr.write(f"[metrics-exporter] listening on 127.0.0.1:{_PORT}\n")
    return server


if __name__ == "__main__":
    # Allow running the exporter standalone for testing
    sys.stderr.write(f"[metrics-exporter] starting standalone on 127.0.0.1:{_PORT}\n")
    server = start_metrics_exporter()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
