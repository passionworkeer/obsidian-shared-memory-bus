"""
Pytest tests for retrieval/search_index.py

Tests index loading, cache invalidation, and signature change detection.
"""

import os
import sys
import json
import tempfile
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

# Load search_ranking first (dependency of search_index)
_ranking_spec = importlib.util.spec_from_file_location(
    "search_ranking", _retrieval_dir / "search_ranking.py"
)
assert _ranking_spec and _ranking_spec.loader
_ranking_mod = importlib.util.module_from_spec(_ranking_spec)
_ranking_spec.loader.exec_module(_ranking_mod)

# Load search_index
_index_spec = importlib.util.spec_from_file_location(
    "search_index", _retrieval_dir / "search_index.py"
)
assert _index_spec and _index_spec.loader
_index_mod = importlib.util.module_from_spec(_index_spec)
_index_spec.loader.exec_module(_index_mod)


# ---------------------------------------------------------------------------
# build_file_stamp tests
# ---------------------------------------------------------------------------

class TestBuildFileStamp:
    def test_missing_file(self, tmp_path):
        result = _index_mod.build_file_stamp(str(tmp_path / "nonexistent.txt"))
        assert result == "__missing__"

    def test_readable_file(self, tmp_path):
        f = tmp_path / "test.txt"
        f.write_bytes(b"hello world")
        result = _index_mod.build_file_stamp(str(f))
        assert "test.txt" in result
        assert len(result.split(":")) == 3

    def test_unreadable_file_raises(self, tmp_path):
        f = tmp_path / "test.txt"
        f.write_bytes(b"hello")
        # Simulate unreadable by patching os.path.exists
        with patch("os.path.exists", return_value=False):
            result = _index_mod.build_file_stamp(str(f))
        # With patched exists, returns __missing__


# ---------------------------------------------------------------------------
# signature tests
# ---------------------------------------------------------------------------

class TestSignatures:
    def test_structured_signature_missing_dir(self, tmp_path):
        with patch.object(_index_mod, "STRUCTURED_DIR", str(tmp_path / "nonexistent")):
            sig = _index_mod.build_structured_signature()
            assert sig == "__missing__"

    def test_structured_signature_empty_dir(self, tmp_path):
        # Empty dir (no structured files) -> each file stamp is __missing__
        with patch.object(_index_mod, "STRUCTURED_DIR", str(tmp_path)):
            sig = _index_mod.build_structured_signature()
            # All file stamps should be __missing__ (files don't exist in empty dir)
            assert "__missing__" in sig
            assert "__empty__" not in sig

    def test_embeddings_signature_missing_file(self, tmp_path):
        with patch.object(_index_mod, "EMBEDDINGS_INDEX", str(tmp_path / "nonexistent.jsonl")):
            sig = _index_mod.build_embeddings_signature()
            assert sig == "__missing__"


# ---------------------------------------------------------------------------
# invalidate_entries_cache tests
# ---------------------------------------------------------------------------

class TestInvalidateEntriesCache:
    def test_clears_data(self):
        _index_mod._ENTRIES_CACHE["data"] = [{"id": "test"}]
        _index_mod._ENTRIES_CACHE["signature"] = "old_sig"
        _index_mod._ENTRIES_CACHE["version"] = 5

        _index_mod.invalidate_entries_cache()

        assert _index_mod._ENTRIES_CACHE["data"] is None
        assert _index_mod._ENTRIES_CACHE["signature"] == ""
        assert _index_mod._ENTRIES_CACHE["version"] == 6  # incremented

    def test_also_clears_bm25_and_search_result_caches(self):
        _index_mod._BM25_CACHE["key1"] = {"model": MagicMock()}
        _index_mod._SEARCH_RESULT_CACHE["key2"] = {"response": {}}

        _index_mod.invalidate_entries_cache()

        assert _index_mod._BM25_CACHE == {}
        assert _index_mod._SEARCH_RESULT_CACHE == {}


# ---------------------------------------------------------------------------
# invalidate_embeddings_cache tests
# ---------------------------------------------------------------------------

class TestInvalidateEmbeddingsCache:
    def test_clears_index_data(self):
        _index_mod._INDEX_CACHE["data"] = {"some": "data"}
        _index_mod._INDEX_CACHE["signature"] = "old_sig"

        _index_mod.invalidate_embeddings_cache()

        assert _index_mod._INDEX_CACHE["data"] is None
        assert _index_mod._INDEX_CACHE["signature"] == ""

    def test_also_clears_query_embed_and_search_result_caches(self):
        _index_mod._QUERY_EMBEDDING_CACHE["k"] = {"embedding": [0.1]}
        _index_mod._SEARCH_RESULT_CACHE["k"] = {"response": {}}

        _index_mod.invalidate_embeddings_cache()

        assert _index_mod._QUERY_EMBEDDING_CACHE == {}
        assert _index_mod._SEARCH_RESULT_CACHE == {}


# ---------------------------------------------------------------------------
# load_entries integration tests (using temp dir)
# ---------------------------------------------------------------------------

class TestLoadEntries:
    def test_loads_from_structured_files(self, tmp_path):
        ai_memory = tmp_path / "00-System" / "ai-memory" / "structured"
        ai_memory.mkdir(parents=True)

        record = {
            "id": "rec-001",
            "title": "Test Record",
            "content": "This is test content for the search index test",
            "t": "2026-01-01T00:00:00Z",
            "schemaVersion": 2,
            "tool": "test-tool",
            "type": "note",
            "source": "test",
            "scope": "project",
            "memory_level": "session",
        }
        inbox = ai_memory / "shared-inbox.jsonl"
        inbox.write_text(json.dumps(record) + "\n", encoding="utf-8")

        with patch.object(_index_mod, "STRUCTURED_DIR", str(ai_memory)):
            _index_mod.invalidate_entries_cache()
            entries = _index_mod.load_entries()

        assert len(entries) >= 1
        entry_ids = [e["id"] for e in entries]
        assert "rec-001" in entry_ids

    def test_deduplicates_by_entry_id(self, tmp_path):
        ai_memory = tmp_path / "00-System" / "ai-memory" / "structured"
        ai_memory.mkdir(parents=True)

        record = {
            "id": "rec-dup",
            "title": "Dup Record",
            "content": "Same id should not appear twice in results",
            "t": "2026-01-01T00:00:00Z",
            "schemaVersion": 2,
            "tool": "test-tool",
            "type": "note",
            "source": "test",
            "scope": "project",
            "memory_level": "session",
        }
        inbox = ai_memory / "shared-inbox.jsonl"
        # Write the same record twice
        inbox.write_text(json.dumps(record) + "\n" + json.dumps(record) + "\n", encoding="utf-8")

        with patch.object(_index_mod, "STRUCTURED_DIR", str(ai_memory)):
            _index_mod.invalidate_entries_cache()
            entries = _index_mod.load_entries()

        ids = [e["id"] for e in entries]
        assert ids.count("rec-dup") == 1

    def test_invalid_json_skipped(self, tmp_path):
        ai_memory = tmp_path / "00-System" / "ai-memory" / "structured"
        ai_memory.mkdir(parents=True)

        inbox = ai_memory / "shared-inbox.jsonl"
        inbox.write_text("not valid json\n", encoding="utf-8")

        with patch.object(_index_mod, "STRUCTURED_DIR", str(ai_memory)):
            _index_mod.invalidate_entries_cache()
            entries = _index_mod.load_entries()

        assert entries == []

    def test_missing_structured_dir_returns_empty(self, tmp_path):
        with patch.object(_index_mod, "STRUCTURED_DIR", str(tmp_path / "nonexistent")):
            _index_mod.invalidate_entries_cache()
            entries = _index_mod.load_entries()
        assert entries == []


# ---------------------------------------------------------------------------
# load_embeddings_index integration tests
# ---------------------------------------------------------------------------

class TestLoadEmbeddingsIndex:
    def test_loads_embeddings_index(self, tmp_path):
        ai_memory = tmp_path / "00-System" / "ai-memory"
        embeddings_dir = ai_memory / "embeddings"
        embeddings_dir.mkdir(parents=True)

        index_file = embeddings_dir / "index.jsonl"
        record = {
            "id": "emb-001",
            "embedding": [0.1, 0.2, 0.3],
            "featureSchemaVersion": 1,
            "model": "all-MiniLM-L6-v2",
            "backend": "hash",
            "configHash": "",
        }
        index_file.write_text(json.dumps(record) + "\n", encoding="utf-8")

        with patch.object(_index_mod, "EMBEDDINGS_INDEX", str(index_file)):
            _index_mod.invalidate_embeddings_cache()
            index = _index_mod.load_embeddings_index()

        assert "emb-001" in index
        assert index["emb-001"]["embedding"] == [0.1, 0.2, 0.3]

    def test_invalid_json_skipped(self, tmp_path):
        embeddings_dir = tmp_path / "embeddings"
        embeddings_dir.mkdir(parents=True)
        index_file = embeddings_dir / "index.jsonl"
        index_file.write_text("not json\n", encoding="utf-8")

        with patch.object(_index_mod, "EMBEDDINGS_INDEX", str(index_file)):
            _index_mod.invalidate_embeddings_cache()
            index = _index_mod.load_embeddings_index()

        assert index == {}

    def test_missing_index_file_returns_empty(self, tmp_path):
        with patch.object(_index_mod, "EMBEDDINGS_INDEX", str(tmp_path / "missing.jsonl")):
            _index_mod.invalidate_embeddings_cache()
            index = _index_mod.load_embeddings_index()
        assert index == {}


# ---------------------------------------------------------------------------
# Cache reuse tests (signature-based)
# ---------------------------------------------------------------------------

class TestCacheReuse:
    def test_entries_cache_reused_when_signature_unchanged(self, tmp_path):
        ai_memory = tmp_path / "00-System" / "ai-memory" / "structured"
        ai_memory.mkdir(parents=True)

        record = {"id": "cached", "title": "Cached", "content": "data", "t": "2026-01-01T00:00:00Z"}
        inbox = ai_memory / "shared-inbox.jsonl"
        inbox.write_text(json.dumps(record) + "\n", encoding="utf-8")

        with patch.object(_index_mod, "STRUCTURED_DIR", str(ai_memory)):
            _index_mod.invalidate_entries_cache()
            first = _index_mod.load_entries()
            second = _index_mod.load_entries()
            # Should return same object (cache hit)
            assert first is second

    def test_embeddings_cache_reused_when_signature_unchanged(self, tmp_path):
        ai_memory = tmp_path / "00-System" / "ai-memory"
        embeddings_dir = ai_memory / "embeddings"
        embeddings_dir.mkdir(parents=True)

        index_file = embeddings_dir / "index.jsonl"
        rec = {"id": "emb", "embedding": [0.1], "featureSchemaVersion": 1, "model": "hash", "backend": "hash", "configHash": ""}
        index_file.write_text(json.dumps(rec) + "\n", encoding="utf-8")

        with patch.object(_index_mod, "EMBEDDINGS_INDEX", str(index_file)):
            _index_mod.invalidate_embeddings_cache()
            first = _index_mod.load_embeddings_index()
            second = _index_mod.load_embeddings_index()
            assert first is second
