"""
Hybrid semantic search over the shared Obsidian memory bus.

Compatibility:
- python semantic-search.py "query" [topK] [strategy]
- python semantic-search.py --mode hybrid --top-k 8 --json "query"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time as time_module
import urllib.error
import urllib.request
from typing import Dict, Iterable, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# In-memory cache for the embeddings index with 30-second TTL.
# Avoids re-reading ~50k lines from index.jsonl on every search.
_INDEX_CACHE = {"data": None, "loaded_at": 0.0}
_INDEX_CACHE_TTL = 30  # seconds

try:
    from rank_bm25 import BM25Okapi  # type: ignore
except Exception:
    BM25Okapi = None

try:
    import jieba  # type: ignore

    jieba.setLogLevel(20)
except Exception:
    jieba = None


DEFAULT_MODEL = "all-MiniLM-L6-v2"
HASH_MODEL = "hashing-v1"
HASH_DIM = 384
OPENAI_BASE_URL = ""
OPENAI_API_KEY = ""
OPENAI_TIMEOUT_SECONDS = 120
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
_WINDOWS_ENV_CACHE: Dict[str, str] = {}


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


def read_windows_environment_variable(name: str) -> str:
    if os.name != "nt":
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


def resolve_openai_timeout_seconds() -> int:
    timeout_ms = int(first_non_empty_env("AI_MEMORY_EMBED_TIMEOUT_MS") or "0")
    if timeout_ms > 0:
        return max(1, math.ceil(timeout_ms / 1000))
    timeout_seconds = int(first_non_empty_env("AI_MEMORY_EMBED_TIMEOUT_SECONDS") or "120")
    return max(1, timeout_seconds)


OPENAI_BASE_URL = first_non_empty_env("AI_MEMORY_EMBED_BASE_URL").rstrip("/")
OPENAI_API_KEY = first_non_empty_env("AI_MEMORY_EMBED_API_KEY")
OPENAI_TIMEOUT_SECONDS = resolve_openai_timeout_seconds()


def resolve_vault_root() -> str:
    for env_key in ("AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"):
        candidate = os.environ.get(env_key, "").strip()
        if candidate and os.path.isdir(candidate):
            return candidate

    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        config_path = os.path.join(appdata, "obsidian", "obsidian.json")
        if os.path.isfile(config_path):
            try:
                with open(config_path, "r", encoding="utf-8") as handle:
                    config = json.load(handle)
                records = []
                for vault in (config.get("vaults") or {}).values():
                    path = str(vault.get("path", "")).strip()
                    if not path or not os.path.isdir(path):
                        continue
                    records.append(
                        {
                            "path": path,
                            "open": bool(vault.get("open")),
                            "ts": int(vault.get("ts") or 0),
                        }
                    )
                open_records = sorted((item for item in records if item["open"]), key=lambda item: item["ts"], reverse=True)
                if open_records:
                    return open_records[0]["path"]
                recent_records = sorted(records, key=lambda item: item["ts"], reverse=True)
                if recent_records:
                    return recent_records[0]["path"]
            except Exception:
                pass

    for fallback in (
        os.path.join(os.path.expanduser("~"), "Desktop", "Obsidian Vault"),
        os.path.join(os.path.expanduser("~"), "Documents", "Obsidian Vault"),
    ):
        if os.path.isdir(fallback):
            return fallback
    raise RuntimeError(
        "no-obsidian-vault: Tried ["
        + os.path.join(os.path.expanduser("~"), "Desktop", "Obsidian Vault")
        + ", "
        + os.path.join(os.path.expanduser("~"), "Documents", "Obsidian Vault")
        + "]. Set AI_MEMORY_OBSIDIAN_VAULT or OBSIDIAN_VAULT_ROOT to your vault path."
    )


VAULT_ROOT = resolve_vault_root()
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


# =============================================================================
# NOTE: This hashing logic (FNV-1a32 + buildHashFeatures) is duplicated in:
#   - generate-embeddings.js (JS version, identical logic)
#   - singleton-stdio-mcp-proxy.mjs (may also use it)
# When modifying this, sync all copies.
# See: https://github.com/.../issues/TWIN-BUG
# =============================================================================

def fnv1a32(value: str) -> int:
    hash_value = 0x811C9DC5
    for character in value:
        hash_value ^= ord(character)
        hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
    return hash_value


def build_hash_features(text: str) -> List[str]:
    source = normalize_spaces(text).lower()
    compact = re.sub(r"\s+", "", source)
    features: List[str] = []

    for token in re.findall(r"[a-z0-9][a-z0-9_\-./:]{1,}", source):
        features.append(f"w:{token}")

    for chunk in re.findall(r"[\u4e00-\u9fff]{2,}", source):
        features.append(f"c:{chunk}")
        for index in range(max(0, len(chunk) - 1)):
            features.append(f"c2:{chunk[index:index + 2]}")
        for index in range(max(0, len(chunk) - 2)):
            features.append(f"c3:{chunk[index:index + 3]}")

    max_gram_count = max(0, min(len(compact) - 2, 400))
    for index in range(max_gram_count):
        features.append(f"g3:{compact[index:index + 3]}")

    if not features and compact:
        features.append(f"raw:{compact}")
    return features


def build_hash_embedding(text: str, dimension: int = HASH_DIM) -> List[float]:
    vector = [0.0] * dimension
    for feature in build_hash_features(text):
        hash_value = fnv1a32(feature)
        slot = hash_value % dimension
        sign = 1.0 if ((hash_value >> 1) & 1) == 0 else -1.0
        vector[slot] += sign

    norm = math.sqrt(sum(value * value for value in vector))
    if norm > 0:
        vector = [round(value / norm, 8) for value in vector]
    return vector


def build_entry(payload: dict) -> Optional[dict]:
    title = normalize_spaces(str(payload.get("title", "")))
    content = normalize_spaces(str(payload.get("content", "")))
    raw_text = normalize_spaces(" ".join(filter(None, [title, content])))
    if is_noise(raw_text):
        return None

    entry_id = str(payload.get("id", "")).strip() or fallback_id(payload, title, content)
    search_text = normalize_spaces(
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
    excerpt = content or search_text
    return {
        "id": entry_id,
        "tool": str(payload.get("tool", "unknown")).strip() or "unknown",
        "type": str(payload.get("type", "")).strip(),
        "project": str(payload.get("project", "")).strip(),
        "agent": str(payload.get("agent", "")).strip(),
        "t": str(payload.get("t", "")).strip(),
        "title": title or excerpt[:120] or entry_id,
        "excerpt": excerpt[:240],
        "text": search_text,
        "tokens": tokenize(search_text),
        "scope": str(payload.get("scope", "")).strip(),
        "visibility": str(payload.get("visibility", "")).strip(),
        "sourceKind": str(payload.get("source_kind", "")).strip(),
        "memoryLevel": str(payload.get("memory_level", "")).strip(),
        "workspace": str(payload.get("workspace", "")).strip(),
        "taskState": str(payload.get("task_state", "")).strip(),
    }


def load_entries() -> List[dict]:
    entries: Dict[str, dict] = {}
    if not os.path.isdir(STRUCTURED_DIR):
        return []

    for file_name in sorted(os.listdir(STRUCTURED_DIR)):
        if not file_name.endswith(".jsonl"):
            continue
        file_path = os.path.join(STRUCTURED_DIR, file_name)
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
                    entry = build_entry(payload)
                    if entry is not None:
                        entries[entry["id"]] = entry
        except Exception:
            continue

    return list(entries.values())


def load_embeddings_index() -> Dict[str, dict]:
    """Load embeddings index with 30-second TTL cache to avoid repeated I/O."""
    now = time_module.time()
    if (_INDEX_CACHE["data"] is not None
            and (now - _INDEX_CACHE["loaded_at"]) < _INDEX_CACHE_TTL):
        return _INDEX_CACHE["data"]

    data = _load_embeddings_index_uncached()
    _INDEX_CACHE["data"] = data
    _INDEX_CACHE["loaded_at"] = now
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


def normalize_backend(backend: str, model_name: str) -> str:
    normalized = (backend or "").strip().lower()
    if normalized:
        return normalized
    if (model_name or "").strip().lower().startswith("hashing-"):
        return "hash"
    return "transformer"


def build_embedding_config_hash(backend: str, model_name: str, base_url: str = "") -> str:
    normalized_backend = normalize_backend(backend, model_name)
    normalized_base_url = base_url.strip().rstrip("/") if normalized_backend in {"openai", "openai-compatible"} else ""
    payload = json.dumps(
        {
            "backend": normalized_backend,
            "model": (model_name or "").strip(),
            "baseUrl": normalized_base_url.lower(),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha1(payload.encode("utf-8", errors="ignore")).hexdigest()[:16]


def keyword_overlap_scores(entries: List[dict], query_tokens: List[str]) -> Dict[str, float]:
    scores: Dict[str, float] = {}
    query_set = set(query_tokens)
    for entry in entries:
        overlap = sum(1 for token in entry.get("tokens", []) if token in query_set)
        if overlap > 0:
            scores[entry["id"]] = float(overlap)
    return scores


def bm25_scores(entries: List[dict], query_tokens: List[str]) -> Dict[str, float]:
    if not entries or not query_tokens:
        return {}
    if BM25Okapi is None:
        return keyword_overlap_scores(entries, query_tokens)
    corpus = [entry["tokens"] if entry["tokens"] else ["_empty_"] for entry in entries]
    model = BM25Okapi(corpus)
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


def embed_query_openai_compatible(query: str, model_name: str) -> Tuple[Optional[List[float]], Optional[str]]:
    if not OPENAI_BASE_URL:
        return None, "missing-openai-base-url"
    if not OPENAI_API_KEY:
        return None, "missing-openai-api-key"

    payload = json.dumps(
        {
            "model": model_name,
            "input": query,
            "encoding_format": "float",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{OPENAI_BASE_URL}/embeddings",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=OPENAI_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        return None, f"openai-compatible-http-{exc.code}: {detail[:500]}"
    except Exception as exc:
        return None, f"openai-compatible-query-embedding-failed: {exc}"

    try:
        parsed = json.loads(body)
        data = parsed.get("data") or []
        if not data:
            return None, "openai-compatible-empty-response"
        vector = data[0].get("embedding")
        if not isinstance(vector, list) or not vector:
            return None, "openai-compatible-empty-vector"
        return [float(value) for value in vector], None
    except Exception as exc:
        return None, f"openai-compatible-invalid-json: {exc}"


def embed_query(query: str, model_name: str, backend: str = "") -> Tuple[Optional[List[float]], Optional[str]]:
    if model_name == HASH_MODEL:
        return build_hash_embedding(query), None

    normalized_backend = normalize_backend(backend, model_name)
    if normalized_backend in {"openai", "openai-compatible"}:
        return embed_query_openai_compatible(query, model_name)

    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except Exception as exc:
        return None, f"sentence-transformers-unavailable: {exc}"

    try:
        model = SentenceTransformer(model_name)
        encoded = model.encode([query], show_progress_bar=False, convert_to_numpy=True)
        vector = encoded[0].tolist() if hasattr(encoded[0], "tolist") else list(encoded[0])
        return [float(value) for value in vector], None
    except Exception as exc:
        return None, f"query-embedding-failed: {exc}"


def dense_scores(entries_by_id: Dict[str, dict], query: str) -> Tuple[Dict[str, float], Optional[str]]:
    index_records = load_embeddings_index()
    if not index_records:
        return {}, "missing-embeddings-index"
    first_record = next(iter(index_records.values()))
    model_name = str(first_record.get("model", DEFAULT_MODEL)).strip() or DEFAULT_MODEL
    backend = normalize_backend(str(first_record.get("backend", "")).strip(), model_name)
    if model_name.startswith("hashing-"):
        model_name = HASH_MODEL
    record_config_hash = str(first_record.get("configHash", "")).strip()
    if record_config_hash:
        active_config_hash = build_embedding_config_hash(backend, model_name, OPENAI_BASE_URL)
        if record_config_hash != active_config_hash:
            return {}, "embedding-config-mismatch:rebuild-memory-embeddings-required"
    query_vector, error = embed_query(query, model_name, backend)
    if error is not None or query_vector is None:
        return {}, error
    first_embedding = first_record.get("embedding", [])
    if isinstance(first_embedding, list) and first_embedding and len(first_embedding) != len(query_vector):
        return {}, f"embedding-dimension-mismatch:index={len(first_embedding)},query={len(query_vector)}"

    scores: Dict[str, float] = {}
    for record_id, payload in index_records.items():
        if record_id not in entries_by_id:
            continue
        score = cosine_similarity(query_vector, payload.get("embedding", []))
        if score > 0:
            scores[record_id] = score
    return scores, None


def ranked_pairs(scores: Dict[str, float], limit: int) -> List[Tuple[str, float]]:
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]


def format_results(
    ranked: List[Tuple[str, float]],
    entries_by_id: Dict[str, dict],
    sources: Dict[str, List[str]],
    bm25_map: Dict[str, float],
    dense_map: Dict[str, float],
) -> List[dict]:
    results: List[dict] = []
    for index, (entry_id, score) in enumerate(ranked, start=1):
        entry = entries_by_id.get(entry_id)
        if entry is None:
            continue
        results.append(
            {
                "rank": index,
                "id": entry_id,
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
                "sources": sources.get(entry_id, []),
                "bm25Score": round(float(bm25_map.get(entry_id, 0.0)), 6) if entry_id in bm25_map else None,
                "denseScore": round(float(dense_map.get(entry_id, 0.0)), 6) if entry_id in dense_map else None,
            }
        )
    return results


def parse_args() -> Dict[str, object]:
    parser = argparse.ArgumentParser(description="Search shared Obsidian memory")
    parser.add_argument("query", nargs="*", help="search query")
    parser.add_argument("--mode", choices=("bm25", "dense", "hybrid", "auto"), default="bm25")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--tool", default="")
    parser.add_argument("--project", default="")
    parser.add_argument("--scope", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--task-state", default="")
    parser.add_argument("--prefer-summaries", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

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
    return {
        "query": query,
        "top_k": top_k,
        "mode": "hybrid" if mode == "auto" else mode,
        "tool": normalize_spaces(args.tool).lower(),
        "project": normalize_spaces(args.project).lower(),
        "scope": normalize_spaces(args.scope).lower(),
        "source_kind": normalize_spaces(args.source_kind).lower(),
        "workspace": normalize_spaces(args.workspace).lower(),
        "task_state": normalize_spaces(args.task_state).lower(),
        "prefer_summaries": bool(args.prefer_summaries),
    }


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


def main() -> None:
    parsed = parse_args()
    query = str(parsed["query"])
    top_k = int(parsed["top_k"])
    requested_mode = str(parsed["mode"])
    entries = apply_filters(load_entries(), parsed)
    entries_by_id = {entry["id"]: entry for entry in entries}
    query_tokens = tokenize(query)

    bm25_map = bm25_scores(entries, query_tokens)
    dense_map: Dict[str, float] = {}
    dense_error: Optional[str] = None
    if requested_mode in {"dense", "hybrid"}:
        dense_map, dense_error = dense_scores(entries_by_id, query)

    effective_mode = requested_mode
    fallback_reason = None
    if requested_mode == "bm25":
        ranked = ranked_pairs(bm25_map, top_k)
    elif requested_mode == "dense":
        if dense_map:
            if bool(parsed.get("prefer_summaries")):
                dense_map = apply_summary_boost(dense_map, entries_by_id)
            ranked = ranked_pairs(dense_map, top_k)
        else:
            effective_mode = "bm25"
            fallback_reason = dense_error or "dense-unavailable"
            ranked = ranked_pairs(bm25_map, top_k)
    else:
        if dense_map:
            if bool(parsed.get("prefer_summaries")):
                bm25_map = apply_summary_boost(bm25_map, entries_by_id)
                dense_map = apply_summary_boost(dense_map, entries_by_id)
            combined: Dict[str, float] = {}
            for rank, (entry_id, _) in enumerate(ranked_pairs(bm25_map, max(top_k * 5, 20)), start=1):
                combined[entry_id] = combined.get(entry_id, 0.0) + (1.0 / (60 + rank))
            for rank, (entry_id, _) in enumerate(ranked_pairs(dense_map, max(top_k * 5, 20)), start=1):
                combined[entry_id] = combined.get(entry_id, 0.0) + (1.0 / (60 + rank))
            ranked = ranked_pairs(combined, top_k)
        else:
            effective_mode = "bm25"
            fallback_reason = dense_error or "hybrid-dense-unavailable"
            if bool(parsed.get("prefer_summaries")):
                bm25_map = apply_summary_boost(bm25_map, entries_by_id)
            ranked = ranked_pairs(bm25_map, top_k)

    sources: Dict[str, List[str]] = {}
    for entry_id in bm25_map:
        sources.setdefault(entry_id, []).append("bm25")
    for entry_id in dense_map:
        sources.setdefault(entry_id, []).append("dense")

    payload = {
        "ok": True,
        "requestedMode": requested_mode,
        "effectiveMode": effective_mode,
        "fallbackReason": fallback_reason,
        "query": query,
        "filters": {
            "tool": parsed.get("tool"),
            "project": parsed.get("project"),
            "scope": parsed.get("scope"),
            "sourceKind": parsed.get("source_kind"),
            "workspace": parsed.get("workspace"),
            "taskState": parsed.get("task_state"),
            "preferSummaries": parsed.get("prefer_summaries"),
        },
        "entryCount": len(entries),
        "hasEmbeddings": bool(load_embeddings_index()),
        "embeddingBackend": None if not load_embeddings_index() else normalize_backend(
            str(next(iter(load_embeddings_index().values())).get("backend", "")).strip(),
            str(next(iter(load_embeddings_index().values())).get("model", DEFAULT_MODEL)).strip() or DEFAULT_MODEL,
        ),
        "results": format_results(ranked, entries_by_id, sources, bm25_map, dense_map),
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
