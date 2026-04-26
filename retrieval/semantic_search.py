"""
Hybrid semantic search over the shared Obsidian memory bus.

Compatibility:
- python semantic-search.py "query" [topK] [strategy]
- python semantic-search.py --mode hybrid --top-k 8 --json "query"

Schema Versions:
- MEMORY_RECORD_SCHEMA_VERSION: 2 (defined in ops/memory-contract.js)
- VECTOR_SCHEMA_VERSION: 1 (defined in retrieval/lsh_utils.py, imported via embedding_providers)
  Note: These are independent version tracks — memory record schema and embedding vector
  schema evolve on separate cycles.

This file was produced by splitting the original retrieval/semantic-search.py (~2117 lines)
into 5 modules: search_ranking, search_index, search_cache, search_server, and this file.
See retrieval/REFACTOR-NOTES.md for the full refactoring plan.
"""

from __future__ import annotations

import os
import sys

# Ensure retrieval/ is always on sys.path regardless of invocation method.
# This lets the submodules (search_ranking, search_index, etc.) be imported
# with bare names whether this file is run as a script or as a package module.
_RETRIEVAL_DIR = os.path.dirname(os.path.abspath(__file__))
if _RETRIEVAL_DIR not in sys.path:
    sys.path.insert(0, _RETRIEVAL_DIR)

# Also add the parent directory (AI_MEMORY_ROOT) to sys.path for flat runtime layout
_PARENT_DIR = os.path.dirname(_RETRIEVAL_DIR)
if _PARENT_DIR not in sys.path:
    sys.path.insert(0, _PARENT_DIR)

import argparse
import datetime
import json
import math
import os
import re
import sys
import time as time_module
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Imports from submodules (split from this file)
# ---------------------------------------------------------------------------

from search_ranking import (
    # Scoring
    bm25_scores,
    get_bm25_model,
    dense_scores,
    cosine_similarity,
    embed_query,
    keyword_overlap_scores,
    normalize_score_map,
    score_entry,
    apply_field_match_bonus,
    rerank_entries,
    ranked_pairs,
    mmr_rerank,
    # Query routing
    classify_query_intent,
    build_query_route,
    task_state_weight,
    # Tokenization / text utils
    tokenize,
    normalize_spaces,
    is_noise,
    derive_entry_layer,
    NOISE_PATTERNS,
    ROUTE_VALUES,
    KNOWN_LAYERS,
    # Misc utilities
    prune_timed_cache,
    build_query_embedding_cache_key,
    get_cached_query_embedding,
    store_query_embedding,
    _BM25_CACHE,
    _QUERY_EMBEDDING_CACHE,
    _SEARCH_RESULT_CACHE,
    _CACHE_METRICS,
    STRUCTURED_FILES,
    DURABLE_SCOPES,
    RECENT_QUERY_PATTERN,
    TASK_QUERY_PATTERN,
    REFERENCE_QUERY_PATTERN,
    DURABLE_QUERY_PATTERN,
    BM25Okapi,
    jieba,
)

from search_index import (
    load_entries,
    _load_entries_uncached,
    load_embeddings_index,
    _load_embeddings_index_uncached,
    invalidate_entries_cache,
    invalidate_embeddings_cache,
    build_file_stamp,
    build_structured_signature,
    build_embeddings_signature,
    REDACTION_CONFIG,
    redact_sensitive,
    build_entry,
    _build_entry_fields,
    _extract_item_text,
    _fallback_id,
    _ENTRIES_CACHE,
    _INDEX_CACHE,
)

from search_cache import (
    build_cache_state,
    clear_search_runtime_caches,
    build_search_result_cache_key,
    get_cached_search_result,
    store_search_result,
)

from search_server import run_server


# ---------------------------------------------------------------------------
# Additional imports from embedding_providers and runtime_support
# ---------------------------------------------------------------------------

from embedding_providers import (
    DEFAULT_MODEL,
    HASH_MODEL,
    VECTOR_SCHEMA_VERSION,
    build_embedding_config_hash,
    embed_query_with_runtime,
    get_transformer_model_name,
)

from runtime_support import (
    first_non_empty_env,
    normalize_bool,
    normalize_int,
    resolve_embedding_runtime,
    resolve_vault_root,
    normalize_embedding_adapter,
)


# ---------------------------------------------------------------------------
# Embedding runtime initialization
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Schema validation flag (imported but also referenced in this file)
# ---------------------------------------------------------------------------

try:
    from schema_validation import validate_record
    _SCHEMA_VALIDATION_AVAILABLE = True
except ImportError:
    _SCHEMA_VALIDATION_AVAILABLE = False


# ---------------------------------------------------------------------------
# stdout/stderr reconfiguration
# ---------------------------------------------------------------------------

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Constants (also used by submodules — kept here so existing callers don't break)
# ---------------------------------------------------------------------------

FILE_REF_PATTERN = re.compile(r"([a-zA-Z][^\s:;#*`\"'<>|\\{}()\[\]]+\.(js|ts|py|ps1|sh|md|json|yaml|yml|toml|go|rs|java|cpp|c|h|css|html))")
FUNC_VAR_PATTERN = re.compile(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\b")


# ---------------------------------------------------------------------------
# Cache TTL settings (override submodule defaults)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Path resolution (shared with submodules)
# ---------------------------------------------------------------------------

try:
    VAULT_ROOT = str(resolve_vault_root())
except RuntimeError:
    # CI or vault-less environment: use a temp directory as fallback
    import tempfile as _tmp
    VAULT_ROOT = _tmp.mkdtemp(prefix="ai-memory-smoke-")
AI_MEMORY_ROOT = os.path.join(VAULT_ROOT, "00-System", "ai-memory")
STRUCTURED_DIR = os.path.join(AI_MEMORY_ROOT, "structured")
EMBEDDINGS_INDEX = os.path.join(AI_MEMORY_ROOT, "embeddings", "index.jsonl")


# ---------------------------------------------------------------------------
# Additional utilities
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Snippet extraction utilities
# ---------------------------------------------------------------------------

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
        snippet_text = f"\u2026{snippet_text}"
    if snippet_end < len(text) and snippet_text:
        snippet_text = f"{snippet_text}\u2026"
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
                    "start": snippet_start,
                    "end": snippet_end,
                    "text": snippet_text,
                }
            )
            covered_regions.append((candidate_field, snippet_start, snippet_end))
            if len(snippets) >= max_snippets:
                return snippets

    return snippets


# ---------------------------------------------------------------------------
# Memory drift detection
# ---------------------------------------------------------------------------

def check_memory_drift(entry: Dict, workspace_hints: Optional[Dict] = None) -> Dict:
    """
    Detect whether a memory record may be pointing to stale or non-existent references.
    """
    workspace = workspace_hints or {}
    project_root = workspace.get("project_root", os.getcwd())
    drift_signals: List[str] = []
    missing_files: List[str] = []

    content = entry.get("content", "") or ""
    title = entry.get("title", "") or ""
    combined = f"{title} {content}"

    freshness = entry.get("freshness", "unknown")
    cold_indicators = re.findall(r"(20[2-9][0-9]|201[0-9])-[0-9]{2}-[0-9]{2}", combined)
    if freshness == "cold" and cold_indicators:
        time_sensitive = ["deadline", "freeze", "release", "deploy", "launch"]
        if any(word in combined.lower() for word in time_sensitive):
            drift_signals.append("cold-record-with-time-sensitive-content")

    raw_file_refs = FILE_REF_PATTERN.findall(combined)[:5]
    for ref in raw_file_refs:
        path = ref[0] if isinstance(ref, tuple) else ref
        if path.startswith(".") or path.startswith("/"):
            continue
        abs_path = os.path.join(project_root, path)
        try:
            if not os.path.exists(abs_path):
                missing_files.append(path)
        except OSError:
            pass

    if missing_files:
        drift_signals.append(f"referenced-files-missing:{len(missing_files)}")

    entry_type = entry.get("type", "")
    if entry_type in ("summary", "session-summary", "daily-summary"):
        if freshness in ("cold", "warm"):
            drift_signals.append("summary-record-cold-staleness")

    if len(drift_signals) >= 2:
        drift_risk = "high"
    elif drift_signals:
        drift_risk = "medium"
    else:
        drift_risk = "low"

    return {
        "driftRisk": drift_risk,
        "driftSignals": drift_signals[:5],
        "missingFileCount": len(missing_files),
    }


# ---------------------------------------------------------------------------
# Request normalization and CLI parsing
# ---------------------------------------------------------------------------

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

    mmr_config = payload.get("mmr", {})
    if isinstance(mmr_config, dict):
        mmr_enabled = normalize_bool(mmr_config.get("enabled", False), fallback=False)
        mmr_lambda = float(mmr_config.get("lambda", mmr_config.get("lambda_param", 0.7)))
    else:
        mmr_enabled = normalize_bool(payload.get("mmr_enabled", False), fallback=False)
        mmr_lambda = float(payload.get("mmr_lambda", 0.7))

    td_config = payload.get("temporal_decay", {})
    if isinstance(td_config, dict):
        td_enabled = normalize_bool(td_config.get("enabled", False), fallback=False)
        td_half_life = normalize_int(td_config.get("half_life_days", 30), fallback=30, minimum=1)
    else:
        td_enabled = normalize_bool(td_config, fallback=False)
        td_half_life = normalize_int(payload.get("temporal_decay_half_life_days", 30), fallback=30, minimum=1)

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
    parser.add_argument("--mmr", action="store_true", help="Enable MMR diversity reranking")
    parser.add_argument("--mmr-lambda", type=float, default=0.7, help="MMR lambda (relevance vs diversity balance, 0-1). Default: 0.7")
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
            "mmr_enabled": bool(args.mmr),
            "mmr_lambda": float(args.mmr_lambda) if args.mmr else 0.7,
        }
    )


# ---------------------------------------------------------------------------
# Filtering and BM25 cache key
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Result formatting
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Search execution
# ---------------------------------------------------------------------------

def execute_search(parsed: Dict[str, object], workspace_root: Optional[str] = None) -> Dict[str, object]:
    query = str(parsed["query"])
    top_k = int(parsed["top_k"])
    requested_mode = str(parsed["mode"])
    current_entries_signature = build_structured_signature()
    current_embeddings_signature = build_embeddings_signature()
    search_result_cache_key = build_search_result_cache_key(
        parsed, current_entries_signature, current_embeddings_signature
    )
    cached_response = get_cached_search_result(search_result_cache_key)
    if cached_response is not None:
        cached_response["cacheState"] = build_cache_state(
            search_result_cache_hit=True, query_embedding_cache_hit=False
        )
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
        dense_map, dense_error, dense_meta = dense_scores(
            entries_by_id, query, load_embeddings_index, EMBEDDING_RUNTIME,
            embeddings_index_path=EMBEDDINGS_INDEX,
        )

    effective_mode = requested_mode
    fallback_reason = None
    query_lower = query.lower()
    temporal_decay = parsed.get("temporal_decay")
    mmr_enabled = bool(parsed.get("mmr_enabled", False))
    mmr_lambda = float(parsed.get("mmr_lambda", 0.7))
    if requested_mode == "bm25":
        ranked, rank_meta, candidate_count = rerank_entries(
            entries_by_id, "bm25", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay
        )
    elif requested_mode == "dense":
        if dense_map:
            ranked, rank_meta, candidate_count = rerank_entries(
                entries_by_id, "dense", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay
            )
        else:
            effective_mode = "bm25"
            fallback_reason = dense_error or "dense-unavailable"
            ranked, rank_meta, candidate_count = rerank_entries(
                entries_by_id, "bm25", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay
            )
    else:
        if dense_map:
            ranked, rank_meta, candidate_count = rerank_entries(
                entries_by_id, "hybrid", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay
            )
        else:
            effective_mode = "bm25"
            fallback_reason = "hybrid-dense-unavailable"
            ranked, rank_meta, candidate_count = rerank_entries(
                entries_by_id, "bm25", top_k, query_route, bm25_map, dense_map, query_lower, temporal_decay
            )

    if mmr_enabled and ranked:
        relevance_scores: Dict[str, float] = {eid: score for eid, score in ranked}
        mmr_ranked = mmr_rerank(
            entries_by_id, relevance_scores, top_k, mmr_lambda, load_embeddings_index,
            embeddings_index_path=EMBEDDINGS_INDEX,
        )
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
            "mmrEnabled": bool(parsed.get("mmr_enabled", False)),
            "mmrLambda": round(float(parsed.get("mmr_lambda", 0.7)), 3),
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


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parsed = parse_args()
    if bool(parsed.get("server")):
        run_server()
        return

    payload = execute_search(parsed)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
