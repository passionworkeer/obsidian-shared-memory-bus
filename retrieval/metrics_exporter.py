"""Lightweight Prometheus metrics exporter for the search worker."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Dict
from urllib.parse import urlsplit

_METRICS_LOCK = threading.Lock()

_SEARCH_LATENCY_BUCKETS = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 10.0
]
_LATENCY_HISTOGRAM: Dict[str, float] = {f"<={b}": 0.0 for b in _SEARCH_LATENCY_BUCKETS}
_LATENCY_HISTOGRAM["+Inf"] = 0.0
_CACHE_HITS = 0.0
_CACHE_MISSES = 0.0
_WORKER_RESTARTS = 0.0
_ACTIVE_REQUESTS = 0
_START_TIME = time.monotonic()


def record_search_latency(seconds: float) -> None:
    if not isinstance(seconds, (int, float)) or seconds < 0:
        return
    with _METRICS_LOCK:
        for bound in _SEARCH_LATENCY_BUCKETS:
            if seconds <= bound:
                _LATENCY_HISTOGRAM[f"<={bound}"] += 1
                break
        _LATENCY_HISTOGRAM["+Inf"] += 1


def increment_cache_hits(count: int = 1) -> None:
    if count > 0:
        with _METRICS_LOCK:
            global _CACHE_HITS
            _CACHE_HITS += count


def increment_cache_misses(count: int = 1) -> None:
    if count > 0:
        with _METRICS_LOCK:
            global _CACHE_MISSES
            _CACHE_MISSES += count


def increment_worker_restarts(count: int = 1) -> None:
    if count > 0:
        with _METRICS_LOCK:
            global _WORKER_RESTARTS
            _WORKER_RESTARTS += count


def increment_active_requests(delta: int) -> None:
    with _METRICS_LOCK:
        global _ACTIVE_REQUESTS
        _ACTIVE_REQUESTS = max(0, _ACTIVE_REQUESTS + delta)


def reset_counters() -> None:
    global _CACHE_HITS, _CACHE_MISSES, _WORKER_RESTARTS
    with _METRICS_LOCK:
        _CACHE_HITS = 0.0
        _CACHE_MISSES = 0.0
        _WORKER_RESTARTS = 0.0
        for key in _LATENCY_HISTOGRAM:
            _LATENCY_HISTOGRAM[key] = 0.0


def _escape_label(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _format_histogram(name: str, help_text: str, documentation: Dict[str, float]) -> str:
    lines = [f"# HELP {name} {help_text}", f"# TYPE {name} histogram"]
    buckets_out = []
    cumulative = 0.0
    sorted_keys = sorted(
        [k for k in documentation if k != "+Inf"],
        key=lambda b: float(b.replace("<= ", "").replace("<=", "")),
    )
    for key in sorted_keys:
        cumulative += documentation[key]
        buckets_out.append(f'{name}_bucket{{le="{_escape_label(key)}"}} {cumulative}')
    buckets_out.append(f'{name}_bucket{{le="+Inf"}} {documentation.get("+Inf", 0.0)}')
    buckets_out.append(f"{name}_sum 0.0")
    buckets_out.append(f"{name}_count {documentation.get('+Inf', 0.0)}")
    return "\n".join(lines + buckets_out)


def _format_counter(name: str, help_text: str, value: float) -> str:
    return "\n".join([
        f"# HELP {name} {help_text}",
        f"# TYPE {name} counter",
        f"{name} {value}",
    ])


def _format_gauge(name: str, help_text: str, value: int) -> str:
    return "\n".join([
        f"# HELP {name} {help_text}",
        f"# TYPE {name} gauge",
        f"{name} {value}",
    ])


def _is_allowed_host_header(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw or any(char in raw for char in "\r\n"):
        return False
    try:
        parsed = urlsplit(f"//{raw}")
        host = (parsed.hostname or "").lower()
        _ = parsed.port
    except ValueError:
        return False
    return (
        host in {"127.0.0.1", "localhost", "::1"}
        and parsed.username is None
        and parsed.password is None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
    )


_PORT = int(os.environ.get("AI_MEMORY_PY_METRICS_PORT", "9091"))


class _MetricsHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _request_host_allowed(self) -> bool:
        if _is_allowed_host_header(self.headers.get("Host")):
            return True
        self._send_json(403, {"error": "forbidden non-loopback host"})
        return False

    def do_GET(self) -> None:
        if not self._request_host_allowed():
            return
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
        if not self._request_host_allowed():
            return
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
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write(f"[metrics-exporter] {format % args}\n")


def start_metrics_exporter() -> HTTPServer:
    server = HTTPServer(("127.0.0.1", _PORT), _MetricsHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="metrics-exporter")
    thread.start()
    sys.stderr.write(f"[metrics-exporter] listening on 127.0.0.1:{_PORT}\n")
    return server


if __name__ == "__main__":
    sys.stderr.write(f"[metrics-exporter] starting standalone on 127.0.0.1:{_PORT}\n")
    server = start_metrics_exporter()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
