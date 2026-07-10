"""
Pytest tests for retrieval/schema_validation.py

These tests mirror the validation rules from ops/memory-contract.js
to ensure cross-language consistency between Node.js and Python.

Schema version: 2
"""

import pytest

from retrieval.schema_validation import (
    ALLOWED_SCOPES,
    ALLOWED_VISIBILITY,
    ALLOWED_SOURCE_KINDS,
    ALLOWED_MEMORY_LEVELS,
    ALLOWED_DURABLE_TYPES,
    MEMORY_RECORD_SCHEMA_VERSION,
    validate_record,
    validate_promotion_metadata,
)


# ---------------------------------------------------------------------------
# Module constant tests
# ---------------------------------------------------------------------------

class TestModuleConstants:
    """Test that module constants match the expected values."""

    def test_memory_record_schema_version_is_2(self):
        """MEMORY_RECORD_SCHEMA_VERSION must be 2."""
        assert MEMORY_RECORD_SCHEMA_VERSION == 2

    def test_allowed_scopes(self):
        """ALLOWED_SCOPES must contain the expected values."""
        expected = {"user", "feedback", "project", "reference", "summary", "task", "run"}
        assert ALLOWED_SCOPES == expected

    def test_allowed_visibility(self):
        """ALLOWED_VISIBILITY must contain shared and private."""
        assert ALLOWED_VISIBILITY == {"shared", "private"}

    def test_allowed_source_kinds(self):
        """ALLOWED_SOURCE_KINDS must contain the expected values."""
        expected = {"writeback", "hook", "session", "event", "blackboard", "run", "cron", "task"}
        assert ALLOWED_SOURCE_KINDS == expected

    def test_allowed_memory_levels(self):
        """ALLOWED_MEMORY_LEVELS must contain the expected values."""
        expected = {"durable", "session", "event", "task"}
        assert ALLOWED_MEMORY_LEVELS == expected

    def test_allowed_durable_types(self):
        """ALLOWED_DURABLE_TYPES must contain the expected values."""
        expected = {"user", "feedback", "project", "reference"}
        assert ALLOWED_DURABLE_TYPES == expected


# ---------------------------------------------------------------------------
# validate_record() tests
# ---------------------------------------------------------------------------

def _make_record(**overrides):
    """Helper: build a minimal valid record and apply overrides."""
    record = {
        "schemaVersion": 2,
        "id": "rec-001",
        "tool": "memory_writeback",
        "type": "note",
        "title": "Test record",
        "source": "test-source",
        "scope": "user",
        "memory_level": "durable",
        "sourceKind": "writeback",
        "visibility": "shared",
        "content_hash": "a" * 64,
    }
    record.update(overrides)
    return record


class TestValidateRecordFullyValid:
    """Test 1: fully valid record."""

    def test_returns_true_with_empty_errors(self):
        record = _make_record()
        is_valid, errors = validate_record(record)
        assert is_valid is True
        assert errors == []


class TestValidateRecordTypeChecks:
    """Tests 2-3: record type validation."""

    def test_none_record(self):
        """None input should return record-not-object."""
        is_valid, errors = validate_record(None)
        assert is_valid is False
        assert "record-not-object" in errors

    def test_string_record(self):
        """String input should return record-not-object."""
        is_valid, errors = validate_record("not a dict")
        assert is_valid is False
        assert "record-not-object" in errors


class TestValidateRecordMissingFields:
    """Tests 4-8: missing required field detection."""

    def test_missing_id(self):
        """Missing 'id' should appear in missing-fields error."""
        record = _make_record()
        del record["id"]
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("id" in e for e in errors)

    def test_missing_title(self):
        """Missing 'title' should appear in missing-fields error."""
        record = _make_record()
        del record["title"]
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("title" in e for e in errors)

    def test_missing_source(self):
        """Missing 'source' should appear in missing-fields error."""
        record = _make_record()
        del record["source"]
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("source" in e for e in errors)

    def test_missing_scope(self):
        """Missing 'scope' should appear in missing-fields error."""
        record = _make_record()
        del record["scope"]
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("scope" in e for e in errors)

    def test_missing_memory_level(self):
        """Missing 'memory_level' should appear in missing-fields error."""
        record = _make_record()
        del record["memory_level"]
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("memory_level" in e for e in errors)


class TestValidateRecordSchemaVersion:
    """Tests 9-11: schemaVersion field validation."""

    def test_schema_version_1(self):
        """schemaVersion=1 should produce unexpected-schema-version:1."""
        record = _make_record(schemaVersion=1)
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert "unexpected-schema-version:1" in errors

    def test_schema_version_999(self):
        """schemaVersion=999 should produce unexpected-schema-version:999."""
        record = _make_record(schemaVersion=999)
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert "unexpected-schema-version:999" in errors

    def test_schema_version_2_is_valid(self):
        """schemaVersion=2 is the correct version and should pass."""
        record = _make_record(schemaVersion=2)
        is_valid, errors = validate_record(record)
        assert is_valid is True
        # Ensure no schema version error appears
        assert not any("schema-version" in e for e in errors)


class TestValidateRecordScope:
    """Tests 12-13: scope field validation."""

    def test_invalid_scope(self):
        """Unknown scope should produce unknown-scope error."""
        record = _make_record(scope="invalid-scope")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("unknown-scope" in e for e in errors)

    def test_valid_scope_user(self):
        """scope='user' is valid."""
        record = _make_record(scope="user")
        is_valid, errors = validate_record(record)
        assert is_valid is True


class TestValidateRecordVisibility:
    """Tests 14-15: visibility field validation."""

    def test_invalid_visibility(self):
        """Unknown visibility should produce unknown-visibility error."""
        record = _make_record(visibility="invalid-visibility")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("unknown-visibility" in e for e in errors)

    def test_valid_visibility_shared(self):
        """visibility='shared' is valid."""
        record = _make_record(visibility="shared")
        is_valid, errors = validate_record(record)
        assert is_valid is True


class TestValidateRecordSourceKind:
    """Tests 16-17: sourceKind field validation."""

    def test_invalid_source_kind(self):
        """Unknown sourceKind should produce unknown-source-kind error."""
        record = _make_record(sourceKind="invalid-source-kind")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("unknown-source-kind" in e for e in errors)

    def test_valid_source_kind_writeback(self):
        """sourceKind='writeback' is valid."""
        record = _make_record(sourceKind="writeback")
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_source_kind_snake_case(self):
        """source_kind (snake_case) should also work."""
        record = _make_record()
        del record["sourceKind"]
        record["source_kind"] = "session"
        is_valid, errors = validate_record(record)
        assert is_valid is True


class TestValidateRecordMemoryLevel:
    """Tests 18-19: memory_level field validation."""

    def test_invalid_memory_level(self):
        """Unknown memory_level should produce unknown-memory-level error."""
        record = _make_record(memory_level="invalid-memory-level")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("unknown-memory-level" in e for e in errors)

    def test_valid_memory_level_durable(self):
        """memory_level='durable' is valid."""
        record = _make_record(memory_level="durable")
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_memory_level_camel_case(self):
        """memoryLevel (camelCase) should also work when memory_level is present."""
        record = _make_record()
        # Both can coexist; camelCase is a fallback for the enum check
        record["memoryLevel"] = "session"
        is_valid, errors = validate_record(record)
        assert is_valid is True


class TestValidateRecordContentHash:
    """Tests 20-22: content_hash field validation."""

    def test_content_hash_too_short(self):
        """content_hash with wrong length should produce invalid-content-hash."""
        record = _make_record(content_hash="abc123")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("invalid-content-hash" in e for e in errors)

    def test_content_hash_too_long(self):
        """content_hash longer than 64 chars should be invalid."""
        record = _make_record(content_hash="a" * 65)
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("invalid-content-hash" in e for e in errors)

    def test_content_hash_non_hex(self):
        """content_hash with non-hex characters should be invalid."""
        record = _make_record(content_hash="g" * 64)  # 'g' is not hex
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("invalid-content-hash" in e for e in errors)

    def test_content_hash_uppercase_hex(self):
        """content_hash with uppercase hex should be valid (case insensitive)."""
        record = _make_record(content_hash="A" * 64)
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_content_hash_valid_64_char_hex(self):
        """Valid 64-character hex content_hash should pass."""
        record = _make_record(content_hash="deadbeef" * 8)
        is_valid, errors = validate_record(record)
        assert is_valid is True
        assert not any("content-hash" in e for e in errors)


class TestValidateRecordOptionalFields:
    """Tests 23-24: optional field type validation."""

    def test_name_wrong_type(self):
        """name with non-string type should produce invalid-name-type."""
        record = _make_record(name=12345)
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert "invalid-name-type" in errors

    def test_description_wrong_type(self):
        """description with non-string type should produce invalid-description-type."""
        record = _make_record(description=["not", "a", "string"])
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert "invalid-description-type" in errors

    def test_name_none_is_valid(self):
        """name=None is allowed (optional field)."""
        record = _make_record()
        record["name"] = None
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_description_none_is_valid(self):
        """description=None is allowed (optional field)."""
        record = _make_record()
        record["description"] = None
        is_valid, errors = validate_record(record)
        assert is_valid is True


# ---------------------------------------------------------------------------
# validate_promotion_metadata() tests
# ---------------------------------------------------------------------------

def _make_promotion(**overrides):
    """Helper: build a minimal valid promotion dict."""
    promotion = {
        "version": 1,
        "key": "promoted-key",
        "reason": "User requested promotion",
        "source_record_id": "src-001",
        "durable_type": "user",
    }
    promotion.update(overrides)
    return promotion


class TestValidatePromotionMetadataValid:
    """Test 25: valid promotion metadata."""

    def test_valid_promotion_returns_empty_errors(self):
        promotion = _make_promotion()
        errors = validate_promotion_metadata(promotion)
        assert errors == []


class TestValidatePromotionMetadataVersion:
    """Test 26: promotion version validation."""

    def test_version_0_unknown(self):
        """version=0 should produce unknown-promotion-version:0."""
        promotion = _make_promotion(version=0)
        errors = validate_promotion_metadata(promotion)
        assert "unknown-promotion-version:0" in errors

    def test_version_2_unknown(self):
        """version=2 should produce unknown-promotion-version:2."""
        promotion = _make_promotion(version=2)
        errors = validate_promotion_metadata(promotion)
        assert "unknown-promotion-version:2" in errors

    def test_version_missing_rejected(self):
        """Missing version is rejected — mirrors JS validatePromotionMetadata,
        where `promotion.version !== 1` errors on undefined. Previously Python
        silently allowed missing version, diverging from JS integrity reports."""
        promotion = _make_promotion()
        del promotion["version"]
        errors = validate_promotion_metadata(promotion)
        assert any("unknown-promotion-version" in e for e in errors)


class TestValidatePromotionMetadataDurableType:
    """Test 27: durable_type validation."""

    def test_invalid_durable_type(self):
        """durable_type not in ALLOWED_DURABLE_TYPES should error."""
        promotion = _make_promotion(durable_type="task")  # 'task' not allowed
        errors = validate_promotion_metadata(promotion)
        assert any("unknown-promotion-durable-type" in e for e in errors)

    def test_valid_durable_type_reference(self):
        """durable_type='reference' is valid."""
        promotion = _make_promotion(durable_type="reference")
        errors = validate_promotion_metadata(promotion)
        assert not any("durable-type" in e for e in errors)

    def test_empty_durable_type_allowed(self):
        """Empty durable_type is allowed (optional field)."""
        promotion = _make_promotion()
        promotion["durable_type"] = ""
        errors = validate_promotion_metadata(promotion)
        assert not any("durable-type" in e for e in errors)


class TestValidatePromotionMetadataRequiredFields:
    """Tests 28-30: required promotion fields."""

    def test_missing_key(self):
        """Missing 'key' should produce missing-promotion-key."""
        promotion = _make_promotion()
        del promotion["key"]
        errors = validate_promotion_metadata(promotion)
        assert "missing-promotion-key" in errors

    def test_missing_reason(self):
        """Missing 'reason' should produce missing-promotion-reason."""
        promotion = _make_promotion()
        del promotion["reason"]
        errors = validate_promotion_metadata(promotion)
        assert "missing-promotion-reason" in errors

    def test_missing_source_record_id(self):
        """Missing 'source_record_id' should produce missing-promotion-source-record-id."""
        promotion = _make_promotion()
        del promotion["source_record_id"]
        errors = validate_promotion_metadata(promotion)
        assert "missing-promotion-source-record-id" in errors


class TestValidatePromotionMetadataIsRefresh:
    """Tests 31-34: is_refresh field validation."""

    def test_is_refresh_non_bool(self):
        """is_refresh with non-bool type should produce invalid-promotion-is-refresh-type."""
        promotion = _make_promotion(is_refresh="true")
        errors = validate_promotion_metadata(promotion)
        assert "invalid-promotion-is-refresh-type" in errors

    def test_is_refresh_true_without_refresh_of_id(self):
        """is_refresh=True without refresh_of_id should error."""
        promotion = _make_promotion(is_refresh=True)
        promotion.pop("refresh_of_id", None)
        errors = validate_promotion_metadata(promotion)
        assert "missing-promotion-refresh-of-id" in errors

    def test_is_refresh_true_without_refresh_of_t(self):
        """is_refresh=True without refresh_of_t should error."""
        promotion = _make_promotion(is_refresh=True)
        promotion.pop("refresh_of_t", None)
        errors = validate_promotion_metadata(promotion)
        assert "missing-promotion-refresh-of-t" in errors

    def test_is_refresh_true_with_both_refresh_fields(self):
        """is_refresh=True with both refresh_of_id and refresh_of_t is valid."""
        promotion = _make_promotion(
            is_refresh=True,
            refresh_of_id="old-rec-001",
            refresh_of_t="2024-01-01T00:00:00Z",
        )
        errors = validate_promotion_metadata(promotion)
        assert errors == []


class TestValidatePromotionMetadataConflictWith:
    """Test 35: conflict_with field validation."""

    def test_conflict_with_empty_string_in_list(self):
        """conflict_with containing empty string should error."""
        promotion = _make_promotion(conflict_with=["valid-id", ""])
        errors = validate_promotion_metadata(promotion)
        assert "invalid-promotion-conflict-with" in errors

    def test_conflict_with_valid_ids(self):
        """conflict_with with valid non-empty IDs is allowed."""
        promotion = _make_promotion(conflict_with=["id-1", "id-2"])
        errors = validate_promotion_metadata(promotion)
        assert "invalid-promotion-conflict-with" not in errors

    def test_conflict_with_empty_list_allowed(self):
        """conflict_with=[] is allowed."""
        promotion = _make_promotion(conflict_with=[])
        errors = validate_promotion_metadata(promotion)
        assert not any("conflict-with" in e for e in errors)


class TestValidatePromotionMetadataNonDict:
    """Test that non-dict promotion input is handled gracefully."""

    def test_promotion_is_none(self):
        """None promotion should return empty errors (not a dict check)."""
        errors = validate_promotion_metadata(None)
        assert errors == []

    def test_promotion_is_string(self):
        """String promotion should return empty errors (not a dict check)."""
        errors = validate_promotion_metadata("not a dict")
        assert errors == []


# ---------------------------------------------------------------------------
# Cross-language consistency tests
# ---------------------------------------------------------------------------

class TestCrossLanguageConsistency:
    """
    Test 36: Cross-language consistency hint.

    Both JS and Python must agree on the same validation results for the same inputs.
    These tests document the expected equivalence.
    """

    def test_valid_record_js_python_equivalence(self):
        """A record valid in JS should be valid in Python."""
        record = _make_record()
        is_valid, errors = validate_record(record)
        assert is_valid is True
        assert errors == []

    def test_invalid_scope_js_python_equivalence(self):
        """An invalid scope in JS should be invalid in Python."""
        record = _make_record(scope="invalid")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("unknown-scope" in e for e in errors)

    def test_valid_promotion_js_python_equivalence(self):
        """A valid promotion in JS should be valid in Python."""
        promotion = _make_promotion()
        errors = validate_promotion_metadata(promotion)
        assert errors == []

    def test_invalid_promotion_version_js_python_equivalence(self):
        """An invalid promotion version in JS should be invalid in Python."""
        promotion = _make_promotion(version=99)
        errors = validate_promotion_metadata(promotion)
        assert "unknown-promotion-version:99" in errors


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestValidateRecordEdgeCases:
    """Additional edge case tests."""

    def test_empty_record(self):
        """Empty dict should fail (missing required fields)."""
        is_valid, errors = validate_record({})
        assert is_valid is False
        assert "missing-fields" in errors[0]

    def test_record_with_extra_fields_allowed(self):
        """Extra fields beyond the schema should be allowed."""
        record = _make_record(custom_field="extra", another_field=12345)
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_record_with_all_allowed_scopes(self):
        """Every allowed scope value should pass."""
        for scope in ALLOWED_SCOPES:
            record = _make_record(scope=scope)
            is_valid, errors = validate_record(record)
            assert is_valid is True, f"scope={scope} should be valid"

    def test_record_with_all_allowed_visibility(self):
        """Every allowed visibility value should pass."""
        for visibility in ALLOWED_VISIBILITY:
            record = _make_record(visibility=visibility)
            is_valid, errors = validate_record(record)
            assert is_valid is True, f"visibility={visibility} should be valid"

    def test_record_with_all_allowed_source_kinds(self):
        """Every allowed sourceKind value should pass."""
        for source_kind in ALLOWED_SOURCE_KINDS:
            record = _make_record(sourceKind=source_kind)
            is_valid, errors = validate_record(record)
            assert is_valid is True, f"sourceKind={source_kind} should be valid"

    def test_record_with_all_allowed_memory_levels(self):
        """Every allowed memory_level value should pass."""
        for level in ALLOWED_MEMORY_LEVELS:
            record = _make_record(memory_level=level)
            is_valid, errors = validate_record(record)
            assert is_valid is True, f"memory_level={level} should be valid"

    def test_record_with_promotion_metadata(self):
        """Record with valid promotion metadata should be valid."""
        record = _make_record()
        record["metadata"] = {"promotion": _make_promotion()}
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_record_with_invalid_promotion_metadata(self):
        """Record with invalid promotion metadata should fail."""
        record = _make_record()
        record["metadata"] = {"promotion": _make_promotion(version=99)}
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("unknown-promotion-version" in e for e in errors)

    def test_record_with_promotion_none(self):
        """Record with metadata.promotion=None should be valid (not a dict)."""
        record = _make_record()
        record["metadata"] = {"promotion": None}
        is_valid, errors = validate_record(record)
        assert is_valid is True

    def test_record_with_empty_string_required_field(self):
        """Empty string for required field should fail."""
        record = _make_record(title="")
        is_valid, errors = validate_record(record)
        assert is_valid is False
        assert any("title" in e for e in errors)
