"""
Pytest tests for retrieval/search_server.py

Tests action handler parsing, response format, and error handling.
"""

import os
import sys
import json
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

# Shared namespace for inter-module references (avoids circular imports)
_ns: dict = {}

# 1. search_ranking
# Re-use any already-loaded instance so that test_search_cache.py /
# test_search_index.py / test_search_ranking.py module-level cache references
# remain valid (avoiding stale dicts after exec_module re-execution).
if "search_ranking" in sys.modules:
    _ns["search_ranking"] = sys.modules["search_ranking"]
else:
    _ranking_spec = importlib.util.spec_from_file_location("search_ranking", _retrieval_dir / "search_ranking.py")
    assert _ranking_spec and _ranking_spec.loader
    _ns["search_ranking"] = importlib.util.module_from_spec(_ranking_spec)
    _ranking_spec.loader.exec_module(_ns["search_ranking"])
    sys.modules["search_ranking"] = _ns["search_ranking"]

# 2. search_index
_index_spec = importlib.util.spec_from_file_location("search_index", _retrieval_dir / "search_index.py")
assert _index_spec and _index_spec.loader
_ns["search_index"] = importlib.util.module_from_spec(_index_spec)
_index_spec.loader.exec_module(_ns["search_index"])
sys.modules["search_index"] = _ns["search_index"]

# 3. search_cache
_cache_spec = importlib.util.spec_from_file_location("search_cache", _retrieval_dir / "search_cache.py")
assert _cache_spec and _cache_spec.loader
_ns["search_cache"] = importlib.util.module_from_spec(_cache_spec)
_cache_spec.loader.exec_module(_ns["search_cache"])
sys.modules["search_cache"] = _ns["search_cache"]

# 4. search_server (depends on all above + semantic_search via deferred imports)
_server_spec = importlib.util.spec_from_file_location("search_server", _retrieval_dir / "search_server.py")
assert _server_spec and _server_spec.loader
_ns["search_server"] = importlib.util.module_from_spec(_server_spec)
_server_spec.loader.exec_module(_ns["search_server"])
sys.modules["search_server"] = _ns["search_server"]

# 5. semantic_search (for deferred imports in search_server handlers)
_semantic_spec = importlib.util.spec_from_file_location(
    "semantic_search", _retrieval_dir / "semantic_search.py"
)
assert _semantic_spec and _semantic_spec.loader
_ns["semantic_search"] = importlib.util.module_from_spec(_semantic_spec)
_semantic_spec.loader.exec_module(_ns["semantic_search"])
sys.modules["semantic_search"] = _ns["semantic_search"]

# Convenience references
_server_mod = _ns["search_server"]


# ---------------------------------------------------------------------------
# write_server_response tests
# ---------------------------------------------------------------------------

class TestWriteServerResponse:
    def test_outputs_json_line(self, capsys):
        payload = {"ok": True, "data": 42}
        _server_mod.write_server_response(payload)

        stdout = capsys.readouterr().out
        parsed = json.loads(stdout.strip())
        assert parsed == payload

    def test_flushes_stdout(self, capsys):
        _server_mod.write_server_response({"test": True})
        # If flush didn't happen, output might be empty in some environments
        stdout = capsys.readouterr().out
        assert '"test": true' in stdout


# ---------------------------------------------------------------------------
# Action handler: health
# ---------------------------------------------------------------------------

class TestHealthAction:
    def test_health_returns_worker_mode(self, capsys):
        lines = ['{"action": "health"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is True
        assert response["action"] == "health"
        assert response["workerMode"] == "persistent-jsonl"
        assert "embeddingRuntime" in response
        assert "cacheState" in response
        assert "schemaValidation" in response

    def test_health_with_request_id(self, capsys):
        lines = ['{"action": "health", "id": "req-42"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["id"] == "req-42"


# ---------------------------------------------------------------------------
# Action handler: clear_cache
# ---------------------------------------------------------------------------

class TestClearCacheAction:
    def test_clear_cache_includes_data_caches(self, capsys):
        lines = ['{"action": "clear_cache", "include_data_caches": true}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is True
        assert response["action"] == "clear_cache"
        assert response["includeDataCaches"] is True

    def test_clear_cache_without_data_caches(self, capsys):
        lines = ['{"action": "clear_cache"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is True
        assert response["includeDataCaches"] is False


# ---------------------------------------------------------------------------
# Action handler: get_records
# ---------------------------------------------------------------------------

class TestGetRecordsAction:
    def test_get_records_requires_ids_array(self, capsys):
        lines = ['{"action": "get_records"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is False
        assert "error" in response

    def test_get_records_empty_ids_error(self, capsys):
        lines = ['{"action": "get_records", "ids": []}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is False

    def test_get_records_returns_found_subset(self, capsys):
        lines = ['{"action": "get_records", "ids": ["non-existent-id-xyz"]}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is True
        assert response["requested"] == 1
        assert response["found"] == []
        assert response["records"] == []


# ---------------------------------------------------------------------------
# Action handler: timeline
# ---------------------------------------------------------------------------

class TestTimelineAction:
    def test_timeline_requires_anchor_id(self, capsys):
        lines = ['{"action": "timeline"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is False

    def test_timeline_nonexistent_anchor(self, capsys):
        lines = ['{"action": "timeline", "anchor_id": "nonexistent-anchor"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is False
        assert "not found" in response["error"].lower()


# ---------------------------------------------------------------------------
# Action handler: search (default)
# ---------------------------------------------------------------------------

class TestSearchAction:
    def test_default_action_is_search(self, capsys):
        # No action specified — defaults to search
        lines = ['{"query": "test", "top_k": 3}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert "ok" in response

    def test_explicit_search_action(self, capsys):
        lines = ['{"action": "search", "query": "test", "top_k": 3}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert "ok" in response


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

class TestServerErrors:
    def test_invalid_json_returns_error(self, capsys):
        lines = ["not valid json at all"]

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is False
        assert "error" in response

    def test_unsupported_action_returns_error(self, capsys):
        lines = ['{"action": "fly_to_mars"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["ok"] is False
        assert "unsupported" in response["error"].lower()

    def test_request_id_preserved_on_error(self, capsys):
        lines = ['{"id": "req-99", "action": "fly"}']

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        response = json.loads(stdout.strip())
        assert response["id"] == "req-99"

    def test_empty_lines_skipped(self, capsys):
        lines = ["", '{"action": "health"}', ""]

        with patch.object(sys, "stdin", MagicMock(**{"__iter__": lambda s: iter(lines)})):
            _server_mod.run_server()

        stdout = capsys.readouterr().out
        responses = [json.loads(line) for line in stdout.strip().split("\n") if line]
        assert len(responses) == 1
        assert responses[0]["action"] == "health"
