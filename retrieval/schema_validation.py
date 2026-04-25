"""
Schema validation for memory records in the Python retrieval layer.

This module mirrors the validation rules from ops/memory-contract.js to ensure
consistency between the Node.js producer side and Python consumer side.

Schema version: 2
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Schema constants — prefer generated schema, fall back to inline definitions.
# Generated file is produced by ops/adapters/generate-schemas.js from
# ops/adapters/schema-registry.json (the canonical source of truth).
# ---------------------------------------------------------------------------

_gen_schema: Optional[Dict] = None
_generated_path = Path(__file__).parent.parent / "ops" / "adapters" / "generated" / "schema-validation-py.py"
if _generated_path.exists():
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("generated_schema", str(_generated_path))
        if spec and spec.loader:
            _generated_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_generated_module)
            _gen_schema = {
                "MEMORY_RECORD_SCHEMA_VERSION": getattr(_generated_module, "MEMORY_RECORD_SCHEMA_VERSION", None),
                "ALLOWED_SCOPES": getattr(_generated_module, "ALLOWED_SCOPES", None),
                "ALLOWED_VISIBILITY": getattr(_generated_module, "ALLOWED_VISIBILITY", None),
                "ALLOWED_SOURCE_KINDS": getattr(_generated_module, "ALLOWED_SOURCE_KINDS", None),
                "ALLOWED_MEMORY_LEVELS": getattr(_generated_module, "ALLOWED_MEMORY_LEVELS", None),
                "ALLOWED_DURABLE_TYPES": getattr(_generated_module, "ALLOWED_DURABLE_TYPES", None),
                "REQUIRED_FIELDS": getattr(_generated_module, "REQUIRED_FIELDS", None),
            }
    except Exception:
        pass  # Fall through to inline definitions

# Schema version constant matching MEMORY_RECORD_SCHEMA_VERSION in memory-contract.js
MEMORY_RECORD_SCHEMA_VERSION: int = (
    _gen_schema["MEMORY_RECORD_SCHEMA_VERSION"]
    if _gen_schema and _gen_schema["MEMORY_RECORD_SCHEMA_VERSION"] is not None
    else 2
)

# Allowed values matching the Node.js constants
ALLOWED_SCOPES: set = (
    _gen_schema["ALLOWED_SCOPES"]
    if _gen_schema and _gen_schema["ALLOWED_SCOPES"] is not None
    else {"user", "feedback", "project", "reference", "summary", "task", "run"}
)

ALLOWED_VISIBILITY: set = (
    _gen_schema["ALLOWED_VISIBILITY"]
    if _gen_schema and _gen_schema["ALLOWED_VISIBILITY"] is not None
    else {"shared", "private"}
)

ALLOWED_SOURCE_KINDS: set = (
    _gen_schema["ALLOWED_SOURCE_KINDS"]
    if _gen_schema and _gen_schema["ALLOWED_SOURCE_KINDS"] is not None
    else {"writeback", "hook", "session", "event", "blackboard", "run", "cron", "task"}
)

ALLOWED_MEMORY_LEVELS: set = (
    _gen_schema["ALLOWED_MEMORY_LEVELS"]
    if _gen_schema and _gen_schema["ALLOWED_MEMORY_LEVELS"] is not None
    else {"durable", "session", "event", "task"}
)

ALLOWED_DURABLE_TYPES: set = (
    _gen_schema["ALLOWED_DURABLE_TYPES"]
    if _gen_schema and _gen_schema["ALLOWED_DURABLE_TYPES"] is not None
    else {"user", "feedback", "project", "reference"}
)

# Required fields for structured memory layers
REQUIRED_FIELDS: list = (
    _gen_schema["REQUIRED_FIELDS"]
    if _gen_schema and _gen_schema["REQUIRED_FIELDS"] is not None
    else [
        "schemaVersion",
        "id",
        "tool",
        "type",
        "title",
        "source",
        "scope",
        "memory_level",
    ]
)

# 5-tier system (ADR-002 v2): Tier 1=Event/Working, Tier 2=Session Durable,
# Tier 3=Project Durable, Tier 4=Shared Durable, Tier 5=Archive
ALLOWED_TIERS: list = (
    list(_gen_schema["ALLOWED_TIERS"])
    if _gen_schema and _gen_schema.get("ALLOWED_TIERS") is not None
    else [1, 2, 3, 4, 5]
)

# Content hash pattern: 64-character hexadecimal string
CONTENT_HASH_PATTERN = re.compile(r"^[a-f0-9]{64}$", re.IGNORECASE)


def _normalize_string(value) -> str:
    """Normalize a value to a trimmed string."""
    return str(value or "").strip()


def _normalize_lower(value) -> str:
    """Normalize a value to a lowercase trimmed string."""
    return _normalize_string(value).lower()


def _is_finite_number(value) -> bool:
    """Check if value is a finite number."""
    try:
        return isinstance(value, (int, float)) and float(value) == float(value)  # NaN check
    except (TypeError, ValueError):
        return False


def _has_value(value) -> bool:
    """Check if a field has a non-empty value."""
    if _is_finite_number(value):
        return True
    return bool(_normalize_string(value))


def validate_promotion_metadata(promotion: dict) -> List[str]:
    """
    Validate promotion metadata within record metadata.

    Mirrors validatePromotionMetadata in memory-contract.js.
    Returns list of error codes (empty if valid).
    """
    errors: List[str] = []

    if not isinstance(promotion, dict):
        return errors

    # Check promotion version
    version = promotion.get("version")
    if version is not None and version != 1:
        errors.append(f"unknown-promotion-version:{version}")

    # Check durable_type
    durable_type = _normalize_lower(promotion.get("durable_type"))
    if durable_type and durable_type not in ALLOWED_DURABLE_TYPES:
        errors.append(f"unknown-promotion-durable-type:{_normalize_string(promotion.get('durable_type'))}")

    # Check required fields
    if not _normalize_string(promotion.get("key")):
        errors.append("missing-promotion-key")

    if not _normalize_string(promotion.get("reason")):
        errors.append("missing-promotion-reason")

    if not _normalize_string(promotion.get("source_record_id")):
        errors.append("missing-promotion-source-record-id")

    # Check is_refresh type
    is_refresh = promotion.get("is_refresh")
    if is_refresh is not None and not isinstance(is_refresh, bool):
        errors.append("invalid-promotion-is-refresh-type")

    # Check conflict_with array
    conflict_with = promotion.get("conflict_with")
    if isinstance(conflict_with, list):
        if any(not _normalize_string(cid) for cid in conflict_with):
            errors.append("invalid-promotion-conflict-with")

    # Check refresh-specific fields
    if is_refresh is True:
        if not _normalize_string(promotion.get("refresh_of_id")):
            errors.append("missing-promotion-refresh-of-id")

        if not _normalize_string(promotion.get("refresh_of_t")):
            errors.append("missing-promotion-refresh-of-t")

    return errors


def validate_record(record: dict) -> Tuple[bool, List[str]]:
    """
    Validate a single memory record against the schema.

    Mirrors validateStructuredRecord in memory-contract.js.

    Args:
        record: The memory record dict to validate.

    Returns:
        Tuple of (is_valid: bool, errors: List[str])
        errors is empty if the record is valid.
    """
    errors: List[str] = []

    # Check if record is an object (dict)
    if not isinstance(record, dict):
        return False, ["record-not-object"]

    # Check required fields
    missing_fields = [f for f in REQUIRED_FIELDS if not _has_value(record.get(f))]
    if missing_fields:
        errors.append(f"missing-fields:{','.join(missing_fields)}")

    # Check schema version
    schema_version = record.get("schemaVersion")
    if schema_version is not None:
        try:
            parsed_version = int(schema_version)
        except (TypeError, ValueError):
            parsed_version = None

        if parsed_version != MEMORY_RECORD_SCHEMA_VERSION:
            version_str = str(schema_version) if schema_version is not None else "missing"
            errors.append(f"unexpected-schema-version:{version_str}")

    # Check scope
    scope = _normalize_lower(record.get("scope"))
    if scope and scope not in ALLOWED_SCOPES:
        errors.append(f"unknown-scope:{_normalize_string(record.get('scope'))}")

    # Check visibility
    visibility = _normalize_lower(record.get("visibility"))
    if visibility and visibility not in ALLOWED_VISIBILITY:
        errors.append(f"unknown-visibility:{_normalize_string(record.get('visibility'))}")

    # Check source_kind (supports both snake_case and camelCase)
    source_kind = _normalize_lower(record.get("source_kind") or record.get("sourceKind"))
    if source_kind and source_kind not in ALLOWED_SOURCE_KINDS:
        errors.append(f"unknown-source-kind:{_normalize_string(record.get('source_kind') or record.get('sourceKind'))}")

    # Check memory_level (supports both snake_case and camelCase)
    memory_level = _normalize_lower(record.get("memory_level") or record.get("memoryLevel"))
    if memory_level and memory_level not in ALLOWED_MEMORY_LEVELS:
        errors.append(f"unknown-memory-level:{_normalize_string(record.get('memory_level') or record.get('memoryLevel'))}")

    # Check content_hash format
    content_hash = _normalize_string(record.get("content_hash"))
    if content_hash and not CONTENT_HASH_PATTERN.match(content_hash):
        errors.append(f"invalid-content-hash:{content_hash}")

    # Check name type (optional field)
    name = record.get("name")
    if name is not None and not isinstance(name, str):
        errors.append("invalid-name-type")

    # Check description type (optional field)
    description = record.get("description")
    if description is not None and not isinstance(description, str):
        errors.append("invalid-description-type")

    # Check promotion metadata
    metadata = record.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("promotion"), dict):
        promo_errors = validate_promotion_metadata(metadata["promotion"])
        errors.extend(promo_errors)

    return len(errors) == 0, errors


@dataclass
class ValidationResult:
    """
    Result of validating a JSONL file.

    Mirrors the summary structure from analyzeStructuredLayer in memory-contract.js.
    """
    path: str
    exists: bool = False
    record_count: int = 0
    valid_record_count: int = 0
    invalid_record_count: int = 0
    malformed_line_count: int = 0
    latest_record_at: str = ""
    latest_record_at_ms: float = 0.0
    invalid_samples: List[Dict] = field(default_factory=list)
    malformed_samples: List[Dict] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "path": self.path,
            "exists": self.exists,
            "recordCount": self.record_count,
            "validRecordCount": self.valid_record_count,
            "invalidRecordCount": self.invalid_record_count,
            "malformedLineCount": self.malformed_line_count,
            "latestRecordAt": self.latest_record_at,
            "latestRecordAtMs": self.latest_record_at_ms,
            "invalidSamples": self.invalid_samples,
            "malformedSamples": self.malformed_samples,
            "errors": self.errors,
        }


def _parse_timestamp_ms(value: str) -> float:
    """Parse an ISO timestamp string to milliseconds since epoch."""
    if not value:
        return 0.0
    try:
        normalized = str(value).strip().replace("Z", "+00:00")
        from datetime import datetime
        dt = datetime.fromisoformat(normalized)
        return dt.timestamp() * 1000
    except Exception:
        return 0.0


def validate_file(jsonl_path: str, detail_limit: int = 12) -> ValidationResult:
    """
    Validate all records in a JSONL file.

    Mirrors analyzeStructuredLayer in memory-contract.js.

    Args:
        jsonl_path: Path to the JSONL file to validate.
        detail_limit: Maximum number of invalid/malformed samples to collect.

    Returns:
        ValidationResult with summary statistics and sample errors.
    """
    result = ValidationResult(path=jsonl_path)

    # Check if file exists
    if not os.path.exists(jsonl_path):
        return result

    result.exists = True

    # Skip directory validation
    if os.path.isdir(jsonl_path):
        return result

    try:
        with open(jsonl_path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except Exception as e:
        result.errors.append(f"read-error:{str(e)}")
        return result

    for line_num, line in enumerate(lines, start=1):
        line = line.strip()
        if not line:
            continue

        # Try to parse JSON
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as e:
            result.malformed_line_count += 1
            if len(result.malformed_samples) < detail_limit:
                result.malformed_samples.append({
                    "line": line_num,
                    "error": str(e),
                })
            continue

        result.record_count += 1

        # Validate the record
        is_valid, errors = validate_record(payload)

        # Track record ID
        record_id = _normalize_string(payload.get("id"))

        # Track latest timestamp
        timestamp = _parse_timestamp_ms(str(payload.get("t", "")))
        if timestamp > result.latest_record_at_ms:
            result.latest_record_at_ms = timestamp
            result.latest_record_at = str(payload.get("t", "") or "")

        if is_valid:
            result.valid_record_count += 1
        else:
            result.invalid_record_count += 1
            if len(result.invalid_samples) < detail_limit:
                result.invalid_samples.append({
                    "id": record_id or f"line-{line_num}",
                    "line": line_num,
                    "errors": errors,
                })

    return result


def validate_directory(structured_dir: str, detail_limit: int = 12) -> Dict[str, ValidationResult]:
    """
    Validate all structured memory layer files in a directory.

    Args:
        structured_dir: Path to the structured memory directory.
        detail_limit: Maximum number of invalid/malformed samples per file.

    Returns:
        Dict mapping file names to ValidationResult objects.
    """
    results: Dict[str, ValidationResult] = {}

    if not os.path.isdir(structured_dir):
        return results

    for file_name in [
        "shared-inbox.jsonl",
        "session-memory.jsonl",
        "shared-events.jsonl",
        "task-memory.jsonl",
        "claude-code.jsonl",
        "openclaw.jsonl",
        "openclaw-blackboard.jsonl",
        "openclaw-runs.jsonl",
        "openclaw-jobs.jsonl",
        "openclaw-journal.jsonl",
    ]:
        file_path = os.path.join(structured_dir, file_name)
        results[file_name] = validate_file(file_path, detail_limit)

    return results


def validate_schema_consistency(registry_path: Optional[str] = None) -> Dict:
    """
    Compare current schema constants against schema-registry.json.

    Args:
        registry_path: Optional path to schema-registry.json.
                        Defaults to ops/adapters/schema-registry.json.

    Returns:
        Dict with 'ok' (bool) and 'issues' (list of strings).
        Prints to stdout and exits with code 0 when in sync, code 1 when drift detected.
    """
    if registry_path is None:
        registry_path = str(
            Path(__file__).parent.parent / "ops" / "adapters" / "schema-registry.json"
        )

    issues: List[str] = []

    # Load registry
    if not os.path.exists(registry_path):
        return {"ok": False, "issues": [f"registry-not-found: {registry_path}"]}

    try:
        with open(registry_path, "r", encoding="utf-8") as f:
            registry = json.load(f)
    except Exception as e:
        return {"ok": False, "issues": [f"registry-unreadable: {e}"]}

    # Check memory-record-v2 version
    reg_record_version = registry.get("schemas", {}).get("memory-record-v2", {}).get("version")
    if reg_record_version != MEMORY_RECORD_SCHEMA_VERSION:
        issues.append(
            f"memory-record-v2 version mismatch: registry={reg_record_version}, "
            f"current={MEMORY_RECORD_SCHEMA_VERSION}"
        )

    # Check required fields
    reg_required = registry.get("schemas", {}).get("memory-record-v2", {}).get("required") or []
    if sorted(reg_required) != sorted(REQUIRED_FIELDS):
        issues.append(
            f"required fields drift: registry={sorted(reg_required)}, "
            f"current={sorted(REQUIRED_FIELDS)}"
        )

    # Check scope enum
    reg_scopes = registry.get("schemas", {}).get("memory-record-v2", {}).get("enums", {}).get("scope", {}).get("allowed") or []
    if sorted(reg_scopes) != sorted(list(ALLOWED_SCOPES)):
        issues.append(
            f"scope enum drift: registry={sorted(reg_scopes)}, current={sorted(list(ALLOWED_SCOPES))}"
        )

    # Check integrity contract version
    reg_integrity_version = registry.get("schemas", {}).get("integrity-contract-v2", {}).get("version")
    if reg_integrity_version != 2:
        issues.append(
            f"integrity-contract-v2 version mismatch: registry={reg_integrity_version}, current=2"
        )

    return {"ok": len(issues) == 0, "issues": issues}


if __name__ == "__main__":
    # Simple CLI for testing
    import sys

    if len(sys.argv) < 2:
        print("Usage: python schema_validation.py <jsonl_file>")
        sys.exit(1)

    result = validate_file(sys.argv[1])
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
