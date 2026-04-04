"""
Tests for PII redaction module.

Run with:
    python ops/redaction_test.py  # auto-test runner
"""

import sys
from typing import List

# Import the module under test (run from repo root as python ops/redaction_test.py)
from redaction import (
    API_KEY,
    CREDIT_CARD,
    EMAIL,
    PHONE,
    REDACTION_CONFIG,
    SSN,
    URL_WITH_AUTH,
    redact_sensitive,
)

# ---------------------------------------------------------------------------
# Test Data (Real examples)
# ---------------------------------------------------------------------------

TEST_EMAILS = [
    "user@gmail.com",
    "john.doe@example.org",
    "alice+bob@company.io",
    "CEO@Corp.NET",
    "support@sub.domain.com",
]

TEST_PHONES = [
    "555-123-4567",
    "555.123.4567",
    "555 123 4567",
    "5551234567",
]

TEST_CREDIT_CARDS = [
    "4111-1111-1111-1111",
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111.1111.1111.1111",
]

TEST_SSNS = [
    "123-45-6789",
]

TEST_API_KEYS = [
    'api_key="sk-abc123xyz4567890"',
    "api_key='xyz-secret-password'",
    "api_key = 1234567890abcdef",
    'token:"abc123xyz4567890"',
    "api_key:abc123xyz4567890",
    "password=superSecret123",
    "secret=mypassword456",
]

TEST_URL_AUTH = [
    "https://user:pass@example.com",
    "http://admin:p4ssw0rd@server.local:8080",
]

# ---------------------------------------------------------------------------
# Pattern Detection Tests
# ---------------------------------------------------------------------------

def test_email_pattern_detects_all() -> None:
    for email in TEST_EMAILS:
        assert EMAIL.search(email), f"EMAIL pattern failed on: {email}"
    print("PASS: EMAIL pattern detects all test cases")


def test_phone_pattern_detects_all() -> None:
    for phone in TEST_PHONES:
        assert PHONE.search(phone), f"PHONE pattern failed on: {phone}"
    print("PASS: PHONE pattern detects all test cases")


def test_creditcard_pattern_detects_all() -> None:
    for card in TEST_CREDIT_CARDS:
        assert CREDIT_CARD.search(card), f"CREDIT_CARD pattern failed on: {card}"
    print("PASS: CREDIT_CARD pattern detects all test cases")


def test_ssn_pattern_detects_all() -> None:
    for ssn in TEST_SSNS:
        assert SSN.search(ssn), f"SSN pattern failed on: {ssn}"
    print("PASS: SSN pattern detects all test cases")


def test_api_key_pattern_detects_all() -> None:
    for key in TEST_API_KEYS:
        assert API_KEY.search(key), f"API_KEY pattern failed on: {key}"
    print("PASS: API_KEY pattern detects all test cases")


def test_url_auth_pattern_detects_all() -> None:
    for url in TEST_URL_AUTH:
        assert URL_WITH_AUTH.search(url), f"URL_WITH_AUTH pattern failed on: {url}"
    print("PASS: URL_WITH_AUTH pattern detects all test cases")


# ---------------------------------------------------------------------------
# Redaction Function Tests
# ---------------------------------------------------------------------------

def test_tools_mode_email_specific_placeholder() -> None:
    result = redact_sensitive("my email is user@gmail.com", mode="tools")
    assert result == "my email is [REDACTED_EMAIL]", f"Got: {result}"
    print("PASS: tools mode email -> [REDACTED_EMAIL]")


def test_tools_mode_multiple_emails() -> None:
    result = redact_sensitive("Contact me at alice@example.com or bob@site.org", mode="tools")
    assert result == "Contact me at [REDACTED_EMAIL] or [REDACTED_EMAIL]", f"Got: {result}"
    print("PASS: tools mode multiple emails -> [REDACTED_EMAIL] x2")


def test_tools_mode_phone() -> None:
    result = redact_sensitive("Call me at 555-123-4567 tomorrow", mode="tools")
    assert result == "Call me at [REDACTED_PHONE] tomorrow", f"Got: {result}"
    print("PASS: tools mode phone -> [REDACTED_PHONE]")


def test_tools_mode_credit_card() -> None:
    result = redact_sensitive("My card is 4111-1111-1111-1111", mode="tools")
    assert result == "My card is [REDACTED_CREDIT_CARD]", f"Got: {result}"
    print("PASS: tools mode credit card -> [REDACTED_CREDIT_CARD]")


def test_tools_mode_ssn() -> None:
    result = redact_sensitive("SSN: 123-45-6789 is required", mode="tools")
    assert result == "SSN: [REDACTED_SSN] is required", f"Got: {result}"
    print("PASS: tools mode SSN -> [REDACTED_SSN]")


def test_tools_mode_api_key() -> None:
    result = redact_sensitive('api_key="sk-abc123xyz4567890" is set', mode="tools")
    assert "[REDACTED_API_KEY]" in result, f"Got: {result}"
    print("PASS: tools mode api_key -> [REDACTED_API_KEY]")


def test_tools_mode_url_auth() -> None:
    result = redact_sensitive("Repo: https://user:pass@example.com/repo.git", mode="tools")
    # URL_WITH_AUTH runs BEFORE EMAIL, so "user:pass@" is stripped completely.
    # The leftover text "example.com" is NOT an email (no local-part before @).
    assert "[REDACTED_URL_AUTH]" in result
    assert "[REDACTED_EMAIL]" not in result, f"Got: {result}"
    print("PASS: tools mode URL auth -> [REDACTED_URL_AUTH] (no EMAIL collision)")


def test_strict_mode_generic_placeholder() -> None:
    result = redact_sensitive("Email: user@gmail.com, Phone: 555-123-4567", mode="strict")
    assert "[REDACTED]" in result
    assert "[REDACTED_EMAIL]" not in result
    print("PASS: strict mode uses generic [REDACTED]")


def test_multiple_pii_types_in_one_text() -> None:
    text = "Email: user@gmail.com, SSN: 123-45-6789, Card: 4111-1111-1111-1111"
    result = redact_sensitive(text, mode="tools")
    assert "[REDACTED_EMAIL]" in result
    assert "[REDACTED_SSN]" in result
    assert "[REDACTED_CREDIT_CARD]" in result
    print("PASS: multiple PII types all redacted")


def test_non_pii_unchanged() -> None:
    text = "This is a normal message about programming in Python."
    result = redact_sensitive(text, mode="tools")
    assert result == text, f"Got: {result}"
    print("PASS: non-PII text unchanged")


def test_empty_string() -> None:
    assert redact_sensitive("", mode="tools") == ""
    print("PASS: empty string -> empty")


def test_none_input() -> None:
    assert redact_sensitive(None, mode="tools") == ""  # type: ignore
    print("PASS: None -> empty string")


def test_config_defaults_to_tools() -> None:
    REDACTION_CONFIG.reset()
    result = redact_sensitive("email: user@gmail.com")
    assert "[REDACTED_EMAIL]" in result
    print("PASS: REDACTION_CONFIG defaults to tools mode")


# ---------------------------------------------------------------------------
# Main Runner
# ---------------------------------------------------------------------------

def run_all_tests() -> int:
    print("=" * 60)
    print("PII Redaction Module Tests")
    print("=" * 60)

    tests = [
        # Pattern detection
        test_email_pattern_detects_all,
        test_phone_pattern_detects_all,
        test_creditcard_pattern_detects_all,
        test_ssn_pattern_detects_all,
        test_api_key_pattern_detects_all,
        test_url_auth_pattern_detects_all,
        # Function behaviour
        test_tools_mode_email_specific_placeholder,
        test_tools_mode_multiple_emails,
        test_tools_mode_phone,
        test_tools_mode_credit_card,
        test_tools_mode_ssn,
        test_tools_mode_api_key,
        test_tools_mode_url_auth,
        test_strict_mode_generic_placeholder,
        test_multiple_pii_types_in_one_text,
        test_non_pii_unchanged,
        test_empty_string,
        test_none_input,
        test_config_defaults_to_tools,
    ]

    passed = 0
    failed = 0
    failures: List[tuple] = []

    for test in tests:
        try:
            test()
            passed += 1
        except AssertionError as e:
            failed += 1
            failures.append((test.__name__, str(e)))
            print(f"FAIL: {test.__name__}: {e}")

    print()
    print("=" * 60)
    if failed == 0:
        print(f"All {passed} tests passed!")
    else:
        print(f"Results: {passed} passed, {failed} failed")
        for name, msg in failures:
            print(f"  - {name}: {msg}")
    print("=" * 60)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(run_all_tests())
