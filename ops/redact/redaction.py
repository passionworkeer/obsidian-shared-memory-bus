"""
PII redaction module for obsidian-shared-memory-bus.

Detects and redacts sensitive information from text before embedding/storage
so that private data never leaves the local memory bus in plain form.

Usage:
    from ops.redaction import redact_sensitive, REDACTION_CONFIG
    cleaned = redact_sensitive("my email is user@gmail.com", mode="tools")
    # -> "my email is [REDACTED_EMAIL]"

    # Strict mode replaces everything with a single placeholder:
    cleaned = redact_sensitive("my email is user@gmail.com", mode="strict")
    # -> "my email is [REDACTED]"

    # Integration with build_entry pipeline:
    from ops.redaction import add_to_python_pipeline
    pipeline_fn = add_to_python_pipeline(build_entry)
    entries = pipeline_fn(payload)
"""

from __future__ import annotations

import os
import re
from typing import Callable, List, Optional, Tuple

# ---------------------------------------------------------------------------
# PII Detection Patterns
# ---------------------------------------------------------------------------

# Credit card numbers: 16 digits with optional separators (groups of 4)
CREDIT_CARD = re.compile(r"\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b")

# US Social Security Numbers: 3-2-4 format
SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")

# API keys, tokens, secrets, passwords: "key: value" style credentials
# Matches "api_key", "api key", "api-key", "token", "secret", "password" (case-insensitive)
# followed by 8+ word characters (covers base64, hex, etc.)
API_KEY = re.compile(r"(api[\s_-]?key|token|secret|password)\s*[:=]\s*[\"\']?[\w-]{8,}[\"\']?", re.I)

# Email addresses
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")

# Phone numbers: 10 digits with optional separators (US-centric, extendable)
PHONE = re.compile(r"\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b")

# URLs with embedded credentials: https://user:pass@example.com
URL_WITH_AUTH = re.compile(r"https?://[\w-]+:[\w-]+@")

# Built-in pattern registry: (name, regex, placeholder_in_tools_mode)
# Order matters: URL_WITH_AUTH must come before EMAIL so that "user:pass@host"
# is stripped before EMAIL can match "pass@host" in the leftover text.
BUILTIN_PATTERNS: List[Tuple[str, re.Pattern, str]] = [
    ("URL_AUTH",     URL_WITH_AUTH,   "[REDACTED_URL_AUTH]"),
    ("CREDIT_CARD",  CREDIT_CARD,     "[REDACTED_CREDIT_CARD]"),
    ("SSN",          SSN,             "[REDACTED_SSN]"),
    ("API_KEY",      API_KEY,         "[REDACTED_API_KEY]"),
    ("EMAIL",        EMAIL,           "[REDACTED_EMAIL]"),
    ("PHONE",        PHONE,           "[REDACTED_PHONE]"),
]

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _resolve_mode() -> str:
    raw = os.environ.get("AI_MEMORY_REDACTION_MODE", "tools").strip().lower()
    return raw if raw in ("tools", "strict") else "tools"


def _resolve_enabled() -> bool:
    raw = os.environ.get("AI_MEMORY_REDACTION_ENABLED", "true").strip().lower()
    return raw not in ("0", "false", "no", "off")


# Guards for env-sourced custom patterns (AI_MEMORY_REDACTION_CUSTOM_PATTERNS).
# Env regexes are user-controlled input; without guards a valid-but-catastrophic
# pattern (e.g. (a+)+) can cause exponential backtracking on tool payloads.
MAX_CUSTOM_PATTERN_LEN = 200
# Heuristic: a quantifier (* + ?) applied to a group whose last token is itself
# a quantifier — the textbook ReDoS signature. Conservative: false positives
# just cause a pattern to be rejected (logged), not a runtime hang.
_REDOX_NESTED_QUANTIFIER = re.compile(r"\([^()]*[*+?][^()]*\)[+*]")


def _resolve_custom_patterns() -> List[Tuple[str, re.Pattern, str]]:
    """Parse AI_MEMORY_REDACTION_CUSTOM_PATTERNS env var.

    Format: "name1:regex1|name2:regex2|..."
    Each regex must match a single group that captures the sensitive value.

    Example:
        AI_MEMORY_REDACTION_CUSTOM_PATTERNS="IPADDR:\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"
    """
    raw = os.environ.get("AI_MEMORY_REDACTION_CUSTOM_PATTERNS", "").strip()
    if not raw:
        return []

    results: List[Tuple[str, re.Pattern, str]] = []
    for entry in raw.split("|"):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            continue
        name_part, pattern_part = entry.split(":", 1)
        name = name_part.strip()
        pattern_str = pattern_part.strip()
        if not name or not pattern_str:
            continue
        try:
            if len(pattern_str) > MAX_CUSTOM_PATTERN_LEN:
                import sys as _sys
                _sys.stderr.write(
                    f"[redaction] skipped overlong custom pattern '{name}' "
                    f"(>{MAX_CUSTOM_PATTERN_LEN} chars)\n"
                )
                continue
            if _REDOX_NESTED_QUANTIFIER.search(pattern_str):
                import sys as _sys
                _sys.stderr.write(
                    f"[redaction] skipped custom pattern '{name}' "
                    f"(nested-quantifier ReDoS heuristic)\n"
                )
                continue
            compiled = re.compile(pattern_str)
            results.append((name, compiled, f"[REDACTED_{name.upper()}]"))
        except re.error as exc:
            import sys as _sys
            _sys.stderr.write(f"[redaction] skipped invalid custom pattern '{name}': {exc}\n")
    return results


# ---------------------------------------------------------------------------
# REDACTION_CONFIG — global config dict
# ---------------------------------------------------------------------------

class _RedactionConfig:
    """Lazy-computed config that respects environment variables."""

    __slots__ = ("_enabled", "_mode", "_custom_patterns")

    def __init__(self) -> None:
        self._enabled: Optional[bool] = None
        self._mode: Optional[str] = None
        self._custom_patterns: Optional[List[Tuple[str, re.Pattern, str]]] = None

    @property
    def enabled(self) -> bool:
        if self._enabled is None:
            self._enabled = _resolve_enabled()
        return self._enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        self._enabled = bool(value)

    @property
    def mode(self) -> str:
        if self._mode is None:
            self._mode = _resolve_mode()
        return self._mode

    @mode.setter
    def mode(self, value: str) -> None:
        if value not in ("tools", "strict"):
            raise ValueError("mode must be 'tools' or 'strict'")
        self._mode = value

    @property
    def custom_patterns(self) -> List[Tuple[str, re.Pattern, str]]:
        if self._custom_patterns is None:
            self._custom_patterns = _resolve_custom_patterns()
        return self._custom_patterns

    def all_patterns(self) -> List[Tuple[str, re.Pattern, str]]:
        return BUILTIN_PATTERNS + list(self.custom_patterns)

    def reset(self) -> None:
        """Reset cached values (useful for testing)."""
        self._enabled = None
        self._mode = None
        self._custom_patterns = None


REDACTION_CONFIG = _RedactionConfig()

# ---------------------------------------------------------------------------
# Core Redaction Functions
# ---------------------------------------------------------------------------

def redact_sensitive(text: str, mode: Optional[str] = None) -> str:
    """
    Scan ``text`` for known PII patterns and replace each match with a
    type-specific placeholder (tools mode) or a generic ``[REDACTED]``
    marker (strict mode).

    Args:
        text: Input string to sanitize. If None or not a string, returns ""
        mode: Override the redaction mode for this call.
              "tools"  -> type-specific placeholders (e.g. [REDACTED_EMAIL])
              "strict" -> single [REDACTED] placeholder for all types
              None     -> use REDACTION_CONFIG.mode

    Returns:
        Sanitized copy of ``text`` (never mutates the original).
    """
    if not isinstance(text, str):
        return ""

    if not REDACTION_CONFIG.enabled:
        return text

    effective_mode = (mode or REDACTION_CONFIG.mode).lower()
    if effective_mode not in ("tools", "strict"):
        effective_mode = "tools"

    if effective_mode == "strict":
        generic = "[REDACTED]"
        for _, pattern, _ in REDACTION_CONFIG.all_patterns():
            text = pattern.sub(generic, text)
        return text

    # tools mode: type-specific placeholders
    result = text
    for _, pattern, placeholder in REDACTION_CONFIG.all_patterns():
        result = pattern.sub(placeholder, result)
    return result


# ---------------------------------------------------------------------------
# Pipeline Integration
# ---------------------------------------------------------------------------

def add_to_python_pipeline(
    build_fn: Callable[[dict], List[dict]]
) -> Callable[[dict], List[dict]]:
    """
    Wrap a ``build_entry``-style function so that the ``content`` and ``title``
    fields of each payload are redacted before the builder processes them.

    This is the recommended way to add redaction to the memory-bus pipeline:
    replace ``build_entry`` with ``add_to_python_pipeline(build_entry)`` in
    ``retrieval/semantic-search.py``.

    Wrapped function signature is identical to the original:
        entries: List[dict] = redacted_build_entry(payload)

    The ``REDACTION_CONFIG`` dict controls whether redaction is active and
    which mode ("tools" | "strict") is used. Override per-call with
    ``REDACTION_CONFIG.mode = "strict"`` or by passing ``mode`` to
    ``redact_sensitive``.

    Returns:
        A wrapper that applies field-level redaction to ``content`` and
        ``title`` before delegating to ``build_fn``.
    """

    def wrapper(payload: dict) -> List[dict]:
        if not isinstance(payload, dict):
            return build_fn(payload) if callable(build_fn) else []

        effective_mode = REDACTION_CONFIG.mode

        # Build a shallow copy of payload so the original is never mutated.
        sanitized: dict = dict(payload)

        for field in ("content", "title", "description"):
            raw = payload.get(field)
            if isinstance(raw, str) and raw:
                sanitized[field] = redact_sensitive(raw, mode=effective_mode)

        # Also scan facts and concepts items (list of strings or {value:[str]} dicts)
        for list_field in ("facts", "concepts"):
            items = sanitized.get(list_field)
            if not isinstance(items, list):
                continue
            sanitized_list: List = []
            for item in items:
                if isinstance(item, str):
                    sanitized_list.append(redact_sensitive(item, mode=effective_mode))
                elif isinstance(item, dict):
                    sanitized_dict = dict(item)
                    raw_val = item.get("value")
                    if isinstance(raw_val, list):
                        sanitized_dict["value"] = [
                            redact_sensitive(str(v), mode=effective_mode) if isinstance(v, str) else v
                            for v in raw_val
                        ]
                    elif isinstance(raw_val, str):
                        sanitized_dict["value"] = redact_sensitive(raw_val, mode=effective_mode)
                    sanitized_list.append(sanitized_dict)
                else:
                    sanitized_list.append(item)
            sanitized[list_field] = sanitized_list

        return build_fn(sanitized)

    return wrapper
