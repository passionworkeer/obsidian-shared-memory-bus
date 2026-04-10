"""
Tests for PII redaction module.

Migrated from ops/redaction_test.py and converted to pytest format.
Run with: pytest tests/unit/py/test_redaction.py -v
"""

import sys
from pathlib import Path

# Add project root to Python path so 'ops.redaction' resolves
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "ops"))

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
# Test Data
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

class TestEmailPattern:
    def test_detects_all_test_cases(self):
        for email in TEST_EMAILS:
            assert EMAIL.search(email), f"EMAIL pattern failed on: {email}"

    def test_does_not_match_plain_domains(self):
        assert EMAIL.search("user@") is None
        assert EMAIL.search("@example.com") is None


class TestPhonePattern:
    def test_detects_all_test_cases(self):
        for phone in TEST_PHONES:
            assert PHONE.search(phone), f"PHONE pattern failed on: {phone}"


class TestCreditCardPattern:
    def test_detects_all_test_cases(self):
        for card in TEST_CREDIT_CARDS:
            assert CREDIT_CARD.search(card), f"CREDIT_CARD pattern failed on: {card}"

    def test_rejects_too_short_numbers(self):
        assert CREDIT_CARD.search("411111111111") is None


class TestSSNPattern:
    def test_detects_ssn(self):
        for ssn in TEST_SSNS:
            assert SSN.search(ssn), f"SSN pattern failed on: {ssn}"

    def test_rejects_invalid_formats(self):
        assert SSN.search("123456789") is None
        assert SSN.search("12-345-6789") is None


class TestApiKeyPattern:
    def test_detects_all_test_cases(self):
        for key in TEST_API_KEYS:
            assert API_KEY.search(key), f"API_KEY pattern failed on: {key}"


class TestUrlAuthPattern:
    def test_detects_all_test_cases(self):
        for url in TEST_URL_AUTH:
            assert URL_WITH_AUTH.search(url), f"URL_WITH_AUTH pattern failed on: {url}"


# ---------------------------------------------------------------------------
# Redaction Function Tests
# ---------------------------------------------------------------------------

class TestRedactSensitiveToolsMode:
    def setup_method(self):
        REDACTION_CONFIG.reset()

    def test_email_specific_placeholder(self):
        result = redact_sensitive("my email is user@gmail.com", mode="tools")
        assert result == "my email is [REDACTED_EMAIL]"

    def test_multiple_emails(self):
        result = redact_sensitive("Contact me at alice@example.com or bob@site.org", mode="tools")
        assert result == "Contact me at [REDACTED_EMAIL] or [REDACTED_EMAIL]"

    def test_phone(self):
        result = redact_sensitive("Call me at 555-123-4567 tomorrow", mode="tools")
        assert result == "Call me at [REDACTED_PHONE] tomorrow"

    def test_credit_card(self):
        result = redact_sensitive("My card is 4111-1111-1111-1111", mode="tools")
        assert result == "My card is [REDACTED_CREDIT_CARD]"

    def test_ssn(self):
        result = redact_sensitive("SSN: 123-45-6789 is required", mode="tools")
        assert result == "SSN: [REDACTED_SSN] is required"

    def test_api_key(self):
        result = redact_sensitive('api_key="sk-abc123xyz4567890" is set', mode="tools")
        assert "[REDACTED_API_KEY]" in result

    def test_url_auth_no_email_collision(self):
        # URL_WITH_AUTH runs BEFORE EMAIL, so "user:pass@" is stripped completely.
        # The leftover text "example.com" is NOT an email (no local-part before @).
        result = redact_sensitive("Repo: https://user:pass@example.com/repo.git", mode="tools")
        assert "[REDACTED_URL_AUTH]" in result
        assert "[REDACTED_EMAIL]" not in result


class TestRedactSensitiveStrictMode:
    def setup_method(self):
        REDACTION_CONFIG.reset()

    def test_uses_generic_placeholder(self):
        result = redact_sensitive("Email: user@gmail.com, Phone: 555-123-4567", mode="strict")
        assert "[REDACTED]" in result
        assert "[REDACTED_EMAIL]" not in result


class TestRedactSensitiveEdgeCases:
    def setup_method(self):
        REDACTION_CONFIG.reset()

    def test_multiple_pii_types_all_redacted(self):
        text = "Email: user@gmail.com, SSN: 123-45-6789, Card: 4111-1111-1111-1111"
        result = redact_sensitive(text, mode="tools")
        assert "[REDACTED_EMAIL]" in result
        assert "[REDACTED_SSN]" in result
        assert "[REDACTED_CREDIT_CARD]" in result

    def test_non_pii_unchanged(self):
        text = "This is a normal message about programming in Python."
        result = redact_sensitive(text, mode="tools")
        assert result == text

    def test_empty_string_returns_empty(self):
        assert redact_sensitive("", mode="tools") == ""

    def test_none_input_returns_empty(self):
        assert redact_sensitive(None, mode="tools") == ""

    def test_defaults_to_tools_mode(self):
        REDACTION_CONFIG.reset()
        result = redact_sensitive("email: user@gmail.com")
        assert "[REDACTED_EMAIL]" in result
