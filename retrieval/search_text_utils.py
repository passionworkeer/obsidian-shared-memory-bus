"""
search_text_utils: text normalization, tokenization, noise detection, and
structured-files list loader.

Split from retrieval/search_ranking.py (originally ~1357 lines) — see
docs/reference/q-high-1-step-5-design.md §3.1 (Q-HIGH-1 step 5.1).

Public re-exports: tokenize, normalize_spaces, is_noise, derive_entry_layer,
NOISE_PATTERNS, STRUCTURED_FILES, DURABLE_SCOPES, ROUTE_VALUES, KNOWN_LAYERS,
RECENT_QUERY_PATTERN, TASK_QUERY_PATTERN, REFERENCE_QUERY_PATTERN,
DURABLE_QUERY_PATTERN, BM25Okapi, jieba.

Consumers (import from this module via search_ranking's re-export layer):
- retrieval/semantic_search.py
- retrieval/search_index.py
- retrieval/search_cache.py (via search_ranking)
- retrieval/search_server.py (via search_ranking)
- tests/cross-language/shared-config-parity.test.js (subprocess import)
- tests/unit/py/test_search_cache.py (file_location spec)
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Dict, List

logger = logging.getLogger(__name__)

try:
    from rank_bm25 import BM25Okapi  # type: ignore
except Exception:
    BM25Okapi = None

# jieba 延迟加载（轻量化优化：避免冷启动开销）
jieba = None


def _ensure_jieba():
    """懒加载 jieba 分词器，首次使用时才初始化"""
    global jieba
    if jieba is not None:
        return jieba
    try:
        import jieba as _jieba_module
        _jieba_module.setLogLevel(20)
        jieba = _jieba_module
        return jieba
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Noise patterns + structured-files constants
# ---------------------------------------------------------------------------

NOISE_PATTERNS = [
    re.compile(r"^Sender\s*\(", re.I),
    re.compile(r"^System:", re.I),
    re.compile(r"^Subagent Context", re.I),
    re.compile(r"^\[Subagent Context\]", re.I),
    re.compile(r"^Exec completed", re.I),
    re.compile(r"^Exec failed", re.I),
    re.compile(r"^A new session was started", re.I),
    re.compile(r"^\[(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s", re.I),
    re.compile(r"^Run your Session Startup", re.I),
]

# Canonical structured-file list lives in shared/structured-files.json (single
# source shared with ops/memory/memory-archival.js). Loaded at import with a
# literal fallback so retrieval/ still works standalone if the JSON is absent.
_STRUCTURED_FILES_FALLBACK = [
    "shared-inbox.jsonl",
    "session-memory.jsonl",
    "shared-events.jsonl",
    "task-memory.jsonl",
    "claude-code.jsonl",
    "openclaw.jsonl",
    "openclaw-blackboard.jsonl",
    "openclaw-runs.jsonl",
    "openclaw-jobs.jsonl",
    "openclaw-journal.jsonl",
]


def _load_structured_files() -> List[str]:
    try:
        _here = os.path.dirname(os.path.abspath(__file__))
        _path = os.path.join(_here, "..", "shared", "structured-files.json")
        with open(_path, "r", encoding="utf-8") as _fh:
            _data = json.load(_fh)
        files = _data.get("files") if isinstance(_data, dict) else None
        if isinstance(files, list) and files:
            return [str(f) for f in files]
    except Exception as exc:  # noqa: BLE001 — degrade to fallback, never crash import
        logger.warning("structured-files.json load failed, using fallback: %s", exc)
    return list(_STRUCTURED_FILES_FALLBACK)


STRUCTURED_FILES = _load_structured_files()
DURABLE_SCOPES = {"user", "feedback", "project", "reference"}
ROUTE_VALUES = {"auto", "mixed", "durable", "task", "recent", "reference"}
KNOWN_LAYERS = ("durable", "session", "event", "task")
RECENT_QUERY_PATTERN = re.compile(r"(最新|最近|刚刚|今天|\b(?:recent|latest|today|current|newest|new)\b)", re.I)
TASK_QUERY_PATTERN = re.compile(
    r"(任务|运行|工单|队列|\b(?:issue|pr|run|job|cron|queue|blackboard|pending|failed|status)\b)",
    re.I,
)
REFERENCE_QUERY_PATTERN = re.compile(r"(路径|链接|文档|参考|\b(?:path|url|link|reference|doc|docs|file)\b)", re.I)
DURABLE_QUERY_PATTERN = re.compile(
    r"(偏好|规则|长期|记忆|全局|\b(?:preference|rule|workflow|durable|global|remember)\b)",
    re.I,
)


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def is_noise(text: str) -> bool:
    normalized = normalize_spaces(text)
    if not normalized or len(normalized) < 5:
        return True
    return any(pattern.match(normalized) for pattern in NOISE_PATTERNS)


def tokenize(text: str) -> List[str]:
    source = (text or "").lower()
    tokens: List[str] = []
    seen = set()

    def add(token: str) -> None:
        normalized = token.strip()
        if not normalized:
            return
        if re.fullmatch(r"[一-鿿]", normalized):
            return
        if re.fullmatch(r"[a-z]", normalized):
            return
        if normalized not in seen:
            seen.add(normalized)
            tokens.append(normalized)

    # 懒加载 jieba（轻量化优化）
    _jieba = _ensure_jieba()
    if _jieba is not None:
        try:
            for piece in _jieba.cut(source):
                add(piece)
        except Exception:
            logger.warning("jieba.cut failed for tokenize; falling back to regex", exc_info=True)

    for piece in re.findall(r"[a-z0-9][a-z0-9_\-./:]{1,}", source):
        add(piece)
    for piece in re.findall(r"[一-鿿]{2,}", source):
        add(piece)
    return tokens


def derive_entry_layer(payload: dict) -> str:
    memory_level = normalize_spaces(str(payload.get("memory_level", payload.get("memoryLevel", "")))).lower()
    source_kind = normalize_spaces(str(payload.get("source_kind", payload.get("sourceKind", "")))).lower()
    scope = normalize_spaces(str(payload.get("scope", ""))).lower()

    if memory_level == "durable" or source_kind == "writeback":
        return "durable"
    if source_kind in {"hook", "event"} or memory_level == "event":
        return "event"
    if memory_level == "task" or source_kind in {"blackboard", "run", "cron", "task"} or scope in {"task", "run"}:
        return "task"
    return "session"
