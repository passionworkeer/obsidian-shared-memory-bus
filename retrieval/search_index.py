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


# ---------------------------------------------------------------------------
# ANN-accelerated dense scoring (optional, opt-in via --use-ann)
#
# See retrieval/ann_index.py for the index implementation and
# tech-debt-roadmap.md 5.3 for the phased rollout plan. The ANN path is only
# used when hnswlib is importable (ANNIndex.is_available()); otherwise callers
# transparently fall back to the existing full-scan cosine scorer in
# search_ranking.dense_scores.
# ---------------------------------------------------------------------------

from typing import Optional, Tuple  # noqa: E402 - appended module section

_ANN_INDEX_CACHE: Dict[str, object] = {
    "index": None,        # ANNIndex instance
    "ids": None,          # List[str] entry_id per row, aligned with the index
    "signature": "",      # embeddings signature used to build this index
}


def build_ann_index(embeddings_index_path: Optional[str] = None):
    """Build (and cache) an ANNIndex from the current embeddings index.

    Returns ``(ann_index, entry_ids)`` or ``(None, None)`` when the index is
    empty or cannot be built. Cached by the embeddings signature so repeated
    queries reuse the same ANN index.
    """
    from ann_index import ANNIndex
    import numpy as np

    signature = build_embeddings_signature()
    if (
        _ANN_INDEX_CACHE["index"] is not None
        and str(_ANN_INDEX_CACHE.get("signature", "")) == signature
    ):
        return _ANN_INDEX_CACHE["index"], _ANN_INDEX_CACHE["ids"]

    records = load_embeddings_index()
    if not records:
        _ANN_INDEX_CACHE["index"] = None
        _ANN_INDEX_CACHE["ids"] = None
        _ANN_INDEX_CACHE["signature"] = signature
        return None, None

    dim = 0
    entry_ids: List[str] = []
    vectors = []
    for record_id, payload in records.items():
        embedding = payload.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            continue
        if dim == 0:
            dim = len(embedding)
        elif len(embedding) != dim:
            continue
        entry_id = str(payload.get("id", record_id)).strip()
        if not entry_id:
            continue
        entry_ids.append(entry_id)
        vectors.append(embedding)

    if not vectors or dim == 0:
        _ANN_INDEX_CACHE["index"] = None
        _ANN_INDEX_CACHE["ids"] = None
        _ANN_INDEX_CACHE["signature"] = signature
        return None, None

    matrix = np.asarray(vectors, dtype=np.float32)
    # Use positional integer labels; entry_ids[i] maps to label i.
    ann = ANNIndex(dim=dim, max_elements=max(len(entry_ids) * 2, 1000))
    ann.add(matrix, list(range(len(entry_ids))))

    _ANN_INDEX_CACHE["index"] = ann
    _ANN_INDEX_CACHE["ids"] = entry_ids
    _ANN_INDEX_CACHE["signature"] = signature
    return ann, entry_ids

def ann_dense_scores(
    query: str,
    EMBEDDING_RUNTIME: Dict[str, object],
    embeddings_index_path: Optional[str] = None,
    top_k: int = 100,
) -> Tuple[Optional[Dict[str, float]], Optional[str], Dict[str, object]]:
    """ANN-accelerated dense scoring.

    Returns ``(scores, error, meta)`` in the same shape as
    ``search_ranking.dense_scores``. ``scores`` maps entry_id -> normalised
    cosine score in [0, 1].

    Returns ``(None, reason, meta)`` when the ANN path is unavailable (hnswlib
    not installed) or the embeddings index is empty/unusable; the caller should
    then fall back to the brute-force dense_scores.
    """
    from ann_index import ANNIndex
    from search_ranking import (
        embed_query,
        normalize_embedding_adapter,
        DEFAULT_MODEL,
        HASH_MODEL,
        VECTOR_SCHEMA_VERSION,
        build_embedding_config_hash,
    )
    import numpy as np

    meta: Dict[str, object] = {"queryEmbeddingCacheHit": False, "ann": True}
    if not ANNIndex.is_available():
        return None, "ann-unavailable:hnswlib-not-installed", meta

    ann, entry_ids = build_ann_index(embeddings_index_path)
    if ann is None or not entry_ids:
        return None, "ann-unavailable:empty-embeddings-index", meta

    # Resolve the query embedding using the stored index metadata, mirroring the
    # schema/config validation in search_ranking.dense_scores.
    records = load_embeddings_index()
    first_record = next(iter(records.values()))
    first_schema_version = int(first_record.get("featureSchemaVersion", 0) or 0)
    if first_schema_version != VECTOR_SCHEMA_VERSION:
        return None, (
            f"embedding-schema-version-mismatch:stored={first_schema_version},"
            f"expected={VECTOR_SCHEMA_VERSION};rebuild-memory-embeddings-required"
        ), meta

    model_name = str(first_record.get("model", DEFAULT_MODEL)).strip() or DEFAULT_MODEL
    backend = normalize_embedding_adapter(str(first_record.get("backend", "")).strip(), model_name) or "hash"
    if model_name.startswith("hashing-"):
        model_name = HASH_MODEL
    record_config_hash = str(first_record.get("configHash", "")).strip()
    query_runtime = dict(EMBEDDING_RUNTIME)
    if record_config_hash:
        active_adapter = normalize_embedding_adapter(
            EMBEDDING_RUNTIME.get("adapter") or EMBEDDING_RUNTIME.get("backend"),
            str(EMBEDDING_RUNTIME.get("model", DEFAULT_MODEL) or DEFAULT_MODEL),
        ) or "hash"
        active_model_name = (
            HASH_MODEL
            if active_adapter == "hash"
            else str(EMBEDDING_RUNTIME.get("model", DEFAULT_MODEL) or DEFAULT_MODEL).strip() or DEFAULT_MODEL
        )
        active_config_hash = build_embedding_config_hash(
            active_adapter,
            active_model_name,
            str(EMBEDDING_RUNTIME.get("baseUrl", "")),
        )
        if record_config_hash != active_config_hash:
            return None, "embedding-config-mismatch:rebuild-memory-embeddings-required", meta
        query_runtime["adapter"] = active_adapter
        query_runtime["backend"] = active_adapter
        query_runtime["model"] = active_model_name
    else:
        query_runtime["adapter"] = backend
        query_runtime["backend"] = backend
        query_runtime["model"] = model_name

    query_vector, error, query_embedding_cache_hit = embed_query(query, query_runtime, model_name)
    meta["queryEmbeddingCacheHit"] = bool(query_embedding_cache_hit)
    if error is not None or query_vector is None:
        return None, error, meta
    if len(query_vector) != ann.dim:
        return None, f"embedding-dimension-mismatch:index={ann.dim},query={len(query_vector)}", meta

    # Over-fetch candidates so the per-entry best-score reduction has enough
    # headroom (one entry may have multiple field embeddings in the index).
    candidate_k = min(max(top_k * 4, 50), len(entry_ids))
    results = ann.search(np.asarray(query_vector, dtype=np.float32), k=candidate_k)

    # Reduce to best cosine score per entry_id (distance = 1 - cosine).
    best_by_entry: Dict[str, float] = {}
    for label, distance in results:
        if label < 0 or label >= len(entry_ids):
            continue
        entry_id = entry_ids[label]
        cosine = 1.0 - float(distance)
        if cosine <= 0:
            continue
        existing = best_by_entry.get(entry_id)
        if existing is None or cosine > existing:
            best_by_entry[entry_id] = cosine

    if not best_by_entry:
        return {}, None, meta

    max_score = max(best_by_entry.values())
    scores: Dict[str, float] = {
        eid: (float(s) / max_score if max_score > 0 else 0.0)
        for eid, s in best_by_entry.items()
    }
    return scores, None, meta