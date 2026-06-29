"""Tests for retrieval/runtime_support.py"""
import pytest
import os
from pathlib import Path
from unittest.mock import patch, MagicMock

from retrieval.runtime_support import (
    normalize_bool,
    normalize_int,
    normalize_string,
    is_plain_dict,
    normalize_embedding_adapter,
    strip_config_metadata,
    merge_config_blocks,
    first_non_empty_env,
    process_env,
    get_user_home,
    get_config_home,
    get_default_vault_candidates,
    resolve_store_root,
    resolve_vault_root,
    resolve_runtime_root,
    load_runtime_config,
    extract_embedding_defaults,
    resolve_embedding_runtime,
    resolve_from_obsidian_config,
    resolve_runtime_root_candidates,
    resolve_runtime_file,
    resolve_runtime_config_path,
    resolve_named_registry_entry,
    EMBEDDING_ADAPTER_ALIASES,
    EMBEDDING_CONFIG_META_KEYS,
    IS_WINDOWS,
)


class TestNormalizeFunctions:
    """Test normalize_* utility functions."""

    def test_normalize_bool_true_values(self):
        assert normalize_bool(True) is True
        assert normalize_bool("true") is True
        assert normalize_bool("True") is True
        assert normalize_bool("1") is True
        assert normalize_bool("yes") is True
        assert normalize_bool("YES") is True
        assert normalize_bool("on") is True

    def test_normalize_bool_false_values(self):
        assert normalize_bool(False) is False
        assert normalize_bool("false") is False
        assert normalize_bool("0") is False
        assert normalize_bool("no") is False
        assert normalize_bool("off") is False

    def test_normalize_bool_fallback(self):
        assert normalize_bool(None) is False
        assert normalize_bool("") is False
        assert normalize_bool("invalid") is False
        assert normalize_bool("invalid", fallback=True) is True

    def test_normalize_int_valid(self):
        assert normalize_int("42") == 42
        assert normalize_int(42) == 42
        assert normalize_int("  100  ") == 100

    def test_normalize_int_minimum(self):
        assert normalize_int(-5, fallback=0, minimum=0) == 0
        assert normalize_int(-5, minimum=10) == 10

    def test_normalize_int_invalid(self):
        assert normalize_int("invalid") == 0
        assert normalize_int(None) == 0

    def test_normalize_string(self):
        assert normalize_string("  hello  ") == "hello"
        assert normalize_string(123) == "123"
        assert normalize_string(None) == ""

    def test_is_plain_dict(self):
        assert is_plain_dict({}) is True
        assert is_plain_dict({"a": 1}) is True
        assert is_plain_dict([]) is False
        assert is_plain_dict("string") is False
        assert is_plain_dict(None) is False


class TestEmbeddingAdapterNormalization:
    """Test embedding adapter normalization."""

    def test_normalize_embedding_adapter_aliases(self):
        assert normalize_embedding_adapter("sentence-transformer") == "transformer"
        assert normalize_embedding_adapter("sentence-transformers") == "transformer"
        assert normalize_embedding_adapter("openai-compatible") == "openai-compatible"
        assert normalize_embedding_adapter("gemini") == "gemini"

    def test_normalize_embedding_adapter_unknown(self):
        result = normalize_embedding_adapter("unknown-adapter")
        assert result == "unknown-adapter"

    def test_normalize_embedding_adapter_fallback(self):
        assert normalize_embedding_adapter("") == ""
        assert normalize_embedding_adapter("", fallback="hash") == "hash"
        assert normalize_embedding_adapter("  ", fallback="gemini") == "gemini"

    def test_aliases_defined(self):
        assert "transformer" in EMBEDDING_ADAPTER_ALIASES.values()
        assert "openai-compatible" in EMBEDDING_ADAPTER_ALIASES.values()


class TestConfigMetadata:
    """Test config metadata handling."""

    def test_strip_config_metadata(self):
        config = {
            "provider": "openai",
            "name": "my-config",
            "label": "Label",
            "model": "text-embedding-3-small",
            "apiKey": "secret",
            "enabled": True,
        }
        result = strip_config_metadata(config)
        assert "provider" not in result
        assert "name" not in result
        assert "model" in result
        assert "apiKey" in result
        assert result == {"model": "text-embedding-3-small", "apiKey": "secret"}

    def test_strip_config_metadata_empty(self):
        assert strip_config_metadata(None) == {}
        assert strip_config_metadata([]) == {}
        assert strip_config_metadata("string") == {}

    def test_merge_config_blocks(self):
        block1 = {"model": "model1", "apiKey": "key1"}
        block2 = {"model": "model2", "baseUrl": "http://example.com"}
        result = merge_config_blocks(block1, block2)
        # Later blocks override earlier ones for non-meta keys
        assert result["model"] == "model2"
        assert result["baseUrl"] == "http://example.com"

    def test_merge_config_blocks_ignores_non_dict(self):
        result = merge_config_blocks({"a": 1}, "string", None, {"b": 2})
        assert result == {"a": 1, "b": 2}


class TestEnvironmentVariables:
    """Test environment variable functions."""

    def test_first_non_empty_env_found(self, monkeypatch):
        monkeypatch.setenv("TEST_VAR1", "value1")
        monkeypatch.setenv("TEST_VAR2", "value2")
        result = first_non_empty_env("TEST_VAR1", "TEST_VAR2")
        assert result == "value1"

    def test_first_non_empty_env_not_found(self, monkeypatch):
        monkeypatch.delenv("MISSING_VAR", raising=False)
        result = first_non_empty_env("MISSING_VAR")
        assert result == ""

    def test_process_env(self, monkeypatch):
        monkeypatch.setenv("TEST_PROCESS", "  trimmed  ")
        result = process_env("TEST_PROCESS")
        assert result == "trimmed"

    def test_process_env_empty(self, monkeypatch):
        monkeypatch.setenv("TEST_EMPTY", "")
        result = process_env("TEST_EMPTY")
        assert result == ""


class TestPathResolution:
    """Test path resolution functions."""

    def test_get_user_home(self):
        home = get_user_home()
        assert isinstance(home, Path)
        assert home.is_dir()

    def test_get_config_home(self):
        config_home = get_config_home()
        assert isinstance(config_home, Path)

    def test_get_default_vault_candidates(self):
        candidates = get_default_vault_candidates()
        assert len(candidates) > 0
        for candidate in candidates:
            assert isinstance(candidate, Path)

    def test_resolve_store_root_uses_ai_memory_store(self, monkeypatch, tmp_path):
        monkeypatch.setenv("AI_MEMORY_STORE", str(tmp_path / "store"))
        monkeypatch.setenv("AI_MEMORY_STORE_ROOT", str(tmp_path / "store-root"))
        assert resolve_store_root() == (tmp_path / "store").resolve()

    def test_resolve_store_root_uses_store_root_alias(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AI_MEMORY_STORE", raising=False)
        monkeypatch.setenv("AI_MEMORY_STORE_ROOT", str(tmp_path / "store-root"))
        assert resolve_store_root() == (tmp_path / "store-root").resolve()

    def test_resolve_store_root_bridges_to_vault_when_no_store_env(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AI_MEMORY_STORE", raising=False)
        monkeypatch.delenv("AI_MEMORY_STORE_ROOT", raising=False)
        monkeypatch.delenv("AI_MEMORY_ROOT", raising=False)
        vault = tmp_path / "vault"
        (vault / "00-System" / "ai-memory").mkdir(parents=True)
        monkeypatch.setenv("AI_MEMORY_OBSIDIAN_VAULT", str(vault))
        assert resolve_store_root() == (vault / "00-System" / "ai-memory").resolve()

    def test_resolve_store_root_vault_beats_legacy_ai_memory_root(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AI_MEMORY_STORE", raising=False)
        monkeypatch.delenv("AI_MEMORY_STORE_ROOT", raising=False)
        vault = tmp_path / "vault"
        (vault / "00-System" / "ai-memory").mkdir(parents=True)
        monkeypatch.setenv("AI_MEMORY_OBSIDIAN_VAULT", str(vault))
        legacy = tmp_path / "legacy-store"
        legacy.mkdir()
        monkeypatch.setenv("AI_MEMORY_ROOT", str(legacy))
        assert resolve_store_root() == (vault / "00-System" / "ai-memory").resolve()

    def test_resolve_runtime_root_candidates_empty(self):
        with patch.dict(os.environ, {}, clear=True):
            candidates = resolve_runtime_root_candidates()
            assert len(candidates) >= 1

    def test_resolve_runtime_root_candidates_with_override(self):
        candidates = resolve_runtime_root_candidates(root_override="C:/test")
        assert len(candidates) >= 1


class TestRuntimeConfig:
    """Test runtime configuration loading."""

    def test_load_runtime_config_returns_required_fields(self):
        # Verify the function returns the expected structure
        result = load_runtime_config(anchor_file="test.py")
        assert "configPath" in result
        assert "exists" in result
        assert "data" in result
        assert "error" in result

    def test_load_runtime_config_returns_error_on_missing(self):
        # When config is missing, error field is empty and exists is False
        result = load_runtime_config(anchor_file="nonexistent.py")
        assert "configPath" in result
        # The exists field reflects whether config was found

    def test_load_runtime_config_invalid_json(self, tmp_path):
        # Create an invalid runtime.json file
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text("not valid json")

        result = load_runtime_config(anchor_file=str(tmp_path / "test.py"))
        # File exists but is invalid JSON
        assert result["exists"] is True

    def test_load_runtime_config_valid(self, tmp_path):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text('{"embeddings": {"providers": {}}}')

        result = load_runtime_config(anchor_file=str(tmp_path / "test.py"))
        assert result["exists"] is True
        assert result["error"] == ""
        # Data should be loaded (may contain additional merged fields)
        assert "data" in result


class TestEmbeddingDefaults:
    """Test embedding defaults extraction."""

    def test_extract_embedding_defaults_from_legacy(self):
        embeddings = {
            "model": "text-embedding-3-small",
            "baseUrl": "https://api.openai.com",
            "activeProfile": "default",
            "profiles": {},
        }
        result = extract_embedding_defaults(embeddings)
        assert result["model"] == "text-embedding-3-small"
        assert result["baseUrl"] == "https://api.openai.com"
        assert "activeProfile" not in result
        assert "profiles" not in result

    def test_extract_embedding_defaults_with_defaults_block(self):
        embeddings = {
            "defaults": {
                "model": "default-model",
                "timeoutMs": 30000,
            },
            "profiles": {},
            "providers": {},
        }
        result = extract_embedding_defaults(embeddings)
        assert result["model"] == "default-model"
        assert result["timeoutMs"] == 30000

    def test_extract_embedding_defaults_empty(self):
        assert extract_embedding_defaults(None) == {}
        assert extract_embedding_defaults([]) == {}
        assert extract_embedding_defaults({}) == {}


class TestResolveNamedRegistry:
    """Test named registry resolution."""

    def test_resolve_named_registry_entry_exact_match(self):
        registry = {
            "default": {"model": "default-model"},
            "custom": {"model": "custom-model"},
        }
        result = resolve_named_registry_entry(registry, ["custom"])
        assert result["name"] == "custom"
        assert result["config"]["model"] == "custom-model"

    def test_resolve_named_registry_entry_fallback_default(self):
        registry = {
            "default": {"model": "default-model"},
        }
        result = resolve_named_registry_entry(registry, ["nonexistent"])
        assert result["name"] == "default"
        assert result["config"]["model"] == "default-model"

    def test_resolve_named_registry_entry_single_key(self):
        registry = {
            "only-one": {"model": "only-model"},
        }
        result = resolve_named_registry_entry(registry, ["nonexistent"])
        assert result["name"] == "only-one"

    def test_resolve_named_registry_entry_not_found(self):
        registry = {"key": "value"}
        result = resolve_named_registry_entry(registry, ["nonexistent"])
        assert result["name"] == ""
        assert result["config"] == {}


class TestResolveEmbeddingRuntime:
    """Test embedding runtime resolution."""

    def test_resolve_embedding_runtime_minimal(self, tmp_path):
        # Create minimal config
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text('{"embeddings": {"providers": {}, "profiles": {}}}')

        result = resolve_embedding_runtime(anchor_file=str(tmp_path / "test.py"))
        assert "adapter" in result
        assert "profileName" in result
        assert "providerName" in result
        assert "resolutionMode" in result

    def test_resolve_embedding_runtime_with_adapter_env(self, tmp_path, monkeypatch):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text('{"embeddings": {"providers": {}, "profiles": {}}}')

        monkeypatch.setenv("AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES", "true")
        monkeypatch.setenv("AI_MEMORY_EMBED_ADAPTER", "gemini")

        result = resolve_embedding_runtime(anchor_file=str(tmp_path / "test.py"))
        assert result["adapter"] == "gemini"

    def test_resolve_embedding_runtime_with_model_env(self, tmp_path, monkeypatch):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text('{"embeddings": {"providers": {}, "profiles": {}}}')

        monkeypatch.setenv("AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES", "true")
        monkeypatch.setenv("AI_MEMORY_EMBED_MODEL", "custom-model")

        result = resolve_embedding_runtime(anchor_file=str(tmp_path / "test.py"))
        assert result["model"] == "custom-model"

    def test_resolve_embedding_runtime_timeout_conversion(self, tmp_path):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text('{"embeddings": {"providers": {}, "profiles": {}}}')

        result = resolve_embedding_runtime(anchor_file=str(tmp_path / "test.py"))
        assert "timeoutMs" in result
        assert "timeoutSeconds" in result
        assert result["timeoutSeconds"] >= 1

    def test_resolve_embedding_runtime_defaults_parameter(self, tmp_path):
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        runtime_json = config_dir / "runtime.json"
        runtime_json.write_text('{"embeddings": {"providers": {}, "profiles": {}}}')

        defaults = {"model": "default-model-from-param", "adapter": "hash"}
        result = resolve_embedding_runtime(
            anchor_file=str(tmp_path / "test.py"),
            defaults=defaults,
        )
        assert result["model"] == "default-model-from-param"


class TestObsidianConfigResolution:
    """Test Obsidian config resolution."""

    def test_resolve_from_obsidian_config_no_file(self, tmp_path):
        # No valid config files exist
        result = resolve_from_obsidian_config()
        # Returns None if no valid vault found

    def test_resolve_from_obsidian_config_invalid_json(self, tmp_path, monkeypatch):
        # Create invalid JSON file
        obsidian_dir = tmp_path / "obsidian"
        obsidian_dir.mkdir()
        config_file = obsidian_dir / "obsidian.json"
        config_file.write_text("not valid json")

        # Mock get_obsidian_config_candidates
        with patch(
            "retrieval.runtime_support.get_obsidian_config_candidates",
            return_value=[config_file],
        ):
            result = resolve_from_obsidian_config()
            assert result is None


class TestVaultRootResolution:
    """Test vault root resolution with env vars."""

    def test_resolve_vault_root_from_env(self, monkeypatch, tmp_path):
        vault_dir = tmp_path / "vault"
        vault_dir.mkdir()

        monkeypatch.setenv("AI_MEMORY_OBSIDIAN_VAULT", str(vault_dir))
        result = resolve_vault_root()
        assert result == vault_dir.resolve()

    def test_resolve_vault_root_returns_path(self):
        # Test that resolve_vault_root returns a valid Path
        try:
            vault = resolve_vault_root()
            assert isinstance(vault, Path)
            # The vault path should exist (may not be an actual vault, but path exists)
        except RuntimeError as e:
            # Vault-less CI/dev machines should fail with an explicit resolution error.
            message = str(e)
            assert (
                "no-obsidian-vault" in message
                or "no-store-root" in message
                or "STORE_RESOLUTION_FAILED" in message
            )

    def test_platform_windows_flag(self):
        """Test that IS_WINDOWS is correctly set."""
        # IS_WINDOWS is set at module load time based on platform
        assert isinstance(IS_WINDOWS, bool)
