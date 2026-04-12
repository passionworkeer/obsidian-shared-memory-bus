"""
Platform detection and cross-platform adaptation utilities for the Python retrieval layer.

Mirrors the platform abstraction pattern from bus/platform/ (Node.js side) so that
both layers agree on the same platform identity and naming conventions.

Platforms:
  - windows  (sys.platform == 'win32')
  - darwin  (sys.platform == 'darwin')
  - linux   (sys.platform.startswith('linux'))
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Platform identity
# ---------------------------------------------------------------------------

PLATFORM = sys.platform  # 'win32' | 'darwin' | 'linux'


def is_windows() -> bool:
    """Return True when running on Windows."""
    return PLATFORM == "win32"


def is_macos() -> bool:
    """Return True when running on macOS."""
    return PLATFORM == "darwin"


def is_linux() -> bool:
    """Return True when running on a Linux-like system."""
    return PLATFORM.startswith("linux")


def get_platform_name() -> str:
    """Return 'windows' | 'darwin' | 'linux' matching the Node.js platform module."""
    if is_windows():
        return "windows"
    if is_macos():
        return "darwin"
    return "linux"


# ---------------------------------------------------------------------------
# Path separators
# ---------------------------------------------------------------------------

def path_sep() -> str:
    """Return the platform path separator ('\\' or '/').

    Matches platform.pathSep in bus/platform/index.js.
    """
    return os.sep


# ---------------------------------------------------------------------------
# Executables
# ---------------------------------------------------------------------------

def get_python_executable() -> str:
    """
    Return the best Python executable name for subprocess calls on this platform.

    Windows: always 'python' (the launcher resolves py/python3/python.exe).
    Unix (macOS/Linux): prefer 'python3', fall back to 'python', then sys.executable.

    The returned value is a name resolved via shutil.which(), NOT an absolute path,
    so that subprocess calls inherit the virtual-environment / PATH resolution
    the caller expects.
    """
    if is_windows():
        return "python"

    # Unix: try python3 first (avoids Python 2), then python
    for name in ("python3", "python"):
        if shutil.which(name):
            return name

    # Ultimate fallback: the current interpreter (handles virtual environments)
    return sys.executable


# ---------------------------------------------------------------------------
# Home directory
# ---------------------------------------------------------------------------

def get_home_dir() -> Path:
    """
    Return the user's home directory as a Path.

    Resolution order (mirrors bus/platform/*.js):
      1. HOME         — standard on macOS / Linux
      2. USERPROFILE  — Windows (also available in some Git-Bash / MSYS2 contexts)
      3. Path.home()  — last-resort fallback from pathlib

    Raises RuntimeError if none of the above succeed.
    """
    for candidate in (
        os.environ.get("HOME", "").strip(),
        os.environ.get("USERPROFILE", "").strip(),
    ):
        if candidate:
            resolved = Path(candidate).expanduser().resolve()
            if resolved.is_dir():
                return resolved

    # pathlib fallback
    try:
        home = Path.home()
        if home.is_dir():
            return home
    except Exception:
        pass

    raise RuntimeError("Unable to resolve the user home directory on this platform.")


# ---------------------------------------------------------------------------
# Config / data directory conventions
# ---------------------------------------------------------------------------

def get_config_home() -> Path:
    """
    Return the platform's XDG_CONFIG_HOME equivalent directory.

    Windows: %APPDATA%  (e.g. C:\\Users\\...\\AppData\\Roaming)
    macOS:   ~/Library/Application Support
    Linux:   $XDG_CONFIG_HOME or ~/.config
    """
    home = get_home_dir()

    if is_windows():
        appdata = os.environ.get("APPDATA", "").strip()
        if appdata:
            return Path(appdata).expanduser().resolve()
        return home / "AppData" / "Roaming"

    if is_macos():
        return home / "Library" / "Application Support"

    # Linux / other Unix
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    if xdg:
        return Path(xdg).expanduser().resolve()
    return home / ".config"


def get_obsidian_config_candidates() -> list[Path]:
    """
    Return a list of Obsidian configuration paths to check on this platform.

    Mirrors the logic in bus/platform/darwin.js and bus/platform/linux.js.
    """
    config_home = get_config_home()

    candidates: list[Path] = []

    if is_windows():
        candidates.append(config_home / "obsidian" / "obsidian.json")

    elif is_macos():
        candidates.append(get_home_dir() / "Library" / "Application Support" / "obsidian" / "obsidian.json")
        candidates.append(config_home / "obsidian" / "obsidian.json")

    else:  # Linux
        candidates.append(config_home / "obsidian" / "obsidian.json")
        candidates.append(get_home_dir() / ".config" / "obsidian" / "obsidian.json")
        candidates.append(Path("/etc/xdg") / "obsidian" / "obsidian.json")

    return candidates


# ---------------------------------------------------------------------------
# Runtime root signatures
# ---------------------------------------------------------------------------

def get_runtime_signature_files() -> tuple[str, ...]:
    """
    Return the filenames that identify a valid runtime root on this platform.

    The Python retrieval layer does not require the PowerShell bus wrapper;
    a runtime root is valid whenever it contains any one of:
      - retrieval/embedding_providers.py  (always present — the core Python module)
      - bus/memory-bus.ps1               (Windows PowerShell entry point)
      - shared-mcp/manifest.json          (Node.js MCP manifest)

    Returns a tuple of relative path strings using forward-slashes so that
    os.path.join works correctly on all platforms.
    """
    base = (
        os.path.join("retrieval", "embedding_providers.py"),
        os.path.join("shared-mcp", "manifest.json"),
    )
    if is_windows():
        return (*base, os.path.join("bus", "memory-bus.ps1"))
    return base


def is_runtime_root(candidate: Path) -> bool:
    """
    Return True when ``candidate`` appears to be the runtime root.

    Checks for any of the files returned by get_runtime_signature_files().
    """
    for sig in get_runtime_signature_files():
        if (candidate / sig).is_file():
            return True
    return False


# ---------------------------------------------------------------------------
# Default vault candidates
# ---------------------------------------------------------------------------

def get_default_vault_candidates() -> list[Path]:
    """
    Return a list of paths that are likely Obsidian vault locations by default.

    Mirrors get_default_vault_candidates() in runtime_support.py but uses
    pathlib throughout.
    """
    home = get_home_dir()
    return [
        home / "Obsidian Vault",
        home / "Documents" / "Obsidian Vault",
        home / "Desktop" / "Obsidian Vault",
    ]


# ---------------------------------------------------------------------------
# Store root (.ai-memory)
# ---------------------------------------------------------------------------

def get_default_store_root() -> Path:
    """
    Return the default .ai-memory store root for the current platform.

    Mirrors platform.storeRootDefault from bus/platform/index.js.
    On all platforms this is ~/.ai-memory.
    """
    return get_home_dir() / ".ai-memory"
