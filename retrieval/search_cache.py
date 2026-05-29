"""
search_cache: Cache strategy — TTL eviction, LRU limits, metrics, and key generation.

Split from retrieval/semantic-search.py (original ~2117 lines) — see
retrieval/REFACTOR-NOTES.md for the full refactoring plan.
"""

from __future__ import annotations

import hashlib
import json
import time as time_module
from typing import Dict, Optional

from search_ranking import (
    normalize_spaces,
    prune_timed_cache,
    _QUERY_EMBEDDING_CACHE,
    _SEARCH_RESULT_CACHE,
    _BM25_CACHE,
    _CACHE_METRICS,
)

from embedding_providers import get_transformer_model_name

from search_index import (
    build_structured_signature,
    build_embeddings_signature,
    _ENTRIES_CACHE,
    _INDEX_CACHE,
    load_embeddings_index,
)


# ---------------------------------------------------------------------------
# SQLite persistent cache (lazy-initialized)
# ---------------------------------------------------------------------------

_SQLITE_CACHE = None  # type: Optional["SqliteSearchCache"]
_SQLITE_CACHE_INIT = False


def _get_sqlite_cache():
    """
    Lazily initialize the SQLite persistent cache.
    Returns None if the cache cannot be created (permissions, missing dirs, etc.)
    so that the system degrades gracefully to in-memory only.
    """
    global _SQLITE_CACHE, _SQLITE_CACHE_INIT
    if _SQLITE_CACHE_INIT:
        return _SQLITE_CACHE
    _SQLITE_CACHE_INIT = True

    # Resolve cache directory from the same canonical store root as search_index.
    import os
    try:
        from runtime_support import resolve_store_root
        store_root = str(resolve_store_root())
    except Exception:
        store_root = (
            os.environ.get("AI_MEMORY_STORE")
            or os.environ.get("AI_MEMORY_STORE_ROOT")
            or os.environ.get("AI_MEMORY_ROOT")
            or os.path.join(os.path.expanduser("~"), ".ai-memory")
        )
    cache_dir = os.path.join(store_root, "cache")

    try:
        from cache.sqlite_cache import SqliteSearchCache
    except ImportError:
        # Also support direct execution from retrieval/ directory
        try:
            from retrieval.cache.sqlite_cache import SqliteSearchCache
        except ImportError:
            return None

    try:
        sqlite_cache = SqliteSearchCache(cache_dir)
        # Cleanup expired entries on startup
        removed = sqlite_cache.cleanup_expired()
        if removed > 0:
            import sys
            sys.stderr.write(f"[search_cache] cleaned {removed} expired SQLite entries\n")
        # Attempt warm — get_warm_queries reads from SQLite itself (no-op on cold DB)
        try:
            from retrieval.cache.warm_strategy import get_warm_queries, warm_cache
            recent = get_warm_queries(cache_dir, max_queries=10)
            if recent:
                warm_cache(sqlite_cache, recent, timeout_seconds=10)
        except Exception:
            pass
        _SQLITE_CACHE = sqlite_cache
        return _SQLITE_CACHE
    except Exception:
        return None


def close_sqlite_cache():
    """Close the SQLite connection. Call on graceful server shutdown."""
    global _SQLITE_CACHE, _SQLITE_CACHE_INIT
    if _SQLITE_CACHE is not None:
        try:
            _SQLITE_CACHE.close()
        except Exception:
            pass
    _SQLITE_CACHE = None
    _SQLITE_CACHE_INIT = False


# ---------------------------------------------------------------------------
# Cache TTL / limit settings (override defaults from search_ranking)
# ---------------------------------------------------------------------------

_QUERY_EMBEDDING_CACHE_TTL = 600.0
_SEARCH_RESULT_CACHE_TTL = 300.0
_QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 128
_SEARCH_RESULT_CACHE_MAX_ENTRIES = 128
_BM25_CACHE_TTL = 600.0
_BM25_CACHE_MAX_ENTRIES = 8


# ---------------------------------------------------------------------------
# Cache state / metrics
# ---------------------------------------------------------------------------

def build_cache_state(
    search_result_cache_hit: bool = False,
    query_embedding_cache_hit: bool = False,
) -> Dict[str, object]:
    # Import here to avoid issues with _QUERY_EMBEDDING_CACHE sharing
    from search_ranking import _QUERY_EMBEDDING_CACHE, BM25Okapi, jieba

    prune_timed_cache(_QUERY_EMBEDDING_CACHE, _QUERY_EMBEDDING_CACHE_TTL, _QUERY_EMBEDDING_CACHE_MAX_ENTRIES)
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)
    prune_timed_cache(_BM25_CACHE, _BM25_CACHE_TTL, _BM25_CACHE_MAX_ENTRIES)
    current_structured_signature = build_structured_signature()
    current_embeddings_signature = build_embeddings_signature()

    sqlite_stats: Dict[str, object] = {}
    sqlite_cache = _get_sqlite_cache()
    if sqlite_cache is not None:
        try:
            sqlite_stats = sqlite_cache.stats()
        except Exception:
            sqlite_stats = {"available": False}

    return {
        "entryCacheVersion": int(_ENTRIES_CACHE.get("version", 0)),
        "structuredSignature": current_structured_signature,
        "embeddingsSignature": current_embeddings_signature,
        "bm25CacheEntries": len(_BM25_CACHE),
        "queryEmbeddingCacheEntries": len(_QUERY_EMBEDDING_CACHE),
        "searchResultCacheEntries": len(_SEARCH_RESULT_CACHE),
        "transformerModel": get_transformer_model_name(),
        "bm25Available": BM25Okapi is not None,
        "jiebaAvailable": jieba is not None,
        "queryEmbeddingCacheHit": bool(query_embedding_cache_hit),
        "searchResultCacheHit": bool(search_result_cache_hit),
        "sqliteCache": sqlite_stats,
        "metrics": {
            "queryEmbeddingHits": int(_CACHE_METRICS["queryEmbeddingHits"]),
            "queryEmbeddingMisses": int(_CACHE_METRICS["queryEmbeddingMisses"]),
            "searchResultHits": int(_CACHE_METRICS["searchResultHits"]),
            "searchResultMisses": int(_CACHE_METRICS["searchResultMisses"]),
        },
    }


def clear_search_runtime_caches(include_data_caches: bool = False) -> Dict[str, object]:
    _BM25_CACHE.clear()
    _QUERY_EMBEDDING_CACHE.clear()
    _SEARCH_RESULT_CACHE.clear()
    _CACHE_METRICS["queryEmbeddingHits"] = 0
    _CACHE_METRICS["queryEmbeddingMisses"] = 0
    _CACHE_METRICS["searchResultHits"] = 0
    _CACHE_METRICS["searchResultMisses"] = 0

    if include_data_caches:
        _ENTRIES_CACHE["data"] = None
        _ENTRIES_CACHE["loaded_at"] = 0.0
        _ENTRIES_CACHE["signature"] = ""
        _ENTRIES_CACHE["version"] = int(_ENTRIES_CACHE.get("version", 0)) + 1
        _INDEX_CACHE["data"] = None
        _INDEX_CACHE["loaded_at"] = 0.0
        _INDEX_CACHE["signature"] = ""

    return build_cache_state(search_result_cache_hit=False, query_embedding_cache_hit=False)


# ---------------------------------------------------------------------------
# Search result cache
# ---------------------------------------------------------------------------

def clone_json_payload(payload: Dict[str, object]) -> Dict[str, object]:
    return json.loads(json.dumps(payload, ensure_ascii=False))


def build_search_result_cache_key(
    parsed: Dict[str, object],
    entries_signature: str,
    embeddings_signature: str,
) -> str:
    # Deferred import to avoid circular dependency with semantic_search.py
    from semantic_search import EMBEDDING_RUNTIME, build_embedding_runtime_summary
    from embedding_providers import build_embedding_config_hash, DEFAULT_MODEL

    runtime_backend = str(EMBEDDING_RUNTIME.get("adapter", EMBEDDING_RUNTIME.get("backend", ""))).strip()
    runtime_model = str(EMBEDDING_RUNTIME.get("model", "")).strip()
    runtime_hash = build_embedding_config_hash(
        runtime_backend,
        runtime_model,
        str(EMBEDDING_RUNTIME.get("baseUrl", "")),
    )
    payload_dict = {
        "request": parsed,
        "entriesSignature": entries_signature,
        "embeddingsSignature": embeddings_signature,
        "runtimeHash": runtime_hash,
    }
    return hashlib.sha1(
        json.dumps(payload_dict, ensure_ascii=False, sort_keys=True).encode("utf-8", errors="ignore")
    ).hexdigest()


def get_cached_search_result(cache_key: str) -> Optional[Dict[str, object]]:
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)

    # 1. Check in-memory cache first (fast path)
    cached = _SEARCH_RESULT_CACHE.get(cache_key)
    if cached is not None:
        _CACHE_METRICS["searchResultHits"] = int(_CACHE_METRICS["searchResultHits"]) + 1
        return clone_json_payload(cached.get("response", {}))

    # 2. Fall back to SQLite persistent cache
    sqlite_cache = _get_sqlite_cache()
    if sqlite_cache is not None:
        result = sqlite_cache.get(cache_key)
        if result is not None:
            # Promote to in-memory cache
            _SEARCH_RESULT_CACHE[cache_key] = {
                "created_at": time_module.time(),
                "response": clone_json_payload(result),
            }
            _CACHE_METRICS["searchResultHits"] = int(_CACHE_METRICS["searchResultHits"]) + 1
            # Re-prune to enforce in-memory size limit
            prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)
            return result

    _CACHE_METRICS["searchResultMisses"] = int(_CACHE_METRICS["searchResultMisses"]) + 1
    return None


def store_search_result(cache_key: str, payload: Dict[str, object], route: str = "") -> None:
    """Store search result in both in-memory and SQLite caches."""
    cloned = clone_json_payload(payload)
    now = time_module.time()

    # Store in in-memory cache
    _SEARCH_RESULT_CACHE[cache_key] = {
        "created_at": now,
        "response": cloned,
    }
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)

    # Store in SQLite persistent cache (async-safe, non-blocking on errors)
    sqlite_cache = _get_sqlite_cache()
    if sqlite_cache is not None:
        try:
            # Compute a rough score from payload for the SQLite record
            score = float(payload.get("totalScore", payload.get("score", 0.0)))
            sqlite_cache.set(
                cache_key=cache_key,
                query=str(payload.get("query", "")),
                route=route,
                result=cloned,
                score=score,
                ttl_seconds=604800,  # 7 days for SQLite
            )
        except Exception:
            pass
