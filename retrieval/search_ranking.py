"""
search_ranking: BM25/dense scoring, query embedding, and ranking logic.

Split from retrieval/semantic-search.py (original ~2117 lines) — see
retrieval/REFACTOR-NOTES.md for the full refactoring plan.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sys
import time as time_module
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Literal, Optional, Tuple

try:
    import numpy as _np
    _HAS_NUMPY = True
except ImportError:
    _np = None
    _HAS_NUMPY = False

logger = logging.getLogger(__name__)

from embedding_providers import (
    DEFAULT_MODEL,
    HASH_MODEL,
    VECTOR_SCHEMA_VERSION,
    build_embedding_config_hash,
    embed_query_with_runtime,
    normalize_embedding_adapter,
)

try:
    from rank_bm25 import BM25Okapi  # type: ignore
except Exception:
    BM25Okapi = None

# jieba 延迟加载（轻量化优化：避免冷启动开销）
jieba = None

def _ensure_jieba():
    """懒加载 jieba 分词器，首次使用时才初始化"""
    global jieba
    if jieba is not None:
        return jieba
    try:
        import jieba as _jieba_module
        _jieba_module.setLogLevel(20)
        jieba = _jieba_module
        return jieba
    except Exception:
        return None

try:
    from streaming_index import StreamingIndex

    _STREAMING_INDEX_AVAILABLE = True
except ImportError:
    _STREAMING_INDEX_AVAILABLE = False
    StreamingIndex = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Global caches
# ---------------------------------------------------------------------------

_BM25_CACHE: Dict[str, dict] = {}
_QUERY_EMBEDDING_CACHE: Dict[str, dict] = {}
_SEARCH_RESULT_CACHE: Dict[str, dict] = {}
_CACHE_METRICS = {
    "queryEmbeddingHits": 0,
    "queryEmbeddingMisses": 0,
    "searchResultHits": 0,
    "searchResultMisses": 0,
}

# ---------------------------------------------------------------------------
# Cache TTL / limit settings
# ---------------------------------------------------------------------------

_CACHE_TTL = 600.0  # overridden by env in semantic_search
_QUERY_EMBEDDING_CACHE_TTL = 600.0
_SEARCH_RESULT_CACHE_TTL = 300.0
_QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 128
_SEARCH_RESULT_CACHE_MAX_ENTRIES = 128
_BM25_CACHE_MAX_ENTRIES = 32


# ---------------------------------------------------------------------------
# Text utilities — also imported by search_index and search_cache
# ---------------------------------------------------------------------------

NOISE_PATTERNS = [
    re.compile(r"^Sender\s*\(", re.I),
    re.compile(r"^System:", re.I),
    re.compile(r"^Subagent Context", re.I),
    re.compile(r"^\[Subagent Context\]", re.I),
    re.compile(r"^Exec completed", re.I),
    re.compile(r"^Exec failed", re.I),
    re.compile(r"^A new session was started", re.I),
    re.compile(r"^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s", re.I),
    re.compile(r"^Run your Session Startup", re.I),
]
# Canonical structured-file list lives in shared/structured-files.json (single
# source shared with ops/memory/memory-archival.js). Loaded at import with a
# literal fallback so retrieval/ still works standalone if the JSON is absent.
_STRUCTURED_FILES_FALLBACK = [
    "shared-inbox.jsonl",
    "session-memory.jsonl",
    "shared-events.jsonl",
    "task-memory.jsonl",
    "claude-code.jsonl",
    "openclaw.jsonl",
    "openclaw-blackboard.jsonl",
    "openclaw-runs.jsonl",
    "openclaw-jobs.jsonl",
    "openclaw-journal.jsonl",
]


def _load_structured_files() -> List[str]:
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
        _path = os.path.join(_here, "..", "shared", "structured-files.json")
        with open(_path, "r", encoding="utf-8") as _fh:
            _data = json.load(_fh)
        files = _data.get("files") if isinstance(_data, dict) else None
        if isinstance(files, list) and files:
            return [str(f) for f in files]
    except Exception as exc:  # noqa: BLE001 — degrade to fallback, never crash import
        logger.warning("structured-files.json load failed, using fallback: %s", exc)
    return list(_STRUCTURED_FILES_FALLBACK)


STRUCTURED_FILES = _load_structured_files()
DURABLE_SCOPES = {"user", "feedback", "project", "reference"}
ROUTE_VALUES = {"auto", "mixed", "durable", "task", "recent", "reference"}
KNOWN_LAYERS = ("durable", "session", "event", "task")
RECENT_QUERY_PATTERN = re.compile(r"(最新|最近|刚刚|今天|\b(?:recent|latest|today|current|newest|new)\b)", re.I)
TASK_QUERY_PATTERN = re.compile(
    r"(任务|运行|工单|队列|\b(?:issue|pr|run|job|cron|queue|blackboard|pending|failed|status)\b)",
    re.I,
)
REFERENCE_QUERY_PATTERN = re.compile(r"(路径|链接|文档|参考|\b(?:path|url|link|reference|doc|docs|file)\b)", re.I)
DURABLE_QUERY_PATTERN = re.compile(
    r"(偏好|规则|长期|记忆|全局|\b(?:preference|rule|workflow|durable|global|remember)\b)",
    re.I,
)


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def is_noise(text: str) -> bool:
    normalized = normalize_spaces(text)
    if not normalized or len(normalized) < 5:
        return True
    return any(pattern.match(normalized) for pattern in NOISE_PATTERNS)


def tokenize(text: str) -> List[str]:
    source = (text or "").lower()
    tokens: List[str] = []
    seen = set()

    def add(token: str) -> None:
        normalized = token.strip()
        if not normalized:
            return
        if re.fullmatch(r"[\u4e00-\u9fff]", normalized):
            return
        if re.fullmatch(r"[a-z]", normalized):
            return
        if normalized not in seen:
            seen.add(normalized)
            tokens.append(normalized)

    # 懒加载 jieba（轻量化优化）
    _jieba = _ensure_jieba()
    if _jieba is not None:
        try:
            for piece in _jieba.cut(source):
                add(piece)
        except Exception:
            logger.warning("jieba.cut failed for tokenize; falling back to regex", exc_info=True)

    for piece in re.findall(r"[a-z0-9][a-z0-9_\-./:]{1,}", source):
        add(piece)
    for piece in re.findall(r"[\u4e00-\u9fff]{2,}", source):
        add(piece)
    return tokens


def derive_entry_layer(payload: dict) -> str:
    memory_level = normalize_spaces(str(payload.get("memory_level", payload.get("memoryLevel", "")))).lower()
    source_kind = normalize_spaces(str(payload.get("source_kind", payload.get("sourceKind", "")))).lower()
    scope = normalize_spaces(str(payload.get("scope", ""))).lower()

    if memory_level == "durable" or source_kind == "writeback":
        return "durable"
    if source_kind in {"hook", "event"} or memory_level == "event":
        return "event"
    if memory_level == "task" or source_kind in {"blackboard", "run", "cron", "task"} or scope in {"task", "run"}:
        return "task"
    return "session"


# ---------------------------------------------------------------------------
# prune_timed_cache — shared utility used by all cache modules
# ---------------------------------------------------------------------------

def prune_timed_cache(cache: Dict[str, dict], ttl_seconds: float, max_entries: int) -> None:
    now = time_module.time()
    stale_keys = [key for key, payload in cache.items() if (now - float(payload.get("created_at", 0.0))) >= ttl_seconds]
    for key in stale_keys:
        cache.pop(key, None)

    if len(cache) <= max_entries:
        return

    ordered_keys = sorted(cache.keys(), key=lambda key: float(cache[key].get("created_at", 0.0)))
    for key in ordered_keys[: max(0, len(cache) - max_entries)]:
        cache.pop(key, None)


# ---------------------------------------------------------------------------
# BM25 scoring
# ---------------------------------------------------------------------------

def get_bm25_model(entries: List[dict], cache_key: str = "") -> Optional[object]:
    if not entries:
        return None

    prune_timed_cache(_BM25_CACHE, _CACHE_TTL, _BM25_CACHE_MAX_ENTRIES)
    now = time_module.time()
    if cache_key:
        cached = _BM25_CACHE.get(cache_key)
        if cached is not None and (now - cached["created_at"]) < _CACHE_TTL and cached["size"] == len(entries):
            return cached["model"]

    corpus = [entry["tokens"] if entry["tokens"] else ["_empty_"] for entry in entries]
    model = BM25Okapi(corpus) if BM25Okapi else None

    if cache_key and model is not None:
        if len(_BM25_CACHE) >= _BM25_CACHE_MAX_ENTRIES:
            oldest_key = min(_BM25_CACHE, key=lambda key: _BM25_CACHE[key]["created_at"])
            _BM25_CACHE.pop(oldest_key, None)
        _BM25_CACHE[cache_key] = {
            "model": model,
            "created_at": now,
            "size": len(entries),
        }

    return model


def bm25_scores(entries: List[dict], query_tokens: List[str], cache_key: str = "") -> Dict[str, float]:
    if not entries or not query_tokens:
        return {}
    if BM25Okapi is None:
        return keyword_overlap_scores(entries, query_tokens)
    model = get_bm25_model(entries, cache_key)
    if model is None:
        return {}
    raw_scores = model.get_scores(query_tokens)
    scores: Dict[str, float] = {}
    for index, score in enumerate(raw_scores):
        if score > 0:
            scores[entries[index]["id"]] = float(score)
    return scores


def keyword_overlap_scores(entries: List[dict], query_tokens: List[str]) -> Dict[str, float]:
    scores: Dict[str, float] = {}
    query_set = set(query_tokens)
    for entry in entries:
        overlap = sum(1 for token in entry.get("tokens", []) if token in query_set)
        if overlap > 0:
            scores[entry["id"]] = float(overlap)
    return scores


# ---------------------------------------------------------------------------
# Dense / cosine similarity scoring
# ---------------------------------------------------------------------------

def cosine_similarity(left: Iterable[float], right: Iterable[float]) -> float:
    left_values = [float(value) for value in left]
    right_values = [float(value) for value in right]
    if not left_values or not right_values or len(left_values) != len(right_values):
        return 0.0

    numerator = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for left_value, right_value in zip(left_values, right_values):
        numerator += left_value * right_value
        left_norm += left_value * left_value
        right_norm += right_value * right_value
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return numerator / math.sqrt(left_norm * right_norm)


def cosine_similarity_batch(query_vec, matrix) -> List[float]:
    """
    Cosine similarity of a single query vector against each row of `matrix`.

    `matrix` is an iterable of vectors (each vector is an iterable of floats).
    When numpy is available, computes row-normalized dot products in one
    vectorized pass. When numpy is absent, falls back to a Python loop calling
    the scalar `cosine_similarity` (identical behavior to the pre-batch path).

    Rows whose length != query length are scored 0.0 (matching scalar behavior).
    """
    # Materialize rows once; needed for both paths (length checks + iteration).
    rows = [list(payload.get("embedding", [])) if isinstance(payload, dict) else list(payload) for payload in matrix]

    if _HAS_NUMPY and _np is not None:
        if not rows:
            return []
        dim = len(query_vec)
        if dim == 0:
            return [0.0] * len(rows)
        # Filter rows to the query dimension; mismatched rows get 0.0.
        aligned: List[List[float]] = []
        aligned_idx: List[int] = []
        for i, row in enumerate(rows):
            if len(row) == dim:
                aligned.append([float(v) for v in row])
                aligned_idx.append(i)
        results = [0.0] * len(rows)
        if not aligned:
            return results
        mat = _np.asarray(aligned, dtype=_np.float64)
        q = _np.asarray([float(v) for v in query_vec], dtype=_np.float64)
        mat_norm = _np.linalg.norm(mat, axis=1)
        q_norm = float(_np.linalg.norm(q))
        if q_norm <= 0.0:
            return results
        safe = mat_norm > 0
        dots = mat[safe] @ q
        scores = dots / (mat_norm[safe] * q_norm)
        for j, idx in enumerate([i for i, ok in enumerate(safe) if ok]):
            results[aligned_idx[idx]] = float(scores[j])
        return results

    # Fallback: scalar per-row (bit-identical to today's behavior).
    return [cosine_similarity(query_vec, row) for row in rows]


def embed_query(query: str, runtime: Dict[str, object], model_name: str = "") -> Tuple[Optional[List[float]], Optional[str], bool]:
    """
    Embed a query using the given runtime config, with caching.

    Returns (embedding, error, cache_hit).
    """
    effective_model = str(model_name or runtime.get("model", DEFAULT_MODEL) or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    effective_adapter = normalize_embedding_adapter(runtime.get("adapter") or runtime.get("backend"), effective_model) or "hash"
    cache_key = build_query_embedding_cache_key(
        query,
        effective_adapter,
        effective_model,
        str(runtime.get("baseUrl", "")),
    )
    cached_embedding = get_cached_query_embedding(cache_key)
    if cached_embedding is not None:
        return cached_embedding, None, True

    vector, error, _, resolved_model = embed_query_with_runtime(query, runtime, effective_model)
    if vector is not None and error is None:
        store_query_embedding(cache_key, vector)
    if resolved_model and resolved_model != effective_model:
        runtime["model"] = resolved_model
    return vector, error, False


def build_query_embedding_cache_key(query: str, backend: str, model_name: str, base_url: str = "") -> str:
    payload = {
        "query": normalize_spaces(query),
        "backend": normalize_embedding_adapter(backend, model_name),
        "model": (model_name or "").strip(),
        "baseUrl": (base_url or "").strip().rstrip("/").lower(),
    }
    return hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8", errors="ignore")).hexdigest()


def get_cached_query_embedding(cache_key: str) -> Optional[List[float]]:
    prune_timed_cache(_QUERY_EMBEDDING_CACHE, _QUERY_EMBEDDING_CACHE_TTL, _QUERY_EMBEDDING_CACHE_MAX_ENTRIES)
    cached = _QUERY_EMBEDDING_CACHE.get(cache_key)
    if cached is None:
        _CACHE_METRICS["queryEmbeddingMisses"] = int(_CACHE_METRICS["queryEmbeddingMisses"]) + 1
        return None

    _CACHE_METRICS["queryEmbeddingHits"] = int(_CACHE_METRICS["queryEmbeddingHits"]) + 1
    return [float(value) for value in cached.get("embedding", [])]


def store_query_embedding(cache_key: str, embedding: List[float]) -> None:
    _QUERY_EMBEDDING_CACHE[cache_key] = {
        "created_at": time_module.time(),
        "embedding": [float(value) for value in embedding],
    }
    prune_timed_cache(_QUERY_EMBEDDING_CACHE, _QUERY_EMBEDDING_CACHE_TTL, _QUERY_EMBEDDING_CACHE_MAX_ENTRIES)


def dense_scores(
    entries_by_id: Dict[str, dict],
    query: str,
    load_embeddings_index,  # callable injected to avoid circular import
    EMBEDDING_RUNTIME: Dict[str, object],
    embeddings_index_path: Optional[str] = None,
) -> Tuple[Dict[str, float], Optional[str], Dict[str, object]]:
    """
    Score all field-level sub-entries in the index against the query embedding.

    Returns (scores, error, meta).

    Memory: When embeddings_index_path is provided, uses StreamingIndex.scan()
    to stream records from disk one at a time (no OOM risk). Falls back to
    load_embeddings_index() when streaming is unavailable.
    """
    import os

    # Peek at first record for schema/version detection.
    # Try streaming first, fall back to legacy dict.
    first_record: Optional[Dict] = None
    stream_index: Optional["StreamingIndex"] = None  # type: ignore[name-defined]

    if (
        _STREAMING_INDEX_AVAILABLE
        and StreamingIndex is not None
        and embeddings_index_path
        and os.path.isfile(embeddings_index_path)
    ):
        stream_index = StreamingIndex(embeddings_index_path)
        for payload in stream_index.scan():
            first_record = payload
            break

    if first_record is None:
        # Fallback: use legacy full-load path (OOM risk on large files)
        index_records = load_embeddings_index()
        if not index_records:
            return {}, "missing-embeddings-index", {"queryEmbeddingCacheHit": False}
        first_record = next(iter(index_records.values()))
        return _dense_scores_fallback(index_records, first_record, query, EMBEDDING_RUNTIME)

    first_schema_version = int(first_record.get("featureSchemaVersion", 0) or 0)
    if first_schema_version != VECTOR_SCHEMA_VERSION:
        return {}, (
            f"embedding-schema-version-mismatch:stored={first_schema_version},"
            f"expected={VECTOR_SCHEMA_VERSION};rebuild-memory-embeddings-required"
        ), {"queryEmbeddingCacheHit": False}
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
            return {}, "embedding-config-mismatch:rebuild-memory-embeddings-required", {"queryEmbeddingCacheHit": False}
        query_runtime["adapter"] = active_adapter
        query_runtime["backend"] = active_adapter
        query_runtime["model"] = active_model_name
    else:
        query_runtime["adapter"] = backend
        query_runtime["backend"] = backend
        query_runtime["model"] = model_name

    query_vector, error, query_embedding_cache_hit = embed_query(query, query_runtime, model_name)
    if error is not None or query_vector is None:
        return {}, error, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}
    first_embedding = first_record.get("embedding", [])
    if isinstance(first_embedding, list) and first_embedding and len(first_embedding) != len(query_vector):
        return {}, f"embedding-dimension-mismatch:index={len(first_embedding)},query={len(query_vector)}", {
            "queryEmbeddingCacheHit": bool(query_embedding_cache_hit)
        }

    # --- Streaming path: scan records from disk one at a time (bounded memory) ---
    best_by_record: Dict[str, Tuple[str, float, dict]] = {}
    skipped_schema_mismatch = 0
    scanned_payloads: List[dict] = []
    for payload in stream_index.scan():  # type: ignore[union-attr]
        entry_id = str(payload.get("id", "")).strip()
        if not entry_id:
            continue
        record_schema_version = int(payload.get("featureSchemaVersion", 0) or 0)
        if record_schema_version != VECTOR_SCHEMA_VERSION:
            skipped_schema_mismatch += 1
            continue
        scanned_payloads.append(payload)

    batch_scores = cosine_similarity_batch(query_vector, scanned_payloads)
    for payload, score in zip(scanned_payloads, batch_scores):
        if score <= 0:
            continue
        entry_id = str(payload.get("id", "")).strip()
        record_id = str(payload.get("record_id", entry_id))
        field = str(payload.get("field", "content"))
        existing = best_by_record.get(record_id)
        if existing is None or score > existing[1]:
            best_by_record[record_id] = (entry_id, score, {**payload, "record_id": record_id, "field": field})

    if skipped_schema_mismatch > 0:
        sys.stderr.write(
            f"[dense_scores] skipped {skipped_schema_mismatch} records due to "
            f"schema version mismatch (expected={VECTOR_SCHEMA_VERSION}); "
            "run generate-embeddings to rebuild the index\n"
        )

    if not best_by_record:
        return {}, None, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}
    max_score = max(float(v[1]) for v in best_by_record.values())
    scores: Dict[str, float] = {}
    for record_id, (entry_id, raw_score, _payload) in best_by_record.items():
        scores[entry_id] = float(raw_score) / max_score if max_score > 0 else 0.0

    return scores, None, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}


def _dense_scores_fallback(
    index_records: Dict[str, dict],
    first_record: Dict,
    query: str,
    EMBEDDING_RUNTIME: Dict[str, object],
) -> Tuple[Dict[str, float], Optional[str], Dict[str, object]]:
    """
    Legacy full-load fallback for dense_scores(). Used when StreamingIndex is unavailable.

    Logic mirrors the streaming path above — kept in sync manually.
    """
    first_schema_version = int(first_record.get("featureSchemaVersion", 0) or 0)
    if first_schema_version != VECTOR_SCHEMA_VERSION:
        return {}, (
            f"embedding-schema-version-mismatch:stored={first_schema_version},"
            f"expected={VECTOR_SCHEMA_VERSION};rebuild-memory-embeddings-required"
        ), {"queryEmbeddingCacheHit": False}
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
            return {}, "embedding-config-mismatch:rebuild-memory-embeddings-required", {"queryEmbeddingCacheHit": False}
        query_runtime["adapter"] = active_adapter
        query_runtime["backend"] = active_adapter
        query_runtime["model"] = active_model_name
    else:
        query_runtime["adapter"] = backend
        query_runtime["backend"] = backend
        query_runtime["model"] = model_name

    query_vector, error, query_embedding_cache_hit = embed_query(query, query_runtime, model_name)
    if error is not None or query_vector is None:
        return {}, error, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}
    first_embedding = first_record.get("embedding", [])
    if isinstance(first_embedding, list) and first_embedding and len(first_embedding) != len(query_vector):
        return {}, f"embedding-dimension-mismatch:index={len(first_embedding)},query={len(query_vector)}", {
            "queryEmbeddingCacheHit": bool(query_embedding_cache_hit)
        }

    best_by_record: Dict[str, Tuple[str, float, dict]] = {}
    skipped_schema_mismatch = 0
    matched_payloads: List[dict] = []
    matched_ids: List[str] = []
    for entry_id, payload in index_records.items():
        record_schema_version = int(payload.get("featureSchemaVersion", 0) or 0)
        if record_schema_version != VECTOR_SCHEMA_VERSION:
            skipped_schema_mismatch += 1
            continue
        matched_payloads.append(payload)
        matched_ids.append(entry_id)

    batch_scores = cosine_similarity_batch(query_vector, matched_payloads)
    for entry_id, payload, score in zip(matched_ids, matched_payloads, batch_scores):
        if score <= 0:
            continue

        record_id = str(payload.get("record_id", entry_id))
        field = str(payload.get("field", "content"))
        existing = best_by_record.get(record_id)
        if existing is None or score > existing[1]:
            best_by_record[record_id] = (entry_id, score, {**payload, "record_id": record_id, "field": field})

    if skipped_schema_mismatch > 0:
        sys.stderr.write(
            f"[dense_scores] skipped {skipped_schema_mismatch} records due to "
            f"schema version mismatch (expected={VECTOR_SCHEMA_VERSION}); "
            "run generate-embeddings to rebuild the index\n"
        )

    if not best_by_record:
        return {}, None, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}
    max_score = max(float(v[1]) for v in best_by_record.values())
    scores: Dict[str, float] = {}
    for record_id, (entry_id, raw_score, _payload) in best_by_record.items():
        scores[entry_id] = float(raw_score) / max_score if max_score > 0 else 0.0

    return scores, None, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}


# ---------------------------------------------------------------------------
# Score normalization
# ---------------------------------------------------------------------------

def normalize_score_map(scores: Dict[str, float]) -> Dict[str, float]:
    if not scores:
        return {}
    max_score = max(float(value) for value in scores.values())
    if max_score <= 0:
        return {}
    return {entry_id: float(value) / max_score for entry_id, value in scores.items() if float(value) > 0}


# ---------------------------------------------------------------------------
# Reciprocal Rank Fusion (RRF)
# ---------------------------------------------------------------------------

# RRF 常量：k=60 是 Elasticsearch/OpenSearch 默认值，平滑 top-1 主导。
RRF_DEFAULT_K = 60


def compute_rank_map(score_map: Dict[str, float]) -> Dict[str, int]:
    """
    将原始 score 映射为排名（rank，从 1 开始）。
    按 score 降序排序；score <= 0 的 entry 不进 rank 表（视为未召回）。
    返回新 dict，输入不变（不可变模式）。
    """
    positive = [(eid, float(v)) for eid, v in score_map.items() if float(v) > 0]
    positive.sort(key=lambda kv: kv[1], reverse=True)
    return {eid: idx + 1 for idx, (eid, _) in enumerate(positive)}


def rrf_fusion_score(
    bm25_rank: Optional[int],
    dense_rank: Optional[int],
    k: int = RRF_DEFAULT_K,
) -> float:
    """
    RRF 公式：score = sum(1 / (k + rank))，某路缺失（rank 为 None）贡献 0。
    rank 从 1 开始。k 必须 > 0。
    """
    if k <= 0:
        k = RRF_DEFAULT_K
    total = 0.0
    if bm25_rank is not None and bm25_rank > 0:
        total += 1.0 / (k + bm25_rank)
    if dense_rank is not None and dense_rank > 0:
        total += 1.0 / (k + dense_rank)
    return total


def resolve_fusion_mode(route: Optional[Dict[str, object]]) -> str:
    """
    决定 hybrid 模式下使用的融合策略：
      1. 环境变量 AI_MEMORY_FUSION（'rrf' / 'weighted'）— 全局开关
      2. route['fusion'] — 单次查询覆盖
      3. 默认 'weighted'（保持现有行为，安全回退）
    """
    env_val = (os.environ.get("AI_MEMORY_FUSION") or "").strip().lower()
    if env_val in {"rrf", "weighted"}:
        return env_val
    if route:
        route_val = str(route.get("fusion", "")).strip().lower()
        if route_val in {"rrf", "weighted"}:
            return route_val
    return "weighted"


# ---------------------------------------------------------------------------
# Entry scoring
# ---------------------------------------------------------------------------

def task_state_weight(task_state: str, intent: str) -> float:
    normalized = normalize_spaces(task_state).lower()
    if not normalized:
        return 1.0
    if intent == "task":
        if normalized in {"processing", "active", "pending"}:
            return 1.12
        if normalized in {"ok", "pr_submitted", "pr_created"}:
            return 1.06
        if normalized in {"failed", "timeout", "dev_error", "report_error", "build_fail"}:
            return 1.01
    if intent == "recent":
        if normalized in {"processing", "active", "pending"}:
            return 1.06
        if normalized in {"ok", "pr_submitted", "pr_created"}:
            return 1.04
    return 1.0


def score_entry(
    entry: dict,
    effective_mode: str,
    route: Dict[str, object],
    bm25_norm: Dict[str, float],
    dense_norm: Dict[str, float],
    temporal_decay: Optional[Dict[str, object]] = None,
    bm25_rank_map: Optional[Dict[str, int]] = None,
    dense_rank_map: Optional[Dict[str, int]] = None,
) -> Optional[Tuple[float, Dict[str, object]]]:
    entry_id = str(entry.get("id", "")).strip()
    bm25_component = float(bm25_norm.get(entry_id, 0.0))
    dense_component = float(dense_norm.get(entry_id, 0.0))

    if effective_mode == "bm25":
        retrieval_score = bm25_component
    elif effective_mode == "dense":
        retrieval_score = dense_component
    else:
        fusion_mode = resolve_fusion_mode(route)
        if fusion_mode == "rrf":
            # RRF：基于 rank 融合，免归一化。某路未召回（rank=None）贡献 0。
            bm25_rank = bm25_rank_map.get(entry_id) if bm25_rank_map else None
            dense_rank = dense_rank_map.get(entry_id) if dense_rank_map else None
            if bm25_rank is None and dense_rank is None:
                retrieval_score = 0.0
            else:
                adaptive_blend = route.get("adaptiveBlend", {})
                rrf_k = int(adaptive_blend.get("rrfK", RRF_DEFAULT_K))
                retrieval_score = rrf_fusion_score(bm25_rank, dense_rank, rrf_k)
        else:
            # 加权求和（默认，安全回退）
            adaptive_blend = route.get("adaptiveBlend", {})
            bm25_w = float(adaptive_blend.get("bm25Weight", 0.55))
            dense_w = float(adaptive_blend.get("denseWeight", 0.45))
            retrieval_score = (bm25_w * bm25_component) + (dense_w * dense_component)

    if retrieval_score <= 0:
        return None

    layer = normalize_spaces(str(entry.get("layer", ""))).lower() or "session"
    scope = normalize_spaces(str(entry.get("scope", ""))).lower() or "summary"
    source_kind = normalize_spaces(str(entry.get("sourceKind", ""))).lower()
    freshness = normalize_spaces(str(entry.get("freshness", ""))).lower() or "unknown"
    task_state = normalize_spaces(str(entry.get("taskState", ""))).lower()
    intent = str(route.get("intent", "mixed"))
    layer_weight = float(dict(route.get("layerWeights", {})).get(layer, 1.0))
    scope_weight = float(dict(route.get("scopeWeights", {})).get(scope, 1.0))
    source_kind_weight = float(dict(route.get("sourceKindWeights", {})).get(source_kind, 1.0))
    freshness_weight = float(dict(route.get("freshnessWeights", {})).get(freshness, 1.0))
    state_weight = task_state_weight(task_state, intent)
    coverage_weight = 1.04 if effective_mode == "hybrid" and bm25_component > 0 and dense_component > 0 else 1.0
    final_score = retrieval_score * layer_weight * scope_weight * source_kind_weight * freshness_weight * state_weight * coverage_weight

    decay_factor = 1.0
    if temporal_decay and bool(temporal_decay.get("enabled", False)):
        updated_at = str(entry.get("t", "")).strip()
        half_life = float(temporal_decay.get("half_life_days", 30.0))
        age_seconds: float = 0.0
        if updated_at:
            try:
                normalized_ts = updated_at.replace("Z", "+00:00")
                ts = datetime.fromisoformat(normalized_ts).timestamp()
                now = datetime.now(timezone.utc).timestamp()
                age_seconds = max(0.0, now - ts)
            except (ValueError, TypeError):
                logger.warning(
                    "failed to parse timestamp %r; applying no decay", updated_at
                )
                age_seconds = 0.0
        decay_factor = 0.5 ** (age_seconds / 86400.0 / half_life) if half_life > 0 else 1.0
        final_score = final_score * decay_factor

    return (
        final_score,
        {
            "retrievalScore": retrieval_score,
            "layerWeight": layer_weight,
            "scopeWeight": scope_weight,
            "sourceKindWeight": source_kind_weight,
            "freshnessWeight": freshness_weight,
            "taskStateWeight": state_weight,
            "coverageWeight": coverage_weight,
            "decayFactor": round(decay_factor, 6),
        },
    )


def apply_field_match_bonus(
    scored: List[Tuple[str, float, Dict[str, object]]],
    entries_by_id: Dict[str, dict],
    query_text_lower: str,
) -> List[Tuple[str, float, Dict[str, object]]]:
    """
    Apply weight bonuses when query terms match specific fields.
    Returns new tuples (input list is not mutated).
    """
    query_terms = set(query_text_lower.split())
    if not query_terms:
        return scored

    result: List[Tuple[str, float, Dict[str, object]]] = []
    for entry_id, final_score, meta in scored:
        entry = entries_by_id.get(entry_id, {})
        field = str(entry.get("field", "content"))
        title_text = str(entry.get("title", "")).lower()
        desc_text = str(entry.get("description", "")).lower()

        bonus = 1.0

        if title_text and len(query_terms) >= 2:
            overlap = len(query_terms & set(title_text.split()))
            if overlap >= min(2, len(query_terms)):
                bonus *= 1.3

        if desc_text and len(query_terms) >= 2:
            overlap = len(query_terms & set(desc_text.split()))
            if overlap >= min(2, len(query_terms)):
                bonus *= 1.2

        if field == "fact":
            bonus *= 1.1
        elif field == "concept":
            bonus *= 1.15

        new_meta = {**meta, "fieldMatchBonus": round(bonus, 6)}
        result.append((entry_id, final_score * bonus, new_meta))

    return result


# ---------------------------------------------------------------------------
# Reranking
# ---------------------------------------------------------------------------

def _cross_encoder_rerank(
    scored: List[Tuple[str, float, Dict[str, object]]],
    entries_by_id: Dict[str, dict],
    query: str,
) -> List[Tuple[str, float, Dict[str, object]]]:
    """Optional cross-encoder rerank. Env-gated AI_MEMORY_RERANK=local (default off).
    Graceful degradation: if sentence_transformers is missing or model load fails
    (network/OOM/etc.), return input unchanged and write a one-line notice to stderr.
    Recommended model: BAAI/bge-reranker-v2-m3 (multilingual, Chinese-capable)."""
    if (os.environ.get("AI_MEMORY_RERANK", "off") or "off").strip().lower() != "local":
        return scored
    if not query or len(scored) <= 1:
        return scored
    try:
        from sentence_transformers import CrossEncoder
    except ImportError:
        sys.stderr.write(
            "[rerank] AI_MEMORY_RERANK=local but sentence_transformers not installed; skipping\n"
        )
        return scored
    try:
        model = CrossEncoder("BAAI/bge-reranker-v2-m3")
        pairs = [
            (query, str(entries_by_id.get(eid, {}).get("content", ""))[:2000])
            for eid, _, _ in scored
        ]
        ce_scores = model.predict(pairs)
        blended = sorted(zip(scored, ce_scores), key=lambda x: float(x[1]), reverse=True)
        return [item for item, _ in blended]
    except Exception as exc:  # model download failure, network, OOM, etc.
        sys.stderr.write(f"[rerank] cross-encoder disabled: {exc}\n")
        return scored


def rerank_entries(
    entries_by_id: Dict[str, dict],
    effective_mode: str,
    top_k: int,
    route: Dict[str, object],
    bm25_map: Dict[str, float],
    dense_map: Dict[str, float],
    query_text_lower: str = "",
    temporal_decay: Optional[Dict[str, object]] = None,
) -> Tuple[List[Tuple[str, float]], Dict[str, Dict[str, object]], int]:
    candidate_ids = set()
    if effective_mode in {"bm25", "hybrid"}:
        candidate_ids.update(bm25_map.keys())
    if effective_mode in {"dense", "hybrid"}:
        candidate_ids.update(dense_map.keys())

    bm25_norm = normalize_score_map(bm25_map)
    dense_norm = normalize_score_map(dense_map)
    bm25_rank_map = compute_rank_map(bm25_map)
    dense_rank_map = compute_rank_map(dense_map)

    all_scored: List[Tuple[str, float, Dict[str, object]]] = []

    for entry_id in candidate_ids:
        entry = entries_by_id.get(entry_id)
        if entry is None:
            continue
        scored = score_entry(
            entry,
            effective_mode,
            route,
            bm25_norm,
            dense_norm,
            temporal_decay,
            bm25_rank_map=bm25_rank_map,
            dense_rank_map=dense_rank_map,
        )
        if scored is None:
            continue
        final_score, meta = scored

        field = str(entry.get("field", "content"))
        bm25_v = float(bm25_norm.get(entry_id, 0.0))
        dense_v = float(dense_norm.get(entry_id, 0.0))
        if effective_mode == "bm25":
            primary_v = bm25_v
        elif effective_mode == "dense":
            primary_v = dense_v
        else:
            adaptive_blend = route.get("adaptiveBlend", {})
            bw = float(adaptive_blend.get("bm25Weight", 0.55))
            dw = float(adaptive_blend.get("denseWeight", 0.45))
            primary_v = bw * bm25_v + dw * dense_v

        matched_field = field if primary_v > 0 else "content"
        meta["matchedField"] = matched_field

        all_scored.append((entry_id, final_score, meta))

    all_scored = apply_field_match_bonus(all_scored, entries_by_id, query_text_lower)

    seen_record_ids: set = set()
    deduped_scored: List[Tuple[str, float, Dict[str, object]]] = []
    for entry_id, final_score, meta in sorted(all_scored, key=lambda x: x[1], reverse=True):
        record_id = str(entries_by_id.get(entry_id, {}).get("record_id", entry_id))
        if record_id not in seen_record_ids:
            seen_record_ids.add(record_id)
            deduped_scored.append((entry_id, final_score, meta))

    rank_meta: Dict[str, Dict[str, object]] = {
        entry_id: meta for entry_id, _, meta in deduped_scored
    }

    top_entries = deduped_scored[:top_k]
    top_entries = _cross_encoder_rerank(top_entries, entries_by_id, query_text_lower)
    ranked: List[Tuple[str, float]] = [(eid, score) for eid, score, _ in top_entries]
    return ranked, rank_meta, len(candidate_ids)


def mmr_rerank(
    entries_by_id: Dict[str, dict],
    relevance_scores: Dict[str, float],
    top_k: int,
    lambda_param: float = 0.7,
    load_embeddings_index=None,  # callable injected to avoid circular import
    embeddings_index_path: Optional[str] = None,
) -> List[Tuple[str, float]]:
    """
    Maximal Marginal Relevance (MMR) diversity reranking.

    Memory: Uses StreamingIndex.scan() to stream embeddings from disk without
    loading the full index into memory.
    """
    import os

    if not relevance_scores or top_k <= 0:
        return []

    lambda_param = max(0.0, min(1.0, lambda_param))

    # Build entry_id -> embedding lookup via streaming (bounded memory)
    entry_embeddings: Dict[str, List[float]] = {}

    if (
        _STREAMING_INDEX_AVAILABLE
        and StreamingIndex is not None
        and embeddings_index_path
        and os.path.isfile(embeddings_index_path)
    ):
        stream_index = StreamingIndex(embeddings_index_path)
        for payload in stream_index.scan():
            emb_id = str(payload.get("id", "")).strip()
            emb_vec = payload.get("embedding", [])
            if emb_id and isinstance(emb_vec, list) and emb_vec:
                entry_embeddings[emb_id] = [float(v) for v in emb_vec]
    elif load_embeddings_index is not None:
        # Legacy fallback: load entire index into memory (OOM risk on large files)
        embeddings_index = load_embeddings_index()
        for entry_id, entry in entries_by_id.items():
            record_id = str(entry.get("record_id", entry_id))
            if record_id in embeddings_index:
                embedding_data = embeddings_index[record_id]
                embedding = embedding_data.get("embedding", [])
                if embedding:
                    entry_embeddings[entry_id] = [float(v) for v in embedding]

    max_rel = max(float(v) for v in relevance_scores.values())
    if max_rel <= 0:
        return []

    normalized_rel: Dict[str, float] = {
        entry_id: float(score) / max_rel
        for entry_id, score in relevance_scores.items()
        if float(score) > 0
    }

    selected: List[Tuple[str, float]] = []
    selected_ids: set = set()
    remaining = set(normalized_rel.keys())

    # Pre-build candidate embedding matrix (numpy path) — only for entries
    # that have an embedding and a positive relevance score.
    cand_ids: List[str] = [eid for eid in remaining if entry_embeddings.get(eid) is not None]
    cand_matrix = None
    cand_norms = None
    if _HAS_NUMPY and _np is not None and cand_ids:
        cand_matrix = _np.asarray(
            [[float(v) for v in entry_embeddings[eid]] for eid in cand_ids],
            dtype=_np.float64,
        )
        cand_norms = _np.linalg.norm(cand_matrix, axis=1)

    selected_matrix_rows: List[_np.ndarray] = []  # type: ignore[type-arg]
    selected_norms: List[float] = []

    while remaining and len(selected) < top_k:
        best_mmr_score = -float("inf")
        best_entry_id = None

        if not selected_ids:
            # First round: MMR == relevance score; pick max.
            for entry_id in remaining:
                mmr_score = normalized_rel.get(entry_id, 0.0)
                if mmr_score > best_mmr_score:
                    best_mmr_score = mmr_score
                    best_entry_id = entry_id
        elif _HAS_NUMPY and _np is not None and cand_matrix is not None:
            # Vectorized: max over selected for each candidate.
            sel_mat = _np.asarray(selected_matrix_rows, dtype=_np.float64)  # (k, dim)
            sel_norms = _np.asarray(selected_norms, dtype=_np.float64)  # (k,)
            sims = cand_matrix @ sel_mat.T  # (N, k)
            denom = _np.outer(cand_norms, sel_norms)  # (N, k)
            safe = denom > 0
            row_max = _np.zeros(cand_matrix.shape[0], dtype=_np.float64)
            for i in range(cand_matrix.shape[0]):
                row_safe = safe[i]
                if row_safe.any():
                    row_max[i] = float(_np.max(sims[i][row_safe] / denom[i][row_safe]))
                else:
                    row_max[i] = 0.0
            cand_index_of = {eid: idx for idx, eid in enumerate(cand_ids)}
            for entry_id in remaining:
                rel_score = normalized_rel.get(entry_id, 0.0)
                idx = cand_index_of.get(entry_id)
                max_sim = float(row_max[idx]) if idx is not None else 0.0
                mmr_score = lambda_param * rel_score - (1.0 - lambda_param) * max_sim
                if mmr_score > best_mmr_score:
                    best_mmr_score = mmr_score
                    best_entry_id = entry_id
        else:
            for entry_id in remaining:
                rel_score = normalized_rel.get(entry_id, 0.0)
                max_sim = 0.0
                entry_emb = entry_embeddings.get(entry_id)

                if entry_emb is not None:
                    for sel_id, _ in selected:
                        sel_emb = entry_embeddings.get(sel_id)
                        if sel_emb is not None:
                            sim = cosine_similarity(entry_emb, sel_emb)
                            max_sim = max(max_sim, sim)

                mmr_score = lambda_param * rel_score - (1.0 - lambda_param) * max_sim

                if mmr_score > best_mmr_score:
                    best_mmr_score = mmr_score
                    best_entry_id = entry_id

        if best_entry_id is None:
            break

        selected.append((best_entry_id, best_mmr_score))
        selected_ids.add(best_entry_id)
        remaining.remove(best_entry_id)

        if _HAS_NUMPY and _np is not None and cand_matrix is not None:
            idx = {eid: i for i, eid in enumerate(cand_ids)}.get(best_entry_id)
            if idx is not None:
                selected_matrix_rows.append(cand_matrix[idx])
                selected_norms.append(float(cand_norms[idx]))

    return selected


def ranked_pairs(scores: Dict[str, float], limit: int) -> List[Tuple[str, float]]:
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]


# ---------------------------------------------------------------------------
# Adaptive query type analysis — dynamically adjusts BM25/Dense blend weights
# ---------------------------------------------------------------------------

# 技术名词模式（专业术语 → 关键词主导）
TECHNICAL_TERM_PATTERN = re.compile(
    r"\b("
    r"python|javascript|typescript|java|cpp|golang|rust|sql|html|css|regex|api|cli|"
    r"gui|orm|cli|devops|cli|json|yaml|toml|xml|markdown|markdown|markdown|"
    r"useeffect|usememo|usestate|usecontext|useref|usecallback|"
    r"context|reducer|middleware|websocket|restful|graphql|grpc|"
    r"npm|pip|maven|gradle|docker|kubernetes|ansible|terraform|"
    r"http|https|tcp|udp|dns|cache|redis|memcached|postgres|mysql|mongodb|"
    r"async|await|promise|callback|closure|decorator|decorator|"
    r"class|function|method|interface|type|enum|struct|trait|generic|"
    r"inheritance|polymorphism|encapsulation|abstraction|"
    r"monad|functor|lambda|closure|curry|higher.order|"
    r"git|commit|push|pull|merge|rebase|branch|tag|diff|patch|"
    r"ci|cd|pipeline|jenkins|github|gitlab|bitbucket|"
    r"oop|fp|tdd|bdd|ddd|cqrs|event.sourcing|"
    r"microservice|monolith|serverless|faas|paas|saas|"
    r"jwt|oauth|ssl|tls|https|ssh|gpg|rsa|aes|"
    r"kernel|thread|process|goroutine|channel|actor|"
    r"virtual.dom|reconcile|scheduler|fiber|hook|effect|ref|"
    r"mcp|protocol|schema|endpoint|route|handler|middleware|"
    r"index|shard|partition|replica|leader|follower|splitbrain|"
    r"llm|embedding|vector|token|rag|rerank|bm25|dense|"
    r"crud|create|read|update|delete|upsert|patch|"
    r"[a-z]{2,}[_][a-z]{2,}"  # snake_case identifiers
    r")\b",
    re.I,
)

# 英文词干模式（短词 → 可能是关键词）
SHORT_TOKEN_PATTERN = re.compile(r"\b[a-z]{2,6}\b")

# 语义描述模式（自然语言提问 → 语义主导）
SEMANTIC_PATTERN = re.compile(
    r"("
    r"怎么|如何|为什么|什么|哪个|哪些|何时|哪里|怎样|多少|"
    r"怎么实现|如何使用|如何处理|如何解决|如何优化|如何改进|"
    r"why|how|what|which|when|where|can i|could i|should i|"
    r"explain|describe|compare|contrast|difference between|"
    r"的最佳实践|最佳方案|推荐|建议|思路|方案|"
    r"告诉我|教我|帮我|给我|概念|原理|思路"
    r")",
    re.I,
)

# 专业符号模式（特殊字符 → 关键词主导）
SPECIAL_CHAR_PATTERN = re.compile(r"[`\[\]{}()=+\-*/<>!&|^%$#@~`]")


def analyze_query_type(query: str) -> Tuple[str, Dict[str, float]]:
    """
    分析查询类型，返回 (query_type, signal_scores)。

    query_type:
      - "keyword_heavy": 技术名词/专有词占比高 → BM25 权重高
      - "semantic_heavy": 自然语言描述占比高 → Dense 权重高
      - "balanced": 两者均衡

    signal_scores 包含各个分析维度，供调试和扩展使用。
    """
    if not query or not query.strip():
        return "balanced", {"keyword_score": 0.5, "semantic_score": 0.5}

    q = query.strip()

    # 1. 统计技术名词
    tech_terms = TECHNICAL_TERM_PATTERN.findall(q)
    keyword_density = len(tech_terms) / max(len(q.split()), 1)

    # 2. 统计自然语言语义指标
    has_semantic_markers = bool(SEMANTIC_PATTERN.search(q))
    has_question_word = bool(re.search(r"[？?]", q))
    is_long_description = len(q) > 30 and q.count(" ") > 5

    # 3. 统计特殊符号（代码片段、文件路径等）
    special_char_ratio = len(SPECIAL_CHAR_PATTERN.findall(q)) / max(len(q), 1)

    # 4. 统计英文字母词干
    short_tokens = SHORT_TOKEN_PATTERN.findall(q)
    avg_token_len = sum(len(t) for t in short_tokens) / max(len(short_tokens), 1) if short_tokens else 0

    # 计算信号强度
    keyword_signals = [
        keyword_density * 5,           # 技术名词密度
        special_char_ratio * 3,         # 特殊字符（代码片段）
        min(avg_token_len / 8.0, 1.0), # 短词干（可能是关键词）
    ]

    semantic_signals = [
        1.5 if has_semantic_markers else 0.0,  # 语义疑问词
        1.0 if has_question_word else 0.0,     # 问号
        1.0 if is_long_description else 0.0,  # 长自然语言描述
    ]

    kw = sum(keyword_signals)
    sem = sum(semantic_signals)

    # 归一化到 [0, 1]
    total = kw + sem
    if total > 0:
        kw_norm = kw / total
        sem_norm = sem / total
    else:
        kw_norm = 0.5
        sem_norm = 0.5

    if kw_norm > 0.65:
        qt = "keyword_heavy"
    elif sem_norm > 0.65:
        qt = "semantic_heavy"
    else:
        qt = "balanced"

    return qt, {
        "keyword_score": round(kw_norm, 4),
        "semantic_score": round(sem_norm, 4),
        "tech_term_count": len(tech_terms),
        "has_semantic_markers": has_semantic_markers,
        "has_question_word": has_question_word,
        "special_char_ratio": round(special_char_ratio, 4),
    }


def compute_adaptive_blend_weights(query_type: str) -> Tuple[float, float]:
    """
    根据查询类型返回自适应混合权重 (bm25_weight, dense_weight)。

    设计原则：
      - keyword_heavy: BM25 对关键词匹配更精准 → 提高 BM25 权重
      - semantic_heavy: Dense 对语义理解更强 → 提高 Dense 权重
      - balanced: 两者均衡（接近原来的 0.58:0.42）
    """
    weights: Dict[str, Tuple[float, float]] = {
        "keyword_heavy": (0.72, 0.28),   # 关键词精准优先
        "semantic_heavy": (0.28, 0.72),  # 语义理解优先
        "balanced": (0.55, 0.45),        # 均衡（微调后比原来的 0.58:0.42 更平衡）
    }
    return weights.get(query_type, (0.55, 0.45))


# ---------------------------------------------------------------------------
# classify_query_intent / build_query_route
# ---------------------------------------------------------------------------

def classify_query_intent(query: str, parsed: Dict[str, object]) -> Tuple[str, str]:
    explicit_route = normalize_spaces(str(parsed.get("route", parsed.get("intent", "")))).lower()
    if explicit_route in ROUTE_VALUES and explicit_route != "auto":
        return explicit_route, explicit_route

    scope = normalize_spaces(str(parsed.get("scope", ""))).lower()
    source_kind = normalize_spaces(str(parsed.get("source_kind", parsed.get("sourceKind", "")))).lower()
    task_state = normalize_spaces(str(parsed.get("task_state", parsed.get("taskState", "")))).lower()
    query_text = normalize_spaces(query).lower()

    if source_kind in {"blackboard", "run", "cron", "task"} or task_state or scope in {"task", "run"}:
        return "task", explicit_route
    if scope == "reference":
        return "reference", explicit_route
    if scope in DURABLE_SCOPES:
        return "durable", explicit_route
    if RECENT_QUERY_PATTERN.search(query_text):
        return "recent", explicit_route
    if TASK_QUERY_PATTERN.search(query_text):
        return "task", explicit_route
    if REFERENCE_QUERY_PATTERN.search(query_text):
        return "reference", explicit_route
    if DURABLE_QUERY_PATTERN.search(query_text):
        return "durable", explicit_route
    return "mixed", explicit_route


def build_query_route(query: str, parsed: Dict[str, object]) -> Dict[str, object]:
    intent, explicit_route = classify_query_intent(query, parsed)
    layer_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"durable": 1.0, "session": 1.0, "event": 0.96, "task": 1.0},
        "durable": {"durable": 1.35, "session": 0.94, "event": 0.82, "task": 0.72},
        "task": {"durable": 0.76, "session": 0.92, "event": 0.84, "task": 1.35},
        "recent": {"durable": 0.8, "session": 1.16, "event": 1.35, "task": 0.96},
        "reference": {"durable": 1.18, "session": 0.92, "event": 0.82, "task": 0.9},
    }
    scope_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"user": 1.06, "feedback": 1.04, "project": 1.03, "reference": 1.03, "summary": 1.0, "task": 0.98, "run": 0.98},
        "durable": {"user": 1.22, "feedback": 1.18, "project": 1.1, "reference": 1.12, "summary": 0.88, "task": 0.76, "run": 0.72},
        "task": {"user": 0.88, "feedback": 0.94, "project": 1.08, "reference": 0.96, "summary": 0.92, "task": 1.2, "run": 1.24},
        "recent": {"user": 0.92, "feedback": 0.96, "project": 1.0, "reference": 0.94, "summary": 1.06, "task": 1.02, "run": 1.04},
        "reference": {"user": 0.92, "feedback": 0.96, "project": 1.14, "reference": 1.28, "summary": 0.9, "task": 0.9, "run": 0.88},
    }
    source_kind_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"writeback": 1.04, "session": 1.0, "hook": 0.98, "blackboard": 1.0, "run": 1.02, "cron": 1.01},
        "durable": {"writeback": 1.12, "session": 1.02, "hook": 0.9, "blackboard": 0.84, "run": 0.82, "cron": 0.8},
        "task": {"writeback": 0.86, "session": 0.96, "hook": 0.88, "blackboard": 1.16, "run": 1.18, "cron": 1.12},
        "recent": {"writeback": 0.96, "session": 1.08, "hook": 1.14, "blackboard": 1.0, "run": 1.02, "cron": 1.04},
        "reference": {"writeback": 1.06, "session": 0.98, "hook": 0.9, "blackboard": 0.9, "run": 0.9, "cron": 0.9},
    }
    freshness_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"hot": 1.02, "warm": 1.0, "cold": 0.98, "unknown": 1.0},
        "durable": {"hot": 1.01, "warm": 1.0, "cold": 1.0, "unknown": 1.0},
        "task": {"hot": 1.1, "warm": 1.04, "cold": 0.96, "unknown": 0.98},
        "recent": {"hot": 1.12, "warm": 1.05, "cold": 0.92, "unknown": 0.96},
        "reference": {"hot": 1.0, "warm": 1.0, "cold": 0.99, "unknown": 1.0},
    }

    effective_layer_weights = dict(layer_weights.get(intent, layer_weights["mixed"]))
    effective_scope_weights = dict(scope_weights.get(intent, scope_weights["mixed"]))
    effective_source_kind_weights = dict(source_kind_weights.get(intent, source_kind_weights["mixed"]))
    effective_freshness_weights = dict(freshness_weights.get(intent, freshness_weights["mixed"]))

    if bool(parsed.get("prefer_summaries")):
        effective_scope_weights["summary"] = effective_scope_weights.get("summary", 1.0) + 0.08
        effective_layer_weights["session"] = effective_layer_weights.get("session", 1.0) + 0.04

    # 自适应混合权重：根据查询类型动态调整 BM25/Dense 权重
    query_text = normalize_spaces(query).lower()
    qt, signal_scores = analyze_query_type(query_text)
    bm25_w, dense_w = compute_adaptive_blend_weights(qt)

    return {
        "intent": intent,
        "explicitRoute": explicit_route,
        "layerWeights": effective_layer_weights,
        "scopeWeights": effective_scope_weights,
        "sourceKindWeights": effective_source_kind_weights,
        "freshnessWeights": effective_freshness_weights,
        # 自适应路由
        "adaptiveBlend": {
            "queryType": qt,
            "bm25Weight": bm25_w,
            "denseWeight": dense_w,
            "signalScores": signal_scores,
        },
    }
