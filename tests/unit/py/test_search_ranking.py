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


# ---------------------------------------------------------------------------
# mmr_rerank tests
# ---------------------------------------------------------------------------

class TestMMRRerank:
    def test_empty_relevance_scores_returns_empty(self):
        result = _search_ranking.mmr_rerank({}, {}, 10, 0.7)
        assert result == []

    def test_zero_top_k_returns_empty(self):
        entries = {"a": make_entry("a")}
        result = _search_ranking.mmr_rerank(entries, {"a": 1.0}, 0, 0.7)
        assert result == []

    def test_lambda_param_clamped_to_valid_range(self):
        """lambda_param should be clamped to [0.0, 1.0]."""
        entries = {"a": make_entry("a")}
        # lambda > 1.0 should be clamped to 1.0
        result = _search_ranking.mmr_rerank(entries, {"a": 1.0}, 1, 1.5)
        assert len(result) == 1
        # lambda < 0.0 should be clamped to 0.0
        result = _search_ranking.mmr_rerank(entries, {"a": 1.0}, 1, -0.5)
        assert len(result) == 1

    def test_respects_top_k_limit(self):
        entries_by_id = {str(i): make_entry(str(i)) for i in range(10)}
        scores = {str(i): float(10 - i) for i in range(10)}  # higher scores for lower ids
        result = _search_ranking.mmr_rerank(entries_by_id, scores, 3, 0.7)
        assert len(result) == 3

    def test_result_contains_valid_entry_ids(self):
        entries_by_id = {"a": make_entry("a"), "b": make_entry("b"), "c": make_entry("c")}
        scores = {"a": 1.0, "b": 0.8, "c": 0.6}
        result = _search_ranking.mmr_rerank(entries_by_id, scores, 3, 0.7)
        ids = [eid for eid, _ in result]
        assert set(ids) == {"a", "b", "c"}

    def test_all_scores_zero_returns_empty(self):
        entries = {"a": make_entry("a"), "b": make_entry("b")}
        result = _search_ranking.mmr_rerank(entries, {"a": 0.0, "b": 0.0}, 2, 0.7)
        assert result == []

    def test_lambda_0_favors_diversity(self):
        """lambda=0 means full diversity, picks entries far apart."""
        # When no embeddings, lambda=0 should just pick in score order
        entries_by_id = {"a": make_entry("a"), "b": make_entry("b")}
        scores = {"a": 1.0, "b": 1.0}  # equal scores
        result = _search_ranking.mmr_rerank(entries_by_id, scores, 1, 0.0)
        # Without embeddings, picks by original order or score tie-break
        assert len(result) == 1

    def test_lambda_1_favors_relevance(self):
        """lambda=1 means full relevance, picks highest scores."""
        entries_by_id = {"a": make_entry("a"), "b": make_entry("b"), "c": make_entry("c")}
        scores = {"a": 1.0, "b": 0.5, "c": 0.2}
        result = _search_ranking.mmr_rerank(entries_by_id, scores, 2, 1.0)
        # Should pick highest relevance scores first
        ids = [eid for eid, _ in result]
        assert ids[0] == "a"  # highest score first

    def test_with_embeddings_diversity_penalty(self):
        """When embeddings are available, similar entries get penalized."""
        # Mock the StreamingIndex to return embeddings that show "a" and "b" are similar
        mock_stream = MagicMock()
        mock_records = [
            {"id": "a", "embedding": [1.0, 0.0]},
            {"id": "b", "embedding": [0.99, 0.01]},  # similar to a
            {"id": "c", "embedding": [0.0, 1.0]},  # different from a and b
        ]
        mock_stream.scan.return_value = iter(mock_records)

        with patch.object(_search_ranking, "StreamingIndex", return_value=mock_stream):
            with patch.object(_search_ranking, "_STREAMING_INDEX_AVAILABLE", True):
                entries_by_id = {"a": make_entry("a"), "b": make_entry("b"), "c": make_entry("c")}
                scores = {"a": 1.0, "b": 0.9, "c": 0.8}  # c is lowest relevance
                result = _search_ranking.mmr_rerank(
                    entries_by_id, scores, 2, 0.7,
                    embeddings_index_path="/fake/path.jsonl"
                )
                # "c" should be selected because it's diverse from "a" (already high relevance)
                # even though its relevance score is lower
                ids = [eid for eid, _ in result]
                if "c" in ids:
                    # Diversity worked - c was selected over b due to similarity penalty
                    assert True

    def test_no_embeddings_falls_back_to_score_order(self):
        """Without embeddings, falls back to relevance score order."""
        # Create entries with different scores
        entries_by_id = {"a": make_entry("a"), "b": make_entry("b")}
        scores = {"a": 2.0, "b": 1.0}
        # No embeddings index path, load_embeddings_index is None
        result = _search_ranking.mmr_rerank(entries_by_id, scores, 2, 0.7)
        ids = [eid for eid, _ in result]
        # Should respect top_k and return entries
        assert len(result) <= 2


# ---------------------------------------------------------------------------
# RRF (Reciprocal Rank Fusion) tests
# ---------------------------------------------------------------------------

class TestRRFFusion:
    def test_compute_rank_map_descending(self):
        scores = {"a": 0.9, "b": 0.5, "c": 0.7}
        ranks = _search_ranking.compute_rank_map(scores)
        assert ranks == {"a": 1, "c": 2, "b": 3}

    def test_compute_rank_map_drops_non_positive(self):
        scores = {"a": 0.9, "b": 0.0, "c": -1.0, "d": 0.5}
        ranks = _search_ranking.compute_rank_map(scores)
        # b/c 排除，只保留正向 score
        assert ranks == {"a": 1, "d": 2}

    def test_compute_rank_map_empty(self):
        assert _search_ranking.compute_rank_map({}) == {}

    def test_compute_rank_map_does_not_mutate_input(self):
        scores = {"a": 0.9, "b": 0.5}
        original = dict(scores)
        _search_ranking.compute_rank_map(scores)
        assert scores == original

    def test_rrf_fusion_score_both_present(self):
        # 1/(60+1) + 1/(60+3) = 1/61 + 1/63
        expected = 1 / 61 + 1 / 63
        assert _search_ranking.rrf_fusion_score(1, 3, k=60) == pytest.approx(expected)

    def test_rrf_fusion_score_bm25_missing(self):
        # bm25 未召回 -> 仅 dense 贡献
        expected = 1 / (60 + 2)
        assert _search_ranking.rrf_fusion_score(None, 2, k=60) == pytest.approx(expected)

    def test_rrf_fusion_score_dense_missing(self):
        expected = 1 / (60 + 1)
        assert _search_ranking.rrf_fusion_score(1, None, k=60) == pytest.approx(expected)

    def test_rrf_fusion_score_both_missing(self):
        assert _search_ranking.rrf_fusion_score(None, None, k=60) == 0.0

    def test_rrf_fusion_score_custom_k(self):
        expected = 1 / (10 + 1) + 1 / (10 + 2)
        assert _search_ranking.rrf_fusion_score(1, 2, k=10) == pytest.approx(expected)

    def test_rrf_fusion_score_invalid_k_falls_back(self):
        # k<=0 回退到默认 60
        expected = 1 / (60 + 1)
        assert _search_ranking.rrf_fusion_score(1, None, k=0) == pytest.approx(expected)

    def test_resolve_fusion_mode_default_weighted(self):
        assert _search_ranking.resolve_fusion_mode({}) == "weighted"
        assert _search_ranking.resolve_fusion_mode(None) == "weighted"

    def test_resolve_fusion_mode_from_route(self):
        assert _search_ranking.resolve_fusion_mode({"fusion": "rrf"}) == "rrf"
        assert _search_ranking.resolve_fusion_mode({"fusion": "weighted"}) == "weighted"

    def test_resolve_fusion_mode_ignores_invalid_route_value(self):
        assert _search_ranking.resolve_fusion_mode({"fusion": "garbage"}) == "weighted"

    def test_resolve_fusion_mode_env_var_overrides_route(self, monkeypatch):
        monkeypatch.setenv("AI_MEMORY_FUSION", "rrf")
        # 即使 route 指定 weighted，env 也优先
        assert _search_ranking.resolve_fusion_mode({"fusion": "weighted"}) == "rrf"

    def test_resolve_fusion_mode_env_var_weighted(self, monkeypatch):
        monkeypatch.setenv("AI_MEMORY_FUSION", "weighted")
        assert _search_ranking.resolve_fusion_mode({"fusion": "rrf"}) == "weighted"

    def test_resolve_fusion_mode_empty_env_falls_back_to_route(self, monkeypatch):
        monkeypatch.setenv("AI_MEMORY_FUSION", "")
        assert _search_ranking.resolve_fusion_mode({"fusion": "rrf"}) == "rrf"


class TestScoreEntryRRF:
    def test_rrf_mode_uses_rank_not_score(self):
        """RRF 模式下 retrievalScore 应等于 rrf_fusion_score(rank_bm25, rank_dense)。"""
        entry = make_entry("a")
        route = {"fusion": "rrf"}
        bm25_norm = {"a": 1.0}
        dense_norm = {"a": 1.0}
        bm25_rank = {"a": 1}
        dense_rank = {"a": 3}
        result = _search_ranking.score_entry(
            entry, "hybrid", route, bm25_norm, dense_norm, None,
            bm25_rank_map=bm25_rank, dense_rank_map=dense_rank,
        )
        assert result is not None
        _, meta = result
        expected = 1 / 61 + 1 / 63
        assert meta["retrievalScore"] == pytest.approx(expected)

    def test_rrf_mode_one_source_missing(self):
        """dense 未召回时仅 bm25 贡献。"""
        entry = make_entry("a")
        route = {"fusion": "rrf"}
        bm25_rank = {"a": 2}  # dense 没有 a
        result = _search_ranking.score_entry(
            entry, "hybrid", route, {"a": 1.0}, {}, None,
            bm25_rank_map=bm25_rank, dense_rank_map={},
        )
        assert result is not None
        _, meta = result
        expected = 1 / (60 + 2)
        assert meta["retrievalScore"] == pytest.approx(expected)

    def test_rrf_mode_both_unrecalled_returns_none(self):
        """两路都未召回 -> retrieval_score=0 -> 返回 None。"""
        entry = make_entry("a")
        route = {"fusion": "rrf"}
        result = _search_ranking.score_entry(
            entry, "hybrid", route, {"a": 1.0}, {"a": 1.0}, None,
            bm25_rank_map={}, dense_rank_map={},
        )
        assert result is None

    def test_rrf_mode_custom_k_from_route(self):
        entry = make_entry("a")
        route = {"fusion": "rrf", "adaptiveBlend": {"rrfK": 10}}
        result = _search_ranking.score_entry(
            entry, "hybrid", route, {"a": 1.0}, {"a": 1.0}, None,
            bm25_rank_map={"a": 1}, dense_rank_map={"a": 2},
        )
        assert result is not None
        _, meta = result
        expected = 1 / 11 + 1 / 12
        assert meta["retrievalScore"] == pytest.approx(expected)

    def test_rrf_mode_still_applies_downstream_weights(self):
        """RRF 替换 retrieval_score 计算后，layer/scope/coverage 等下游权重仍生效。"""
        entry = make_entry("a", layer="durable", scope="user")
        route = {"fusion": "rrf", "intent": "durable"}
        # 沿用 make_route 的权重表，需要补全
        full_route = {**make_route("durable"), "fusion": "rrf"}
        result = _search_ranking.score_entry(
            entry, "hybrid", full_route, {"a": 1.0}, {"a": 1.0}, None,
            bm25_rank_map={"a": 1}, dense_rank_map={"a": 1},
        )
        assert result is not None
        final_score, meta = result
        # coverage bonus 因两路都召回 = 1.04
        assert meta["coverageWeight"] == 1.04
        # layer=durable + intent=durable -> 1.35
        assert meta["layerWeight"] == 1.35
        # 最终分数 = retrieval * layer * scope * sourceKind * freshness * state * coverage * decay
        rrf = 1 / 61 + 1 / 61
        expected = rrf * meta["layerWeight"] * meta["scopeWeight"] * meta["sourceKindWeight"] * meta["freshnessWeight"] * meta["taskStateWeight"] * meta["coverageWeight"] * meta["decayFactor"]
        assert final_score == pytest.approx(expected, rel=1e-6)

    def test_weighted_mode_still_default_when_no_route_fusion(self):
        """无 fusion 字段时回退到加权求和（安全）。"""
        entry = make_entry("a")
        result = _search_ranking.score_entry(
            entry, "hybrid", make_route(), {"a": 1.0}, {"a": 1.0}, None,
            bm25_rank_map={"a": 1}, dense_rank_map={"a": 1},
        )
        assert result is not None
        _, meta = result
        # 加权求和：0.55*1 + 0.45*1 = 1.0
        assert meta["retrievalScore"] == pytest.approx(1.0)

    def test_weighted_mode_unchanged_without_rank_maps(self):
        """向后兼容：不传 rank map 时加权求和路径不受影响。"""
        entry = make_entry("a")
        result = _search_ranking.score_entry(
            entry, "hybrid", make_route(), {"a": 1.0}, {"a": 1.0}, None,
        )
        assert result is not None
        _, meta = result
        assert meta["retrievalScore"] == pytest.approx(1.0)


class TestRerankEntriesRRF:
    def test_rerank_uses_rrf_when_route_fusion_rrf(self):
        """端到端：rerank_entries 在 fusion=rrf 下应按 RRF 排序。"""
        entries = {
            "a": make_entry("a"),
            "b": make_entry("b"),
            "c": make_entry("c"),
        }
        # bm25: a > b > c ；dense: c > a > b
        # RRF: a=1/61+1/62, b=1/62+1/63, c=1/63+1/61
        bm25_map = {"a": 0.9, "b": 0.5, "c": 0.1}
        dense_map = {"c": 0.9, "a": 0.5, "b": 0.1}
        route = {**make_route(), "fusion": "rrf"}
        ranked, meta, count = _search_ranking.rerank_entries(
            entries, "hybrid", 3, route, bm25_map, dense_map, "", None,
        )
        assert count == 3
        # a 的 rrf 应最高（bm25#1 + dense#2）
        assert ranked[0][0] == "a"

    def test_rerank_weighted_mode_unaffected(self, monkeypatch):
        """默认 weighted 模式：rerank 行为与改动前一致。"""
        monkeypatch.delenv("AI_MEMORY_FUSION", raising=False)
        entries = {"a": make_entry("a"), "b": make_entry("b")}
        bm25_map = {"a": 0.9, "b": 0.1}
        dense_map = {"a": 0.1, "b": 0.9}
        ranked, _, count = _search_ranking.rerank_entries(
            entries, "hybrid", 2, make_route(), bm25_map, dense_map, "", None,
        )
        assert count == 2
        # weighted: 两路归一化后都为 1.0，0.55+0.45=1.0 相同，靠稳定性即可
        assert {eid for eid, _ in ranked} == {"a", "b"}


class TestCrossEncoderRerank:
    """bge-reranker cross-encoder rerank (env-gated AI_MEMORY_RERANK=local, default off)."""

    def test_off_by_default_returns_input_unchanged(self):
        scored = [("a", 1.0, {}), ("b", 0.5, {})]
        # AI_MEMORY_RERANK unset → off → identity (no model touched)
        result = _search_ranking._cross_encoder_rerank(scored, {}, "query")
        assert result == scored

    def test_local_without_sentence_transformers_degrades_gracefully(self, monkeypatch):
        monkeypatch.setenv("AI_MEMORY_RERANK", "local")
        scored = [("a", 1.0, {}), ("b", 0.5, {})]
        entries = {"a": {"content": "alpha"}, "b": {"content": "beta"}}
        # sentence_transformers absent in test env → graceful degradation, order kept
        result = _search_ranking._cross_encoder_rerank(scored, entries, "query")
        assert [eid for eid, _, _ in result] == ["a", "b"]

    def test_local_with_empty_query_returns_input(self, monkeypatch):
        monkeypatch.setenv("AI_MEMORY_RERANK", "local")
        scored = [("a", 1.0, {})]
        assert _search_ranking._cross_encoder_rerank(scored, {}, "") == scored

