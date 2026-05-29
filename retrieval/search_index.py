"""
search_index: Index loading and cache management for structured entries and embeddings.

Split from retrieval/semantic-search.py (original ~2117 lines) — see
retrieval/REFACTOR-NOTES.md for the full refactoring plan.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import sys
import time as time_module
from typing import Dict, List

from search_ranking import (
    tokenize,
    normalize_spaces,
    is_noise,
    derive_entry_layer,
    NOISE_PATTERNS,
    STRUCTURED_FILES,
)

try:
    from ops.redact.redaction import REDACTION_CONFIG, redact_sensitive
except ModuleNotFoundError:
    from redaction import REDACTION_CONFIG, redact_sensitive

try:
    from schema_validation import validate_record
    _SCHEMA_VALIDATION_AVAILABLE = True
except ImportError:
    _SCHEMA_VALIDATION_AVAILABLE = False

# ---------------------------------------------------------------------------
# Global caches
# ---------------------------------------------------------------------------

_INDEX_CACHE: Dict[str, object] = {"data": None, "loaded_at": 0.0, "signature": ""}
_ENTRIES_CACHE: Dict[str, object] = {"data": None, "loaded_at": 0.0, "version": 0, "signature": ""}

# Shared mutable caches (imported from search_ranking to keep them in sync)
from search_ranking import _BM25_CACHE, _SEARCH_RESULT_CACHE, _QUERY_EMBEDDING_CACHE

# ---------------------------------------------------------------------------
# Path constants (mirrored from semantic_search for testability)
# ---------------------------------------------------------------------------

def _resolve_store_root() -> str:
    try:
        from runtime_support import resolve_store_root
        return str(resolve_store_root())
    except Exception:
        return (
            os.environ.get("AI_MEMORY_STORE")
            or os.environ.get("AI_MEMORY_STORE_ROOT")
            or os.environ.get("AI_MEMORY_ROOT")
            or os.path.join(os.path.expanduser("~"), ".ai-memory")
        )

STORE_ROOT = _resolve_store_root()
AI_MEMORY_ROOT = STORE_ROOT
STRUCTURED_DIR = os.path.join(STORE_ROOT, "structured")
EMBEDDINGS_INDEX = os.path.join(STORE_ROOT, "embeddings", "index.jsonl")


# ---------------------------------------------------------------------------
# Cache invalidation
# ---------------------------------------------------------------------------

def invalidate_entries_cache() -> None:
    _ENTRIES_CACHE["data"] = None
    _ENTRIES_CACHE["loaded_at"] = 0.0
    _ENTRIES_CACHE["signature"] = ""
    _ENTRIES_CACHE["version"] = int(_ENTRIES_CACHE.get("version", 0)) + 1
    _BM25_CACHE.clear()
    _SEARCH_RESULT_CACHE.clear()


def invalidate_embeddings_cache() -> None:
    _INDEX_CACHE["data"] = None
    _INDEX_CACHE["loaded_at"] = 0.0
    _INDEX_CACHE["signature"] = ""

    from search_ranking import _QUERY_EMBEDDING_CACHE
    _QUERY_EMBEDDING_CACHE.clear()
    _SEARCH_RESULT_CACHE.clear()


# ---------------------------------------------------------------------------
# Signature helpers
# ---------------------------------------------------------------------------

def build_file_stamp(file_path: str) -> str:
    if not os.path.exists(file_path):
        return "__missing__"
    try:
        with open(file_path, "rb") as handle:
            body = handle.read()
        return f"{os.path.basename(file_path)}:{hashlib.sha1(body).hexdigest()}:{len(body)}"
    except Exception:
        return f"{os.path.basename(file_path)}:__unreadable__"


def build_structured_signature() -> str:
    if not os.path.isdir(STRUCTURED_DIR):
        return "__missing__"
    parts = [build_file_stamp(os.path.join(STRUCTURED_DIR, file_name)) for file_name in STRUCTURED_FILES]
    return "|".join(parts) if parts else "__empty__"


def build_embeddings_signature() -> str:
    return build_file_stamp(EMBEDDINGS_INDEX)


# ---------------------------------------------------------------------------
# Entry building helpers (used by _load_entries_uncached)
# ---------------------------------------------------------------------------

def _extract_item_text(item) -> str:
    """Extract display text from a fact or concept item."""
    if isinstance(item, str):
        return normalize_spaces(item)
    if isinstance(item, dict) and isinstance(item.get("value"), list):
        parts = [normalize_spaces(str(v)) for v in item["value"] if v]
        return " / ".join(parts)
    return normalize_spaces(str(item) if item else "")


def _build_entry_fields(
    payload: dict, entry_id: str, record_id: str, field: str, search_text: str, layer: str
) -> dict:
    """Shared field construction for parent and sub-entries."""
    excerpt = search_text
    return {
        "id": entry_id,
        "record_id": record_id,
        "field": field,
        "search_text": search_text[:6000],
        "tokens": tokenize(search_text),
        "excerpt": excerpt[:240],
        "title": payload.get("title", "") or excerpt[:120] or entry_id,
        "description": str(payload.get("description", "")) or "",
        "layer": layer,
        "tool": str(payload.get("tool", "unknown")).strip() or "unknown",
        "type": str(payload.get("type", "")).strip(),
        "project": str(payload.get("project", "")).strip(),
        "agent": str(payload.get("agent", "")).strip(),
        "t": str(payload.get("t", "")).strip(),
        "scope": str(payload.get("scope", "")).strip(),
        "visibility": str(payload.get("visibility", "")).strip(),
        "sourceKind": str(payload.get("source_kind", "")).strip(),
        "memoryLevel": str(payload.get("memory_level", "")).strip(),
        "workspace": str(payload.get("workspace", "")).strip(),
        "taskState": str(payload.get("task_state", "")).strip(),
        "freshness": str(payload.get("freshness", "")).strip(),
        "content": str(payload.get("content", "")).strip(),
    }


def build_entry(payload: dict) -> List[dict]:
    """
    Build search entries for one structured record.

    Returns a list containing one parent entry (field='content') plus one entry
    per fact (field='fact') and one per concept (field='concept').
    """
    raw_title = normalize_spaces(str(payload.get("title", "")))
    raw_content = normalize_spaces(str(payload.get("content", "")))

    if REDACTION_CONFIG.enabled:
        payload = {**payload, "title": redact_sensitive(raw_title), "content": redact_sensitive(raw_content)}

    title = normalize_spaces(str(payload.get("title", "")))
    content = normalize_spaces(str(payload.get("content", "")))
    raw_text = normalize_spaces(" ".join(filter(None, [raw_title, raw_content])))
    if is_noise(raw_text):
        return []

    record_id = str(payload.get("id", "")).strip() or _fallback_id(payload, title, content)
    layer = derive_entry_layer(payload)

    parent_search = normalize_spaces(
        " ".join(
            filter(
                None,
                [
                    title,
                    content,
                    str(payload.get("agent", "")).strip(),
                    str(payload.get("project", "")).strip(),
                    str(payload.get("type", "")).strip(),
                    str(payload.get("tool", "")).strip(),
                ],
            )
        )
    )[:6000]

    entries: List[dict] = [
        _build_entry_fields(payload, record_id, record_id, "content", parent_search, layer)
    ]

    for i, fact in enumerate(payload.get("facts", []) or []):
        fact_text = _extract_item_text(fact)
        if fact_text and not is_noise(fact_text):
            entries.append(
                _build_entry_fields(
                    payload,
                    f"{record_id}__fact_{i}",
                    record_id,
                    "fact",
                    fact_text,
                    layer,
                )
            )

    for i, concept in enumerate(payload.get("concepts", []) or []):
        concept_text = _extract_item_text(concept)
        if concept_text and not is_noise(concept_text):
            entries.append(
                _build_entry_fields(
                    payload,
                    f"{record_id}__concept_{i}",
                    record_id,
                    "concept",
                    concept_text,
                    layer,
                )
            )

    return entries


def _fallback_id(payload: dict, title: str, content: str) -> str:
    seed = "|".join(
        [
            str(payload.get("tool", "")).strip(),
            str(payload.get("t", "")).strip(),
            title.strip(),
            content.strip(),
        ]
    )
    return hashlib.sha1(seed.encode("utf-8", errors="ignore")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Index loading
# ---------------------------------------------------------------------------

def _load_entries_uncached(structured_dir: str) -> List[dict]:
    seen_ids: set = set()
    entries: List[dict] = []

    if not os.path.isdir(structured_dir):
        return []

    for file_name in STRUCTURED_FILES:
        file_path = os.path.join(structured_dir, file_name)
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except Exception:
                        continue
                    if _SCHEMA_VALIDATION_AVAILABLE:
                        valid, errors = validate_record(payload)
                        if not valid:
                            continue
                    for entry in build_entry(payload):
                        if entry["id"] not in seen_ids:
                            seen_ids.add(entry["id"])
                            entries.append(entry)
        except Exception:
            continue

    return entries


def load_entries() -> List[dict]:
    current_signature = build_structured_signature()
    if (
        _ENTRIES_CACHE["data"] is not None
        and str(_ENTRIES_CACHE.get("signature", "")) == current_signature
    ):
        return _ENTRIES_CACHE["data"]

    invalidate_entries_cache()
    data = _load_entries_uncached(STRUCTURED_DIR)
    _ENTRIES_CACHE["data"] = data
    _ENTRIES_CACHE["loaded_at"] = time_module.time()
    _ENTRIES_CACHE["signature"] = current_signature
    return data


def load_embeddings_index() -> Dict[str, dict]:
    current_signature = build_embeddings_signature()
    if (
        _INDEX_CACHE["data"] is not None
        and str(_INDEX_CACHE.get("signature", "")) == current_signature
    ):
        return _INDEX_CACHE["data"]

    invalidate_embeddings_cache()
    data = _load_embeddings_index_uncached(EMBEDDINGS_INDEX)
    _INDEX_CACHE["data"] = data
    _INDEX_CACHE["loaded_at"] = time_module.time()
    _INDEX_CACHE["signature"] = current_signature
    return data


def _load_embeddings_index_uncached(embeddings_index: str) -> Dict[str, dict]:
    """Uncached implementation — use load_embeddings_index() instead."""
    records: Dict[str, dict] = {}
    if not os.path.isfile(embeddings_index):
        return records

    try:
        with open(embeddings_index, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except Exception:
                    continue
                record_id = str(payload.get("id", "")).strip()
                if record_id and isinstance(payload.get("embedding"), list):
                    records[record_id] = payload
    except Exception:
        return {}
    return records
