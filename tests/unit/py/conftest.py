"""
Pytest configuration to set up Python path for tests.

Sets sys.path so that:
- "from ops.redaction import ..." works (repo root → ops/ accessible)
- "from retrieval.xxx import ..." works (repo root → retrieval/ accessible)
"""
import sys
import os
from pathlib import Path

# _test_file: e.g. /path/to/obsidian-shared-memory-bus/tests/unit/py/test_foo.py
#   parent4 = repo root (/path/to/obsidian-shared-memory-bus)
_test_file_resolved = Path(__file__).resolve()
project_root = _test_file_resolved.parent.parent.parent.parent
repo_ops = project_root / "ops"
repo_retrieval = project_root / "retrieval"

for p in [str(project_root), str(repo_ops), str(repo_retrieval)]:
    if p not in sys.path:
        sys.path.insert(0, p)
