"""
search_server: STDIO JSONL server protocol for persistent search workers.

Split from retrieval/semantic-search.py (original ~2117 lines) — see
retrieval/REFACTOR-NOTES.md for the full refactoring plan.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time as _time_module
from typing import Dict, List

from search_ranking import (
    normalize_spaces,
    STRUCTURED_FILES,
)

from search_cache import (
    build_cache_state,
    clear_search_runtime_caches,
    get_cached_search_result,
    store_search_result,
)

from search_index import (
    load_entries,
    load_embeddings_index,
    build_structured_signature,
    build_embeddings_signature,
    STRUCTURED_FILES,
)

from embedding_providers import (
    DEFAULT_MODEL,
    normalize_embedding_adapter,
)

try:
    from schema_validation import validate_record
    _SCHEMA_VALIDATION_AVAILABLE = True
except ImportError:
    _SCHEMA_VALIDATION_AVAILABLE = False

# ---------------------------------------------------------------------------
# Structured observability (metrics exporter on port 9091)
# ---------------------------------------------------------------------------

try:
    from metrics_exporter import (
        start_metrics_exporter,
        record_search_latency,
        increment_cache_hits,
        increment_cache_misses,
        increment_active_requests,
    )
    _METRICS_AVAILABLE = True
except ImportError:
    _METRICS_AVAILABLE = False
    def record_search_latency(_s): pass
    def increment_cache_hits(_n=1): pass
    def increment_cache_misses(_n=1): pass
    def increment_active_requests(_d): pass
    def start_metrics_exporter():
        return None

_METRICS_SERVER = None


# ---------------------------------------------------------------------------
# Schema validation flag (needed here for timeline action)
# ---------------------------------------------------------------------------

_SCHEMA_VALIDATION_AVAILABLE_SERVER = _SCHEMA_VALIDATION_AVAILABLE


# ---------------------------------------------------------------------------
# Server protocol
# ---------------------------------------------------------------------------

def write_server_response(payload: Dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_timestamp_seconds(value: str) -> float:
    import datetime
    candidate = normalize_spaces(value)
    if not candidate:
        return 0.0
    try:
        normalized = candidate.replace("Z", "+00:00")
        return max(0.0, datetime.datetime.fromisoformat(normalized).timestamp())
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Action handlers
# ---------------------------------------------------------------------------

def handle_health(request_id: str) -> Dict[str, object]:
    # Deferred import to avoid circular dependency with semantic_search.py
    from semantic_search import build_embedding_runtime_summary
    return {
        "id": request_id,
        "ok": True,
        "action": "health",
        "workerMode": "persistent-jsonl",
        "embeddingRuntime": build_embedding_runtime_summary(),
        "cacheState": build_cache_state(search_result_cache_hit=False, query_embedding_cache_hit=False),
        "schemaValidation": {
            "available": _SCHEMA_VALIDATION_AVAILABLE,
            "schemaVersion": 2,
        },
    }


def handle_clear_cache(request_id: str, include_data_caches: bool) -> Dict[str, object]:
    return {
        "id": request_id,
        "ok": True,
        "action": "clear_cache",
        "includeDataCaches": include_data_caches,
        "cacheState": clear_search_runtime_caches(include_data_caches),
    }


def handle_get_records(request_id: str, record_ids: List[str]) -> Dict[str, object]:
    # Deferred import to avoid circular dependency with semantic_search.py
    from semantic_search import normalize_request_payload  # noqa: F401

    entries = load_entries()
    entries_by_id = {entry["id"]: entry for entry in entries}
    records = []
    found = []

    for record_id in record_ids:
        raw = entries_by_id.get(record_id)
        if raw is None:
            continue
        found.append(record_id)
        content = str(raw.get("content", "") or raw.get("text", ""))
        records.append(
            {
                "id": raw["id"],
                "t": raw.get("t", ""),
                "tool": raw.get("tool", ""),
                "type": raw.get("type", ""),
                "title": raw.get("title", ""),
                "content": content,
                "description": str(raw.get("description", "")).strip(),
                "facts": raw.get("facts") if isinstance(raw.get("facts"), list) else [],
                "concepts": raw.get("concepts") if isinstance(raw.get("concepts"), list) else [],
                "files_read": raw.get("filesRead") or raw.get("files_read") or [],
                "files_modified": raw.get("filesModified") or raw.get("files_modified") or [],
                "scope": raw.get("scope", ""),
                "memory_level": raw.get("memoryLevel", ""),
                "freshness": raw.get("freshness", ""),
                "confidence": raw.get("confidence"),
                "project": raw.get("project", ""),
                "agent": raw.get("agent", ""),
                "workspace": raw.get("workspace", ""),
                "task_state": raw.get("taskState", ""),
                "visibility": raw.get("visibility", ""),
                "source_kind": raw.get("sourceKind", ""),
                "layer": raw.get("layer", ""),
                "estimated_tokens": math.ceil(len(content) / 4),
            }
        )

    return {
        "id": request_id,
        "ok": True,
        "action": "get_records",
        "requested": len(record_ids),
        "found": found,
        "records": records,
    }


def handle_timeline(request_id: str, anchor_id: str, depth_before: int, depth_after: int) -> Dict[str, object]:
    # Deferred import to avoid circular dependency with semantic_search.py
    from semantic_search import normalize_request_payload  # noqa: F401
    import datetime

    entries = load_entries()

    # Build raw lookup from structured files
    from search_ranking import normalize_spaces as _ns
    from runtime_support import normalize_int

    structured_dir = os.path.join(
        os.environ.get("VAULT_ROOT", ""),
        "00-System",
        "ai-memory",
        "structured",
    )
    raw_lookup: Dict[str, dict] = {}
    if os.path.isdir(structured_dir):
        for file_name in STRUCTURED_FILES:
            file_path = os.path.join(structured_dir, file_name)
            if not os.path.isfile(file_path):
                continue
            try:
                with open(file_path, "r", encoding="utf-8") as handle:
                    for line_text in handle:
                        line_text = line_text.strip()
                        if not line_text:
                            continue
                        try:
                            raw_entry = json.loads(line_text)
                        except Exception:
                            continue
                        if _SCHEMA_VALIDATION_AVAILABLE:
                            valid, _ = validate_record(raw_entry)
                            if not valid:
                                continue
                        eid = _ns(str(raw_entry.get("id", "")))
                        if eid and eid not in raw_lookup:
                            raw_lookup[eid] = raw_entry
            except Exception:
                continue

    def entry_timestamp(entry: dict) -> float:
        return parse_timestamp_seconds(str(entry.get("t", "")))

    entries_sorted = sorted(entries, key=entry_timestamp)
    anchor_index = next((i for i, e in enumerate(entries_sorted) if e["id"] == anchor_id), None)
    if anchor_index is None:
        raise ValueError(f"anchor_id not found: {anchor_id}")

    start = max(0, anchor_index - depth_before)
    end = min(len(entries_sorted), anchor_index + depth_after + 1)
    window = entries_sorted[start:end]

    raw_map: Dict[str, dict] = {e["id"]: raw_lookup.get(e["id"], {}) for e in window}
    items = []
    for e in window:
        content = str(e.get("content", "") or e.get("text", ""))
        items.append(
            {
                "id": e["id"],
                "t": e.get("t", ""),
                "tool": e.get("tool", ""),
                "type": e.get("type", ""),
                "title": e.get("title", ""),
                "scope": e.get("scope", ""),
                "memory_level": e.get("memoryLevel", ""),
                "is_anchor": e["id"] == anchor_id,
                "excerpt": content[:240],
            }
        )

    anchor_entry = entries_sorted[anchor_index]
    return {
        "id": request_id,
        "ok": True,
        "action": "timeline",
        "anchor": {
            "id": anchor_entry["id"],
            "t": anchor_entry.get("t", ""),
            "tool": anchor_entry.get("tool", ""),
            "type": anchor_entry.get("type", ""),
            "title": anchor_entry.get("title", ""),
            "scope": anchor_entry.get("scope", ""),
            "memory_level": anchor_entry.get("memoryLevel", ""),
            "excerpt": str(anchor_entry.get("content", "") or anchor_entry.get("text", ""))[:240],
        },
        "items": items,
        "total_count": len(window),
    }


def handle_search(request_id: str, payload: Dict[str, object], workspace_root: str = "") -> Dict[str, object]:
    # Deferred import to avoid circular dependency with semantic_search.py
    from semantic_search import normalize_request_payload, execute_search

    started_at = _time_module.monotonic()
    if _METRICS_AVAILABLE:
        increment_active_requests(1)

    try:
        response = execute_search(normalize_request_payload(payload), workspace_root=workspace_root)

        # Record cache hit / miss based on the response metadata
        cache_hit = response.get("cacheHit") or response.get("cache_hit")
        if cache_hit:
            increment_cache_hits(1)
        else:
            increment_cache_misses(1)

        if request_id:
            response["id"] = request_id
        return response
    finally:
        elapsed = _time_module.monotonic() - started_at
        if _METRICS_AVAILABLE:
            record_search_latency(elapsed)
            increment_active_requests(-1)


# ---------------------------------------------------------------------------
# Server loop
# ---------------------------------------------------------------------------

def run_server() -> None:
    global _METRICS_SERVER
    from runtime_support import normalize_bool, normalize_int

    # Start the Prometheus metrics exporter (port 9091) — non-blocking, daemon thread.
    _METRICS_SERVER = start_metrics_exporter()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = ""
        try:
            payload = json.loads(line)
            request_id = normalize_spaces(str(payload.get("id", "")))
            action = normalize_spaces(str(payload.get("action", "search"))).lower() or "search"

            if action == "health":
                write_server_response(handle_health(request_id))
                continue

            if action == "clear_cache":
                include_data_caches = normalize_bool(
                    payload.get("include_data_caches", payload.get("includeDataCaches", False)), fallback=False
                )
                write_server_response(handle_clear_cache(request_id, include_data_caches))
                continue

            if action == "get_records":
                record_ids = payload.get("ids", [])
                if not isinstance(record_ids, list):
                    raise ValueError("ids must be an array")
                record_ids = [normalize_spaces(str(rid)) for rid in record_ids if normalize_spaces(str(rid))]
                if not record_ids:
                    raise ValueError("ids cannot be empty")
                write_server_response(handle_get_records(request_id, record_ids))
                continue

            if action == "timeline":
                anchor_id = normalize_spaces(str(payload.get("anchor_id", "")))
                if not anchor_id:
                    raise ValueError("anchor_id is required")
                depth_before = normalize_int(payload.get("depth_before"), fallback=3, minimum=0)
                depth_after = normalize_int(payload.get("depth_after"), fallback=3, minimum=0)
                write_server_response(handle_timeline(request_id, anchor_id, depth_before, depth_after))
                continue

            if action != "search":
                raise ValueError(f"unsupported-action:{action}")

            workspace_root = normalize_spaces(str(payload.get("workspace_root", ""))) or None
            write_server_response(handle_search(request_id, payload, workspace_root=workspace_root))

        except Exception as exc:
            error_payload: Dict[str, object] = {
                "ok": False,
                "error": str(exc),
            }
            if request_id:
                error_payload["id"] = request_id
            write_server_response(error_payload)
