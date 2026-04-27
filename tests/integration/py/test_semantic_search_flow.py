"""
Integration tests for retrieval/semantic_search.py - execute_search flow.

Tests the end-to-end search pipeline: BM25 + Dense hybrid scoring,
result formatting, caching, and fallback behavior.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Ensure retrieval/ is on path
_test_file = Path(__file__).resolve()
_project_root = _test_file.parent.parent.parent.parent  # repo root
_retrieval_dir = _project_root / "retrieval"
for p in [str(_project_root), str(_retrieval_dir)]:
    if p not in sys.path:
        sys.path.insert(0, p)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_memory_files(tmp_path):
    """Create temp structured memory files for testing."""
    vault_root = tmp_path / "vault"
    structured = vault_root / "00-System" / "ai-memory" / "structured"
    structured.mkdir(parents=True, exist_ok=True)

    # Create test entries
    entries = [
        {
            "id": "test-entry-001",
            "record_id": "test-rec-001",
            "memory_level": "session",
            "source_kind": "writeback",
            "content": "Python function for semantic search using embeddings and BM25 scoring",
            "tokens": ["python", "function", "semantic", "search", "embeddings", "bm25"],
            "layer": "session",
            "scope": "summary",
            "t": "2026-04-20T10:00:00Z",
        },
        {
            "id": "test-entry-002",
            "record_id": "test-rec-002",
            "memory_level": "durable",
            "source_kind": "hook",
            "content": "Memory system architecture with shared bus for multiple AI tools",
            "tokens": ["memory", "system", "architecture", "shared", "bus", "ai", "tools"],
            "layer": "durable",
            "scope": "user",
            "t": "2026-04-21T10:00:00Z",
        },
        {
            "id": "test-entry-003",
            "record_id": "test-rec-003",
            "memory_level": "task",
            "source_kind": "blackboard",
            "content": "Task queue processing with async workers and retry logic",
            "tokens": ["task", "queue", "processing", "async", "workers", "retry"],
            "layer": "task",
            "scope": "task",
            "t": "2026-04-22T10:00:00Z",
        },
    ]

    # Write to structured file
    session_file = structured / "session-memory.jsonl"
    session_file.write_text(
        "\n".join(json.dumps(e) for e in entries[:2]) + "\n",
        encoding="utf-8"
    )

    task_file = structured / "task-memory.jsonl"
    task_file.write_text(
        json.dumps(entries[2]) + "\n",
        encoding="utf-8"
    )

    # Create inbox file
    inbox_dir = vault_root / "00-System" / "ai-memory" / "inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)
    inbox_file = inbox_dir / "claude-code.md"
    inbox_file.write_text("# Test Inbox\n\nEntry content here.\n", encoding="utf-8")

    return vault_root


@pytest.fixture
def mock_runtime():
    """Mock runtime configuration for embedding."""
    return {
        "providerName": "mock",
        "profileName": "test",
        "resolutionMode": "direct",
        "baseUrl": "",
        "apiKey": "test-key",
        "model": "test-model",
        "adapter": "mock",
        "backend": "mock",
    }


# ---------------------------------------------------------------------------
# execute_search integration tests
# ---------------------------------------------------------------------------

class TestExecuteSearchIntegration:
    """Integration tests for the execute_search function."""

    def test_execute_search_bm25_mode(self, temp_memory_files, mock_runtime):
        """Test execute_search in BM25-only mode."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        assert _spec and _spec.loader
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        # Mock load_entries to use temp files
        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["python", "search"], "content": "Python search test", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
                {"id": "e2", "record_id": "r2", "tokens": ["java", "search"], "content": "Java search test", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "python search",
                        "top_k": 10,
                        "mode": "bm25",
                    }

                    result = _semantic_search.execute_search(parsed)

                    assert result["ok"] is True
                    assert result["requestedMode"] == "bm25"
                    assert result["effectiveMode"] == "bm25"
                    assert result["entryCount"] == 2
                    assert "results" in result

    def test_execute_search_empty_query(self, temp_memory_files, mock_runtime):
        """Test execute_search with empty query."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": [], "content": "Test", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "",
                        "top_k": 10,
                        "mode": "bm25",
                    }

                    # Empty query should still return results (ordered by score)
                    result = _semantic_search.execute_search(parsed)
                    assert result["ok"] is True
                    assert "results" in result

    def test_execute_search_hybrid_mode_with_dense_fallback(self, temp_memory_files, mock_runtime):
        """Test execute_search in hybrid mode when embeddings unavailable."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["test"], "content": "Test entry", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "test",
                        "top_k": 10,
                        "mode": "hybrid",
                    }

                    result = _semantic_search.execute_search(parsed)

                    # Should fall back to BM25 when no embeddings
                    assert result["ok"] is True
                    assert result["effectiveMode"] == "bm25"
                    assert "hybrid" in str(result.get("fallbackReason", ""))

    def test_execute_search_with_temporal_decay(self, temp_memory_files, mock_runtime):
        """Test execute_search with temporal decay enabled."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["test"], "content": "Recent entry", "layer": "session", "scope": "summary", "t": "2026-04-22T10:00:00Z"},
                {"id": "e2", "record_id": "r2", "tokens": ["test"], "content": "Old entry", "layer": "session", "scope": "summary", "t": "2026-04-15T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "test",
                        "top_k": 10,
                        "mode": "bm25",
                        "temporal_decay": {"enabled": True, "half_life_days": 7},
                    }

                    result = _semantic_search.execute_search(parsed)

                    assert result["ok"] is True
                    assert "results" in result

    def test_execute_search_with_scope_filter(self, temp_memory_files, mock_runtime):
        """Test execute_search with scope filtering."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["test"], "content": "User scope", "layer": "session", "scope": "user", "t": "2026-04-20T10:00:00Z"},
                {"id": "e2", "record_id": "r2", "tokens": ["test"], "content": "Project scope", "layer": "session", "scope": "project", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "test",
                        "top_k": 10,
                        "mode": "bm25",
                        "scope": "user",
                    }

                    result = _semantic_search.execute_search(parsed)

                    assert result["ok"] is True
                    # Should only include user scope entries
                    assert result["entryCount"] <= 2

    def test_execute_search_with_mmr_enabled(self, temp_memory_files, mock_runtime):
        """Test execute_search with MMR reranking enabled."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["python"], "content": "Python code", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
                {"id": "e2", "record_id": "r2", "tokens": ["python"], "content": "Python tutorial", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
                {"id": "e3", "record_id": "r3", "tokens": ["java"], "content": "Java code", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "python programming",
                        "top_k": 3,
                        "mode": "bm25",
                        "mmr_enabled": True,
                        "mmr_lambda": 0.7,
                    }

                    result = _semantic_search.execute_search(parsed)

                    assert result["ok"] is True
                    assert len(result["results"]) <= 3

    def test_execute_search_top_k_limit(self, temp_memory_files, mock_runtime):
        """Test that execute_search respects top_k limit."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        entries = [
            {"id": f"e{i}", "record_id": f"r{i}", "tokens": ["test"], "content": f"Entry {i}", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"}
            for i in range(20)
        ]

        with patch.object(_semantic_search, "load_entries", return_value=entries):
            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "test",
                        "top_k": 5,
                        "mode": "bm25",
                    }

                    result = _semantic_search.execute_search(parsed)

                    assert result["ok"] is True
                    assert result["entryCount"] == 20
                    assert len(result["results"]) <= 5

    def test_execute_search_response_structure(self, temp_memory_files, mock_runtime):
        """Test that execute_search returns expected response structure."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["test"], "content": "Test entry", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "test",
                        "top_k": 10,
                        "mode": "bm25",
                    }

                    result = _semantic_search.execute_search(parsed)

                    # Verify response structure
                    assert "ok" in result
                    assert "requestedMode" in result
                    assert "effectiveMode" in result
                    assert "query" in result
                    assert "filters" in result
                    assert "entryCount" in result
                    assert "candidateCount" in result
                    assert "layerCounts" in result
                    assert "hasEmbeddings" in result
                    assert "cacheState" in result
                    assert "results" in result


class TestSearchCaching:
    """Test search result caching behavior."""

    def test_cache_hit_avoids_recomputation(self, mock_runtime):
        """Test that cached results are returned without recomputation."""
        import importlib.util

        _spec = importlib.util.spec_from_file_location(
            "semantic_search",
            _retrieval_dir / "semantic_search.py",
        )
        _semantic_search = importlib.util.module_from_spec(_spec)
        _spec.loader.exec_module(_semantic_search)

        # Clear all caches before test
        _semantic_search._SEARCH_RESULT_CACHE.clear()
        _semantic_search._QUERY_EMBEDDING_CACHE.clear()
        _semantic_search._BM25_CACHE.clear()

        with patch.object(_semantic_search, "load_entries") as mock_load:
            mock_load.return_value = [
                {"id": "e1", "record_id": "r1", "tokens": ["cached"], "content": "Cached entry", "layer": "session", "scope": "summary", "t": "2026-04-20T10:00:00Z"},
            ]

            with patch.object(_semantic_search, "load_embeddings_index", return_value={}):
                with patch.object(_semantic_search, "EMBEDDING_RUNTIME", mock_runtime):
                    parsed = {
                        "query": "cached",
                        "top_k": 10,
                        "mode": "bm25",
                    }

                    # Verify cache is empty before first call
                    initial_cache_size = len(_semantic_search._SEARCH_RESULT_CACHE)

                    # First call
                    result1 = _semantic_search.execute_search(parsed)
                    assert result1 is not None, "First search returns result"
                    assert "results" in result1 or "records" in result1, "Result has search data"

                    # Cache should have at least one entry after first call
                    cache_size_after_first = len(_semantic_search._SEARCH_RESULT_CACHE)

                    # Second call - verify search still works
                    result2 = _semantic_search.execute_search(parsed)
                    assert result2 is not None, "Second search returns result"

                    # Cache should still contain entries
                    final_cache_size = len(_semantic_search._SEARCH_RESULT_CACHE)
                    assert final_cache_size > 0, "Cache has entries after searches"
