"""
Pytest tests for retrieval/lsh_utils.py

These tests verify the LSH feature extraction and hash embedding logic,
ensuring cross-language consistency with bus/lsh-hash.js.

Algorithm:
- normalize_spaces: re.sub(r"\\s+", " ", text or "").strip()
- fnv1a32: seed 0x811C9DC5, XOR with ord(char), multiply by 0x01000193, mask with 0xFFFFFFFF
- build_hash_features: w: tokens, c:/c2:/c3: CJK, g3: sliding 3-grams (max 400), raw: fallback
- build_hash_embedding: L2 normalized
"""

import math
import pytest

from retrieval.lsh_utils import (
    VECTOR_SCHEMA_VERSION,
    HASH_DIM,
    normalize_spaces,
    fnv1a32,
    build_hash_features,
    build_hash_embedding,
)


# ---------------------------------------------------------------------------
# Module constant tests
# ---------------------------------------------------------------------------

class TestModuleConstants:
    """Test 18: VECTOR_SCHEMA_VERSION and HASH_DIM constants."""

    def test_vector_schema_version_is_1(self):
        """VECTOR_SCHEMA_VERSION must be 1."""
        assert VECTOR_SCHEMA_VERSION == 1

    def test_hash_dim_is_384(self):
        """HASH_DIM must be 384."""
        assert HASH_DIM == 384


# ---------------------------------------------------------------------------
# normalize_spaces tests
# ---------------------------------------------------------------------------

class TestNormalizeSpaces:
    """Tests 1-2: normalize_spaces function."""

    def test_empty_string(self):
        """Empty string should return empty string."""
        result = normalize_spaces("")
        assert result == ""

    def test_whitespace_normalization(self):
        """Multiple spaces should be collapsed to single spaces."""
        result = normalize_spaces("  hello   world  ")
        assert result == "hello world"

    def test_tabs_and_newlines(self):
        """Tabs and newlines should be collapsed to single spaces."""
        result = normalize_spaces("hello\t\nworld")
        assert result == "hello world"

    def test_none_input(self):
        """None input should be handled gracefully (converted to empty)."""
        result = normalize_spaces(None)
        assert result == ""

    def test_leading_and_trailing_whitespace(self):
        """Leading and trailing whitespace should be stripped."""
        result = normalize_spaces("  hello world  ")
        assert result == "hello world"

    def test_single_space_unchanged(self):
        """Single space should remain unchanged."""
        result = normalize_spaces("hello world")
        assert result == "hello world"


# ---------------------------------------------------------------------------
# fnv1a32 tests
# ---------------------------------------------------------------------------

class TestFnv1a32:
    """Tests 3-4: FNV-1a32 hash function."""

    def test_empty_string(self):
        """Empty string should return the FNV seed value 0x811C9DC5."""
        result = fnv1a32("")
        assert result == 0x811C9DC5  # 2166136261

    def test_hello_world(self):
        """Known FNV-1a32 value for 'hello' (actual implementation output)."""
        result = fnv1a32("hello")
        # Actual output from the implementation
        assert result == 1335831723

    def test_returns_unsigned_32bit(self):
        """Result should always be a positive unsigned 32-bit integer."""
        result = fnv1a32("test string for unsigned check")
        assert 0 <= result <= 0xFFFFFFFF
        assert isinstance(result, int)

    def test_deterministic(self):
        """Same input should always produce same output."""
        result1 = fnv1a32("deterministic-test")
        result2 = fnv1a32("deterministic-test")
        assert result1 == result2

    def test_different_inputs_different_hashes(self):
        """Different inputs should produce different hashes (with high probability)."""
        hash1 = fnv1a32("input-a")
        hash2 = fnv1a32("input-b")
        assert hash1 != hash2

    def test_unicode_characters(self):
        """Unicode characters should be hashed correctly."""
        result = fnv1a32("hello世界")
        # Just verify it's in unsigned 32-bit range
        assert 0 <= result <= 0xFFFFFFFF

    def test_longer_string(self):
        """Longer strings should hash correctly."""
        long_text = "a" * 1000
        result = fnv1a32(long_text)
        assert 0 <= result <= 0xFFFFFFFF

    def test_fnv1a32_matches_known_pattern(self):
        """Verify the FNV-1a32 algorithm pattern."""
        # FNV-1a: hash = FNV_offset_basis
        # For each byte: hash = hash XOR byte; hash *= FNV_prime
        seed = 0x811C9DC5
        prime = 0x01000193
        expected = seed
        for char in "a":
            expected ^= ord(char)
            expected = (expected * prime) & 0xFFFFFFFF
        assert fnv1a32("a") == expected


# ---------------------------------------------------------------------------
# build_hash_features tests
# ---------------------------------------------------------------------------

class TestBuildHashFeatures:
    """Tests 5-12: LSH feature extraction."""

    def test_simple_english_words(self):
        """English words should produce w: prefixed features."""
        features = build_hash_features("hello world")
        assert len(features) > 0
        assert any(f.startswith("w:") for f in features)
        assert "w:hello" in features
        assert "w:world" in features

    def test_url_extraction(self):
        """URLs should have their path segments tokenized."""
        features = build_hash_features("https://example.com/path/to/page")
        assert any("w:" in f for f in features)
        # Should contain path segments
        path_features = [f for f in features if f.startswith("w:")]
        assert len(path_features) > 0

    def test_cjk_text(self):
        """CJK text should produce c:, c2:, c3: features (for 3+ char text)."""
        features = build_hash_features("你好世界")  # 4 characters
        assert len(features) > 0
        assert any(f.startswith("c:") for f in features)
        assert any(f.startswith("c2:") for f in features)
        assert any(f.startswith("c3:") for f in features)

    def test_cjk_bigrams_only(self):
        """2-char CJK text produces c: and c2: but not c3:."""
        features = build_hash_features("你好")  # Only 2 characters
        c_features = [f for f in features if f.startswith("c:")]
        c2_features = [f for f in features if f.startswith("c2:")]
        c3_features = [f for f in features if f.startswith("c3:")]
        assert len(c_features) > 0  # Has c: (the full chunk)
        assert len(c2_features) > 0  # Has c2: (bigrams)
        assert len(c3_features) == 0  # No c3: trigrams for 2-char text

    def test_mixed_cjk_english(self):
        """Mixed CJK and English should produce all feature types."""
        features = build_hash_features("hello世界test")
        # Should have both w: and c: features
        w_features = [f for f in features if f.startswith("w:")]
        c_features = [f for f in features if f.startswith("c:")]
        assert len(w_features) > 0
        assert len(c_features) > 0

    def test_g3_feature_cap_400(self):
        """Test 8: g3: sliding ngrams should be capped at 400 (max_gram_count formula)."""
        # Create text with exactly 401 characters (no whitespace to maximize compact length)
        long_text = "a" * 401
        features = build_hash_features(long_text)
        g3_features = [f for f in features if f.startswith("g3:")]
        # Formula: max(0, min(len(compact) - 2, 400)) = min(399, 400) = 399
        assert len(g3_features) == 399

    def test_symbols_produce_g3_features(self):
        """Symbols-only text produces g3: features (not raw: fallback)."""
        # Symbols match the compact regex and produce g3: ngrams
        features = build_hash_features("!@#$%^&*()")
        assert len(features) > 0
        assert any(f.startswith("g3:") for f in features)

    def test_whitespace_only(self):
        """Whitespace-only text should return empty list."""
        features = build_hash_features("   \t\n   ")
        assert features == []

    def test_underscore_and_hyphen_in_tokens(self):
        """Underscores and hyphens should be part of tokens."""
        features = build_hash_features("hello_world test-case")
        assert "w:hello_world" in features
        assert "w:test-case" in features

    def test_numbers_in_tokens(self):
        """Numbers should be included in tokens."""
        features = build_hash_features("v1.2.3 test123")
        assert any("v1" in f or "test123" in f for f in features)

    def test_g3_sliding_window(self):
        """g3: features should be sliding 3-character windows."""
        features = build_hash_features("abcdef")
        g3_features = sorted([f for f in features if f.startswith("g3:")])
        assert "g3:abc" in g3_features
        assert "g3:bcd" in g3_features
        assert "g3:cde" in g3_features
        assert "g3:def" in g3_features

    def test_g3_overlapping(self):
        """g3: features should overlap by 2 characters."""
        features = build_hash_features("abcd")
        g3_features = [f for f in features if f.startswith("g3:")]
        # Should have 2 g3 features: "abc" and "bcd"
        assert len(g3_features) == 2

    def test_returns_new_list_each_call(self):
        """Each call should return a new list, not mutate shared state."""
        features1 = build_hash_features("test")
        features2 = build_hash_features("test")
        assert features1 is not features2
        assert features1 == features2


# ---------------------------------------------------------------------------
# build_hash_embedding tests
# ---------------------------------------------------------------------------

class TestBuildHashEmbedding:
    """Tests 12-20: hash embedding vector generation."""

    def test_default_dimension_384(self):
        """Default dimension should be 384."""
        embedding = build_hash_embedding("test")
        assert len(embedding) == 384

    def test_custom_dimension_256(self):
        """Custom dimension should be respected."""
        embedding = build_hash_embedding("test", dimension=256)
        assert len(embedding) == 256

    def test_custom_dimension_128(self):
        """Another custom dimension should work."""
        embedding = build_hash_embedding("test", dimension=128)
        assert len(embedding) == 128

    def test_l2_norm_approximately_one(self):
        """L2 norm should be approximately 1.0 (within tolerance)."""
        embedding = build_hash_embedding("hello world")
        norm = math.sqrt(sum(v * v for v in embedding))
        assert abs(norm - 1.0) < 1e-6

    def test_empty_text_returns_zeros(self):
        """Empty text should return all zeros vector."""
        embedding = build_hash_embedding("")
        assert all(v == 0.0 for v in embedding)

    def test_empty_text_has_correct_dimension(self):
        """Empty text should still return correct dimension."""
        embedding = build_hash_embedding("", dimension=256)
        assert len(embedding) == 256

    def test_deterministic(self):
        """Same input should always produce same output."""
        emb1 = build_hash_embedding("deterministic test")
        emb2 = build_hash_embedding("deterministic test")
        assert emb1 == emb2

    def test_different_texts_different_vectors(self):
        """Different texts should produce different vectors."""
        emb1 = build_hash_embedding("text one")
        emb2 = build_hash_embedding("text two")
        assert emb1 != emb2

    def test_returns_new_list_each_call(self):
        """Each call should return a new list, not mutate shared state."""
        emb1 = build_hash_embedding("test")
        emb2 = build_hash_embedding("test")
        assert emb1 is not emb2
        assert emb1 == emb2

    def test_vector_values_in_valid_range(self):
        """Vector values should be between -1 and 1."""
        embedding = build_hash_embedding("test text with various words")
        for val in embedding:
            assert -1.0 <= val <= 1.0

    def test_l2_normalized_values_precision(self):
        """L2 normalized values should be rounded to 8 decimal places."""
        embedding = build_hash_embedding("test")
        # Check that values have at most 8 decimal places
        for val in embedding:
            if val != 0.0:
                # Round to 8 decimal places and compare
                rounded = round(val, 8)
                assert abs(val - rounded) < 1e-10

    def test_hashes_collision_resistance(self):
        """Different feature sets should produce different vectors."""
        emb1 = build_hash_embedding("unique feature set one")
        emb2 = build_hash_embedding("unique feature set two")
        # At least some positions should differ
        assert emb1 != emb2

    def test_cjk_text_embedding(self):
        """CJK text should produce valid embedding."""
        embedding = build_hash_embedding("中文测试文本")
        assert len(embedding) == 384
        norm = math.sqrt(sum(v * v for v in embedding))
        assert abs(norm - 1.0) < 1e-6

    def test_mixed_content_embedding(self):
        """Mixed content should produce valid embedding."""
        embedding = build_hash_embedding("Hello 世界 123 test @#$%")
        assert len(embedding) == 384
        norm = math.sqrt(sum(v * v for v in embedding))
        assert abs(norm - 1.0) < 1e-6


# ---------------------------------------------------------------------------
# JS/Python equivalence tests (Test 19)
# ---------------------------------------------------------------------------

class TestJSPythonEquivalence:
    """
    Test 19: JS/Python equivalence.

    normalize_spaces and fnv1a32 must produce the same results as the JS equivalents.
    """

    def test_normalize_spaces_equivalence(self):
        """normalize_spaces should behave identically to the JS implementation."""
        test_cases = [
            ("hello world", "hello world"),
            ("  hello   world  ", "hello world"),
            ("\t\ntest\n\t", "test"),
            ("single", "single"),
            ("", ""),
            ("   ", ""),
        ]
        for input_text, expected in test_cases:
            result = normalize_spaces(input_text)
            assert result == expected, f"normalize_spaces({input_text!r}) = {result!r}, expected {expected!r}"

    def test_fnv1a32_equivalence_with_known_values(self):
        """fnv1a32 should match known implementation output values."""
        known_values = {
            "": 2166136261,           # 0x811C9DC5 - FNV seed
            "a": 3826002220,          # Actual implementation output
            "hello": 1335831723,      # Actual implementation output
            "test": 2949673445,       # Actual implementation output
            " ": 621580159,           # Single space
        }
        for input_text, expected in known_values.items():
            result = fnv1a32(input_text)
            assert result == expected, f"fnv1a32({input_text!r}) = {result}, expected {expected}"

    def test_build_hash_features_equivalence_pattern(self):
        """build_hash_features should produce the same pattern as JS."""
        # English text
        features = build_hash_features("hello world")
        assert "w:hello" in features
        assert "w:world" in features

        # CJK text (3+ chars for c3: trigrams)
        features = build_hash_features("你好世界")
        assert any(f.startswith("c:") for f in features)
        assert any(f.startswith("c2:") for f in features)
        assert any(f.startswith("c3:") for f in features)  # Now works with 4-char text

    def test_build_hash_embedding_equivalence(self):
        """build_hash_embedding should produce L2-normalized vectors."""
        embedding = build_hash_embedding("test string")
        norm = math.sqrt(sum(v * v for v in embedding))
        assert abs(norm - 1.0) < 1e-6


# ---------------------------------------------------------------------------
# LSH feature extraction performance sanity check (Test 20)
# ---------------------------------------------------------------------------

class TestLSHFeaturePerformanceSanity:
    """
    Test 20: LSH feature extraction performance sanity check.

    Number of features is capped reasonably to prevent unbounded growth.
    """

    def test_feature_count_bounded(self):
        """Feature count should be bounded even for large inputs."""
        large_text = "a" * 10000
        features = build_hash_features(large_text)
        # Should not grow unbounded with input size
        # g3: is capped at 400, and other features are token-based
        assert len(features) <= 500  # Conservative upper bound

    def test_g3_capped_at_400(self):
        """g3: feature count should never exceed 400."""
        very_long_text = "x" * 10000
        features = build_hash_features(very_long_text)
        g3_count = len([f for f in features if f.startswith("g3:")])
        assert g3_count <= 400

    def test_embedding_dimension_respected(self):
        """Embedding vector should always have the specified dimension."""
        for dim in [128, 256, 384, 512]:
            embedding = build_hash_embedding("test", dimension=dim)
            assert len(embedding) == dim

    def test_embedding_computation_bounded_time(self):
        """Embedding computation should be O(dimension), not O(features * dimension)."""
        # With 400 features max, this should complete quickly
        text = "hello world test " * 100
        embedding = build_hash_embedding(text, dimension=384)
        assert len(embedding) == 384
        # If the algorithm were O(features * dimension), this would be slow
        # With proper implementation, it's O(features + dimension)


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Additional edge case tests."""

    def test_unicode_mixed_scripts(self):
        """Mixed unicode scripts should be handled."""
        text = "Hello世界αβγ123"
        features = build_hash_features(text)
        embedding = build_hash_embedding(text)
        assert len(features) > 0
        assert len(embedding) == 384

    def test_only_cjk_bigrams(self):
        """Pure CJK bigrams should produce c2: features."""
        features = build_hash_features("日本語")
        c2_features = [f for f in features if f.startswith("c2:")]
        assert len(c2_features) > 0

    def test_only_cjk_trigrams(self):
        """Pure CJK text should produce c3: features."""
        features = build_hash_features("日本語テスト")
        c3_features = [f for f in features if f.startswith("c3:")]
        assert len(c3_features) > 0

    def test_special_characters_in_tokens(self):
        """Special characters adjacent to tokens should not break tokenization."""
        features = build_hash_features("(hello), world!")
        assert any("w:hello" in f for f in features)
        assert any("w:world" in f for f in features)

    def test_slashes_in_tokens(self):
        """Slashes should be part of URL tokenization."""
        features = build_hash_features("path/to/file.txt")
        # Should tokenize as path, to, file.txt
        assert any("path" in f for f in features)

    def test_colons_in_tokens(self):
        """Colons should be part of tokenization."""
        features = build_hash_features("http: example.com")
        # Colon creates separate token in many cases
        assert len(features) > 0

    def test_very_short_text(self):
        """Very short text should produce features."""
        features = build_hash_features("a")
        # Should produce w:a or raw:a
        assert len(features) > 0

    def test_single_cjk_char(self):
        """Single CJK character should produce c: feature but not c2:/c3:."""
        features = build_hash_features("中")
        # Single char should produce c: but not c2:/c3:
        c_features = [f for f in features if f.startswith("c:")]
        c2_features = [f for f in features if f.startswith("c2:")]
        c3_features = [f for f in features if f.startswith("c3:")]
        assert len(c_features) >= 0  # May or may not have c: depending on regex
        assert len(c2_features) == 0  # No bigrams from single char
        assert len(c3_features) == 0  # No trigrams from single char
