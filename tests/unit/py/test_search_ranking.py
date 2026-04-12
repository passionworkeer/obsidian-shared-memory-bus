"""
Pytest tests for retrieval/search_ranking.py

Tests BM25/dense scoring, normalize_score_map, score_entry, rerank,
apply_field_match_bonus, mmr_rerank, and keyword_overlap_scores.
"""

import os
import sys
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

# Load search_ranking.py
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "search_ranking",
    _retrieval_dir / "search_ranking.py",
)
assert _spec and _spec.loader, "Could not load search_ranking.py"
_search_ranking = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_search_ranking)

# Load semantic_search to access normalize_spaces, tokenize etc.
_sem_spec = importlib.util.spec_from_file_location(
    "semantic_search_module",
    _retrieval_dir / "semantic_search.py",
)
_semantic_search_mod = importlib.util.module_from_spec(_sem_spec)
_sem_spec.loader.exec_module(_semantic_search_mod)


# ---------------------------------------------------------------------------
# Helper: mini entry fixtures
# ---------------------------------------------------------------------------

def make_entry(entry_id, tokens=None, layer="session", scope="summary",
               source_kind="session", freshness="warm", task_state="",
               field="content", title="", description=""):
    return {
        "id": entry_id,
        "record_id": entry_id,
        "tokens": tokens or [],
        "layer": layer,
        "scope": scope,
        "sourceKind": source_kind,
        "freshness": freshness,
        "taskState": task_state,
        "field": field,
        "title": title,
        "description": description,
        "t": "2026-01-01T00:00:00Z",
    }


def make_route(intent="mixed"):
    # Use the actual weights from build_query_route() for each intent
    layer_weights_map = {
        "mixed": {"durable": 1.0, "session": 1.0, "event": 0.96, "task": 1.0},
        "durable": {"durable": 1.35, "session": 0.94, "event": 0.82, "task": 0.72},
        "task": {"durable": 0.76, "session": 0.92, "event": 0.84, "task": 1.35},
        "recent": {"durable": 0.8, "session": 1.16, "event": 1.35, "task": 0.96},
        "reference": {"durable": 1.18, "session": 0.92, "event": 0.82, "task": 0.9},
    }
    scope_weights_map = {
        "mixed": {"user": 1.06, "feedback": 1.04, "project": 1.03, "reference": 1.03, "summary": 1.0, "task": 0.98, "run": 0.98},
        "durable": {"user": 1.22, "feedback": 1.18, "project": 1.1, "reference": 1.12, "summary": 0.88, "task": 0.76, "run": 0.72},
        "task": {"user": 0.88, "feedback": 0.94, "project": 1.08, "reference": 0.96, "summary": 0.92, "task": 1.2, "run": 1.24},
        "recent": {"user": 0.92, "feedback": 0.96, "project": 1.0, "reference": 0.94, "summary": 1.06, "task": 1.02, "run": 1.04},
        "reference": {"user": 0.92, "feedback": 0.96, "project": 1.14, "reference": 1.28, "summary": 0.9, "task": 0.9, "run": 0.88},
    }
    return {
        "intent": intent,
        "explicitRoute": "",
        "layerWeights": layer_weights_map.get(intent, layer_weights_map["mixed"]),
        "scopeWeights": scope_weights_map.get(intent, scope_weights_map["mixed"]),
        "sourceKindWeights": {"writeback": 1.04, "session": 1.0, "hook": 0.98, "blackboard": 1.0, "run": 1.02, "cron": 1.01},
        "freshnessWeights": {"hot": 1.02, "warm": 1.0, "cold": 0.98, "unknown": 1.0},
    }


# ---------------------------------------------------------------------------
# cosine_similarity tests
# ---------------------------------------------------------------------------

class TestCosineSimilarity:
    def test_identical_vectors(self):
        v = [0.5, 0.5, 0.5, 0.5]
        assert _search_ranking.cosine_similarity(v, v) == pytest.approx(1.0)

    def test_orthogonal_vectors(self):
        v1 = [1.0, 0.0]
        v2 = [0.0, 1.0]
        assert _search_ranking.cosine_similarity(v1, v2) == 0.0

    def test_opposite_vectors(self):
        v1 = [1.0, 0.0]
        v2 = [-1.0, 0.0]
        assert _search_ranking.cosine_similarity(v1, v2) == -1.0

    def test_empty_vectors(self):
        assert _search_ranking.cosine_similarity([], []) == 0.0

    def test_mismatched_length(self):
        assert _search_ranking.cosine_similarity([1.0], [1.0, 0.0]) == 0.0

    def test_normalized_returns_1(self):
        v1 = [0.6, 0.8]
        v2 = [0.6, 0.8]
        assert _search_ranking.cosine_similarity(v1, v2) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# normalize_score_map tests
# ---------------------------------------------------------------------------

class TestNormalizeScoreMap:
    def test_empty_map(self):
        assert _search_ranking.normalize_score_map({}) == {}

    def test_single_entry(self):
        result = _search_ranking.normalize_score_map({"a": 10.0})
        assert result == {"a": 1.0}

    def test_multiple_entries_scaled(self):
        result = _search_ranking.normalize_score_map({"a": 10.0, "b": 5.0, "c": 2.5})
        assert result["a"] == pytest.approx(1.0)
        assert result["b"] == pytest.approx(0.5)
        assert result["c"] == pytest.approx(0.25)

    def test_zero_scores_removed(self):
        result = _search_ranking.normalize_score_map({"a": 10.0, "b": 0.0, "c": 5.0})
        assert "b" not in result
        assert result["a"] == 1.0
        assert result["c"] == 0.5

    def test_all_zero(self):
        assert _search_ranking.normalize_score_map({"a": 0.0, "b": 0.0}) == {}


# ---------------------------------------------------------------------------
# task_state_weight tests
# ---------------------------------------------------------------------------

class TestTaskStateWeight:
    def test_empty_state(self):
        assert _search_ranking.task_state_weight("", "mixed") == 1.0

    def test_task_intent_processing(self):
        assert _search_ranking.task_state_weight("processing", "task") == 1.12

    def test_task_intent_active(self):
        assert _search_ranking.task_state_weight("active", "task") == 1.12

    def test_task_intent_pending(self):
        assert _search_ranking.task_state_weight("pending", "task") == 1.12

    def test_task_intent_ok(self):
        assert _search_ranking.task_state_weight("ok", "task") == 1.06

    def test_task_intent_failed(self):
        assert _search_ranking.task_state_weight("failed", "task") == 1.01

    def test_recent_intent_processing(self):
        assert _search_ranking.task_state_weight("processing", "recent") == 1.06

    def test_recent_intent_ok(self):
        assert _search_ranking.task_state_weight("ok", "recent") == 1.04

    def test_mixed_intent_returns_1(self):
        assert _search_ranking.task_state_weight("processing", "mixed") == 1.0


# ---------------------------------------------------------------------------
# score_entry tests
# ---------------------------------------------------------------------------

class TestScoreEntry:
    def test_zero_bm25_and_dense_returns_none(self):
        entry = make_entry("a")
        result = _search_ranking.score_entry(entry, "hybrid", make_route(), {}, {}, None)
        assert result is None

    def test_bm25_mode_uses_only_bm25(self):
        entry = make_entry("a")
        result = _search_ranking.score_entry(entry, "bm25", make_route(), {"a": 1.0}, {"a": 0.5}, None)
        assert result is not None
        score, meta = result
        assert meta["retrievalScore"] == pytest.approx(1.0)

    def test_dense_mode_uses_only_dense(self):
        entry = make_entry("a")
        result = _search_ranking.score_entry(entry, "dense", make_route(), {"a": 0.5}, {"a": 1.0}, None)
        assert result is not None
        score, meta = result
        assert meta["retrievalScore"] == pytest.approx(1.0)

    def test_hybrid_mode_combines(self):
        entry = make_entry("a")
        result = _search_ranking.score_entry(entry, "hybrid", make_route(), {"a": 1.0}, {"a": 1.0}, None)
        assert result is not None
        score, meta = result
        # 0.58 * 1.0 + 0.42 * 1.0 = 1.0
        assert meta["retrievalScore"] == pytest.approx(1.0)

    def test_layer_weight_applied(self):
        entry = make_entry("a", layer="durable")
        route = make_route("durable")
        result = _search_ranking.score_entry(entry, "bm25", route, {"a": 1.0}, {}, None)
        assert result is not None
        score, meta = result
        # durable layer weight for durable intent = 1.35
        assert meta["layerWeight"] == 1.35

    def test_scope_weight_applied(self):
        entry = make_entry("a", scope="user")
        route = make_route("durable")
        result = _search_ranking.score_entry(entry, "bm25", route, {"a": 1.0}, {}, None)
        assert result is not None
        score, meta = result
        # user scope weight for durable intent = 1.22
        assert meta["scopeWeight"] == 1.22

    def test_freshness_weight_applied(self):
        entry = make_entry("a", freshness="hot")
        route = make_route("mixed")
        result = _search_ranking.score_entry(entry, "bm25", route, {"a": 1.0}, {}, None)
        assert result is not None
        score, meta = result
        assert meta["freshnessWeight"] == 1.02

    def test_task_state_weight_applied(self):
        entry = make_entry("a", task_state="processing")
        route = make_route("task")
        result = _search_ranking.score_entry(entry, "bm25", route, {"a": 1.0}, {}, None)
        assert result is not None
        score, meta = result
        assert meta["taskStateWeight"] == 1.12

    def test_hybrid_coverage_bonus_when_both_sources(self):
        entry = make_entry("a")
        result = _search_ranking.score_entry(entry, "hybrid", make_route(), {"a": 1.0}, {"a": 1.0}, None)
        assert result is not None
        score, meta = result
        assert meta["coverageWeight"] == 1.04

    def test_no_coverage_bonus_when_only_one_source(self):
        entry = make_entry("a")
        result = _search_ranking.score_entry(entry, "hybrid", make_route(), {"a": 1.0}, {}, None)
        assert result is not None
        score, meta = result
        assert meta["coverageWeight"] == 1.0

    def test_temporal_decay_applied(self):
        entry = make_entry("a", tokens=["test"])
        entry["t"] = "2026-01-01T00:00:00Z"
        decay = {"enabled": True, "half_life_days": 30}
        result = _search_ranking.score_entry(entry, "bm25", make_route(), {"a": 1.0}, {}, decay)
        assert result is not None
        score, meta = result
        assert 0.0 < meta["decayFactor"] < 1.0

    def test_temporal_decay_disabled(self):
        entry = make_entry("a", tokens=["test"])
        decay = {"enabled": False, "half_life_days": 30}
        result = _search_ranking.score_entry(entry, "bm25", make_route(), {"a": 1.0}, {}, decay)
        assert result is not None
        score, meta = result
        assert meta["decayFactor"] == 1.0


# ---------------------------------------------------------------------------
# apply_field_match_bonus tests
# ---------------------------------------------------------------------------

class TestApplyFieldMatchBonus:
    def test_empty_input(self):
        result = _search_ranking.apply_field_match_bonus([], {}, "")
        assert result == []

    def test_fact_bonus(self):
        entries_by_id = {"a": make_entry("a", field="fact", title="test")}
        scored = [("a", 1.0, {})]
        result = _search_ranking.apply_field_match_bonus(scored, entries_by_id, "test query")
        assert result[0][2]["fieldMatchBonus"] == pytest.approx(1.1)

    def test_concept_bonus(self):
        entries_by_id = {"a": make_entry("a", field="concept", title="test")}
        scored = [("a", 1.0, {})]
        result = _search_ranking.apply_field_match_bonus(scored, entries_by_id, "test query")
        assert result[0][2]["fieldMatchBonus"] == pytest.approx(1.15)

    def test_title_match_bonus(self):
        entries_by_id = {"a": make_entry("a", title="python programming")}
        scored = [("a", 1.0, {})]
        result = _search_ranking.apply_field_match_bonus(scored, entries_by_id, "python programming")
        assert result[0][2]["fieldMatchBonus"] == pytest.approx(1.3)

    def test_description_match_bonus(self):
        entries_by_id = {"a": make_entry("a", description="machine learning")}
        scored = [("a", 1.0, {})]
        result = _search_ranking.apply_field_match_bonus(scored, entries_by_id, "machine learning")
        assert result[0][2]["fieldMatchBonus"] == pytest.approx(1.2)

    def test_combined_bonuses(self):
        # "python programming" title overlaps with query "python programming" (2 terms) -> title bonus=1.3
        # field=concept -> concept bonus=1.15
        # combined = 1.15 * 1.3 = 1.495
        entries_by_id = {"a": make_entry("a", field="concept", title="python programming", description="code example")}
        scored = [("a", 1.0, {})]
        result = _search_ranking.apply_field_match_bonus(scored, entries_by_id, "python programming")
        assert result[0][2]["fieldMatchBonus"] == pytest.approx(1.495)

    def test_no_bonus_for_empty_query(self):
        # Empty query returns unscored list unchanged; fieldMatchBonus key is absent
        entries_by_id = {"a": make_entry("a", field="fact")}
        scored = [("a", 1.0, {})]
        result = _search_ranking.apply_field_match_bonus(scored, entries_by_id, "")
        assert result == scored  # unchanged, no fieldMatchBonus added


# ---------------------------------------------------------------------------
# keyword_overlap_scores tests
# ---------------------------------------------------------------------------

class TestKeywordOverlapScores:
    def test_empty_entries(self):
        result = _search_ranking.keyword_overlap_scores([], ["test"])
        assert result == {}

    def test_empty_query(self):
        entries = [make_entry("a", tokens=["test", "query"])]
        result = _search_ranking.keyword_overlap_scores(entries, [])
        assert result == {}

    def test_single_overlap(self):
        entries = [make_entry("a", tokens=["test", "query"])]
        result = _search_ranking.keyword_overlap_scores(entries, ["test"])
        assert result["a"] == 1.0

    def test_multiple_overlap(self):
        entries = [make_entry("a", tokens=["test", "query", "search"])]
        result = _search_ranking.keyword_overlap_scores(entries, ["test", "query"])
        assert result["a"] == 2.0

    def test_no_overlap(self):
        entries = [make_entry("a", tokens=["python"])]
        result = _search_ranking.keyword_overlap_scores(entries, ["test"])
        assert "a" not in result

    def test_multiple_entries(self):
        entries = [
            make_entry("a", tokens=["test", "query"]),
            make_entry("b", tokens=["test"]),
            make_entry("c", tokens=["query"]),
        ]
        result = _search_ranking.keyword_overlap_scores(entries, ["test", "query"])
        assert result["a"] == 2.0
        assert result["b"] == 1.0
        assert result["c"] == 1.0


# ---------------------------------------------------------------------------
# ranked_pairs tests
# ---------------------------------------------------------------------------

class TestRankedPairs:
    def test_empty_scores(self):
        result = _search_ranking.ranked_pairs({}, 10)
        assert result == []

    def test_sorted_descending(self):
        result = _search_ranking.ranked_pairs({"a": 0.5, "b": 1.0, "c": 0.2}, 10)
        assert result == [("b", 1.0), ("a", 0.5), ("c", 0.2)]

    def test_respects_limit(self):
        result = _search_ranking.ranked_pairs({"a": 0.5, "b": 1.0, "c": 0.2}, 2)
        assert len(result) == 2
        assert result[0] == ("b", 1.0)


# ---------------------------------------------------------------------------
# rerank_entries tests
# ---------------------------------------------------------------------------

class TestRerankEntries:
    def test_empty_inputs(self):
        ranked, meta, count = _search_ranking.rerank_entries({}, "hybrid", 10, make_route(), {}, {}, "", None)
        assert ranked == []
        assert meta == {}
        assert count == 0

    def test_bm25_only_mode(self):
        entries_by_id = {
            "a": make_entry("a", tokens=["test"]),
            "b": make_entry("b", tokens=["test", "query"]),
        }
        ranked, meta, count = _search_ranking.rerank_entries(
            entries_by_id, "bm25", 10, make_route(), {"a": 1.0, "b": 2.0}, {}, "", None
        )
        assert count == 2
        assert ranked[0][0] == "b"  # higher BM25
        assert ranked[1][0] == "a"

    def test_dedup_by_record_id(self):
        """Same record_id entries should be deduplicated."""
        entries_by_id = {
            "parent1": make_entry("parent1", tokens=["test"], field="content"),
            "fact1": make_entry("fact1", tokens=["test", "query"], field="fact"),
        }
        # Both share the same record_id (parent1 -> record_id=parent1, fact1 -> record_id=parent1)
        entries_by_id["fact1"]["record_id"] = "parent1"

        ranked, meta, count = _search_ranking.rerank_entries(
            entries_by_id, "bm25", 10, make_route(), {"parent1": 1.0, "fact1": 2.0}, {}, "", None
        )
        # Only the highest-scoring should appear
        ids = [eid for eid, _ in ranked]
        record_ids_in_results = {entries_by_id[eid].get("record_id", eid) for eid in ids}
        assert len(record_ids_in_results) == len(ids)

    def test_top_k_limit(self):
        entries_by_id = {str(i): make_entry(str(i), tokens=["test"]) for i in range(20)}
        bm25_map = {str(i): float(i) for i in range(20)}
        ranked, meta, count = _search_ranking.rerank_entries(
            entries_by_id, "bm25", 5, make_route(), bm25_map, {}, "", None
        )
        assert len(ranked) == 5
        assert count == 20
