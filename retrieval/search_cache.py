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
    cached = _SEARCH_RESULT_CACHE.get(cache_key)
    if cached is None:
        _CACHE_METRICS["searchResultMisses"] = int(_CACHE_METRICS["searchResultMisses"]) + 1
        return None

    _CACHE_METRICS["searchResultHits"] = int(_CACHE_METRICS["searchResultHits"]) + 1
    return clone_json_payload(cached.get("response", {}))


def store_search_result(cache_key: str, payload: Dict[str, object]) -> None:
    _SEARCH_RESULT_CACHE[cache_key] = {
        "created_at": time_module.time(),
        "response": clone_json_payload(payload),
    }
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)
