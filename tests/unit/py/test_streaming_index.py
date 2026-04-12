"""
Tests for retrieval/streaming_index.py

Validates memory-efficient streaming iteration over large JSONL index files
without loading the entire file into memory.
"""
import json
import os
import sys
import tempfile
import types
from pathlib import Path

import pytest

# Ensure retrieval/ is on path
_test_file = Path(__file__).resolve()
_project_root = _test_file.parent.parent.parent.parent  # repo root
_retrieval_dir = _project_root / "retrieval"
for p in [str(_project_root), str(_retrieval_dir)]:
    if p not in sys.path:
        sys.path.insert(0, p)

# ---------------------------------------------------------------------------
# Module import
# ---------------------------------------------------------------------------
try:
    from retrieval.streaming_index import StreamingIndex, StreamingIndexReader
except ImportError as exc:
    pytest.fail(f"Failed to import streaming_index: {exc}")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_index_file(tmp_path):
    """Create a temp JSONL file with 1000 index records."""
    file_path = tmp_path / "test_index.jsonl"
    records = []
    for i in range(1000):
        record = {
            "id": f"rec-{i:04d}",
            "record_id": f"rec-{i:04d}",
            "field": "content",
            "embedding": [0.1 * j for j in range(384)],  # 384-dim vector
            "featureSchemaVersion": 1,
            "model": "hash",
            "backend": "hash",
            "configHash": "test-hash",
            "t": "2026-01-01T00:00:00Z",
        }
        records.append(json.dumps(record))

    with open(file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(records) + "\n")

    return file_path


@pytest.fixture
def empty_index_file(tmp_path):
    """Create an empty index file."""
    file_path = tmp_path / "empty_index.jsonl"
    file_path.write_text("", encoding="utf-8")
    return file_path


# ---------------------------------------------------------------------------
# StreamingIndexReader tests
# ---------------------------------------------------------------------------

class TestStreamingIndexReader:
    """Test StreamingIndexReader — one-pass reader without caching."""

    def test_read_all_records(self, temp_index_file):
        """Reader should yield all 1000 records in one pass."""
        reader = StreamingIndexReader(temp_index_file)
        records = list(reader)
        assert len(records) == 1000

    def test_read_empty_file(self, empty_index_file):
        """Reader should handle empty files gracefully."""
        reader = StreamingIndexReader(empty_index_file)
        records = list(reader)
        assert records == []

    def test_read_missing_file(self, tmp_path):
        """Reader should handle missing files gracefully (yields nothing)."""
        reader = StreamingIndexReader(tmp_path / "nonexistent.jsonl")
        records = list(reader)
        assert records == []

    def test_yields_dicts(self, temp_index_file):
        """Reader should yield dict objects, not strings."""
        reader = StreamingIndexReader(temp_index_file)
        first = next(reader)
        assert isinstance(first, dict)
        assert "id" in first
        assert "embedding" in first

    def test_embedding_vectors_preserved(self, temp_index_file):
        """Embedding vectors should be loaded as lists of floats."""
        reader = StreamingIndexReader(temp_index_file)
        first = next(reader)
        emb = first["embedding"]
        assert isinstance(emb, list)
        assert len(emb) == 384
        assert all(isinstance(v, (int, float)) for v in emb)

    def test_malformed_lines_skipped(self, tmp_path):
        """Reader should skip malformed JSON lines without crashing."""
        file_path = tmp_path / "malformed.jsonl"
        with open(file_path, "w", encoding="utf-8") as f:
            f.write('{"id": "good-1"}\n')
            f.write("not json at all\n")
            f.write('{"id": "good-2"}\n')
            f.write("\n")  # blank line
            f.write('{"broken: json\n')  # unclosed brace

        reader = StreamingIndexReader(file_path)
        records = list(reader)
        assert len(records) == 2
        assert records[0]["id"] == "good-1"
        assert records[1]["id"] == "good-2"

    def test_iterate_returns_generator(self, temp_index_file):
        """iterate() should return a generator type, not a list."""
        reader = StreamingIndexReader(temp_index_file)
        gen = reader.iterate()
        assert isinstance(gen, types.GeneratorType)

    def test_iterator_consumed_exactly_once(self, temp_index_file):
        """Each call to __iter__ should start a fresh pass over the file."""
        reader = StreamingIndexReader(temp_index_file)
        first_pass = list(reader)
        second_pass = list(reader)
        assert len(first_pass) == 1000
        assert len(second_pass) == 1000


# ---------------------------------------------------------------------------
# StreamingIndex tests
# ---------------------------------------------------------------------------

class TestStreamingIndex:
    """Test StreamingIndex — bounded LRU cache over a streaming reader."""

    def test_get_returns_record(self, temp_index_file):
        """get() should return the full record dict for a known ID."""
        index = StreamingIndex(temp_index_file)
        record = index.get("rec-0050")
        assert record is not None
        assert record["id"] == "rec-0050"
        assert isinstance(record["embedding"], list)
        assert len(record["embedding"]) == 384

    def test_get_returns_none_for_unknown_id(self, temp_index_file):
        """get() should return None when the ID is not found."""
        index = StreamingIndex(temp_index_file)
        record = index.get("nonexistent-id")
        assert record is None

    def test_get_embedding_returns_vector(self, temp_index_file):
        """get_embedding() should return just the vector list."""
        index = StreamingIndex(temp_index_file)
        emb = index.get_embedding("rec-0001")
        assert emb is not None
        assert isinstance(emb, list)
        assert len(emb) == 384

    def test_get_embedding_returns_none_for_unknown(self, temp_index_file):
        """get_embedding() should return None for unknown IDs."""
        index = StreamingIndex(temp_index_file)
        emb = index.get_embedding("does-not-exist")
        assert emb is None

    def test_find_by_prefix_returns_generator(self, temp_index_file):
        """find_by_prefix() should return a generator."""
        index = StreamingIndex(temp_index_file)
        result = index.find_by_prefix("rec-00")
        assert isinstance(result, types.GeneratorType)

    def test_find_by_prefix_finds_matching_records(self, temp_index_file):
        """find_by_prefix('rec-00') should return rec-0000 through rec-0099."""
        index = StreamingIndex(temp_index_file)
        results = list(index.find_by_prefix("rec-00"))
        assert len(results) == 100
        ids = [r["id"] for r in results]
        assert "rec-0000" in ids
        assert "rec-0099" in ids
        assert "rec-0100" not in ids

    def test_find_by_prefix_no_matches(self, temp_index_file):
        """find_by_prefix() with no matches returns empty list."""
        index = StreamingIndex(temp_index_file)
        results = list(index.find_by_prefix("nonexistent-prefix"))
        assert results == []

    def test_scan_returns_generator(self, temp_index_file):
        """scan() should return a generator."""
        index = StreamingIndex(temp_index_file)
        result = index.scan()
        assert isinstance(result, types.GeneratorType)

    def test_scan_full_iteration(self, temp_index_file):
        """scan() should iterate over all records."""
        index = StreamingIndex(temp_index_file)
        all_records = list(index.scan())
        assert len(all_records) == 1000

    def test_scan_batched(self, temp_index_file):
        """scan_batched() should yield chunks of the configured size."""
        index = StreamingIndex(temp_index_file)
        batches = list(index.scan_batched(batch_size=100))
        assert len(batches) == 10
        assert len(batches[0]) == 100
        assert len(batches[-1]) == 100

    def test_scan_batched_remainder(self, temp_index_file):
        """scan_batched() should handle non-divisible record counts."""
        index = StreamingIndex(temp_index_file)
        # 1003 records: 10 batches of 100 + 1 batch of 3
        batches = list(index.scan_batched(batch_size=100))
        # We have 1000 records, so 10 batches exactly
        assert len(batches) == 10

    def test_empty_file_scan(self, empty_index_file):
        """scan() on empty file returns empty generator."""
        index = StreamingIndex(empty_index_file)
        records = list(index.scan())
        assert records == []

    def test_cache_stores_hot_entries(self, temp_index_file):
        """Repeated get() calls should hit the cache after the first miss."""
        index = StreamingIndex(temp_index_file)

        # First call: cache miss
        _ = index.get("rec-0001")
        stats_after_first = index.stats()
        assert stats_after_first["misses"] == 1

        # Second call: should be a cache hit
        _ = index.get("rec-0001")
        stats_after_second = index.stats()
        assert stats_after_second["hits"] >= 1

    def test_stats_includes_cache_size(self, temp_index_file):
        """stats() should report current and max cached entries."""
        index = StreamingIndex(temp_index_file)
        _ = index.get("rec-0001")
        stats = index.stats()
        assert "cached_entries" in stats
        assert "max_cached" in stats
        assert "hits" in stats
        assert "misses" in stats
        assert "hit_rate" in stats
        assert stats["max_cached"] == 5000

    def test_max_cached_respected(self, tmp_path):
        """Cache should respect the max_cached parameter."""
        # Create 100 records
        file_path = tmp_path / "small_index.jsonl"
        records = []
        for i in range(100):
            rec = {
                "id": f"x-{i:03d}",
                "record_id": f"x-{i:03d}",
                "field": "content",
                "embedding": [0.1] * 10,
                "featureSchemaVersion": 1,
                "model": "hash",
                "backend": "hash",
                "configHash": "",
                "t": "2026-01-01T00:00:00Z",
            }
            records.append(json.dumps(rec))
        file_path.write_text("\n".join(records) + "\n", encoding="utf-8")

        index = StreamingIndex(file_path, max_cached=10)

        # Access 20 unique entries — only 10 should be cached
        for i in range(20):
            index.get(f"x-{i:03d}")

        assert index.stats()["cached_entries"] <= 10

    def test_cache_eviction_on_overflow(self, tmp_path):
        """Old entries should be evicted when cache exceeds max size."""
        file_path = tmp_path / "evict_index.jsonl"
        records = []
        for i in range(50):
            rec = {
                "id": f"y-{i:03d}",
                "record_id": f"y-{i:03d}",
                "field": "content",
                "embedding": [0.1] * 10,
                "featureSchemaVersion": 1,
                "model": "hash",
                "backend": "hash",
                "configHash": "",
                "t": "2026-01-01T00:00:00Z",
            }
            records.append(json.dumps(rec))
        file_path.write_text("\n".join(records) + "\n", encoding="utf-8")

        index = StreamingIndex(file_path, max_cached=5)

        # Fill cache past capacity
        for i in range(10):
            index.get(f"y-{i:03d}")

        # Cache should not exceed max_cached
        assert index.stats()["cached_entries"] <= 5

    def test_nonexistent_file_get(self, tmp_path):
        """get() on a nonexistent file should return None gracefully."""
        index = StreamingIndex(tmp_path / "does_not_exist.jsonl")
        result = index.get("any-id")
        assert result is None

    def test_nonexistent_file_scan(self, tmp_path):
        """scan() on a nonexistent file should return empty generator."""
        index = StreamingIndex(tmp_path / "does_not_exist.jsonl")
        records = list(index.scan())
        assert records == []
