"""
Hybrid semantic search over the shared Obsidian memory bus.

Compatibility:
- python semantic-search.py "query" [topK] [strategy]
- python semantic-search.py --mode hybrid --top-k 8 --json "query"
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import os
import re
import sys
import time as time_module
from typing import Dict, Iterable, List, Optional, Tuple

from embedding_providers import (
    DEFAULT_MODEL,
    HASH_MODEL,
    VECTOR_SCHEMA_VERSION,
    build_embedding_config_hash,
    embed_query_with_runtime,
    get_transformer_model_name,
    normalize_embedding_adapter,
)
try:
    from ops.redaction import REDACTION_CONFIG, redact_sensitive
except ModuleNotFoundError:
    from redaction import REDACTION_CONFIG, redact_sensitive
from runtime_support import first_non_empty_env, normalize_bool, normalize_int, resolve_embedding_runtime, resolve_vault_root

try:
    from schema_validation import validate_record
    _SCHEMA_VALIDATION_AVAILABLE = True
except ImportError:
    _SCHEMA_VALIDATION_AVAILABLE = False

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# In-memory cache for the embeddings index with 30-second TTL.
# Avoids re-reading ~50k lines from index.jsonl on every search.
_INDEX_CACHE = {"data": None, "loaded_at": 0.0, "signature": ""}
_ENTRIES_CACHE = {"data": None, "loaded_at": 0.0, "version": 0, "signature": ""}
_BM25_CACHE: Dict[str, dict] = {}
_QUERY_EMBEDDING_CACHE: Dict[str, dict] = {}
_SEARCH_RESULT_CACHE: Dict[str, dict] = {}
_CACHE_METRICS = {
    "queryEmbeddingHits": 0,
    "queryEmbeddingMisses": 0,
    "searchResultHits": 0,
    "searchResultMisses": 0,
}

try:
    from rank_bm25 import BM25Okapi  # type: ignore
except Exception:
    BM25Okapi = None

# Patterns that indicate a reference to code artifacts
FILE_REF_PATTERN = re.compile(r"([a-zA-Z][^\s:;#*`\"'<>|\\{}()\[\]]+\.(js|ts|py|ps1|sh|md|json|yaml|yml|toml|go|rs|java|cpp|c|h|css|html))")

# Loose identifier pattern — only used for targeted context checks, not broad matching
FUNC_VAR_PATTERN = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b")


def check_memory_drift(entry: Dict, workspace_hints: Optional[Dict] = None) -> Dict:
    """
    Detect whether a memory record may be pointing to stale or non-existent references.

    This is a pure read-only function: it only inspects the entry and filesystem,
    never writes anything.

    Returns: { driftRisk: 'low'|'medium'|'high', driftSignals: List[str],
               missingFileCount: int }
    """
    workspace = workspace_hints or {}
    project_root = workspace.get("project_root", os.getcwd())
    drift_signals: List[str] = []
    missing_files: List[str] = []

    content = entry.get("content", "") or ""
    title = entry.get("title", "") or ""
    combined = f"{title} {content}"

    # Signal 1: freshness=cold + time-sensitive content
    # A cold record mentioning deadlines, freezes, releases, deploys, or launches
    # is more likely to be stale than a general-purpose memory note.
    freshness = entry.get("freshness", "unknown")
    cold_indicators = re.findall(r"(20[2-9][0-9]|201[0-9])-[0-9]{2}-[0-9]{2}", combined)
    if freshness == "cold" and cold_indicators:
        time_sensitive = ["deadline", "freeze", "release", "deploy", "launch"]
        if any(word in combined.lower() for word in time_sensitive):
            drift_signals.append("cold-record-with-time-sensitive-content")

    # Signal 2: referenced files that no longer exist
    # Cap per-record file checks at 5 to keep drift detection bounded and fast.
    raw_file_refs = FILE_REF_PATTERN.findall(combined)[:5]
    # Resolve project_root safely: if it doesn't exist or is inaccessible, skip checks.
    for ref in raw_file_refs:
        path = ref[0] if isinstance(ref, tuple) else ref
        if path.startswith(".") or path.startswith("/"):
            # Relative-with-dot or absolute path — skip to avoid false positives.
            continue
        abs_path = os.path.join(project_root, path)
        try:
            if not os.path.exists(abs_path):
                missing_files.append(path)
        except OSError:
            # Permission error, symlink loop, or similar — skip this file.
            pass

    if missing_files:
        drift_signals.append(f"referenced-files-missing:{len(missing_files)}")

    # Signal 3: summary-style record that is already cold or warm
    # Summaries decay quickly; a warm/cold summary is a high-staleness signal.
    entry_type = entry.get("type", "")
    if entry_type in ("summary", "session-summary", "daily-summary"):
        if freshness in ("cold", "warm"):
            drift_signals.append("summary-record-cold-staleness")

    # Determine risk level
    if len(drift_signals) >= 2:
        drift_risk = "high"
    elif drift_signals:
        drift_risk = "medium"
    else:
        drift_risk = "low"

    return {
        "driftRisk": drift_risk,
        "driftSignals": drift_signals[:5],  # cap at 5 for readability
        "missingFileCount": len(missing_files),
    }

try:
    import jieba  # type: ignore

    jieba.setLogLevel(20)
except Exception:
    jieba = None
_CACHE_TTL = float(normalize_int(first_non_empty_env("AI_MEMORY_BM25_CACHE_TTL_SECONDS"), fallback=600, minimum=30))
_QUERY_EMBEDDING_CACHE_TTL = float(
    normalize_int(first_non_empty_env("AI_MEMORY_QUERY_EMBED_CACHE_TTL_SECONDS"), fallback=600, minimum=30)
)
_SEARCH_RESULT_CACHE_TTL = float(
    normalize_int(first_non_empty_env("AI_MEMORY_SEARCH_RESULT_CACHE_TTL_SECONDS"), fallback=300, minimum=30)
)
_QUERY_EMBEDDING_CACHE_MAX_ENTRIES = normalize_int(
    first_non_empty_env("AI_MEMORY_QUERY_EMBED_CACHE_MAX_ENTRIES"), fallback=128, minimum=8
)
_SEARCH_RESULT_CACHE_MAX_ENTRIES = normalize_int(
    first_non_empty_env("AI_MEMORY_SEARCH_RESULT_CACHE_MAX_ENTRIES"), fallback=128, minimum=8
)
_BM25_CACHE_MAX_ENTRIES = normalize_int(first_non_empty_env("AI_MEMORY_BM25_CACHE_MAX_ENTRIES"), fallback=8, minimum=1)
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
STRUCTURED_FILES = [
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


def build_file_stamp(file_path: str) -> str:
    if not os.path.exists(file_path):
        return "__missing__"
    try:
        with open(file_path, "rb") as handle:
            body = handle.read()
        return f"{os.path.basename(file_path)}:{hashlib.sha1(body).hexdigest()}:{len(body)}"
    except Exception:
        return f"{os.path.basename(file_path)}:__unreadable__"


def build_structured_signature() -> str:
    if not os.path.isdir(STRUCTURED_DIR):
        return "__missing__"
    parts = [build_file_stamp(os.path.join(STRUCTURED_DIR, file_name)) for file_name in STRUCTURED_FILES]
    return "|".join(parts) if parts else "__empty__"


def build_embeddings_signature() -> str:
    return build_file_stamp(EMBEDDINGS_INDEX)


def invalidate_entries_cache() -> None:
    _ENTRIES_CACHE["data"] = None
    _ENTRIES_CACHE["loaded_at"] = 0.0
    _ENTRIES_CACHE["signature"] = ""
    _ENTRIES_CACHE["version"] = int(_ENTRIES_CACHE.get("version", 0)) + 1
    _BM25_CACHE.clear()
    _SEARCH_RESULT_CACHE.clear()


def invalidate_embeddings_cache() -> None:
    _INDEX_CACHE["data"] = None
    _INDEX_CACHE["loaded_at"] = 0.0
    _INDEX_CACHE["signature"] = ""

    _QUERY_EMBEDDING_CACHE.clear()
    _SEARCH_RESULT_CACHE.clear()


def clear_search_runtime_caches(include_data_caches: bool = False) -> Dict[str, object]:
    _BM25_CACHE.clear()
    _QUERY_EMBEDDING_CACHE.clear()
    _SEARCH_RESULT_CACHE.clear()
    _CACHE_METRICS["queryEmbeddingHits"] = 0
    _CACHE_METRICS["queryEmbeddingMisses"] = 0
    _CACHE_METRICS["searchResultHits"] = 0
    _CACHE_METRICS["searchResultMisses"] = 0

    if include_data_caches:
        _ENTRIES_CACHE["data"] = None
        _ENTRIES_CACHE["loaded_at"] = 0.0
        _ENTRIES_CACHE["signature"] = ""
        _ENTRIES_CACHE["version"] = int(_ENTRIES_CACHE.get("version", 0)) + 1
        _INDEX_CACHE["data"] = None
        _INDEX_CACHE["loaded_at"] = 0.0
        _INDEX_CACHE["signature"] = ""

    return build_cache_state(search_result_cache_hit=False, query_embedding_cache_hit=False)


def prune_timed_cache(cache: Dict[str, dict], ttl_seconds: float, max_entries: int) -> None:
    now = time_module.time()
    stale_keys = [key for key, payload in cache.items() if (now - float(payload.get("created_at", 0.0))) >= ttl_seconds]
    for key in stale_keys:
        cache.pop(key, None)

    if len(cache) <= max_entries:
        return

    ordered_keys = sorted(cache.keys(), key=lambda key: float(cache[key].get("created_at", 0.0)))
    for key in ordered_keys[: max(0, len(cache) - max_entries)]:
        cache.pop(key, None)


def build_cache_state(search_result_cache_hit: bool = False, query_embedding_cache_hit: bool = False) -> Dict[str, object]:
    prune_timed_cache(_QUERY_EMBEDDING_CACHE, _QUERY_EMBEDDING_CACHE_TTL, _QUERY_EMBEDDING_CACHE_MAX_ENTRIES)
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)
    prune_timed_cache(_BM25_CACHE, _CACHE_TTL, _BM25_CACHE_MAX_ENTRIES)
    current_structured_signature = build_structured_signature()
    current_embeddings_signature = build_embeddings_signature()
    return {
        "entryCacheVersion": int(_ENTRIES_CACHE.get("version", 0)),
        "structuredSignature": current_structured_signature,
        "embeddingsSignature": current_embeddings_signature,
        "bm25CacheEntries": len(_BM25_CACHE),
        "queryEmbeddingCacheEntries": len(_QUERY_EMBEDDING_CACHE),
        "searchResultCacheEntries": len(_SEARCH_RESULT_CACHE),
        "transformerModel": get_transformer_model_name(),
        "bm25Available": BM25Okapi is not None,
        "jiebaAvailable": jieba is not None,
        "queryEmbeddingCacheHit": bool(query_embedding_cache_hit),
        "searchResultCacheHit": bool(search_result_cache_hit),
        "metrics": {
            "queryEmbeddingHits": int(_CACHE_METRICS["queryEmbeddingHits"]),
            "queryEmbeddingMisses": int(_CACHE_METRICS["queryEmbeddingMisses"]),
            "searchResultHits": int(_CACHE_METRICS["searchResultHits"]),
            "searchResultMisses": int(_CACHE_METRICS["searchResultMisses"]),
        },
    }


def clone_json_payload(payload: Dict[str, object]) -> Dict[str, object]:
    return json.loads(json.dumps(payload, ensure_ascii=False))


def build_query_embedding_cache_key(query: str, backend: str, model_name: str, base_url: str = "") -> str:
    payload = {
        "query": normalize_spaces(query),
        "backend": normalize_embedding_adapter(backend, model_name),
        "model": (model_name or "").strip(),
        "baseUrl": (base_url or "").strip().rstrip("/").lower(),
    }
    return hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8", errors="ignore")).hexdigest()


def get_cached_query_embedding(cache_key: str) -> Optional[List[float]]:
    prune_timed_cache(_QUERY_EMBEDDING_CACHE, _QUERY_EMBEDDING_CACHE_TTL, _QUERY_EMBEDDING_CACHE_MAX_ENTRIES)
    cached = _QUERY_EMBEDDING_CACHE.get(cache_key)
    if cached is None:
        _CACHE_METRICS["queryEmbeddingMisses"] = int(_CACHE_METRICS["queryEmbeddingMisses"]) + 1
        return None

    _CACHE_METRICS["queryEmbeddingHits"] = int(_CACHE_METRICS["queryEmbeddingHits"]) + 1
    return [float(value) for value in cached.get("embedding", [])]


def store_query_embedding(cache_key: str, embedding: List[float]) -> None:
    _QUERY_EMBEDDING_CACHE[cache_key] = {
        "created_at": time_module.time(),
        "embedding": [float(value) for value in embedding],
    }
    prune_timed_cache(_QUERY_EMBEDDING_CACHE, _QUERY_EMBEDDING_CACHE_TTL, _QUERY_EMBEDDING_CACHE_MAX_ENTRIES)


def build_search_result_cache_key(parsed: Dict[str, object], entries_signature: str, embeddings_signature: str) -> str:
    runtime_backend = str(EMBEDDING_RUNTIME.get("adapter", EMBEDDING_RUNTIME.get("backend", ""))).strip()
    runtime_model = str(EMBEDDING_RUNTIME.get("model", "")).strip()
    runtime_hash = build_embedding_config_hash(runtime_backend, runtime_model, str(EMBEDDING_RUNTIME.get("baseUrl", "")))
    payload = {
        "request": parsed,
        "entriesSignature": entries_signature,
        "embeddingsSignature": embeddings_signature,
        "runtimeHash": runtime_hash,
    }
    return hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8", errors="ignore")).hexdigest()


def get_cached_search_result(cache_key: str) -> Optional[Dict[str, object]]:
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)
    cached = _SEARCH_RESULT_CACHE.get(cache_key)
    if cached is None:
        _CACHE_METRICS["searchResultMisses"] = int(_CACHE_METRICS["searchResultMisses"]) + 1
        return None

    _CACHE_METRICS["searchResultHits"] = int(_CACHE_METRICS["searchResultHits"]) + 1
    return clone_json_payload(cached.get("response", {}))


def store_search_result(cache_key: str, payload: Dict[str, object]) -> None:
    _SEARCH_RESULT_CACHE[cache_key] = {
        "created_at": time_module.time(),
        "response": clone_json_payload(payload),
    }
    prune_timed_cache(_SEARCH_RESULT_CACHE, _SEARCH_RESULT_CACHE_TTL, _SEARCH_RESULT_CACHE_MAX_ENTRIES)
EMBEDDING_RUNTIME = resolve_embedding_runtime(
    __file__,
    defaults={
        "adapter": "hash",
        "model": DEFAULT_MODEL,
        "timeoutMs": 120000,
        "requestDelayMs": 0,
        "batchSize": 0,
        "allowBatchFallback": False,
    },
)


def build_embedding_runtime_summary() -> Dict[str, object]:
    return {
        "profile": str(EMBEDDING_RUNTIME.get("profileName", "")),
        "provider": str(EMBEDDING_RUNTIME.get("providerName", "")),
        "adapter": str(EMBEDDING_RUNTIME.get("adapter", EMBEDDING_RUNTIME.get("backend", "hash")) or "hash"),
        "backend": str(EMBEDDING_RUNTIME.get("backend", EMBEDDING_RUNTIME.get("adapter", "hash")) or "hash"),
        "model": str(EMBEDDING_RUNTIME.get("model", DEFAULT_MODEL) or DEFAULT_MODEL),
        "baseUrl": str(EMBEDDING_RUNTIME.get("baseUrl", "")),
        "apiKeyEnv": str(EMBEDDING_RUNTIME.get("apiKeyEnv", "")),
        "apiKeyConfigured": bool(EMBEDDING_RUNTIME.get("apiKey")),
        "timeoutMs": int(EMBEDDING_RUNTIME.get("timeoutMs", 120000) or 120000),
        "requestDelayMs": int(EMBEDDING_RUNTIME.get("requestDelayMs", 0) or 0),
        "batchSize": int(EMBEDDING_RUNTIME.get("batchSize", 0) or 0),
        "allowBatchFallback": bool(EMBEDDING_RUNTIME.get("allowBatchFallback")),
        "resolutionMode": str(EMBEDDING_RUNTIME.get("resolutionMode", "")),
        "availableProfiles": list(EMBEDDING_RUNTIME.get("availableProfiles", []) or []),
        "availableProviders": list(EMBEDDING_RUNTIME.get("availableProviders", []) or []),
        "configPath": str(EMBEDDING_RUNTIME.get("configPath", "")),
        "configExists": bool(EMBEDDING_RUNTIME.get("configExists")),
        "configError": str(EMBEDDING_RUNTIME.get("configError", "")),
    }


VAULT_ROOT = str(resolve_vault_root())
AI_MEMORY_ROOT = os.path.join(VAULT_ROOT, "00-System", "ai-memory")
STRUCTURED_DIR = os.path.join(AI_MEMORY_ROOT, "structured")
EMBEDDINGS_INDEX = os.path.join(AI_MEMORY_ROOT, "embeddings", "index.jsonl")


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def is_noise(text: str) -> bool:
    normalized = normalize_spaces(text)
    if not normalized or len(normalized) < 5:
        return True
    return any(pattern.match(normalized) for pattern in NOISE_PATTERNS)


def fallback_id(payload: dict, title: str, content: str) -> str:
    seed = "|".join(
        [
            str(payload.get("tool", "")).strip(),
            str(payload.get("t", "")).strip(),
            title.strip(),
            content.strip(),
        ]
    )
    return hashlib.sha1(seed.encode("utf-8", errors="ignore")).hexdigest()[:16]


def tokenize(text: str) -> List[str]:
    source = (text or "").lower()
    tokens: List[str] = []
    seen = set()

    def add(token: str) -> None:
        normalized = token.strip()
        if not normalized:
            return
        if re.fullmatch(r"[\u4e00-\u9fff]", normalized):
            return
        if re.fullmatch(r"[a-z]", normalized):
            return
        if normalized not in seen:
            seen.add(normalized)
            tokens.append(normalized)

    if jieba is not None:
        try:
            for piece in jieba.cut(source):
                add(piece)
        except Exception:
            pass

    for piece in re.findall(r"[a-z0-9][a-z0-9_\-./:]{1,}", source):
        add(piece)
    for piece in re.findall(r"[\u4e00-\u9fff]{2,}", source):
        add(piece)
    return tokens


def build_snippet_terms(query: str) -> List[str]:
    candidates: List[str] = []
    normalized_query = normalize_spaces(query).lower()
    if normalized_query:
        candidates.append(normalized_query)
    candidates.extend(token.lower() for token in tokenize(query))
    candidates.extend(re.findall(r"[a-z0-9][a-z0-9_\-./:]{1,}|[\u4e00-\u9fff]{2,}", normalized_query))

    ordered: List[str] = []
    seen = set()
    for candidate in sorted(candidates, key=lambda item: (-len(item), item)):
        normalized = normalize_spaces(candidate).lower()
        if len(normalized) < 2 or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered[:16]


def extract_snippet_window(text: str, start: int, end: int, window_chars: int) -> Tuple[str, int, int]:
    desired_length = max(int(window_chars), end - start)
    context = max(24, (desired_length - (end - start)) // 2)
    snippet_start = max(0, start - context)
    snippet_end = min(len(text), end + context)

    current_length = snippet_end - snippet_start
    if current_length < desired_length:
        shortfall = desired_length - current_length
        grow_left = min(snippet_start, math.ceil(shortfall / 2))
        grow_right = min(len(text) - snippet_end, shortfall - grow_left)
        snippet_start -= grow_left
        snippet_end += grow_right
        remaining = desired_length - (snippet_end - snippet_start)
        if remaining > 0 and snippet_start > 0:
            extra_left = min(snippet_start, remaining)
            snippet_start -= extra_left
            remaining -= extra_left
        if remaining > 0 and snippet_end < len(text):
            snippet_end = min(len(text), snippet_end + remaining)

    snippet_text = text[snippet_start:snippet_end].strip()
    if snippet_start > 0 and snippet_text:
        snippet_text = f"…{snippet_text}"
    if snippet_end < len(text) and snippet_text:
        snippet_text = f"{snippet_text}…"
    return snippet_text, snippet_start, snippet_end


def extract_verbatim_snippets(
    query: str,
    entry: dict,
    window_chars: int = 220,
    max_snippets: int = 1,
) -> List[Dict[str, object]]:
    terms = build_snippet_terms(query)
    if not terms:
        return []

    window_chars = max(80, min(600, int(window_chars)))
    max_snippets = max(1, min(5, int(max_snippets)))
    entry_field = normalize_spaces(str(entry.get("field", "content"))).lower() or "content"

    field_candidates: List[Tuple[str, str]] = []
    if entry_field in {"fact", "concept"}:
        field_candidates.append((entry_field, str(entry.get("search_text", ""))))
    else:
        field_candidates.extend(
            [
                ("title", str(entry.get("title", ""))),
                ("description", str(entry.get("description", ""))),
                ("content", str(entry.get("content", ""))),
            ]
        )
        fallback_search_text = str(entry.get("search_text", ""))
        if fallback_search_text:
            field_candidates.append(("content", fallback_search_text))

    snippets: List[Dict[str, object]] = []
    covered_regions: List[Tuple[str, int, int]] = []
    seen_texts = set()

    for candidate_field, candidate_text in field_candidates:
        normalized_text = normalize_spaces(candidate_text)
        if not normalized_text:
            continue

        dedupe_key = (candidate_field, normalized_text)
        if dedupe_key in seen_texts:
            continue
        seen_texts.add(dedupe_key)

        lowered = normalized_text.lower()
        matches: List[Tuple[int, int, str]] = []
        for term in terms:
            cursor = lowered.find(term)
            while cursor >= 0:
                match_end = cursor + len(term)
                matches.append((cursor, match_end, normalized_text[cursor:match_end]))
                if len(matches) >= max_snippets * 6:
                    break
                cursor = lowered.find(term, cursor + max(1, len(term)))
            if len(matches) >= max_snippets * 6:
                break

        matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
        for match_start, match_end, match_text in matches:
            is_covered = any(
                field_name == candidate_field and not (match_end <= region_start or match_start >= region_end)
                for field_name, region_start, region_end in covered_regions
            )
            if is_covered:
                continue

            snippet_text, snippet_start, snippet_end = extract_snippet_window(
                normalized_text, match_start, match_end, window_chars
            )
            snippets.append(
                {
                    "field": candidate_field,
                    "match": match_text,
                    "start": match_start,
                    "end": match_end,
                    "text": snippet_text,
                }
            )
            covered_regions.append((candidate_field, snippet_start, snippet_end))
            if len(snippets) >= max_snippets:
                return snippets

    return snippets


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


def parse_timestamp_seconds(value: str) -> float:
    candidate = normalize_spaces(value)
    if not candidate:
        return 0.0

    try:
        normalized = candidate.replace("Z", "+00:00")
        return max(0.0, datetime.datetime.fromisoformat(normalized).timestamp())
    except Exception:
        return 0.0


def calculate_age_days(updated_at: str) -> float:
    """
    Parse an ISO timestamp and return the number of days since that update.

    Args:
        updated_at: ISO 8601 timestamp string (e.g. "2026-03-05T14:30:00" or "2026-03-05T14:30:00Z")

    Returns:
        float: Days elapsed since the timestamp, relative to the current UTC time.
               Returns 0.0 if the timestamp cannot be parsed or is in the future.
    """
    if not updated_at:
        return 0.0
    try:
        normalized = updated_at.strip().replace("Z", "+00:00")
        ts = datetime.datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return 0.0
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    age_seconds = now - ts
    if age_seconds < 0:
        return 0.0
    return age_seconds / 86400.0


def temporal_decay_score(base_score: float, age_days: float, half_life: float = 30.0) -> float:
    """
    Apply exponential temporal decay to a relevance score.

    The decay factor halves every `half_life` days:
        decay_factor = 0.5 ^ (age_days / half_life)

    Formula: decayed_score = base_score * decay_factor

    Args:
        base_score: The raw relevance score before decay.
        age_days:   How many days old the entry is.
        half_life:  Number of days after which the score drops to 50%%. Default 30.

    Returns:
        float: base_score multiplied by the decay factor.
               Returns base_score unchanged when half_life is 0 or negative (decay disabled).

    Examples:
        30 days old, half_life=30  -> 0.5x
        60 days old, half_life=30  -> 0.25x
        90 days old, half_life=30  -> 0.125x
        0 days old                 -> 1.0x
    """
    if half_life <= 0.0 or age_days < 0.0:
        return base_score
    decay_factor = 0.5 ** (age_days / half_life)
    return base_score * decay_factor


def count_entries_by_layer(entries: List[dict]) -> Dict[str, int]:
    counts: Dict[str, int] = {layer: 0 for layer in KNOWN_LAYERS}
    for entry in entries:
        layer = str(entry.get("layer", "")).strip() or "session"
        counts[layer] = counts.get(layer, 0) + 1
    return counts


def classify_query_intent(query: str, parsed: Dict[str, object]) -> Tuple[str, str]:
    explicit_route = normalize_spaces(str(parsed.get("route", parsed.get("intent", "")))).lower()
    if explicit_route in ROUTE_VALUES and explicit_route != "auto":
        return explicit_route, explicit_route

    scope = normalize_spaces(str(parsed.get("scope", ""))).lower()
    source_kind = normalize_spaces(str(parsed.get("source_kind", parsed.get("sourceKind", "")))).lower()
    task_state = normalize_spaces(str(parsed.get("task_state", parsed.get("taskState", "")))).lower()
    query_text = normalize_spaces(query).lower()

    if source_kind in {"blackboard", "run", "cron", "task"} or task_state or scope in {"task", "run"}:
        return "task", explicit_route
    if scope == "reference":
        return "reference", explicit_route
    if scope in DURABLE_SCOPES:
        return "durable", explicit_route
    if RECENT_QUERY_PATTERN.search(query_text):
        return "recent", explicit_route
    if TASK_QUERY_PATTERN.search(query_text):
        return "task", explicit_route
    if REFERENCE_QUERY_PATTERN.search(query_text):
        return "reference", explicit_route
    if DURABLE_QUERY_PATTERN.search(query_text):
        return "durable", explicit_route
    return "mixed", explicit_route


def build_query_route(query: str, parsed: Dict[str, object]) -> Dict[str, object]:
    intent, explicit_route = classify_query_intent(query, parsed)
    layer_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"durable": 1.0, "session": 1.0, "event": 0.96, "task": 1.0},
        "durable": {"durable": 1.35, "session": 0.94, "event": 0.82, "task": 0.72},
        "task": {"durable": 0.76, "session": 0.92, "event": 0.84, "task": 1.35},
        "recent": {"durable": 0.8, "session": 1.16, "event": 1.35, "task": 0.96},
        "reference": {"durable": 1.18, "session": 0.92, "event": 0.82, "task": 0.9},
    }
    scope_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"user": 1.06, "feedback": 1.04, "project": 1.03, "reference": 1.03, "summary": 1.0, "task": 0.98, "run": 0.98},
        "durable": {"user": 1.22, "feedback": 1.18, "project": 1.1, "reference": 1.12, "summary": 0.88, "task": 0.76, "run": 0.72},
        "task": {"user": 0.88, "feedback": 0.94, "project": 1.08, "reference": 0.96, "summary": 0.92, "task": 1.2, "run": 1.24},
        "recent": {"user": 0.92, "feedback": 0.96, "project": 1.0, "reference": 0.94, "summary": 1.06, "task": 1.02, "run": 1.04},
        "reference": {"user": 0.92, "feedback": 0.96, "project": 1.14, "reference": 1.28, "summary": 0.9, "task": 0.9, "run": 0.88},
    }
    source_kind_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"writeback": 1.04, "session": 1.0, "hook": 0.98, "blackboard": 1.0, "run": 1.02, "cron": 1.01},
        "durable": {"writeback": 1.12, "session": 1.02, "hook": 0.9, "blackboard": 0.84, "run": 0.82, "cron": 0.8},
        "task": {"writeback": 0.86, "session": 0.96, "hook": 0.88, "blackboard": 1.16, "run": 1.18, "cron": 1.12},
        "recent": {"writeback": 0.96, "session": 1.08, "hook": 1.14, "blackboard": 1.0, "run": 1.02, "cron": 1.04},
        "reference": {"writeback": 1.06, "session": 0.98, "hook": 0.9, "blackboard": 0.9, "run": 0.9, "cron": 0.9},
    }
    freshness_weights: Dict[str, Dict[str, float]] = {
        "mixed": {"hot": 1.02, "warm": 1.0, "cold": 0.98, "unknown": 1.0},
        "durable": {"hot": 1.01, "warm": 1.0, "cold": 1.0, "unknown": 1.0},
        "task": {"hot": 1.1, "warm": 1.04, "cold": 0.96, "unknown": 0.98},
        "recent": {"hot": 1.12, "warm": 1.05, "cold": 0.92, "unknown": 0.96},
        "reference": {"hot": 1.0, "warm": 1.0, "cold": 0.99, "unknown": 1.0},
    }

    effective_layer_weights = dict(layer_weights.get(intent, layer_weights["mixed"]))
    effective_scope_weights = dict(scope_weights.get(intent, scope_weights["mixed"]))
    effective_source_kind_weights = dict(source_kind_weights.get(intent, source_kind_weights["mixed"]))
    effective_freshness_weights = dict(freshness_weights.get(intent, freshness_weights["mixed"]))

    if bool(parsed.get("prefer_summaries")):
        effective_scope_weights["summary"] = effective_scope_weights.get("summary", 1.0) + 0.08
        effective_layer_weights["session"] = effective_layer_weights.get("session", 1.0) + 0.04

    return {
        "intent": intent,
        "explicitRoute": explicit_route,
        "layerWeights": effective_layer_weights,
        "scopeWeights": effective_scope_weights,
        "sourceKindWeights": effective_source_kind_weights,
        "freshnessWeights": effective_freshness_weights,
    }


def normalize_score_map(scores: Dict[str, float]) -> Dict[str, float]:
    if not scores:
        return {}
    max_score = max(float(value) for value in scores.values())
    if max_score <= 0:
        return {}
    return {entry_id: float(value) / max_score for entry_id, value in scores.items() if float(value) > 0}


def task_state_weight(task_state: str, intent: str) -> float:
    normalized = normalize_spaces(task_state).lower()
    if not normalized:
        return 1.0
    if intent == "task":
        if normalized in {"processing", "active", "pending"}:
            return 1.12
        if normalized in {"ok", "pr_submitted", "pr_created"}:
            return 1.06
        if normalized in {"failed", "timeout", "dev_error", "report_error", "build_fail"}:
            return 1.01
    if intent == "recent":
        if normalized in {"processing", "active", "pending"}:
            return 1.06
        if normalized in {"ok", "pr_submitted", "pr_created"}:
            return 1.04
    return 1.0


def score_entry(
    entry: dict,
    effective_mode: str,
    route: Dict[str, object],
    bm25_norm: Dict[str, float],
    dense_norm: Dict[str, float],
    temporal_decay: Optional[Dict[str, object]] = None,
) -> Optional[Tuple[float, Dict[str, object]]]:
    entry_id = str(entry.get("id", "")).strip()
    bm25_component = float(bm25_norm.get(entry_id, 0.0))
    dense_component = float(dense_norm.get(entry_id, 0.0))

    if effective_mode == "bm25":
        retrieval_score = bm25_component
    elif effective_mode == "dense":
        retrieval_score = dense_component
    else:
        retrieval_score = (0.58 * bm25_component) + (0.42 * dense_component)

    if retrieval_score <= 0:
        return None

    layer = normalize_spaces(str(entry.get("layer", ""))).lower() or "session"
    scope = normalize_spaces(str(entry.get("scope", ""))).lower() or "summary"
    source_kind = normalize_spaces(str(entry.get("sourceKind", ""))).lower()
    freshness = normalize_spaces(str(entry.get("freshness", ""))).lower() or "unknown"
    task_state = normalize_spaces(str(entry.get("taskState", ""))).lower()
    intent = str(route.get("intent", "mixed"))
    layer_weight = float(dict(route.get("layerWeights", {})).get(layer, 1.0))
    scope_weight = float(dict(route.get("scopeWeights", {})).get(scope, 1.0))
    source_kind_weight = float(dict(route.get("sourceKindWeights", {})).get(source_kind, 1.0))
    freshness_weight = float(dict(route.get("freshnessWeights", {})).get(freshness, 1.0))
    state_weight = task_state_weight(task_state, intent)
    coverage_weight = 1.04 if effective_mode == "hybrid" and bm25_component > 0 and dense_component > 0 else 1.0
    final_score = retrieval_score * layer_weight * scope_weight * source_kind_weight * freshness_weight * state_weight * coverage_weight

    # Apply temporal decay: newer content is favored over older content.
    decay_factor = 1.0
    if temporal_decay and bool(temporal_decay.get("enabled", False)):
        updated_at = str(entry.get("t", "")).strip()
        half_life = float(temporal_decay.get("half_life_days", 30.0))
        age_days = calculate_age_days(updated_at)
        decay_factor = 0.5 ** (age_days / half_life) if half_life > 0 else 1.0
        final_score = final_score * decay_factor

    return (
        final_score,
        {
            "retrievalScore": retrieval_score,
            "layerWeight": layer_weight,
            "scopeWeight": scope_weight,
            "sourceKindWeight": source_kind_weight,
            "freshnessWeight": freshness_weight,
            "taskStateWeight": state_weight,
            "coverageWeight": coverage_weight,
            "decayFactor": round(decay_factor, 6),
        },
    )


def apply_field_match_bonus(
    scored: List[Tuple[str, float, Dict[str, object]]],
    entries_by_id: Dict[str, dict],
    query_text_lower: str,
) -> List[Tuple[str, float, Dict[str, object]]]:
    """
    Apply weight bonuses when query terms match specific fields.

    Based on restored-cli's hybrid ranking:
      - query matches title (name) exactly → ×1.3
      - query matches description → ×1.2
      - matchedField='fact' in hybrid context → ×1.1
      - matchedField='concept' → ×1.15

    Returns new tuples (immutable — input list is not mutated).
    """
    query_terms = set(query_text_lower.split())
    if not query_terms:
        return scored

    result: List[Tuple[str, float, Dict[str, object]]] = []
    for entry_id, final_score, meta in scored:
        entry = entries_by_id.get(entry_id, {})
        field = str(entry.get("field", "content"))
        title_text = str(entry.get("title", "")).lower()
        desc_text = str(entry.get("description", "")).lower()

        bonus = 1.0

        # Title/name exact match bonus: require at least 2-term overlap
        if title_text and len(query_terms) >= 2:
            overlap = len(query_terms & set(title_text.split()))
            if overlap >= min(2, len(query_terms)):
                bonus *= 1.3

        # Description match bonus
        if desc_text and len(query_terms) >= 2:
            overlap = len(query_terms & set(desc_text.split()))
            if overlap >= min(2, len(query_terms)):
                bonus *= 1.2

        # Field type bonus (facts/concepts are more signal-dense than raw content)
        if field == "fact":
            bonus *= 1.1
        elif field == "concept":
            bonus *= 1.15

        # Build new meta dict (immutable)
        new_meta = {**meta, "fieldMatchBonus": round(bonus, 6)}
        result.append((entry_id, final_score * bonus, new_meta))

    return result


def rerank_entries(
    entries_by_id: Dict[str, dict],
    effective_mode: str,
    top_k: int,
    route: Dict[str, object],
    bm25_map: Dict[str, float],
    dense_map: Dict[str, float],
    query_text_lower: str = "",
    temporal_decay: Optional[Dict[str, object]] = None,
) -> Tuple[List[Tuple[str, float]], Dict[str, Dict[str, object]], int]:
    candidate_ids = set()
    if effective_mode in {"bm25", "hybrid"}:
        candidate_ids.update(bm25_map.keys())
    if effective_mode in {"dense", "hybrid"}:
        candidate_ids.update(dense_map.keys())

    bm25_norm = normalize_score_map(bm25_map)
    dense_norm = normalize_score_map(dense_map)

    # Collect all scored entries
    all_scored: List[Tuple[str, float, Dict[str, object]]] = []

    for entry_id in candidate_ids:
        entry = entries_by_id.get(entry_id)
        if entry is None:
            continue
        scored = score_entry(entry, effective_mode, route, bm25_norm, dense_norm, temporal_decay)
        if scored is None:
            continue
        final_score, meta = scored

        # Determine which field contributed the highest retrieval signal
        field = str(entry.get("field", "content"))
        bm25_v = float(bm25_norm.get(entry_id, 0.0))
        dense_v = float(dense_norm.get(entry_id, 0.0))
        if effective_mode == "bm25":
            primary_v = bm25_v
        elif effective_mode == "dense":
            primary_v = dense_v
        else:
            primary_v = 0.58 * bm25_v + 0.42 * dense_v

        matched_field = field if primary_v > 0 else "content"
        meta["matchedField"] = matched_field

        all_scored.append((entry_id, final_score, meta))

    # Apply field-match weight bonuses (immutable — returns new list)
    all_scored = apply_field_match_bonus(all_scored, entries_by_id, query_text_lower)

    # Deduplicate by record_id: keep the highest-scoring sub-entry per record
    seen_record_ids: set = set()
    deduped_scored: List[Tuple[str, float, Dict[str, object]]] = []
    for entry_id, final_score, meta in sorted(all_scored, key=lambda x: x[1], reverse=True):
        record_id = str(entries_by_id.get(entry_id, {}).get("record_id", entry_id))
        if record_id not in seen_record_ids:
            seen_record_ids.add(record_id)
            deduped_scored.append((entry_id, final_score, meta))

    # Build rank_meta ONLY from entries that survived deduplication, so that
    # matchedField always refers to the entry that actually appears in results.
    rank_meta: Dict[str, Dict[str, object]] = {
        entry_id: meta for entry_id, _, meta in deduped_scored
    }

    # Apply top-K on deduplicated entries
    top_entries = deduped_scored[:top_k]
    ranked: List[Tuple[str, float]] = [(eid, score) for eid, score, _ in top_entries]
    return ranked, rank_meta, len(candidate_ids)


def _build_entry_fields(payload: dict, entry_id: str, record_id: str, field: str, search_text: str, layer: str) -> dict:
    """Shared field construction for parent and sub-entries.

    `entry_id`  — the unique key for this entry (parent id or parent_id__fact/concept_N)
    `record_id` — the parent record id all sub-entries link back to (used for deduplication)
    """
    excerpt = search_text
    return {
        "id": entry_id,
        "record_id": record_id,
        "field": field,
        "search_text": search_text[:6000],
        "tokens": tokenize(search_text),
        "excerpt": excerpt[:240],
        "title": payload.get("title", "") or excerpt[:120] or entry_id,
        "description": str(payload.get("description", "")) or "",
        "layer": layer,
        "tool": str(payload.get("tool", "unknown")).strip() or "unknown",
        "type": str(payload.get("type", "")).strip(),
        "project": str(payload.get("project", "")).strip(),
        "agent": str(payload.get("agent", "")).strip(),
        "t": str(payload.get("t", "")).strip(),
        "scope": str(payload.get("scope", "")).strip(),
        "visibility": str(payload.get("visibility", "")).strip(),
        "sourceKind": str(payload.get("source_kind", "")).strip(),
        "memoryLevel": str(payload.get("memory_level", "")).strip(),
        "workspace": str(payload.get("workspace", "")).strip(),
        "taskState": str(payload.get("task_state", "")).strip(),
        "freshness": str(payload.get("freshness", "")).strip(),
        "description": str(payload.get("description", "")).strip(),
        "content": str(payload.get("content", "")).strip(),
    }


def _extract_item_text(item) -> str:
    """Extract display text from a fact or concept item.

    Handles two formats:
      - Object format:  { "value": [...string items...], "Count": N }
        -> returns all string items joined with " / "
      - String format:  plain string
        -> returns the string as-is
    """
    if isinstance(item, str):
        return normalize_spaces(item)
    if isinstance(item, dict) and isinstance(item.get("value"), list):
        parts = [normalize_spaces(str(v)) for v in item["value"] if v]
        return " / ".join(parts)
    return normalize_spaces(str(item) if item else "")


def build_entry(payload: dict) -> List[dict]:
    """
    Build search entries for one structured record.

    Returns a list containing one parent entry (field='content') plus one entry
    per fact (field='fact') and one per concept (field='concept').  Records
    without facts/concepts produce only the parent entry.

    PII redaction is applied to ``content`` and ``title`` fields before any other
    processing (guarded by ``REDACTION_CONFIG.enabled``).  The noise filter always
    evaluates the original (pre-redaction) raw text so that redaction placeholders
    do not silently bypass noise detection.
    """
    # Preserve originals for the noise filter; redact in-place for the rest.
    raw_title = normalize_spaces(str(payload.get("title", "")))
    raw_content = normalize_spaces(str(payload.get("content", "")))

    if REDACTION_CONFIG.enabled:
        payload = {**payload, "title": redact_sensitive(raw_title), "content": redact_sensitive(raw_content)}

    title = normalize_spaces(str(payload.get("title", "")))
    content = normalize_spaces(str(payload.get("content", "")))
    raw_text = normalize_spaces(" ".join(filter(None, [raw_title, raw_content])))
    if is_noise(raw_text):
        return []

    record_id = str(payload.get("id", "")).strip() or fallback_id(payload, title, content)
    layer = derive_entry_layer(payload)

    parent_search = normalize_spaces(
        " ".join(
            filter(
                None,
                [
                    title,
                    content,
                    str(payload.get("agent", "")).strip(),
                    str(payload.get("project", "")).strip(),
                    str(payload.get("type", "")).strip(),
                    str(payload.get("tool", "")).strip(),
                ],
            )
        )
    )[:6000]

    entries: List[dict] = [
        _build_entry_fields(payload, record_id, record_id, "content", parent_search, layer)
    ]

    for i, fact in enumerate(payload.get("facts", [])):
        fact_text = _extract_item_text(fact)
        if fact_text and not is_noise(fact_text):
            entries.append(
                _build_entry_fields(
                    payload,
                    f"{record_id}__fact_{i}",
                    record_id,
                    "fact",
                    fact_text,
                    layer,
                )
            )

    for i, concept in enumerate(payload.get("concepts", [])):
        concept_text = _extract_item_text(concept)
        if concept_text and not is_noise(concept_text):
            entries.append(
                _build_entry_fields(
                    payload,
                    f"{record_id}__concept_{i}",
                    record_id,
                    "concept",
                    concept_text,
                    layer,
                )
            )

    return entries


def _load_entries_uncached() -> List[dict]:
    seen_ids: set = set()
    entries: List[dict] = []
    if not os.path.isdir(STRUCTURED_DIR):
        return []

    for file_name in STRUCTURED_FILES:
        file_path = os.path.join(STRUCTURED_DIR, file_name)
        if not os.path.isfile(file_path):
            continue
        try:
            with open(file_path, "r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except Exception:
                        continue
                    # Schema validation: skip records that fail contract validation
                    if _SCHEMA_VALIDATION_AVAILABLE:
                        valid, errors = validate_record(payload)
                        if not valid:
                            continue
                    for entry in build_entry(payload):
                        if entry["id"] not in seen_ids:
                            seen_ids.add(entry["id"])
                            entries.append(entry)
        except Exception:
            continue

    return entries


def load_entries() -> List[dict]:
    current_signature = build_structured_signature()
    if (
        _ENTRIES_CACHE["data"] is not None
        and str(_ENTRIES_CACHE.get("signature", "")) == current_signature
    ):
        return _ENTRIES_CACHE["data"]

    invalidate_entries_cache()
    data = _load_entries_uncached()
    _ENTRIES_CACHE["data"] = data
    _ENTRIES_CACHE["loaded_at"] = time_module.time()
    _ENTRIES_CACHE["signature"] = current_signature
    return data


def load_embeddings_index() -> Dict[str, dict]:
    current_signature = build_embeddings_signature()
    if (
        _INDEX_CACHE["data"] is not None
        and str(_INDEX_CACHE.get("signature", "")) == current_signature
    ):
        return _INDEX_CACHE["data"]

    invalidate_embeddings_cache()
    data = _load_embeddings_index_uncached()
    _INDEX_CACHE["data"] = data
    _INDEX_CACHE["loaded_at"] = time_module.time()
    _INDEX_CACHE["signature"] = current_signature
    return data


def _load_embeddings_index_uncached() -> Dict[str, dict]:
    """Uncached implementation — use load_embeddings_index() instead."""
    records: Dict[str, dict] = {}
    if not os.path.isfile(EMBEDDINGS_INDEX):
        return records

    try:
        with open(EMBEDDINGS_INDEX, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except Exception:
                    continue
                record_id = str(payload.get("id", "")).strip()
                if record_id and isinstance(payload.get("embedding"), list):
                    records[record_id] = payload
    except Exception:
        return {}
    return records


def keyword_overlap_scores(entries: List[dict], query_tokens: List[str]) -> Dict[str, float]:
    scores: Dict[str, float] = {}
    query_set = set(query_tokens)
    for entry in entries:
        overlap = sum(1 for token in entry.get("tokens", []) if token in query_set)
        if overlap > 0:
            scores[entry["id"]] = float(overlap)
    return scores


def get_bm25_model(entries: List[dict], cache_key: str = ""):
    if not entries:
        return None

    prune_timed_cache(_BM25_CACHE, _CACHE_TTL, _BM25_CACHE_MAX_ENTRIES)
    now = time_module.time()
    if cache_key:
        cached = _BM25_CACHE.get(cache_key)
        if cached is not None and (now - cached["created_at"]) < _CACHE_TTL and cached["size"] == len(entries):
            return cached["model"]

    corpus = [entry["tokens"] if entry["tokens"] else ["_empty_"] for entry in entries]
    model = BM25Okapi(corpus)

    if cache_key:
        if len(_BM25_CACHE) >= _BM25_CACHE_MAX_ENTRIES:
            oldest_key = min(_BM25_CACHE, key=lambda key: _BM25_CACHE[key]["created_at"])
            _BM25_CACHE.pop(oldest_key, None)
        _BM25_CACHE[cache_key] = {
            "model": model,
            "created_at": now,
            "size": len(entries),
        }

    return model


def bm25_scores(entries: List[dict], query_tokens: List[str], cache_key: str = "") -> Dict[str, float]:
    if not entries or not query_tokens:
        return {}
    if BM25Okapi is None:
        return keyword_overlap_scores(entries, query_tokens)
    model = get_bm25_model(entries, cache_key)
    if model is None:
        return {}
    raw_scores = model.get_scores(query_tokens)
    scores: Dict[str, float] = {}
    for index, score in enumerate(raw_scores):
        if score > 0:
            scores[entries[index]["id"]] = float(score)
    return scores


def cosine_similarity(left: Iterable[float], right: Iterable[float]) -> float:
    left_values = [float(value) for value in left]
    right_values = [float(value) for value in right]
    if not left_values or not right_values or len(left_values) != len(right_values):
        return 0.0

    numerator = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for left_value, right_value in zip(left_values, right_values):
        numerator += left_value * right_value
        left_norm += left_value * left_value
        right_norm += right_value * right_value
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return numerator / math.sqrt(left_norm * right_norm)


def embed_query(query: str, runtime: Dict[str, object], model_name: str = "") -> Tuple[Optional[List[float]], Optional[str], bool]:
    effective_model = str(model_name or runtime.get("model", DEFAULT_MODEL) or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    effective_adapter = normalize_embedding_adapter(runtime.get("adapter") or runtime.get("backend"), effective_model) or "hash"
    cache_key = build_query_embedding_cache_key(
        query,
        effective_adapter,
        effective_model,
        str(runtime.get("baseUrl", "")),
    )
    cached_embedding = get_cached_query_embedding(cache_key)
    if cached_embedding is not None:
        return cached_embedding, None, True

    vector, error, _, resolved_model = embed_query_with_runtime(query, runtime, effective_model)
    if vector is not None and error is None:
        store_query_embedding(cache_key, vector)
    if resolved_model and resolved_model != effective_model:
        runtime["model"] = resolved_model
    return vector, error, False


def dense_scores(entries_by_id: Dict[str, dict], query: str) -> Tuple[Dict[str, float], Optional[str], Dict[str, object]]:
    """
    Score all field-level sub-entries in the index against the query embedding.

    Returns a dict keyed by entry_id (sub-entry id) with cosine similarity scores.
    For records with multiple field sub-entries (content, fact_*, concept_*),
    only the highest-scoring sub-entry per record_id is returned after deduplication.

    Handles legacy v1 index records (no record_id/field) transparently:
    - Missing record_id  -> use id as record_id
    - Missing field      -> default to "content"
    """
    index_records = load_embeddings_index()
    if not index_records:
        return {}, "missing-embeddings-index", {"queryEmbeddingCacheHit": False}

    first_record = next(iter(index_records.values()))
    first_schema_version = int(first_record.get("featureSchemaVersion", 0) or 0)
    if first_schema_version != VECTOR_SCHEMA_VERSION:
        return {}, (
            f"embedding-schema-version-mismatch:stored={first_schema_version},"
            f"expected={VECTOR_SCHEMA_VERSION};rebuild-memory-embeddings-required"
        ), {"queryEmbeddingCacheHit": False}
    model_name = str(first_record.get("model", DEFAULT_MODEL)).strip() or DEFAULT_MODEL
    backend = normalize_embedding_adapter(str(first_record.get("backend", "")).strip(), model_name) or "hash"
    if model_name.startswith("hashing-"):
        model_name = HASH_MODEL
    record_config_hash = str(first_record.get("configHash", "")).strip()
    query_runtime = dict(EMBEDDING_RUNTIME)
    if record_config_hash:
        active_adapter = normalize_embedding_adapter(
            EMBEDDING_RUNTIME.get("adapter") or EMBEDDING_RUNTIME.get("backend"),
            str(EMBEDDING_RUNTIME.get("model", DEFAULT_MODEL) or DEFAULT_MODEL),
        ) or "hash"
        active_model_name = (
            HASH_MODEL
            if active_adapter == "hash"
            else str(EMBEDDING_RUNTIME.get("model", DEFAULT_MODEL) or DEFAULT_MODEL).strip() or DEFAULT_MODEL
        )
        active_config_hash = build_embedding_config_hash(
            active_adapter,
            active_model_name,
            str(EMBEDDING_RUNTIME.get("baseUrl", "")),
        )
        if record_config_hash != active_config_hash:
            return {}, "embedding-config-mismatch:rebuild-memory-embeddings-required", {"queryEmbeddingCacheHit": False}
        query_runtime["adapter"] = active_adapter
        query_runtime["backend"] = active_adapter
        query_runtime["model"] = active_model_name
    else:
        query_runtime["adapter"] = backend
        query_runtime["backend"] = backend
        query_runtime["model"] = model_name

    query_vector, error, query_embedding_cache_hit = embed_query(query, query_runtime, model_name)
    if error is not None or query_vector is None:
        return {}, error, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}
    first_embedding = first_record.get("embedding", [])
    if isinstance(first_embedding, list) and first_embedding and len(first_embedding) != len(query_vector):
        return {}, f"embedding-dimension-mismatch:index={len(first_embedding)},query={len(query_vector)}", {
            "queryEmbeddingCacheHit": bool(query_embedding_cache_hit)
        }

    # Score every sub-entry individually; deduplicate by record_id keeping the best.
    best_by_record: Dict[str, Tuple[str, float, dict]] = {}  # record_id -> (entry_id, score, payload)
    skipped_schema_mismatch = 0
    for entry_id, payload in index_records.items():
        record_schema_version = int(payload.get("featureSchemaVersion", 0) or 0)
        if record_schema_version != VECTOR_SCHEMA_VERSION:
            skipped_schema_mismatch += 1
            continue

        # Determine record_id and field (handle legacy v1 records)
        record_id = str(payload.get("record_id", entry_id))
        field = str(payload.get("field", "content"))

        score = cosine_similarity(query_vector, payload.get("embedding", []))
        if score <= 0:
            continue

        # Keep highest-scoring sub-entry per record_id
        existing = best_by_record.get(record_id)
        if existing is None or score > existing[1]:
            best_by_record[record_id] = (entry_id, score, {**payload, "record_id": record_id, "field": field})

    if skipped_schema_mismatch > 0:
        sys.stderr.write(
            f"[dense_scores] skipped {skipped_schema_mismatch} records due to "
            f"schema version mismatch (expected={VECTOR_SCHEMA_VERSION}); "
            "run generate-embeddings to rebuild the index\n"
        )

    # Normalize scores to [0, 1] range using max-score scaling
    if not best_by_record:
        return {}, None, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}
    max_score = max(float(v[1]) for v in best_by_record.values())
    scores: Dict[str, float] = {}
    for record_id, (entry_id, raw_score, _payload) in best_by_record.items():
        scores[entry_id] = float(raw_score) / max_score if max_score > 0 else 0.0

    return scores, None, {"queryEmbeddingCacheHit": bool(query_embedding_cache_hit)}


def ranked_pairs(scores: Dict[str, float], limit: int) -> List[Tuple[str, float]]:
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]


def format_results(
    ranked: List[Tuple[str, float]],
    entries_by_id: Dict[str, dict],
    sources: Dict[str, List[str]],
    bm25_map: Dict[str, float],
    dense_map: Dict[str, float],
    rank_meta: Dict[str, Dict[str, object]],
    query: str,
    include_verbatim: bool = False,
    snippet_window: int = 220,
    max_verbatim_per_result: int = 1,
    workspace_hints: Optional[Dict] = None,
) -> List[dict]:
    results: List[dict] = []
    for index, (entry_id, score) in enumerate(ranked, start=1):
        entry = entries_by_id.get(entry_id)
        if entry is None:
            continue
        raw_meta = rank_meta.get(entry_id, {})
        meta = {
            key: round(float(value), 6) if isinstance(value, (int, float)) else value
            for key, value in raw_meta.items()
        }
        search_text = entry.get("search_text", "")
        content_text = entry.get("content", "")
        estimated_tokens = (len(search_text) + len(content_text)) // 4

        # Memory drift detection — pure read, never writes.
        drift_info = check_memory_drift(entry, workspace_hints)

        result_payload = {
            "rank": index,
            "id": entry_id,
            "record_id": entry.get("record_id", entry_id),
            "field": entry.get("field", "content"),
            "score": round(float(score), 6),
            "tool": entry["tool"],
            "project": entry["project"],
            "type": entry["type"],
            "t": entry["t"][:19] if entry["t"] else "",
            "title": entry["title"][:140],
            "excerpt": entry["excerpt"][:240],
            "scope": entry.get("scope", ""),
            "visibility": entry.get("visibility", ""),
            "sourceKind": entry.get("sourceKind", ""),
            "memoryLevel": entry.get("memoryLevel", ""),
            "workspace": entry.get("workspace", ""),
            "taskState": entry.get("taskState", ""),
            "freshness": entry.get("freshness", ""),
            "layer": entry.get("layer", ""),
            "sources": sources.get(entry_id, []),
            "bm25Score": round(float(bm25_map.get(entry_id, 0.0)), 6) if entry_id in bm25_map else None,
            "denseScore": round(float(dense_map.get(entry_id, 0.0)), 6) if entry_id in dense_map else None,
            "rankMeta": meta or None,
            "estimated_tokens": estimated_tokens,
            "driftRisk": drift_info["driftRisk"],
            "driftSignals": drift_info["driftSignals"] or None,
            "missingFileCount": drift_info.get("missingFileCount") or None,
        }
        if include_verbatim:
            result_payload["verbatimSnippets"] = extract_verbatim_snippets(
                query,
                entry,
                window_chars=snippet_window,
                max_snippets=max_verbatim_per_result,
            )
        results.append(result_payload)
    return results


def mmr_rerank(
    entries_by_id: Dict[str, dict],
    relevance_scores: Dict[str, float],
    top_k: int,
    lambda_param: float = 0.7,
) -> List[Tuple[str, float]]:
    """
    Maximal Marginal Relevance (MMR) diversity reranking.

    MMR formula: score(i) = λ * rel(i) - (1-λ) * max(sim(i, s)) for s in selected

    Where:
    - rel(i) = relevance score of candidate i (normalized to [0,1])
    - sim(i, s) = cosine similarity between embeddings of i and selected item s
    - λ = trade-off parameter (0 = pure diversity, 1 = pure relevance)

    Selection algorithm:
    1. Start with the highest relevance item
    2. For each subsequent pick, choose the item that maximizes MMR score
    3. Repeat until maxResults reached

    Args:
        entries_by_id: Map of entry_id -> entry dict (must contain embedding if available)
        relevance_scores: Map of entry_id -> relevance score (higher = more relevant)
        top_k: Maximum number of results to return
        lambda_param: Trade-off between relevance (λ) and diversity (1-λ), default 0.7

    Returns:
        List of (entry_id, mmr_score) tuples, ordered by selection order
    """
    if not relevance_scores or top_k <= 0:
        return []

    # Clamp lambda to [0, 1]
    lambda_param = max(0.0, min(1.0, lambda_param))

    # Load embeddings index to get embedding vectors
    embeddings_index = load_embeddings_index()

    # Build entry_id -> embedding lookup
    entry_embeddings: Dict[str, List[float]] = {}
    for entry_id, entry in entries_by_id.items():
        record_id = str(entry.get("record_id", entry_id))
        # Try to get embedding from index
        if record_id in embeddings_index:
            embedding_data = embeddings_index[record_id]
            embedding = embedding_data.get("embedding", [])
            if embedding:
                entry_embeddings[entry_id] = [float(v) for v in embedding]

    # Normalize relevance scores to [0, 1]
    max_rel = max(float(v) for v in relevance_scores.values())
    if max_rel <= 0:
        return []

    normalized_rel: Dict[str, float] = {
        entry_id: float(score) / max_rel
        for entry_id, score in relevance_scores.items()
        if float(score) > 0
    }

    # MMR selection
    selected: List[Tuple[str, float]] = []
    selected_ids: set = set()
    remaining = set(normalized_rel.keys())

    while remaining and len(selected) < top_k:
        best_mmr_score = -float('inf')
        best_entry_id = None

        for entry_id in remaining:
            rel_score = normalized_rel.get(entry_id, 0.0)

            if not selected_ids:
                # First item: pure relevance
                mmr_score = rel_score
            else:
                # Calculate max similarity to already selected items
                max_sim = 0.0
                entry_emb = entry_embeddings.get(entry_id)

                if entry_emb is not None:
                    for sel_id, _ in selected:
                        sel_emb = entry_embeddings.get(sel_id)
                        if sel_emb is not None:
                            sim = cosine_similarity(entry_emb, sel_emb)
                            max_sim = max(max_sim, sim)

                # MMR formula: λ * rel(i) - (1-λ) * max_sim
                mmr_score = lambda_param * rel_score - (1.0 - lambda_param) * max_sim

            if mmr_score > best_mmr_score:
                best_mmr_score = mmr_score
                best_entry_id = entry_id

        if best_entry_id is None:
            break

        selected.append((best_entry_id, best_mmr_score))
        selected_ids.add(best_entry_id)
        remaining.remove(best_entry_id)

    return selected


def normalize_request_payload(payload: Dict[str, object]) -> Dict[str, object]:
    query = normalize_spaces(str(payload.get("query", "")))
    if not query:
        raise ValueError("query is required")

    raw_mode = normalize_spaces(str(payload.get("mode", "hybrid"))).lower()
    mode = "hybrid" if raw_mode == "auto" else raw_mode
    if mode not in {"bm25", "dense", "hybrid"}:
        mode = "hybrid"

    top_k = normalize_int(
        payload.get("top_k", payload.get("topK", payload.get("limit", 10))),
        fallback=10,
        minimum=1,
    )

    route = normalize_spaces(str(payload.get("route", payload.get("intent", "auto")))).lower() or "auto"
    if route not in ROUTE_VALUES:
        route = "auto"

    # MMR configuration
    mmr_config = payload.get("mmr", {})
    if isinstance(mmr_config, dict):
        mmr_enabled = normalize_bool(mmr_config.get("enabled", False), fallback=False)
        mmr_lambda = float(mmr_config.get("lambda", mmr_config.get("lambda_param", 0.7)))
    else:
        # Support legacy top-level mmr_enabled, mmr_lambda
        mmr_enabled = normalize_bool(payload.get("mmr_enabled", False), fallback=False)
        mmr_lambda = float(payload.get("mmr_lambda", 0.7))

    # Temporal decay configuration: favor newer content in results.
    td_config = payload.get("temporal_decay", {})
    if isinstance(td_config, dict):
        td_enabled = normalize_bool(td_config.get("enabled", False), fallback=False)
        td_half_life = normalize_int(td_config.get("half_life_days", 30), fallback=30, minimum=1)
    else:
        # Support legacy top-level boolean
        td_enabled = normalize_bool(td_config, fallback=False)
        td_half_life = normalize_int(payload.get("temporal_decay_half_life_days", 30), fallback=30, minimum=1)

    # Clamp lambda to [0, 1]
    mmr_lambda = max(0.0, min(1.0, mmr_lambda))

    return {
        "query": query,
        "top_k": top_k,
        "mode": mode,
        "route": route,
        "tool": normalize_spaces(str(payload.get("tool", ""))).lower(),
        "project": normalize_spaces(str(payload.get("project", ""))).lower(),
        "scope": normalize_spaces(str(payload.get("scope", ""))).lower(),
        "source_kind": normalize_spaces(str(payload.get("source_kind", payload.get("sourceKind", "")))).lower(),
        "workspace": normalize_spaces(str(payload.get("workspace", ""))).lower(),
        "task_state": normalize_spaces(str(payload.get("task_state", payload.get("taskState", "")))).lower(),
        "prefer_summaries": normalize_bool(payload.get("prefer_summaries", payload.get("preferSummaries", False)), fallback=False),
        "include_verbatim": normalize_bool(payload.get("include_verbatim", payload.get("includeVerbatim", False)), fallback=False),
        "snippet_window": min(
            600,
            normalize_int(payload.get("snippet_window", payload.get("snippetWindow", 220)), fallback=220, minimum=80),
        ),
        "max_verbatim_per_result": min(
            5,
            normalize_int(
                payload.get("max_verbatim_per_result", payload.get("maxVerbatimPerResult", 1)),
                fallback=1,
                minimum=1,
            ),
        ),
        "mmr_enabled": mmr_enabled,
        "mmr_lambda": mmr_lambda,
        "temporal_decay": {
            "enabled": td_enabled,
            "half_life_days": td_half_life,
        },
    }


def parse_args() -> Dict[str, object]:
    parser = argparse.ArgumentParser(description="Search shared Obsidian memory")
    parser.add_argument("query", nargs="*", help="search query")
    parser.add_argument("--mode", choices=("bm25", "dense", "hybrid", "auto"), default="bm25")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--route", choices=tuple(sorted(ROUTE_VALUES)), default="auto")
    parser.add_argument("--tool", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--scope", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--task-state", default="")
    parser.add_argument("--prefer-summaries", action="store_true")
    parser.add_argument("--include-verbatim", action="store_true")
    parser.add_argument("--snippet-window", type=int, default=220)
    parser.add_argument("--max-verbatim-per-result", type=int, default=1)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--server", action="store_true", help="Run persistent JSONL server mode.")
    args = parser.parse_args()

    if bool(args.server):
        return {"server": True}

    query_parts = list(args.query)
    top_k = args.top_k
    mode = args.mode
    if len(query_parts) >= 3 and query_parts[-2].isdigit() and query_parts[-1] in {"auto", "bm25", "dense", "hybrid"}:
        top_k = int(query_parts[-2])
        mode = query_parts[-1]
        query_parts = query_parts[:-2]
    elif len(query_parts) >= 2 and query_parts[-1].isdigit():
        top_k = int(query_parts[-1])
        query_parts = query_parts[:-1]
    elif len(query_parts) >= 1 and query_parts[-1] in {"auto", "bm25", "dense", "hybrid"} and "--mode" not in sys.argv:
        mode = query_parts[-1]
        query_parts = query_parts[:-1]

    query = normalize_spaces(" ".join(query_parts))
    if not query:
        raise SystemExit('Usage: python semantic-search.py "query" [topK] [strategy]')
    return normalize_request_payload(
        {
            "query": query,
            "top_k": top_k,
            "mode": mode,
            "route": args.route,
            "tool": args.tool,
            "project": args.project,
            "scope": args.scope,
            "source_kind": args.source_kind,
            "workspace": args.workspace,
            "task_state": args.task_state,
            "prefer_summaries": bool(args.prefer_summaries),
            "include_verbatim": bool(args.include_verbatim),
            "snippet_window": args.snippet_window,
            "max_verbatim_per_result": args.max_verbatim_per_result,
        }
    )


def apply_filters(entries: List[dict], filters: Dict[str, object]) -> List[dict]:
    def matches(entry: dict) -> bool:
        tool = str(filters.get("tool", ""))
        if tool and entry.get("tool", "").lower() != tool:
            return False
        project = str(filters.get("project", ""))
        if project and project not in entry.get("project", "").lower():
            return False
        scope = str(filters.get("scope", ""))
        if scope and entry.get("scope", "").lower() != scope:
            return False
        source_kind = str(filters.get("source_kind", ""))
        if source_kind and entry.get("sourceKind", "").lower() != source_kind:
            return False
        workspace = str(filters.get("workspace", ""))
        if workspace and workspace not in entry.get("workspace", "").lower():
            return False
        task_state = str(filters.get("task_state", ""))
        if task_state and entry.get("taskState", "").lower() != task_state:
            return False
        return True

    return [entry for entry in entries if matches(entry)]


def build_bm25_cache_key(filters: Dict[str, object], entry_count: int) -> str:
    version = int(_ENTRIES_CACHE.get("version", 0))
    parts = [
        str(filters.get("tool", "")),
        str(filters.get("project", "")),
        str(filters.get("scope", "")),
        str(filters.get("source_kind", "")),
        str(filters.get("workspace", "")),
        str(filters.get("task_state", "")),
        str(bool(filters.get("prefer_summaries"))).lower(),
        str(entry_count),
        str(version),
    ]
    return "|".join(parts)


def apply_summary_boost(scores: Dict[str, float], entries_by_id: Dict[str, dict]) -> Dict[str, float]:
    boosted: Dict[str, float] = {}
    for entry_id, score in scores.items():
        entry = entries_by_id.get(entry_id, {})
        bonus = 0.0
        if entry.get("scope", "").lower() == "summary":
            bonus += 0.05
        if entry.get("memoryLevel", "").lower() == "session":
            bonus += 0.03
        boosted[entry_id] = score + bonus
    return boosted


def execute_search(parsed: Dict[str, object], workspace_root: Optional[str] = None) -> Dict[str, object]:
    query = str(parsed["query"])
    top_k = int(parsed["top_k"])
    requested_mode = str(parsed["mode"])
    current_entries_signature = build_structured_signature()
    current_embeddings_signature = build_embeddings_signature()
    search_result_cache_key = build_search_result_cache_key(parsed, current_entries_signature, current_embeddings_signature)
    cached_response = get_cached_search_result(search_result_cache_key)
    if cached_response is not None:
        cached_response["cacheState"] = build_cache_state(search_result_cache_hit=True, query_embedding_cache_hit=False)
        return cached_response

    entries = apply_filters(load_entries(), parsed)
    entries_by_id = {entry["id"]: entry for entry in entries}
    layer_counts = count_entries_by_layer(entries)
    query_route = build_query_route(query, parsed)
    query_tokens = tokenize(query)
    bm25_cache_key = build_bm25_cache_key(parsed, len(entries))

    bm25_map = bm25_scores(entries, query_tokens, bm25_cache_key)
    dense_map: Dict[str, float] = {}
    dense_error: Optional[str] = None
    dense_meta: Dict[str, object] = {"queryEmbeddingCacheHit": False}
    if requested_mode in {"dense", "hybrid"}:
        dense_map, dense_error, dense_meta = dense_scores(entries_by_id, query)

    effective_mode = requested_mode
    fallback_reason = None
    query_lower = query.lower()
    temporal_decay = parsed.get("temporal_decay")
    mmr_enabled = bool(parsed.get("mmr_enabled", False))
    mmr_lambda = float(parsed.get("mmr_lambda", 0.7))
    if requested_mode == "bm25":
        ranked, rank_meta, candidate_count = rerank_entries(entries_by_id, "bm25", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay)
    elif requested_mode == "dense":
        if dense_map:
            ranked, rank_meta, candidate_count = rerank_entries(entries_by_id, "dense", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay)
        else:
            effective_mode = "bm25"
            fallback_reason = dense_error or "dense-unavailable"
            ranked, rank_meta, candidate_count = rerank_entries(entries_by_id, "bm25", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay)
    else:
        if dense_map:
            ranked, rank_meta, candidate_count = rerank_entries(entries_by_id, "hybrid", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay)
        else:
            effective_mode = "bm25"
            fallback_reason = "hybrid-dense-unavailable"
            ranked, rank_meta, candidate_count = rerank_entries(entries_by_id, "bm25", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay)

    # Apply MMR diversity reranking if enabled (after initial ranking)
    if mmr_enabled and ranked:
        # Build relevance score dict from ranked results for MMR
        relevance_scores: Dict[str, float] = {eid: score for eid, score in ranked}
        mmr_ranked = mmr_rerank(entries_by_id, relevance_scores, top_k, mmr_lambda)
        if mmr_ranked:
            ranked = mmr_ranked

    sources: Dict[str, List[str]] = {}
    for entry_id in bm25_map:
        sources.setdefault(entry_id, []).append("bm25")
    for entry_id in dense_map:
        sources.setdefault(entry_id, []).append("dense")

    embeddings_index = load_embeddings_index()
    embedding_backend = None
    if embeddings_index:
        first_embedding = next(iter(embeddings_index.values()))
        embedding_backend = normalize_embedding_adapter(
            str(first_embedding.get("backend", "")).strip(),
            str(first_embedding.get("model", DEFAULT_MODEL)).strip() or DEFAULT_MODEL,
        )

    workspace_hints: Optional[Dict] = {"project_root": workspace_root} if workspace_root else None

    payload = {
        "ok": True,
        "requestedMode": requested_mode,
        "effectiveMode": effective_mode,
        "fallbackReason": fallback_reason,
        "query": query,
        "queryIntent": query_route["intent"],
        "queryRoute": query_route,
        "filters": {
            "route": parsed.get("route"),
            "tool": parsed.get("tool"),
            "project": parsed.get("project"),
            "scope": parsed.get("scope"),
            "sourceKind": parsed.get("source_kind"),
            "workspace": parsed.get("workspace"),
            "taskState": parsed.get("task_state"),
            "preferSummaries": parsed.get("prefer_summaries"),
            "includeVerbatim": parsed.get("include_verbatim"),
            "snippetWindow": parsed.get("snippet_window"),
            "maxVerbatimPerResult": parsed.get("max_verbatim_per_result"),
            "temporalDecay": parsed.get("temporal_decay"),
        },
        "entryCount": len(entries),
        "candidateCount": candidate_count,
        "layerCounts": layer_counts,
        "hasEmbeddings": bool(embeddings_index),
        "embeddingRuntime": build_embedding_runtime_summary(),
        "embeddingBackend": embedding_backend,
        "embeddingAdapter": str(EMBEDDING_RUNTIME.get("adapter", EMBEDDING_RUNTIME.get("backend", "hash")) or "hash"),
        "embeddingProvider": str(EMBEDDING_RUNTIME.get("providerName", "")),
        "embeddingProfile": str(EMBEDDING_RUNTIME.get("profileName", "")),
        "embeddingResolutionMode": str(EMBEDDING_RUNTIME.get("resolutionMode", "")),
        "embeddingConfigPath": str(EMBEDDING_RUNTIME.get("configPath", "")),
        "embeddingConfigError": str(EMBEDDING_RUNTIME.get("configError", "")),
        "cacheState": build_cache_state(
            search_result_cache_hit=False,
            query_embedding_cache_hit=bool(dense_meta.get("queryEmbeddingCacheHit")),
        ),
        "results": format_results(
            ranked,
            entries_by_id,
            sources,
            bm25_map,
            dense_map,
            rank_meta,
            query,
            include_verbatim=bool(parsed.get("include_verbatim")),
            snippet_window=int(parsed.get("snippet_window", 220)),
            max_verbatim_per_result=int(parsed.get("max_verbatim_per_result", 1)),
            workspace_hints=workspace_hints,
        ),
    }
    store_search_result(search_result_cache_key, payload)
    return payload


def write_server_response(payload: Dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_server() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = ""
        try:
            payload = json.loads(line)
            request_id = normalize_spaces(str(payload.get("id", "")))
            action = normalize_spaces(str(payload.get("action", "search"))).lower() or "search"

            if action == "health":
                write_server_response(
                    {
                        "id": request_id,
                        "ok": True,
                        "action": "health",
                        "workerMode": "persistent-jsonl",
                        "embeddingRuntime": build_embedding_runtime_summary(),
                        "cacheState": build_cache_state(search_result_cache_hit=False, query_embedding_cache_hit=False),
                        "schemaValidation": {
                            "available": _SCHEMA_VALIDATION_AVAILABLE,
                            "schemaVersion": 2,
                        },
                    }
                )
                continue

            if action == "clear_cache":
                include_data_caches = normalize_bool(
                    payload.get("include_data_caches", payload.get("includeDataCaches", False)), fallback=False
                )
                write_server_response(
                    {
                        "id": request_id,
                        "ok": True,
                        "action": "clear_cache",
                        "includeDataCaches": include_data_caches,
                        "cacheState": clear_search_runtime_caches(include_data_caches),
                    }
                )
                continue

            if action == "get_records":
                record_ids = payload.get("ids", [])
                if not isinstance(record_ids, list):
                    raise ValueError("ids must be an array")
                record_ids = [normalize_spaces(str(rid)) for rid in record_ids if normalize_spaces(str(rid))]
                if not record_ids:
                    raise ValueError("ids cannot be empty")

                entries = load_entries()
                entries_by_id = {entry["id"]: entry for entry in entries}
                records = []
                found = []
                for record_id in record_ids:
                    raw = entries_by_id.get(record_id)
                    if raw is None:
                        continue
                    found.append(record_id)
                    content = str(raw.get("content", "") or raw.get("text", ""))
                    records.append(
                        {
                            "id": raw["id"],
                            "t": raw.get("t", ""),
                            "tool": raw.get("tool", ""),
                            "type": raw.get("type", ""),
                            "title": raw.get("title", ""),
                            "content": content,
                            "description": str(raw.get("description", "")).strip(),
                            "facts": raw.get("facts") if isinstance(raw.get("facts"), list) else [],
                            "concepts": raw.get("concepts") if isinstance(raw.get("concepts"), list) else [],
                            "files_read": raw.get("filesRead") or raw.get("files_read") or [],
                            "files_modified": raw.get("filesModified") or raw.get("files_modified") or [],
                            "scope": raw.get("scope", ""),
                            "memory_level": raw.get("memoryLevel", ""),
                            "freshness": raw.get("freshness", ""),
                            "confidence": raw.get("confidence"),
                            "project": raw.get("project", ""),
                            "agent": raw.get("agent", ""),
                            "workspace": raw.get("workspace", ""),
                            "task_state": raw.get("taskState", ""),
                            "visibility": raw.get("visibility", ""),
                            "source_kind": raw.get("sourceKind", ""),
                            "layer": raw.get("layer", ""),
                            "estimated_tokens": math.ceil(len(content) / 4),
                        }
                    )
                write_server_response(
                    {
                        "id": request_id,
                        "ok": True,
                        "action": "get_records",
                        "requested": len(record_ids),
                        "found": found,
                        "records": records,
                    }
                )
                continue

            if action == "timeline":
                anchor_id = normalize_spaces(str(payload.get("anchor_id", "")))
                if not anchor_id:
                    raise ValueError("anchor_id is required")
                depth_before = normalize_int(payload.get("depth_before"), fallback=3, minimum=0)
                depth_after = normalize_int(payload.get("depth_after"), fallback=3, minimum=0)

                entries = load_entries()
                raw_lookup: Dict[str, dict] = {}
                for file_name in STRUCTURED_FILES:
                    file_path = os.path.join(STRUCTURED_DIR, file_name)
                    if not os.path.isfile(file_path):
                        continue
                    try:
                        with open(file_path, "r", encoding="utf-8") as handle:
                            for line_text in handle:
                                line_text = line_text.strip()
                                if not line_text:
                                    continue
                                try:
                                    raw_entry = json.loads(line_text)
                                except Exception:
                                    continue
                                if _SCHEMA_VALIDATION_AVAILABLE:
                                    valid, _ = validate_record(raw_entry)
                                    if not valid:
                                        continue
                                eid = normalize_spaces(str(raw_entry.get("id", "")))
                                if eid and eid not in raw_lookup:
                                    raw_lookup[eid] = raw_entry
                    except Exception:
                        continue

                def entry_timestamp(entry: dict) -> float:
                    return parse_timestamp_seconds(str(entry.get("t", "")))

                entries_sorted = sorted(entries, key=entry_timestamp)
                anchor_index = next((i for i, e in enumerate(entries_sorted) if e["id"] == anchor_id), None)
                if anchor_index is None:
                    raise ValueError(f"anchor_id not found: {anchor_id}")

                start = max(0, anchor_index - depth_before)
                end = min(len(entries_sorted), anchor_index + depth_after + 1)
                window = entries_sorted[start:end]

                raw_map: Dict[str, dict] = {e["id"]: raw_lookup.get(e["id"], {}) for e in window}
                items = []
                for e in window:
                    content = str(e.get("content", "") or e.get("text", ""))
                    items.append(
                        {
                            "id": e["id"],
                            "t": e.get("t", ""),
                            "tool": e.get("tool", ""),
                            "type": e.get("type", ""),
                            "title": e.get("title", ""),
                            "scope": e.get("scope", ""),
                            "memory_level": e.get("memoryLevel", ""),
                            "is_anchor": e["id"] == anchor_id,
                            "excerpt": content[:240],
                        }
                    )

                anchor_entry = entries_sorted[anchor_index]
                write_server_response(
                    {
                        "id": request_id,
                        "ok": True,
                        "action": "timeline",
                        "anchor": {
                            "id": anchor_entry["id"],
                            "t": anchor_entry.get("t", ""),
                            "tool": anchor_entry.get("tool", ""),
                            "type": anchor_entry.get("type", ""),
                            "title": anchor_entry.get("title", ""),
                            "scope": anchor_entry.get("scope", ""),
                            "memory_level": anchor_entry.get("memoryLevel", ""),
                            "excerpt": str(anchor_entry.get("content", "") or anchor_entry.get("text", ""))[:240],
                        },
                        "items": items,
                        "total_count": len(window),
                    }
                )
                continue

            if action != "search":
                raise ValueError(f"unsupported-action:{action}")

            workspace_root = normalize_spaces(str(payload.get("workspace_root", ""))) or None
            response = execute_search(normalize_request_payload(payload), workspace_root=workspace_root)
            if request_id:
                response["id"] = request_id
            write_server_response(response)
        except Exception as exc:
            error_payload: Dict[str, object] = {
                "ok": False,
                "error": str(exc),
            }
            if request_id:
                error_payload["id"] = request_id
            write_server_response(error_payload)


def main() -> None:
    parsed = parse_args()
    if bool(parsed.get("server")):
        run_server()
        return

    payload = execute_search(parsed)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
