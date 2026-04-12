"""
Pytest tests for retrieval/embedding_providers.py

Tests pure functions: build_embedding_config_hash, get_provider_host,
_backoff_delay, _parse_batch_response, and BatchBuilder class.
"""

import pytest

from retrieval.embedding_providers import (
    build_embedding_config_hash,
    get_provider_host,
    _backoff_delay,
    _parse_batch_response,
    BatchBuilder,
    Chunk,
    ProviderBatch,
)


# ---------------------------------------------------------------------------
# build_embedding_config_hash tests
# ---------------------------------------------------------------------------

class TestBuildEmbeddingConfigHash:
    """Tests for build_embedding_config_hash function."""

    def test_same_inputs_produce_same_hash(self):
        """Identical inputs must always produce the same hash."""
        hash1 = build_embedding_config_hash("hash", "all-MiniLM-L6-v2", "")
        hash2 = build_embedding_config_hash("hash", "all-MiniLM-L6-v2", "")
        assert hash1 == hash2

    def test_different_adapter_produces_different_hash(self):
        """Different adapter values must produce different hashes."""
        hash1 = build_embedding_config_hash("hash", "all-MiniLM-L6-v2", "")
        hash2 = build_embedding_config_hash("openai-compatible", "all-MiniLM-L6-v2", "")
        assert hash1 != hash2

    def test_different_model_produces_different_hash(self):
        """Different model names must produce different hashes."""
        hash1 = build_embedding_config_hash("hash", "all-MiniLM-L6-v2", "")
        hash2 = build_embedding_config_hash("hash", "bge-small-en-v1.5", "")
        assert hash1 != hash2

    def test_different_base_url_produces_different_hash(self):
        """Different base_url values must produce different hashes for openai-compatible."""
        hash1 = build_embedding_config_hash("openai-compatible", "text-embedding-3-small", "https://api.openai.com")
        hash2 = build_embedding_config_hash("openai-compatible", "text-embedding-3-small", "https://api.another.com")
        assert hash1 != hash2

    def test_empty_adapter_and_model(self):
        """Empty adapter and model should be handled gracefully."""
        hash1 = build_embedding_config_hash("", "", "")
        assert isinstance(hash1, str)
        assert len(hash1) > 0

    def test_none_inputs(self):
        """None inputs should be handled gracefully."""
        # normalize_embedding_adapter handles None via normalize_string
        hash1 = build_embedding_config_hash(None, None, None)
        assert isinstance(hash1, str)
        assert len(hash1) > 0

    def test_hash_length_is_16_chars(self):
        """Hash should be exactly 16 characters (first 16 of SHA-1 hex)."""
        hash_result = build_embedding_config_hash("hash", "test-model", "")
        assert len(hash_result) == 16
        assert hash_result.isalnum()


# ---------------------------------------------------------------------------
# get_provider_host tests
# ---------------------------------------------------------------------------

class TestGetProviderHost:
    """Tests for get_provider_host function."""

    def test_https_url_extracts_host(self):
        """HTTPS URL should extract the host without scheme."""
        result = get_provider_host("https://api.openai.com/v1")
        assert result == "api.openai.com"

    def test_http_url_extracts_host(self):
        """HTTP URL should extract the host without scheme."""
        result = get_provider_host("http://localhost:8000")
        assert result == "localhost:8000"

    def test_url_without_scheme(self):
        """URL without scheme should still extract host if possible."""
        result = get_provider_host("api.openai.com/v1")
        # Without scheme, pattern won't match, returns empty
        assert result == ""

    def test_trailing_slash_stripped(self):
        """URL with trailing slash should have it stripped."""
        result = get_provider_host("https://api.openai.com/")
        assert result == "api.openai.com"

    def test_empty_string(self):
        """Empty string should return empty string."""
        result = get_provider_host("")
        assert result == ""

    def test_none_input(self):
        """None input should return empty string."""
        result = get_provider_host(None)
        assert result == ""

    def test_url_with_port_and_path(self):
        """URL with port and path should extract host:port only."""
        result = get_provider_host("https://localhost:11434/v1/embeddings")
        assert result == "localhost:11434"


# ---------------------------------------------------------------------------
# _backoff_delay tests
# ---------------------------------------------------------------------------

class TestBackoffDelay:
    """Tests for _backoff_delay function.

    The implementation uses: raw = min_ms * (2 ** (attempt - 1))
    So attempt=0 gives 0.5x, attempt=1 gives 1x, attempt=2 gives 2x, etc.
    """

    def test_attempt_0_is_half_min_ms(self):
        """Attempt 0 (first retry) should return approximately 0.5x min_ms before jitter."""
        result = _backoff_delay(attempt=0, min_ms=1000, max_ms=5000, jitter_ratio=0.0)
        # With attempt=0: raw = 1000 * 0.5 = 500
        assert result == 500

    def test_attempt_1_returns_min_ms(self):
        """Attempt 1 should return min_ms before jitter."""
        result = _backoff_delay(attempt=1, min_ms=1000, max_ms=5000, jitter_ratio=0.0)
        # With attempt=1: raw = 1000 * 1 = 1000
        assert result == 1000

    def test_attempt_2_returns_double_min_ms(self):
        """Attempt 2 should return 2x min_ms."""
        result = _backoff_delay(attempt=2, min_ms=1000, max_ms=10000, jitter_ratio=0.0)
        # With attempt=2: raw = 1000 * 2 = 2000
        assert result == 2000

    def test_respects_max_ms_cap(self):
        """Delay should not exceed max_ms (ignoring jitter)."""
        result = _backoff_delay(attempt=10, min_ms=1000, max_ms=2400, jitter_ratio=0.0)
        # With attempt=10: raw = 1000 * 512 = 512000, but capped at 2400
        assert result <= 2400

    def test_returns_integer(self):
        """Backoff delay should return an integer."""
        result = _backoff_delay(attempt=1, min_ms=1000, max_ms=5000, jitter_ratio=0.1)
        assert isinstance(result, int)

    def test_zero_jitter_is_deterministic(self):
        """With zero jitter, same attempt should give same result."""
        result1 = _backoff_delay(attempt=2, min_ms=1000, max_ms=10000, jitter_ratio=0.0)
        result2 = _backoff_delay(attempt=2, min_ms=1000, max_ms=10000, jitter_ratio=0.0)
        assert result1 == result2

    def test_high_attempt_hits_max(self):
        """Very high attempt numbers should hit max_ms cap."""
        result = _backoff_delay(attempt=20, min_ms=100, max_ms=500, jitter_ratio=0.0)
        assert result == 500

    def test_jitter_increases_delay(self):
        """With jitter, result should be higher than base delay."""
        base = _backoff_delay(attempt=1, min_ms=1000, max_ms=5000, jitter_ratio=0.0)
        with_jitter = _backoff_delay(attempt=1, min_ms=1000, max_ms=5000, jitter_ratio=0.2)
        assert with_jitter >= base


# ---------------------------------------------------------------------------
# _parse_batch_response tests
# ---------------------------------------------------------------------------

class TestParseBatchResponse:
    """Tests for _parse_batch_response function."""

    def test_valid_json_with_data(self):
        """Valid JSON with data field should parse correctly."""
        body = '{"data": [{"embedding": [0.1, 0.2, 0.3]}], "model": "test", "usage": {"total_tokens": 10}}'
        result, error = _parse_batch_response(body)
        assert error is None
        assert result is not None
        assert len(result) == 1
        assert result[0][0] == [0.1, 0.2, 0.3]
        assert result[0][1] is None

    def test_missing_data_key_raises_error(self):
        """Missing 'data' key should return error."""
        body = '{"model": "test", "usage": {}}'
        result, error = _parse_batch_response(body)
        assert error is not None
        assert result is None

    def test_empty_data_array_returns_error(self):
        """Empty data array should return error."""
        body = '{"data": [], "model": "test"}'
        result, error = _parse_batch_response(body)
        assert error is not None
        assert result is None

    def test_malformed_json_raises_error(self):
        """Malformed JSON should return error."""
        body = '{"data": [invalid json}'
        result, error = _parse_batch_response(body)
        assert error is not None
        assert result is None

    def test_multiple_embeddings(self):
        """Multiple embeddings in data array should all be parsed."""
        body = '{"data": [{"embedding": [1.0]}, {"embedding": [2.0]}]}'
        result, error = _parse_batch_response(body)
        assert error is None
        assert result is not None
        assert len(result) == 2
        assert result[0][0] == [1.0]
        assert result[1][0] == [2.0]

    def test_empty_vector_returns_error_slot(self):
        """Empty embedding vector should return error slot, not fail."""
        body = '{"data": [{"embedding": []}]}'
        result, error = _parse_batch_response(body)
        assert error is None
        assert result is not None
        assert result[0][0] is None
        assert result[0][1] is not None


# ---------------------------------------------------------------------------
# Chunk dataclass tests
# ---------------------------------------------------------------------------

class TestChunkDataclass:
    """Tests for Chunk dataclass."""

    def test_chunk_creation(self):
        """Chunk should store text, chunk_id, and metadata."""
        chunk = Chunk(text="hello world", chunk_id="test-1", metadata={"source": "test"})
        assert chunk.text == "hello world"
        assert chunk.chunk_id == "test-1"
        assert chunk.metadata == {"source": "test"}

    def test_chunk_defaults(self):
        """Chunk should have default empty values."""
        chunk = Chunk(text="hello")
        assert chunk.text == "hello"
        assert chunk.chunk_id == ""
        assert chunk.metadata == {}


# ---------------------------------------------------------------------------
# ProviderBatch dataclass tests
# ---------------------------------------------------------------------------

class TestProviderBatchDataclass:
    """Tests for ProviderBatch dataclass."""

    def test_provider_batch_creation(self):
        """ProviderBatch should store adapter, model, runtime, and chunks."""
        chunks = [Chunk(text="hello")]
        runtime = {"baseUrl": "https://api.openai.com"}
        batch = ProviderBatch(adapter="openai-compatible", model="text-embedding-3-small", runtime=runtime, chunks=chunks)
        assert batch.adapter == "openai-compatible"
        assert batch.model == "text-embedding-3-small"
        assert batch.runtime == runtime
        assert batch.chunks == chunks

    def test_provider_batch_defaults(self):
        """ProviderBatch should have default empty chunks list."""
        batch = ProviderBatch(adapter="hash", model="test", runtime={})
        assert batch.chunks == []


# ---------------------------------------------------------------------------
# BatchBuilder tests
# ---------------------------------------------------------------------------

class TestBatchBuilder:
    """Tests for BatchBuilder class."""

    def test_add_single_chunk(self):
        """add() should append a chunk to the internal batch."""
        builder = BatchBuilder()
        builder.add(text="hello world", adapter="hash", model="test", runtime={})
        assert len(builder) == 1

    def test_add_returns_none(self):
        """add() should return None (not chainable)."""
        builder = BatchBuilder()
        result = builder.add(text="hello", adapter="hash", model="test", runtime={})
        assert result is None

    def test_add_batch_multiple_chunks(self):
        """add_batch() should add multiple chunks with prefix-based chunk IDs."""
        builder = BatchBuilder()
        builder.add_batch(
            texts=["chunk1", "chunk2", "chunk3"],
            adapter="hash",
            model="test",
            runtime={},
            chunk_ids=["a", "b", "c"],
        )
        assert len(builder) == 3

    def test_add_batch_with_metadata(self):
        """add_batch() should apply metadata to each chunk."""
        builder = BatchBuilder()
        metas = [{"index": 0}, {"index": 1}]
        builder.add_batch(
            texts=["hello", "world"],
            adapter="hash",
            model="test",
            runtime={},
            metadatas=metas,
        )
        batches = builder.batches()
        assert len(batches) == 1
        assert batches[0].chunks[0].metadata == {"index": 0}
        assert batches[0].chunks[1].metadata == {"index": 1}

    def test_batches_groups_by_adapter(self):
        """batches() should group chunks by (adapter, model, runtime)."""
        builder = BatchBuilder()
        builder.add(text="chunk1", adapter="hash", model="model1", runtime={})
        builder.add(text="chunk2", adapter="openai-compatible", model="model2", runtime={"baseUrl": "https://api.test.com"})
        builder.add(text="chunk3", adapter="hash", model="model1", runtime={})
        builder.add(text="chunk4", adapter="openai-compatible", model="model2", runtime={"baseUrl": "https://api.test.com"})

        batches = builder.batches()
        # Should have 2 groups: hash+model1 and openai-compatible+model2
        assert len(batches) == 2

    def test_batches_respects_runtime(self):
        """batches() should separate chunks with different runtimes."""
        builder = BatchBuilder()
        builder.add(text="chunk1", adapter="openai-compatible", model="test", runtime={"baseUrl": "https://api.a.com"})
        builder.add(text="chunk2", adapter="openai-compatible", model="test", runtime={"baseUrl": "https://api.b.com"})

        batches = builder.batches()
        assert len(batches) == 2

    def test_len_returns_total_chunks(self):
        """__len__() should return total number of chunks across all batches."""
        builder = BatchBuilder()
        assert len(builder) == 0
        builder.add(text="c1", adapter="hash", model="m1", runtime={})
        builder.add(text="c2", adapter="hash", model="m1", runtime={})
        builder.add(text="c3", adapter="openai-compatible", model="m2", runtime={"baseUrl": "https://test.com"})
        assert len(builder) == 3

    def test_make_key_format(self):
        """_make_key() should produce expected format."""
        key = BatchBuilder._make_key("hash", "model1", {})
        assert key == "hash|model1|"

        key_with_url = BatchBuilder._make_key("openai-compatible", "model1", {"baseUrl": "https://api.test.com"})
        assert key_with_url == "openai-compatible|model1|https://api.test.com"

    def test_split_key_roundtrip(self):
        """_split_key() should reverse _make_key() correctly."""
        adapter, model, runtime = BatchBuilder._split_key("hash|model1|")
        assert adapter == "hash"
        assert model == "model1"
        assert runtime == {}

    def test_split_key_with_base_url(self):
        """_split_key() should restore baseUrl for openai-compatible."""
        adapter, model, runtime = BatchBuilder._split_key("openai-compatible|model1|https://api.test.com")
        assert adapter == "openai-compatible"
        assert model == "model1"
        assert runtime == {"baseUrl": "https://api.test.com"}

    def test_batches_preserves_order(self):
        """batches() should return groups in insertion order."""
        builder = BatchBuilder()
        builder.add(text="a", adapter="a", model="m", runtime={})
        builder.add(text="b", adapter="b", model="m", runtime={})
        builder.add(text="c", adapter="c", model="m", runtime={})
        batches = builder.batches()
        adapters = [b.adapter for b in batches]
        assert adapters == ["a", "b", "c"]

    def test_empty_builder(self):
        """Empty builder should return empty batches list."""
        builder = BatchBuilder()
        assert builder.batches() == []
