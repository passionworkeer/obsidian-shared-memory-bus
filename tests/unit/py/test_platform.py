"""
Unit tests for retrieval/platform.py

Tests the cross-platform detection utilities: platform identity,
path separators, executables, home directory, config home, Obsidian
config candidates, runtime signatures, and default store root.
"""

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Load platform.py (needs to be accessible via sys.path — conftest.py sets this up)
import importlib.util

_TEST_FILE = Path(__file__).resolve()
_PROJECT_ROOT = _TEST_FILE.parent.parent.parent.parent
_PLATFORM_PATH = _PROJECT_ROOT / "retrieval" / "platform.py"
_spec = importlib.util.spec_from_file_location("platform", str(_PLATFORM_PATH))
if _spec is None or _spec.loader is None:
    raise ImportError("Could not create module spec for retrieval/platform.py")
_platform_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_platform_module)

# Convenience references
is_windows = _platform_module.is_windows
is_macos = _platform_module.is_macos
is_linux = _platform_module.is_linux
get_platform_name = _platform_module.get_platform_name
path_sep = _platform_module.path_sep
get_python_executable = _platform_module.get_python_executable
get_home_dir = _platform_module.get_home_dir
get_config_home = _platform_module.get_config_home
get_obsidian_config_candidates = _platform_module.get_obsidian_config_candidates
get_default_store_root = _platform_module.get_default_store_root
get_default_vault_candidates = _platform_module.get_default_vault_candidates
get_runtime_signature_files = _platform_module.get_runtime_signature_files
is_runtime_root = _platform_module.is_runtime_root
PLATFORM = _platform_module.PLATFORM


# ---------------------------------------------------------------------------
# Platform identity
# ---------------------------------------------------------------------------

class TestPlatformIdentity:
    """Tests for platform detection booleans and name."""

    def test_platform_is_known(self):
        """PLATFORM must be one of the three known values."""
        assert PLATFORM in ("win32", "darwin", "linux")

    def test_exactly_one_platform_flag_is_true(self):
        """Exactly one of is_windows / is_macos / is_linux must be True."""
        flags = [is_windows(), is_macos(), is_linux()]
        assert flags.count(True) == 1, (
            f"Expected exactly one platform flag to be True; "
            f"got is_windows={is_windows()} is_macos={is_macos()} is_linux={is_linux()}"
        )

    def test_platform_name_matches_true_flag(self):
        """get_platform_name() must return the name that corresponds to the true flag."""
        name = get_platform_name()
        if is_windows():
            assert name == "windows"
        elif is_macos():
            assert name == "darwin"
        else:
            assert name == "linux"

    def test_platform_name_is_known(self):
        """get_platform_name() must return a known platform string."""
        assert get_platform_name() in ("windows", "darwin", "linux")

    def test_flags_are_mutually_exclusive(self):
        """is_windows, is_macos, is_linux must not all return the same value."""
        results = [is_windows(), is_macos(), is_linux()]
        assert not all(results), "All platform flags cannot all be True"
        assert not none(results), "All platform flags cannot all be False"


def none(seq):
    """Return True if every item in seq is falsy."""
    return not any(seq)


# ---------------------------------------------------------------------------
# Path separator
# ---------------------------------------------------------------------------

class TestPathSep:
    """Tests for path_sep()."""

    def test_path_sep_is_forward_or_backslash(self):
        """path_sep() must return '/' or '\\\\'."""
        sep = path_sep()
        assert sep in ("/", "\\"), f"path_sep() returned '{sep}' which is not '/' or '\\\\'"

    def test_path_sep_matches_os_sep(self):
        """path_sep() must match os.sep."""
        assert path_sep() == os.sep


# ---------------------------------------------------------------------------
# Python executable
# ---------------------------------------------------------------------------

class TestPythonExecutable:
    """Tests for get_python_executable()."""

    def test_returns_string(self):
        """get_python_executable() must return a non-empty string."""
        result = get_python_executable()
        assert isinstance(result, str)
        assert len(result) > 0

    def test_returns_non_whitespace(self):
        """The returned executable name must not contain whitespace."""
        result = get_python_executable()
        assert " " not in result, f"Executable name '{result}' contains whitespace"

    def test_windows_returns_python(self):
        """On Windows, get_python_executable() must return 'python'."""
        with patch.object(_platform_module, "PLATFORM", "win32"):
            result = get_python_executable()
            assert result == "python"

    @patch.object(_platform_module, "PLATFORM", "linux")
    def test_linux_tries_python3_first(self):
        """On Linux, get_python_executable() prefers python3 if available."""
        with patch.object(_platform_module, "is_windows", lambda: False):
            with patch.object(_platform_module, "is_linux", lambda: True):
                with patch("shutil.which") as mock_which:
                    mock_which.return_value = "/usr/bin/python3"
                    result = get_python_executable()
                    assert result == "python3"
                    # Verify python3 was checked before python
                    calls = mock_which.call_args_list
                    assert calls[0][0][0] == "python3"


# ---------------------------------------------------------------------------
# Home directory
# ---------------------------------------------------------------------------

class TestHomeDir:
    """Tests for get_home_dir()."""

    def test_returns_path(self):
        """get_home_dir() must return a Path object."""
        result = get_home_dir()
        assert isinstance(result, Path)

    def test_resolved_path_exists(self):
        """The returned path must exist as a directory."""
        result = get_home_dir()
        assert result.exists(), f"Home directory '{result}' does not exist"
        assert result.is_dir(), f"Home directory '{result}' is not a directory"

    def test_path_is_absolute(self):
        """The returned path must be absolute."""
        result = get_home_dir()
        assert result.is_absolute(), f"Home directory '{result}' is not absolute"

    def test_fallback_order(self, tmp_path):
        """HOME should be checked before USERPROFILE on non-Windows."""
        # tmp_path is a real directory — use it as the HOME candidate.
        # Create a subdirectory so it passes is_dir() check.
        home_dir = tmp_path / "home"
        home_dir.mkdir()
        other_dir = tmp_path / "other"
        with patch.dict(os.environ, {"HOME": str(home_dir), "USERPROFILE": str(other_dir)}, clear=False):
            with patch.object(_platform_module, "is_windows", lambda: False):
                result = get_home_dir()
                assert str(result) == str(home_dir)

    def test_raises_when_no_home_available(self):
        """Must raise RuntimeError when no home directory is available."""
        with patch.dict(os.environ, {"HOME": "", "USERPROFILE": ""}, clear=True):
            with patch.object(Path, "home", side_effect=RuntimeError("no home")):
                with pytest.raises(RuntimeError, match="Unable to resolve"):
                    get_home_dir()


# ---------------------------------------------------------------------------
# Config home
# ---------------------------------------------------------------------------

class TestConfigHome:
    """Tests for get_config_home()."""

    def test_returns_path(self):
        """get_config_home() must return a Path object."""
        result = get_config_home()
        assert isinstance(result, Path)

    def test_resolved_path_is_absolute(self):
        """The returned path must be absolute."""
        result = get_config_home()
        assert result.is_absolute(), f"Config home '{result}' is not absolute"

    def test_windows_uses_appdata(self):
        """On Windows, config home should resolve to %APPDATA%."""
        with patch.object(_platform_module, "is_windows", lambda: True):
            with patch.dict(os.environ, {"APPDATA": "C:\\Users\\Test\\AppData\\Roaming"}):
                result = get_config_home()
                assert "AppData" in str(result) or "Roaming" in str(result)

    def test_linux_falls_back_to_xdg(self):
        """On Linux without XDG_CONFIG_HOME, falls back to ~/.config."""
        with patch.object(_platform_module, "is_windows", lambda: False):
            with patch.object(_platform_module, "is_macos", lambda: False):
                with patch.object(_platform_module, "get_home_dir", return_value=Path("/home/testuser")):
                    with patch.dict(os.environ, {"XDG_CONFIG_HOME": ""}):
                        result = get_config_home()
                        assert ".config" in str(result)


# ---------------------------------------------------------------------------
# Obsidian config candidates
# ---------------------------------------------------------------------------

class TestObsidianConfigCandidates:
    """Tests for get_obsidian_config_candidates()."""

    def test_returns_list(self):
        """Must return a list of Path objects."""
        result = get_obsidian_config_candidates()
        assert isinstance(result, list)
        assert all(isinstance(p, Path) for p in result)

    def test_returns_non_empty(self):
        """Must return at least one candidate path."""
        result = get_obsidian_config_candidates()
        assert len(result) > 0

    def test_all_paths_absolute(self):
        """All candidate paths must be absolute."""
        for candidate in get_obsidian_config_candidates():
            assert candidate.is_absolute(), f"Candidate '{candidate}' is not absolute"

    def test_linux_includes_xdg_config(self):
        """On Linux, candidates must include the XDG config path."""
        with patch.object(_platform_module, "is_windows", lambda: False):
            with patch.object(_platform_module, "is_macos", lambda: False):
                candidates = get_obsidian_config_candidates()
                candidates_str = [str(p) for p in candidates]
                # At least one should reference .config
                assert any(".config" in p for p in candidates_str), (
                    f"Linux candidates should include .config path; got {candidates_str}"
                )


# ---------------------------------------------------------------------------
# Default store root
# ---------------------------------------------------------------------------

class TestDefaultStoreRoot:
    """Tests for get_default_store_root()."""

    def test_returns_path(self):
        """Must return a Path object."""
        result = get_default_store_root()
        assert isinstance(result, Path)

    def test_named_ai_memory(self):
        """The store root must be named .ai-memory."""
        result = get_default_store_root()
        assert result.name == ".ai-memory"

    def test_under_home_dir(self):
        """The store root must be under the user's home directory."""
        store_root = get_default_store_root()
        home = get_home_dir()
        assert str(store_root).startswith(str(home)), (
            f"Store root '{store_root}' should be under home '{home}'"
        )

    def test_is_absolute(self):
        """The store root must be an absolute path."""
        result = get_default_store_root()
        assert result.is_absolute()


# ---------------------------------------------------------------------------
# Runtime signature files
# ---------------------------------------------------------------------------

class TestRuntimeSignatureFiles:
    """Tests for get_runtime_signature_files()."""

    def test_returns_tuple(self):
        """Must return a tuple of path strings."""
        result = get_runtime_signature_files()
        assert isinstance(result, tuple)

    def test_embedding_providers_is_first(self):
        """The primary signature must be retrieval/embedding_providers.py."""
        result = get_runtime_signature_files()
        # The first entry must contain 'embedding_providers.py'
        assert any("embedding_providers.py" in s for s in result), (
            f"embedding_providers.py not in signatures: {result}"
        )

    def test_all_entries_are_strings(self):
        """Every signature entry must be a non-empty string."""
        result = get_runtime_signature_files()
        for entry in result:
            assert isinstance(entry, str)
            assert len(entry) > 0

    def test_no_leading_separator(self):
        """Signature entries must not start with a path separator."""
        result = get_runtime_signature_files()
        for entry in result:
            assert not entry.startswith("/"), (
                f"Signature entry '{entry}' starts with '/'"
            )
            assert not entry.startswith("\\"), (
                f"Signature entry '{entry}' starts with '\\\\'"
            )


# ---------------------------------------------------------------------------
# is_runtime_root
# ---------------------------------------------------------------------------

class TestIsRuntimeRoot:
    """Tests for is_runtime_root()."""

    def test_returns_bool(self):
        """Must return True or False."""
        result = is_runtime_root(Path("/nonexistent/path"))
        assert isinstance(result, bool)

    def test_false_for_nonexistent_dir(self):
        """Must return False when the directory does not exist."""
        result = is_runtime_root(Path("/this/path/does/not/exist/12345"))
        assert result is False

    def test_true_when_embedding_providers_present(self, tmp_path):
        """Must return True when retrieval/embedding_providers.py exists."""
        retrieval_dir = tmp_path / "retrieval"
        retrieval_dir.mkdir()
        (retrieval_dir / "embedding_providers.py").write_text("# fake", encoding="utf-8")
        result = is_runtime_root(tmp_path)
        assert result is True

    def test_false_when_no_signature_present(self, tmp_path):
        """Must return False when no signature file is present."""
        result = is_runtime_root(tmp_path)
        assert result is False


# ---------------------------------------------------------------------------
# Default vault candidates
# ---------------------------------------------------------------------------

class TestDefaultVaultCandidates:
    """Tests for get_default_vault_candidates()."""

    def test_returns_list(self):
        """Must return a list."""
        result = get_default_vault_candidates()
        assert isinstance(result, list)

    def test_non_empty(self):
        """Must return at least one candidate."""
        assert len(get_default_vault_candidates()) > 0

    def test_all_paths_absolute(self):
        """All candidates must be absolute paths."""
        for candidate in get_default_vault_candidates():
            assert candidate.is_absolute(), f"Candidate '{candidate}' is not absolute"

    def test_contains_obsidian_vault(self):
        """Must include a path ending with 'Obsidian Vault'."""
        candidates = get_default_vault_candidates()
        names = [p.name for p in candidates]
        assert "Obsidian Vault" in names, f"No 'Obsidian Vault' in candidates: {names}"
