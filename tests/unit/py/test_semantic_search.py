"""
Pytest tests for retrieval/semantic-search.py

Tests pure functions: classify_query_intent, normalize_request_payload,
build_query_embedding_cache_key, build_bm25_cache_key, and parse_args.

After the split into submodules, semantic_search imports from search_ranking,
search_index, search_cache, and search_server. We must load those first and
inject them into sys.modules so semantic_search finds them.
"""

import os
import sys
import pytest
from unittest.mock import patch
import importlib.util

# Load submodules in dependency order, inject into sys.modules so that
# semantic_search (which imports them) can find them.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(_SCRIPT_DIR)))
_RETRIEVAL_DIR = os.path.join(_PROJECT_ROOT, "retrieval")

# Shared namespace for inter-module references
_ns: dict = {}

# 1. search_ranking — no dependencies on the other new modules
# Guard: reuse any already-loaded instance so that other test-file module-level
# cache references (e.g. in test_search_index.py) remain valid.
if "search_ranking" in sys.modules:
    _ns["search_ranking"] = sys.modules["search_ranking"]
else:
    _spec_rank = importlib.util.spec_from_file_location("search_ranking", os.path.join(_RETRIEVAL_DIR, "search_ranking.py"))
    assert _spec_rank and _spec_rank.loader
    _ns["search_ranking"] = importlib.util.module_from_spec(_spec_rank)
    _spec_rank.loader.exec_module(_ns["search_ranking"])
    sys.modules["search_ranking"] = _ns["search_ranking"]

# 2. search_index — depends on search_ranking (guard against re-execution)
if "search_index" in sys.modules:
    _ns["search_index"] = sys.modules["search_index"]
else:
    _spec_idx = importlib.util.spec_from_file_location("search_index", os.path.join(_RETRIEVAL_DIR, "search_index.py"))
    assert _spec_idx and _spec_idx.loader
    _ns["search_index"] = importlib.util.module_from_spec(_spec_idx)
    _spec_idx.loader.exec_module(_ns["search_index"])
    sys.modules["search_index"] = _ns["search_index"]

# 3. search_cache — depends on search_ranking and search_index (guard against re-execution)
if "search_cache" in sys.modules:
    _ns["search_cache"] = sys.modules["search_cache"]
else:
    _spec_cache = importlib.util.spec_from_file_location("search_cache", os.path.join(_RETRIEVAL_DIR, "search_cache.py"))
    assert _spec_cache and _spec_cache.loader
    _ns["search_cache"] = importlib.util.module_from_spec(_spec_cache)
    _spec_cache.loader.exec_module(_ns["search_cache"])
    sys.modules["search_cache"] = _ns["search_cache"]

# 4. search_server — depends on all above + semantic_search (deferred) (guard against re-execution)
if "search_server" in sys.modules:
    _ns["search_server"] = sys.modules["search_server"]
else:
    _spec_srv = importlib.util.spec_from_file_location("search_server", os.path.join(_RETRIEVAL_DIR, "search_server.py"))
    assert _spec_srv and _spec_srv.loader
    _ns["search_server"] = importlib.util.module_from_spec(_spec_srv)
    _spec_srv.loader.exec_module(_ns["search_server"])
    sys.modules["search_server"] = _ns["search_server"]

# 5. semantic_search — imports from all submodules
_SEMANTIC_PATH = os.path.join(_RETRIEVAL_DIR, "semantic_search.py")
_semantic_search_module = importlib.util.module_from_spec(
    importlib.util.spec_from_file_location("semantic_search", _SEMANTIC_PATH)
)
assert _semantic_search_module.__spec__
_semantic_search_module.__spec__.loader.exec_module(_semantic_search_module)

from retrieval.embedding_providers import normalize_embedding_adapter

# Import what we need from the loaded module
classify_query_intent = _semantic_search_module.classify_query_intent
normalize_request_payload = _semantic_search_module.normalize_request_payload
build_query_embedding_cache_key = _semantic_search_module.build_query_embedding_cache_key
build_bm25_cache_key = _semantic_search_module.build_bm25_cache_key
parse_args = _semantic_search_module.parse_args


# ---------------------------------------------------------------------------
# classify_query_intent tests
# ---------------------------------------------------------------------------

class TestClassifyQueryIntent:
    """Tests for classify_query_intent function."""

    def test_explicit_route_takes_priority(self):
        """Explicit route in parsed dict should take priority."""
        intent, explicit = classify_query_intent("test query", {"route": "task"})
        assert intent == "task"
        assert explicit == "task"

    def test_task_related_query_routes_to_task(self):
        """Task-related queries should route to 'task'."""
        # Uses TASK_QUERY_PATTERN which matches: issue, pr, run, job, cron, queue, etc.
        # Note: "run" alone triggers task routing
        intent, explicit = classify_query_intent("run the pipeline job", {})
        assert intent == "task"

    def test_reference_query_routes_to_reference(self):
        """Reference-related queries should route to 'reference'."""
        # Uses REFERENCE_QUERY_PATTERN which matches: path, url, link, reference, doc, docs, file
        intent, explicit = classify_query_intent("show me the docs", {})
        assert intent == "reference"

    def test_durable_query_routes_to_durable(self):
        """Durable/persistent queries should route to 'durable'."""
        # Uses DURABLE_QUERY_PATTERN which matches: preference, rule, workflow, durable, global, remember
        intent, explicit = classify_query_intent("remember my preferences", {})
        assert intent == "durable"

    def test_recent_query_routes_to_recent(self):
        """Recent/latest queries should route to 'recent'."""
        # Uses RECENT_QUERY_PATTERN which matches: latest, recent, newest, today, etc.
        intent, explicit = classify_query_intent("show me the latest items", {})
        assert intent == "recent"

    def test_mixed_query_falls_back_to_mixed(self):
        """Queries without clear intent should default to 'mixed'."""
        intent, explicit = classify_query_intent("hello world", {})
        assert intent == "mixed"
        assert explicit == ""

    def test_source_kind_task_overrides(self):
        """source_kind='task' should route to task regardless of query text."""
        intent, explicit = classify_query_intent("hello", {"source_kind": "task"})
        assert intent == "task"

    def test_scope_reference_overrides(self):
        """scope='reference' should route to reference regardless of query text."""
        intent, explicit = classify_query_intent("hello world", {"scope": "reference"})
        assert intent == "reference"

    def test_scope_durable_overrides(self):
        """scope in DURABLE_SCOPES should route to durable (except reference which has its own route)."""
        for scope in {"user", "feedback", "project"}:
            intent, explicit = classify_query_intent("test", {"scope": scope})
            assert intent == "durable", f"scope={scope} should route to durable"

    def test_scope_reference_routes_to_reference(self):
        """scope=reference should route to reference (not durable)."""
        intent, explicit = classify_query_intent("test", {"scope": "reference"})
        assert intent == "reference"

    def test_chinese_recent_pattern(self):
        """Chinese 'recent' patterns should be recognized."""
        # 最新, 最近, 刚刚, 今天 are in RECENT_QUERY_PATTERN
        intent, explicit = classify_query_intent("最新的任务是什么", {})
        assert intent == "recent"

    def test_chinese_task_pattern(self):
        """Chinese task patterns should be recognized."""
        # 任务, 工单, 队列 are in TASK_QUERY_PATTERN
        intent, explicit = classify_query_intent("查找工单状态", {})
        assert intent == "task"

    def test_empty_query_defaults_to_mixed(self):
        """Empty query should default to 'mixed'."""
        intent, explicit = classify_query_intent("", {})
        assert intent == "mixed"


# ---------------------------------------------------------------------------
# normalize_request_payload tests
# ---------------------------------------------------------------------------

class TestNormalizeRequestPayload:
    """Tests for normalize_request_payload function."""

    def test_basic_mode_normalization(self):
        """Mode 'bm25' should normalize correctly."""
        result = normalize_request_payload({"query": "test", "mode": "bm25"})
        assert result["mode"] == "bm25"

    def test_auto_normalizes_to_hybrid(self):
        """Mode 'auto' should normalize to 'hybrid'."""
        result = normalize_request_payload({"query": "test", "mode": "auto"})
        assert result["mode"] == "hybrid"

    def test_dense_mode_normalizes_correctly(self):
        """Mode 'dense' should normalize correctly."""
        result = normalize_request_payload({"query": "test", "mode": "dense"})
        assert result["mode"] == "dense"

    def test_hybrid_mode_normalizes_correctly(self):
        """Mode 'hybrid' should normalize correctly."""
        result = normalize_request_payload({"query": "test", "mode": "hybrid"})
        assert result["mode"] == "hybrid"

    def test_invalid_mode_defaults_to_hybrid(self):
        """Invalid mode should default to 'hybrid'."""
        result = normalize_request_payload({"query": "test", "mode": "invalid_mode"})
        assert result["mode"] == "hybrid"

    def test_top_k_parameter(self):
        """top_k should be extracted and normalized."""
        result = normalize_request_payload({"query": "test", "top_k": 5})
        assert result["top_k"] == 5

    def test_top_k_with_camel_case(self):
        """topK (camelCase) should be recognized."""
        result = normalize_request_payload({"query": "test", "topK": 15})
        assert result["top_k"] == 15

    def test_route_parameter(self):
        """route should be extracted."""
        result = normalize_request_payload({"query": "test", "route": "task"})
        assert result["route"] == "task"

    def test_intent_alias_for_route(self):
        """intent should be aliased to route."""
        result = normalize_request_payload({"query": "test", "intent": "recent"})
        assert result["route"] == "recent"

    def test_invalid_route_defaults_to_auto(self):
        """Invalid route should default to 'auto'."""
        result = normalize_request_payload({"query": "test", "route": "invalid"})
        assert result["route"] == "auto"

    def test_prefer_summaries_normalized(self):
        """prefer_summaries should be boolean."""
        result = normalize_request_payload({"query": "test", "prefer_summaries": True})
        assert result["prefer_summaries"] is True

    def test_prefer_summaries_false_normalized(self):
        """prefer_summaries=False should remain False."""
        result = normalize_request_payload({"query": "test", "prefer_summaries": False})
        assert result["prefer_summaries"] is False

    def test_mmr_config_extracted(self):
        """MMR configuration should be extracted."""
        result = normalize_request_payload({
            "query": "test",
            "mmr": {"enabled": True, "lambda": 0.6}
        })
        assert result["mmr_enabled"] is True
        assert result["mmr_lambda"] == 0.6

    def test_mmr_lambda_clamped_to_valid_range(self):
        """MMR lambda should be clamped to [0, 1]."""
        result = normalize_request_payload({
            "query": "test",
            "mmr": {"lambda": 1.5}
        })
        assert result["mmr_lambda"] == 1.0

    def test_temporal_decay_config_extracted(self):
        """Temporal decay configuration should be extracted."""
        result = normalize_request_payload({
            "query": "test",
            "temporal_decay": {"enabled": True, "half_life_days": 15}
        })
        assert result["temporal_decay"]["enabled"] is True
        assert result["temporal_decay"]["half_life_days"] == 15

    def test_query_required(self):
        """Empty query should raise ValueError."""
        with pytest.raises(ValueError, match="query is required"):
            normalize_request_payload({})

    def test_scope_extracted(self):
        """scope should be extracted from payload."""
        result = normalize_request_payload({"query": "test", "scope": "user"})
        assert result["scope"] == "user"


# ---------------------------------------------------------------------------
# build_query_embedding_cache_key tests
# ---------------------------------------------------------------------------

class TestBuildQueryEmbeddingCacheKey:
    """Tests for build_query_embedding_cache_key function."""

    def test_same_inputs_produce_same_key(self):
        """Identical inputs must always produce the same cache key."""
        key1 = build_query_embedding_cache_key("test query", "hash", "all-MiniLM-L6-v2", "")
        key2 = build_query_embedding_cache_key("test query", "hash", "all-MiniLM-L6-v2", "")
        assert key1 == key2

    def test_different_query_produces_different_key(self):
        """Different queries must produce different cache keys."""
        key1 = build_query_embedding_cache_key("query one", "hash", "model", "")
        key2 = build_query_embedding_cache_key("query two", "hash", "model", "")
        assert key1 != key2

    def test_different_adapter_produces_different_key(self):
        """Different adapters must produce different cache keys."""
        key1 = build_query_embedding_cache_key("test", "hash", "model", "")
        key2 = build_query_embedding_cache_key("test", "openai-compatible", "model", "")
        assert key1 != key2

    def test_different_model_produces_different_key(self):
        """Different models must produce different cache keys."""
        key1 = build_query_embedding_cache_key("test", "hash", "model1", "")
        key2 = build_query_embedding_cache_key("test", "hash", "model2", "")
        assert key1 != key2

    def test_different_base_url_produces_different_key(self):
        """Different base URLs must produce different cache keys."""
        key1 = build_query_embedding_cache_key("test", "openai-compatible", "model", "https://api.a.com")
        key2 = build_query_embedding_cache_key("test", "openai-compatible", "model", "https://api.b.com")
        assert key1 != key2

    def test_base_url_trailing_slash_normalized(self):
        """Base URL trailing slashes should be normalized."""
        key1 = build_query_embedding_cache_key("test", "openai-compatible", "model", "https://api.test.com/")
        key2 = build_query_embedding_cache_key("test", "openai-compatible", "model", "https://api.test.com")
        assert key1 == key2

    def test_key_is_sha1_hex(self):
        """Cache key should be a SHA-1 hex string."""
        key = build_query_embedding_cache_key("test", "hash", "model", "")
        assert len(key) == 40
        assert all(c in "0123456789abcdef" for c in key)


# ---------------------------------------------------------------------------
# build_bm25_cache_key tests
# ---------------------------------------------------------------------------

class TestBuildBm25CacheKey:
    """Tests for build_bm25_cache_key function."""

    def test_same_inputs_produce_same_key(self):
        """Identical inputs must produce the same cache key."""
        key1 = build_bm25_cache_key({"tool": "claude"}, 100)
        key2 = build_bm25_cache_key({"tool": "claude"}, 100)
        assert key1 == key2

    def test_different_filters_produce_different_key(self):
        """Different filters must produce different cache keys."""
        key1 = build_bm25_cache_key({"tool": "claude"}, 100)
        key2 = build_bm25_cache_key({"tool": "other"}, 100)
        assert key1 != key2

    def test_different_entry_count_produces_different_key(self):
        """Different entry counts must produce different cache keys."""
        key1 = build_bm25_cache_key({}, 100)
        key2 = build_bm25_cache_key({}, 200)
        assert key1 != key2

    def test_key_format_is_pipe_separated(self):
        """Cache key should be pipe-separated values."""
        key = build_bm25_cache_key({"tool": "test", "scope": "user"}, 50)
        assert "|" in key

    def test_multiple_filters_all_affect_key(self):
        """All filter values should contribute to the key."""
        key1 = build_bm25_cache_key({"tool": "a", "scope": "b"}, 10)
        key2 = build_bm25_cache_key({"tool": "a", "scope": "c"}, 10)
        key3 = build_bm25_cache_key({"tool": "b", "scope": "b"}, 10)
        # All three should be different
        assert len({key1, key2, key3}) == 3


# ---------------------------------------------------------------------------
# parse_args tests
# ---------------------------------------------------------------------------

class TestParseArgs:
    """Tests for parse_args function."""

    def test_basic_query_parsing(self):
        """Basic query string should be parsed correctly."""
        with patch.object(sys, "argv", ["semantic-search.py", "test query"]):
            result = parse_args()
            assert result["query"] == "test query"
            assert result["mode"] == "bm25"
            assert result["top_k"] == 10

    def test_mode_flag_normalized(self):
        """--mode flag should set the mode."""
        with patch.object(sys, "argv", ["semantic-search.py", "--mode", "hybrid", "test"]):
            result = parse_args()
            assert result["mode"] == "hybrid"

    def test_route_flag(self):
        """--route flag should set the route."""
        with patch.object(sys, "argv", ["semantic-search.py", "--route", "task", "test"]):
            result = parse_args()
            assert result["route"] == "task"

    def test_top_k_flag(self):
        """--top-k flag should set top_k."""
        with patch.object(sys, "argv", ["semantic-search.py", "--top-k", "20", "test"]):
            result = parse_args()
            assert result["top_k"] == 20

    def test_json_flag(self):
        """--json flag should enable JSON output (stored in args.json which maps to include_verbatim)."""
        with patch.object(sys, "argv", ["semantic-search.py", "--json", "test"]):
            result = parse_args()
            assert "include_verbatim" in result

    def test_prefer_summaries_flag(self):
        """--prefer-summaries flag should enable prefer_summaries."""
        with patch.object(sys, "argv", ["semantic-search.py", "--prefer-summaries", "test"]):
            result = parse_args()
            assert result["prefer_summaries"] is True

    def test_legacy_positional_topk(self):
        """Legacy positional [topK] format should work."""
        with patch.object(sys, "argv", ["semantic-search.py", "test", "5"]):
            result = parse_args()
            assert result["query"] == "test"
            assert result["top_k"] == 5

    def test_legacy_positional_strategy(self):
        """Legacy positional [strategy] format should work."""
        with patch.object(sys, "argv", ["semantic-search.py", "test", "dense"]):
            result = parse_args()
            assert result["query"] == "test"
            assert result["mode"] == "dense"

    def test_combined_topk_and_strategy(self):
        """Combined [topK] [strategy] format should work."""
        with patch.object(sys, "argv", ["semantic-search.py", "test", "15", "hybrid"]):
            result = parse_args()
            assert result["query"] == "test"
            assert result["top_k"] == 15
            assert result["mode"] == "hybrid"

    def test_server_mode(self):
        """--server flag should trigger server mode."""
        with patch.object(sys, "argv", ["semantic-search.py", "--server"]):
            result = parse_args()
            assert result.get("server") is True


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Tests for edge cases across all functions."""

    def test_empty_query_string_raises(self):
        """Empty query string should raise ValueError."""
        with pytest.raises(ValueError, match="query is required"):
            normalize_request_payload({"query": ""})

    def test_none_values_in_payload(self):
        """None values should be handled gracefully."""
        result = normalize_request_payload({
            "query": "test",
            "mode": None,
            "top_k": None,
        })
        # Should use defaults for None values
        assert result["mode"] in {"bm25", "dense", "hybrid"}
        assert result["top_k"] >= 1

    def test_whitespace_query_normalized(self):
        """Query with extra whitespace should be normalized."""
        with patch.object(sys, "argv", ["semantic-search.py", "  test   query  "]):
            result = parse_args()
            assert "test" in result["query"]
            assert "  " not in result["query"]

    def test_cache_key_with_none_base_url(self):
        """Cache key should handle None base_url."""
        key = build_query_embedding_cache_key("test", "hash", "model", None)
        assert isinstance(key, str)
        assert len(key) > 0

    def test_intent_with_empty_parsed(self):
        """Intent classification should handle empty parsed dict."""
        intent, explicit = classify_query_intent("test", {})
        assert intent in {"mixed", "task", "reference", "durable", "recent"}
        assert explicit == ""
