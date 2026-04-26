"""
Shared runtime helpers for portable ai-memory Python scripts.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

# Dynamically import the sibling platform.py module (avoids stdlib name collision
# and works whether or not retrieval/ is a package with __init__.py).
_platform_spec = importlib.util.spec_from_file_location(
    "_retrieval_platform", os.path.join(os.path.dirname(__file__), "platform.py")
)
assert _platform_spec and _platform_spec.loader
_platform_mod = importlib.util.module_from_spec(_platform_spec)
_platform_spec.loader.exec_module(_platform_mod)

# Module-level aliases (use underscore prefix to avoid shadowing wrapper functions below)
_get_config_home = _platform_mod.get_config_home
_get_default_store_root = _platform_mod.get_default_store_root
_get_home_dir = _platform_mod.get_home_dir
_get_obsidian_config_candidates = _platform_mod.get_obsidian_config_candidates
_get_platform_name = _platform_mod.get_platform_name
_is_windows_fn = _platform_mod.is_windows

IS_WINDOWS = _is_windows_fn()
IS_MACOS = _get_platform_name() == "darwin"

# Re-export for external callers (same interface as original)
is_windows = _is_windows_fn
get_platform_name = _get_platform_name
get_default_store_root = _get_default_store_root
_WINDOWS_ENV_CACHE: Dict[str, str] = {}
EMBEDDING_RUNTIME_RESERVED_KEYS = {
    "activeProfile",
    "activeProvider",
    "profiles",
    "providers",
    "defaults",
}
EMBEDDING_CONFIG_META_KEYS = {
    "provider",
    "name",
    "label",
    "description",
    "notes",
    "enabled",
}
EMBEDDING_ADAPTER_ALIASES = {
    "hash": "hash",
    "hashing": "hash",
    "transformer": "transformer",
    "sentence-transformer": "transformer",
    "sentence-transformers": "transformer",
    "openai": "openai-compatible",
    "openai-compatible": "openai-compatible",
    "gemini": "gemini",
}


def normalize_bool(value: object, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if not text:
        return fallback
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return fallback


def normalize_int(value: object, fallback: int = 0, minimum: int = 0) -> int:
    try:
        parsed = int(str(value or "").strip())
    except Exception:
        return fallback
    return max(minimum, parsed)


def normalize_string(value: object) -> str:
    return str(value or "").strip()


def is_plain_dict(value: object) -> bool:
    return isinstance(value, dict)


def normalize_embedding_adapter(value: object, fallback: str = "") -> str:
    normalized = normalize_string(value).lower()
    if not normalized:
        return normalize_string(fallback).lower()
    return EMBEDDING_ADAPTER_ALIASES.get(normalized, normalized)


def strip_config_metadata(config: object) -> Dict[str, object]:
    if not is_plain_dict(config):
        return {}
    return {key: value for key, value in dict(config).items() if key not in EMBEDDING_CONFIG_META_KEYS}


def merge_config_blocks(*blocks: object) -> Dict[str, object]:
    merged: Dict[str, object] = {}
    for block in blocks:
        if not is_plain_dict(block):
            continue
        merged.update(strip_config_metadata(block))
    return merged


def read_windows_environment_variable(name: str) -> str:
    if not IS_WINDOWS:
        return ""
    cached = _WINDOWS_ENV_CACHE.get(name)
    if cached is not None:
        return cached
    value = ""
    try:
        import winreg  # type: ignore

        locations = (
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        )
        for hive, subkey in locations:
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    raw_value, _ = winreg.QueryValueEx(key, name)
            except OSError:
                continue
            if isinstance(raw_value, str) and raw_value.strip():
                value = raw_value.strip()
                break
    except Exception:
        value = ""
    _WINDOWS_ENV_CACHE[name] = value
    return value


def first_non_empty_env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "")
        if value and value.strip():
            return value.strip()
    for name in names:
        value = read_windows_environment_variable(name)
        if value:
            return value
    return ""


def process_env(name: str) -> str:
    value = os.environ.get(name, "")
    return value.strip() if value and value.strip() else ""


def get_user_home() -> Path:
    # Delegate to platform.py to keep detection logic in one place.
    return _get_home_dir()


def get_config_home() -> Path:
    # Delegate to platform.py to keep detection logic in one place.
    return _get_config_home()


def get_obsidian_config_candidates() -> List[Path]:
    # Delegate to platform.py to keep detection logic in one place.
    return _get_obsidian_config_candidates()


def get_default_vault_candidates() -> List[Path]:
    # Delegate to platform.py to keep detection logic in one place.
    home = _get_home_dir()
    return [
        home / "Obsidian Vault",
        home / "Documents" / "Obsidian Vault",
        home / "Desktop" / "Obsidian Vault",
    ]


def resolve_from_obsidian_config() -> Optional[Path]:
    for config_path in get_obsidian_config_candidates():
        if not config_path.is_file():
            continue
        try:
            payload = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            continue

        vaults = []
        for raw_entry in (payload.get("vaults") or {}).values():
            candidate = Path(str(raw_entry.get("path", "")).strip()).expanduser()
            if not candidate.is_dir():
                continue
            vaults.append(
                {
                    "path": candidate.resolve(),
                    "open": bool(raw_entry.get("open")),
                    "ts": int(raw_entry.get("ts") or 0),
                }
            )

        if not vaults:
            continue

        by_recent = sorted(vaults, key=lambda item: item["ts"], reverse=True)
        open_vault = next((item for item in by_recent if item["open"]), None)
        if open_vault:
            return Path(open_vault["path"])
        return Path(by_recent[0]["path"])
    return None


def resolve_vault_root() -> Path:
    for env_key in ("AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"):
        candidate = first_non_empty_env(env_key)
        if candidate and Path(candidate).is_dir():
            return Path(candidate).expanduser().resolve()

    config_vault = resolve_from_obsidian_config()
    if config_vault is not None:
        return config_vault

    for candidate in get_default_vault_candidates():
        if candidate.is_dir():
            return candidate.resolve()

    tried = ", ".join(str(path) for path in get_default_vault_candidates())
    raise RuntimeError(
        "no-obsidian-vault: Tried ["
        + tried
        + "]. Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT to your vault path."
    )


def resolve_runtime_root_candidates(anchor_file: str = "", root_override: str = "") -> List[Path]:
    candidates: List[Path] = []
    anchor_path = Path(anchor_file).resolve() if anchor_file else None
    raw_candidates = [
        root_override,
        first_non_empty_env("AI_MEMORY_ROOT"),
        str(anchor_path.parent) if anchor_path else "",
        str(anchor_path.parent.parent) if anchor_path else "",
    ]
    for raw_candidate in raw_candidates:
        candidate = str(raw_candidate or "").strip()
        if not candidate:
            continue
        resolved = Path(candidate).expanduser().resolve()
        if resolved not in candidates:
            candidates.append(resolved)
    if not candidates:
        candidates.append(Path.cwd().resolve())
    return candidates


def resolve_runtime_root(anchor_file: str = "", root_override: str = "") -> Path:
    # _platform_mod is already loaded at module level.
    is_runtime_root = _platform_mod.is_runtime_root

    signatures = (
        os.path.join("retrieval", "embedding_providers.py"),
        os.path.join("bus", "memory-bus.ps1"),
        os.path.join("shared-mcp", "manifest.json"),
    )
    candidates = resolve_runtime_root_candidates(anchor_file=anchor_file, root_override=root_override)
    for candidate in candidates:
        if any((candidate / signature).is_file() for signature in signatures):
            return candidate
    return candidates[0]


def resolve_runtime_file(anchor_file: str, *relative_candidates: str, root_override: str = "") -> Path:
    for base_path in resolve_runtime_root_candidates(anchor_file=anchor_file, root_override=root_override):
        for relative_candidate in relative_candidates:
            candidate = base_path / relative_candidate
            if candidate.is_file():
                return candidate.resolve()
    root = resolve_runtime_root(anchor_file=anchor_file, root_override=root_override)
    return (root / relative_candidates[0]).resolve()


def resolve_runtime_config_path(anchor_file: str, root_override: str = "") -> Path:
    explicit = first_non_empty_env("AI_MEMORY_RUNTIME_CONFIG_PATH")
    if explicit:
        return Path(explicit).expanduser().resolve()

    for root in resolve_runtime_root_candidates(anchor_file=anchor_file, root_override=root_override):
        for relative_path in (
            Path("config") / "runtime.json",
            Path("templates") / "config" / "runtime.json",
        ):
            config_path = root / relative_path
            if config_path.is_file():
                return config_path.resolve()

    fallback_root = resolve_runtime_root(anchor_file=anchor_file, root_override=root_override)
    return (fallback_root / "config" / "runtime.json").resolve()


def load_runtime_config(anchor_file: str, root_override: str = "") -> Dict[str, object]:
    config_path = resolve_runtime_config_path(anchor_file=anchor_file, root_override=root_override)
    if not config_path.is_file():
        return {
            "configPath": str(config_path),
            "exists": False,
            "data": {},
            "error": "",
        }

    try:
        return {
            "configPath": str(config_path),
            "exists": True,
            "data": json.loads(config_path.read_text(encoding="utf-8")),
            "error": "",
        }
    except Exception as error:
        return {
            "configPath": str(config_path),
            "exists": True,
            "data": {},
            "error": str(error),
        }


def extract_embedding_defaults(embeddings: object) -> Dict[str, object]:
    if not is_plain_dict(embeddings):
        return {}

    legacy_defaults = {
        key: value
        for key, value in dict(embeddings).items()
        if key not in EMBEDDING_RUNTIME_RESERVED_KEYS
    }
    defaults = embeddings.get("defaults", {}) if is_plain_dict(embeddings) else {}
    return merge_config_blocks(legacy_defaults, defaults)


def resolve_named_registry_entry(registry: object, candidates: List[str], default_name: str = "default") -> Dict[str, object]:
    normalized_registry = registry if is_plain_dict(registry) else {}
    for candidate in candidates:
        name = normalize_string(candidate)
        if not name:
            continue
        payload = normalized_registry.get(name) if is_plain_dict(normalized_registry) else None
        if is_plain_dict(payload):
            return {
                "name": name,
                "config": payload,
            }

    default_payload = normalized_registry.get(default_name) if is_plain_dict(normalized_registry) else None
    if is_plain_dict(default_payload):
        return {
            "name": default_name,
            "config": default_payload,
        }

    if is_plain_dict(normalized_registry):
        available_names = list(normalized_registry.keys())
        if len(available_names) == 1:
            payload = normalized_registry.get(available_names[0])
            if is_plain_dict(payload):
                return {
                    "name": available_names[0],
                    "config": payload,
                }

    return {
        "name": "",
        "config": {},
    }


def resolve_embedding_runtime(anchor_file: str, root_override: str = "", defaults: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    resolved_defaults = defaults if is_plain_dict(defaults) else {}
    allow_process_embedding_overrides = normalize_bool(
        process_env("AI_MEMORY_ALLOW_EMBED_RUNTIME_ENV_OVERRIDES"),
        fallback=False,
    )

    def selection_override(name: str) -> str:
        return process_env(name) if allow_process_embedding_overrides else ""

    loaded = load_runtime_config(anchor_file=anchor_file, root_override=root_override)
    data = loaded.get("data")
    embeddings = data.get("embeddings", {}) if is_plain_dict(data) else {}
    providers = embeddings.get("providers", {}) if is_plain_dict(embeddings) else {}
    profiles = embeddings.get("profiles", {}) if is_plain_dict(embeddings) else {}

    requested_profile_name = selection_override("AI_MEMORY_EMBED_PROFILE")
    configured_profile_name = normalize_string(embeddings.get("activeProfile", "")) if is_plain_dict(embeddings) else ""
    resolved_profile = resolve_named_registry_entry(profiles, [requested_profile_name, configured_profile_name])
    profile_config = resolved_profile.get("config", {})

    requested_provider_name = selection_override("AI_MEMORY_EMBED_PROVIDER")
    profile_provider_name = normalize_string(profile_config.get("provider", "")) if is_plain_dict(profile_config) else ""
    configured_provider_name = normalize_string(embeddings.get("activeProvider", "")) if is_plain_dict(embeddings) else ""
    resolved_provider = resolve_named_registry_entry(
        providers,
        [requested_provider_name, profile_provider_name, configured_provider_name],
    )
    provider_config = resolved_provider.get("config", {})

    merged = merge_config_blocks(
        extract_embedding_defaults(embeddings),
        provider_config,
        profile_config,
    )

    adapter = (
        normalize_embedding_adapter(selection_override("AI_MEMORY_EMBED_ADAPTER"))
        or normalize_embedding_adapter(selection_override("AI_MEMORY_EMBED_BACKEND"))
        or normalize_embedding_adapter(merged.get("adapter"))
        or normalize_embedding_adapter(merged.get("backend"))
        or normalize_embedding_adapter(resolved_defaults.get("adapter"))
        or normalize_embedding_adapter(resolved_defaults.get("backend"))
        or "hash"
    )
    uses_api_key = adapter == "openai-compatible"

    api_key_env = (
        process_env("AI_MEMORY_EMBED_API_KEY_ENV")
        or normalize_string(merged.get("apiKeyEnv", ""))
        or normalize_string(resolved_defaults.get("apiKeyEnv", ""))
    )
    direct_api_key = first_non_empty_env("AI_MEMORY_EMBED_API_KEY") if uses_api_key else ""
    indirect_api_key = first_non_empty_env(api_key_env) if uses_api_key and api_key_env else ""
    configured_api_key = (
        normalize_string(merged.get("apiKey", ""))
        or normalize_string(resolved_defaults.get("apiKey", ""))
    ) if uses_api_key else ""
    api_key = (
        direct_api_key
        or indirect_api_key
        or configured_api_key
    )

    resolution_mode = "legacy-base"
    if normalize_string(resolved_profile.get("name", "")) and normalize_string(resolved_provider.get("name", "")):
        resolution_mode = "profile-provider"
    elif normalize_string(resolved_provider.get("name", "")):
        resolution_mode = "provider-direct"
    elif normalize_string(resolved_profile.get("name", "")):
        resolution_mode = "legacy-profile-inline"

    timeout_ms = normalize_int(
        selection_override("AI_MEMORY_EMBED_TIMEOUT_MS") or merged.get("timeoutMs"),
        fallback=normalize_int(resolved_defaults.get("timeoutMs"), fallback=120000, minimum=1000),
        minimum=1000,
    )

    return {
        "profileName": normalize_string(resolved_profile.get("name", "")),
        "providerName": normalize_string(resolved_provider.get("name", "")),
        "availableProfiles": list(profiles.keys()) if is_plain_dict(profiles) else [],
        "availableProviders": list(providers.keys()) if is_plain_dict(providers) else [],
        "resolutionMode": resolution_mode,
        "adapter": adapter,
        "backend": adapter,
        "model": (
            selection_override("AI_MEMORY_EMBED_MODEL")
            or normalize_string(merged.get("model", ""))
            or normalize_string(resolved_defaults.get("model", ""))
        ),
        "baseUrl": (
            selection_override("AI_MEMORY_EMBED_BASE_URL")
            or normalize_string(merged.get("baseUrl", ""))
            or normalize_string(resolved_defaults.get("baseUrl", ""))
        ).rstrip("/"),
        "apiKeyEnv": api_key_env,
        "apiKey": api_key,
        "timeoutMs": timeout_ms,
        "timeoutSeconds": max(1, int((timeout_ms + 999) / 1000)),
        "requestDelayMs": normalize_int(
            selection_override("AI_MEMORY_EMBED_REQUEST_DELAY_MS")
            or selection_override("AI_MEMORY_EMBED_DELAY_MS")
            or merged.get("requestDelayMs")
            or merged.get("delayMs"),
            fallback=normalize_int(resolved_defaults.get("requestDelayMs"), fallback=0, minimum=0),
            minimum=0,
        ),
        "batchSize": normalize_int(
            selection_override("AI_MEMORY_EMBED_BATCH_SIZE") or merged.get("batchSize"),
            fallback=normalize_int(resolved_defaults.get("batchSize"), fallback=0, minimum=0),
            minimum=0,
        ),
        "allowBatchFallback": normalize_bool(
            selection_override("AI_MEMORY_EMBED_ALLOW_BATCH_FALLBACK") or merged.get("allowBatchFallback"),
            fallback=normalize_bool(resolved_defaults.get("allowBatchFallback"), fallback=False),
        ),
        "processEmbeddingOverridesAllowed": allow_process_embedding_overrides,
        "configPath": str(loaded.get("configPath", "")),
        "configExists": bool(loaded.get("exists")),
        "configError": str(loaded.get("error", "")),
    }
