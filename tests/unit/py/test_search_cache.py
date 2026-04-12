"""
Pytest tests for retrieval/search_cache.py

Tests cache TTL eviction, LRU limit enforcement, cache key generation,
cache hit/miss metrics, and build_cache_state.
"""

import os
import sys
import time
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Ensure retrieval/ is on path
_test_file = Path(__file__).resolve()
_project_root = _test_file.parent.parent.parent.parent  # repo root
_retrieval_dir = _project_root / "retrieval"
for p in [str(_project_root), str(_retrieval_dir)]:
    if p not in sys.path:
        sys.path.insert(0, p)

import importlib.util

# Load dependencies in order (shared namespace for inter-module references)
_ns: dict = {}

# 1. search_ranking (no dependencies on the other new modules)
_ranking_spec = importlib.util.spec_from_file_location("search_ranking", _retrieval_dir / "search_ranking.py")
assert _ranking_spec and _ranking_spec.loader
_ns["search_ranking"] = importlib.util.module_from_spec(_ranking_spec)
_ranking_spec.loader.exec_module(_ns["search_ranking"])
sys.modules["search_ranking"] = _ns["search_ranking"]

# 2. search_index (depends on search_ranking)
_index_spec = importlib.util.spec_from_file_location("search_index", _retrieval_dir / "search_index.py")
assert _index_spec and _index_spec.loader
_ns["search_index"] = importlib.util.module_from_spec(_index_spec)
_index_spec.loader.exec_module(_ns["search_index"])
sys.modules["search_index"] = _ns["search_index"]

# 3. search_cache (depends on search_ranking and search_index)
_cache_spec = importlib.util.spec_from_file_location("search_cache", _retrieval_dir / "search_cache.py")
assert _cache_spec and _cache_spec.loader
_ns["search_cache"] = importlib.util.module_from_spec(_cache_spec)
_cache_spec.loader.exec_module(_ns["search_cache"])
sys.modules["search_cache"] = _ns["search_cache"]

# Convenience references
_cache_mod = _ns["search_cache"]
_ranking_mod = _ns["search_ranking"]
_index_mod = _ns["search_index"]


# ---------------------------------------------------------------------------
# prune_timed_cache tests
# ---------------------------------------------------------------------------

class TestPruneTimedCache:
    def test_removes_stale_entries(self):
        cache = {
            "k1": {"created_at": time.time() - 1000, "data": "old"},
            "k2": {"created_at": time.time(), "data": "new"},
        }
        _cache_mod.prune_timed_cache(cache, ttl_seconds=600, max_entries=100)
        assert "k1" not in cache
        assert "k2" in cache

    def test_respects_max_entries_lru(self):
        cache = {}
        now = time.time()
        for i in range(20):
            cache[f"k{i}"] = {"created_at": now - i, "data": f"v{i}"}

        _cache_mod.prune_timed_cache(cache, ttl_seconds=10000, max_entries=5)
        # Should keep the 5 most recent (highest created_at)
        assert len(cache) == 5

    def test_empty_cache_no_op(self):
        cache = {}
        _cache_mod.prune_timed_cache(cache, ttl_seconds=600, max_entries=10)
        assert cache == {}

    def test_no_eviction_when_within_limits(self):
        cache = {
            f"k{i}": {"created_at": time.time() - 1, "data": f"v{i}"}
            for i in range(5)
        }
        _cache_mod.prune_timed_cache(cache, ttl_seconds=600, max_entries=10)
        assert len(cache) == 5


# ---------------------------------------------------------------------------
# build_query_embedding_cache_key tests (from search_ranking)
# ---------------------------------------------------------------------------

class TestBuildQueryEmbeddingCacheKey:
    def test_deterministic(self):
        key1 = _ranking_mod.build_query_embedding_cache_key("test", "hash", "model", "")
        key2 = _ranking_mod.build_query_embedding_cache_key("test", "hash", "model", "")
        assert key1 == key2

    def test_different_query_different_key(self):
        key1 = _ranking_mod.build_query_embedding_cache_key("query1", "hash", "model", "")
        key2 = _ranking_mod.build_query_embedding_cache_key("query2", "hash", "model", "")
        assert key1 != key2

    def test_base_url_trailing_slash_stripped(self):
        key1 = _ranking_mod.build_query_embedding_cache_key("test", "openai", "model", "https://api.com/")
        key2 = _ranking_mod.build_query_embedding_cache_key("test", "openai", "model", "https://api.com")
        assert key1 == key2

    def test_is_sha1_hex(self):
        key = _ranking_mod.build_query_embedding_cache_key("test", "hash", "model", "")
        assert len(key) == 40
        assert all(c in "0123456789abcdef" for c in key)

    def test_whitespace_normalized(self):
        key1 = _ranking_mod.build_query_embedding_cache_key("  test  ", "hash", "model", "")
        key2 = _ranking_mod.build_query_embedding_cache_key("test", "hash", "model", "")
        assert key1 == key2


# ---------------------------------------------------------------------------
# get_cached_query_embedding / store_query_embedding tests (from search_ranking)
# ---------------------------------------------------------------------------

class TestQueryEmbeddingCache:
    def setup_method(self):
        # Reset the cache before each test
        _ranking_mod._QUERY_EMBEDDING_CACHE.clear()
        _ranking_mod._CACHE_METRICS["queryEmbeddingHits"] = 0
        _ranking_mod._CACHE_METRICS["queryEmbeddingMisses"] = 0

    def test_miss_on_empty_cache(self):
        result = _ranking_mod.get_cached_query_embedding("nonexistent_key_abc123")
        assert result is None
        assert _ranking_mod._CACHE_METRICS["queryEmbeddingMisses"] == 1

    def test_hit_returns_embedding(self):
        key = "test_key_abc"
        embedding = [0.1, 0.2, 0.3]
        _ranking_mod.store_query_embedding(key, embedding)

        result = _ranking_mod.get_cached_query_embedding(key)
        assert result == embedding
        assert _ranking_mod._CACHE_METRICS["queryEmbeddingHits"] == 1

    def test_stores_correct_structure(self):
        key = "struct_key_xyz"
        embedding = [0.5, 0.6]
        _ranking_mod.store_query_embedding(key, embedding)

        stored = _ranking_mod._QUERY_EMBEDDING_CACHE[key]
        assert "created_at" in stored
        assert stored["embedding"] == [0.5, 0.6]


# ---------------------------------------------------------------------------
# build_search_result_cache_key tests
# ---------------------------------------------------------------------------

class TestBuildSearchResultCacheKey:
    def test_is_sha1_hex(self):
        key = _cache_mod.build_search_result_cache_key(
            {"query": "test", "top_k": 5},
            "sig_entries",
            "sig_emb",
        )
        assert len(key) == 40

    def test_different_signatures_different_keys(self):
        key1 = _cache_mod.build_search_result_cache_key(
            {"query": "test"}, "sig1", "sig_emb"
        )
        key2 = _cache_mod.build_search_result_cache_key(
            {"query": "test"}, "sig2", "sig_emb"
        )
        assert key1 != key2

    def test_deterministic(self):
        req = {"query": "test", "mode": "bm25"}
        key1 = _cache_mod.build_search_result_cache_key(req, "A", "B")
        key2 = _cache_mod.build_search_result_cache_key(req, "A", "B")
        assert key1 == key2


# ---------------------------------------------------------------------------
# get_cached_search_result / store_search_result tests
# ---------------------------------------------------------------------------

class TestSearchResultCache:
    def setup_method(self):
        _cache_mod._SEARCH_RESULT_CACHE.clear()
        _cache_mod._CACHE_METRICS["searchResultHits"] = 0
        _cache_mod._CACHE_METRICS["searchResultMisses"] = 0

    def test_miss_on_empty_cache(self):
        result = _cache_mod.get_cached_search_result("nonexistent")
        assert result is None
        assert _cache_mod._CACHE_METRICS["searchResultMisses"] == 1

    def test_hit_returns_response(self):
        key = "sr_key_test"
        response = {"ok": True, "results": [{"id": "a", "score": 0.9}]}
        _cache_mod.store_search_result(key, response)

        result = _cache_mod.get_cached_search_result(key)
        assert result == response
        assert _cache_mod._CACHE_METRICS["searchResultHits"] == 1

    def test_store_copies_payload(self):
        key = "sr_copy_test"
        response = {"ok": True, "count": 5}
        _cache_mod.store_search_result(key, response)

        # Modify original — cached should be unaffected
        response["count"] = 999
        cached = _cache_mod.get_cached_search_result(key)
        assert cached["count"] == 5


# ---------------------------------------------------------------------------
# clear_search_runtime_caches tests
# ---------------------------------------------------------------------------

class TestClearSearchRuntimeCaches:
    def setup_method(self):
        # Clear ALL caches to ensure test isolation (defensive — previous test classes
        # may not have cleared query-embed cache).
        _ranking_mod._BM25_CACHE.clear()
        _ranking_mod._QUERY_EMBEDDING_CACHE.clear()
        _ranking_mod._SEARCH_RESULT_CACHE.clear()
        _ranking_mod._CACHE_METRICS["queryEmbeddingHits"] = 0
        _ranking_mod._CACHE_METRICS["queryEmbeddingMisses"] = 0
        _ranking_mod._CACHE_METRICS["searchResultHits"] = 0
        _ranking_mod._CACHE_METRICS["searchResultMisses"] = 0

    def test_clears_runtime_caches(self):
        _ranking_mod._BM25_CACHE["k1"] = {"model": MagicMock()}
        _ranking_mod._QUERY_EMBEDDING_CACHE["k2"] = {"embedding": [0.1]}
        _cache_mod._SEARCH_RESULT_CACHE["k3"] = {"response": {}}

        result = _cache_mod.clear_search_runtime_caches(include_data_caches=False)

        assert _ranking_mod._BM25_CACHE == {}
        assert _cache_mod._QUERY_EMBEDDING_CACHE == {}
        assert _cache_mod._SEARCH_RESULT_CACHE == {}
        assert result["bm25CacheEntries"] == 0
        assert result["queryEmbeddingCacheEntries"] == 0
        assert result["searchResultCacheEntries"] == 0

    def test_include_data_caches_flag(self):
        _index_mod._ENTRIES_CACHE["data"] = [{"id": "x"}]
        _index_mod._INDEX_CACHE["data"] = {"y": {}}

        _cache_mod.clear_search_runtime_caches(include_data_caches=True)

        assert _index_mod._ENTRIES_CACHE["data"] is None
        assert _index_mod._INDEX_CACHE["data"] is None

    def test_metrics_reset(self):
        _ranking_mod._CACHE_METRICS["queryEmbeddingHits"] = 5
        _ranking_mod._CACHE_METRICS["searchResultHits"] = 3

        _cache_mod.clear_search_runtime_caches()

        assert _ranking_mod._CACHE_METRICS["queryEmbeddingHits"] == 0
        assert _ranking_mod._CACHE_METRICS["searchResultHits"] == 0


# ---------------------------------------------------------------------------
# build_cache_state tests
# ---------------------------------------------------------------------------

class TestBuildCacheState:
    def setup_method(self):
        _ranking_mod._BM25_CACHE.clear()
        _ranking_mod._QUERY_EMBEDDING_CACHE.clear()
        _cache_mod._SEARCH_RESULT_CACHE.clear()

    def test_returns_dict_with_required_keys(self):
        result = _cache_mod.build_cache_state()
        assert "entryCacheVersion" in result
        assert "structuredSignature" in result
        assert "embeddingsSignature" in result
        assert "bm25CacheEntries" in result
        assert "queryEmbeddingCacheEntries" in result
        assert "searchResultCacheEntries" in result
        assert "transformerModel" in result
        assert "bm25Available" in result
        assert "jiebaAvailable" in result
        assert "metrics" in result

    def test_reflects_hit_flags(self):
        result_hit = _cache_mod.build_cache_state(search_result_cache_hit=True)
        result_miss = _cache_mod.build_cache_state(search_result_cache_hit=False)
        assert result_hit["searchResultCacheHit"] is True
        assert result_miss["searchResultCacheHit"] is False

    def test_metrics_included(self):
        result = _cache_mod.build_cache_state()
        assert "queryEmbeddingHits" in result["metrics"]
        assert "queryEmbeddingMisses" in result["metrics"]
        assert "searchResultHits" in result["metrics"]
        assert "searchResultMisses" in result["metrics"]
