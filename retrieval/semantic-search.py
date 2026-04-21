"""
Compatibility wrapper for the hyphenated semantic-search entrypoint.
The refactored implementation lives in semantic_search.py, but the flat runtime
layout and validation scripts still expect semantic-search.py to exist.
"""

from __future__ import annotations
import pathlib
import runpy
import sys


CURRENT_DIR = pathlib.Path(__file__).resolve().parent
TARGET = CURRENT_DIR / "semantic_search.py"

# Ensure CURRENT_DIR is on sys.path so all the search_* modules can be imported
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

runpy.run_path(str(TARGET), run_name="__main__")
