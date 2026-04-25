"""
ops/adapters/generated/schema-validation-py.py

AUTO-GENERATED — do not edit by hand.
Source: ops/adapters/schema-registry.json

This file is derived from the canonical schema registry. It provides
schema constants for use by retrieval/schema_validation.py.
If this file is missing, schema_validation.py falls back to inline definitions.
"""

from __future__ import annotations

# Schema version constants matching memory-contract.js
MEMORY_RECORD_SCHEMA_VERSION: int = 2
MEMORY_INTEGRITY_CONTRACT_VERSION: int = 2

# Allowed values matching the Node.js constants
ALLOWED_SCOPES: set = {
    "user",
    "feedback",
    "project",
    "reference",
    "summary",
    "task",
    "run",
}
ALLOWED_VISIBILITY: set = {
    "shared",
    "private",
}
ALLOWED_SOURCE_KINDS: set = {
    "writeback",
    "hook",
    "session",
    "event",
    "blackboard",
    "run",
    "cron",
    "task",
}
ALLOWED_MEMORY_LEVELS: set = {
    "durable",
    "session",
    "event",
    "task",
}
ALLOWED_DURABLE_TYPES: set = {
    "user",
    "feedback",
    "project",
    "reference",
}

# Required fields for structured memory layers (mirrored in memory-contract.js)
REQUIRED_FIELDS: list = [
    "schemaVersion",
    "id",
    "tool",
    "type",
    "title",
    "source",
    "scope",
    "memory_level",
]

# 5-tier system (ADR-002 v2)
ALLOWED_TIERS: list = [
    1,
    2,
    3,
    4,
    5,
]

# Registry metadata
SCHEMA_REGISTRY_VERSION: int = 1
SCHEMA_REGISTRY_GENERATED_AT: str = "2026-04-25T04:17:59.109Z"
