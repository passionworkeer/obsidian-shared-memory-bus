"""
Embedding provider adapters for shared-memory retrieval.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Tuple

from lsh_utils import HASH_DIM, VECTOR_SCHEMA_VERSION, build_hash_embedding, fnv1a32
from runtime_support import normalize_embedding_adapter

DEFAULT_MODEL = "all-MiniLM-L6-v2"
HASH_MODEL = "hashing-v1"
_TRANSFORMER_MODEL_CACHE: Dict[str, object] = {"name": "", "model": None}


def build_embedding_config_hash(adapter: str, model_name: str, base_url: str = "") -> str:
    normalized_adapter = normalize_embedding_adapter(adapter, model_name)
    normalized_base_url = base_url.strip().rstrip("/") if normalized_adapter == "openai-compatible" else ""
    payload = json.dumps(
        {
            "backend": normalized_adapter,
            "model": (model_name or "").strip(),
            "baseUrl": normalized_base_url.lower(),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha1(payload.encode("utf-8", errors="ignore")).hexdigest()[:16]


def get_provider_host(base_url: str) -> str:
    normalized = (base_url or "").strip().rstrip("/")
    if not normalized:
        return ""
    match = re.match(r"^[a-zA-Z]+://([^/]+)", normalized)
    return match.group(1) if match else ""


def get_transformer_model_name() -> str:
    return str(_TRANSFORMER_MODEL_CACHE.get("name", ""))


def embed_query_openai_compatible(query: str, runtime: Dict[str, object], model_name: str) -> Tuple[Optional[List[float]], Optional[str]]:
    base_url = str(runtime.get("baseUrl", "")).rstrip("/")
    api_key = str(runtime.get("apiKey", ""))
    timeout_seconds = int(runtime.get("timeoutSeconds", 120) or 120)

    if not base_url:
        return None, "missing-openai-base-url"
    if not api_key:
        return None, "missing-openai-api-key"

    payload = json.dumps(
        {
            "model": model_name,
            "input": query,
            "encoding_format": "float",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/embeddings",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
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


def embed_query_transformer(query: str, model_name: str) -> Tuple[Optional[List[float]], Optional[str]]:
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except Exception as exc:
        return None, f"sentence-transformers-unavailable: {exc}"

    try:
        cached_name = str(_TRANSFORMER_MODEL_CACHE.get("name", ""))
        model = _TRANSFORMER_MODEL_CACHE.get("model")
        if model is None or cached_name != model_name:
            model = SentenceTransformer(model_name)
            _TRANSFORMER_MODEL_CACHE["name"] = model_name
            _TRANSFORMER_MODEL_CACHE["model"] = model
        encoded = model.encode([query], show_progress_bar=False, convert_to_numpy=True)
        vector = encoded[0].tolist() if hasattr(encoded[0], "tolist") else list(encoded[0])
        return [float(value) for value in vector], None
    except Exception as exc:
        return None, f"query-embedding-failed: {exc}"


def embed_query_with_runtime(
    query: str,
    runtime: Dict[str, object],
    model_name: str = "",
) -> Tuple[Optional[List[float]], Optional[str], str, str]:
    resolved_model = str(model_name or runtime.get("model", DEFAULT_MODEL) or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    adapter = normalize_embedding_adapter(runtime.get("adapter") or runtime.get("backend"), resolved_model) or "hash"

    if resolved_model.startswith("hashing-"):
        resolved_model = HASH_MODEL

    if adapter == "hash" or resolved_model == HASH_MODEL:
        return build_hash_embedding(query), None, "hash", HASH_MODEL
    if adapter == "openai-compatible":
        vector, error = embed_query_openai_compatible(query, runtime, resolved_model)
        return vector, error, adapter, resolved_model
    if adapter == "transformer":
        vector, error = embed_query_transformer(query, resolved_model)
        return vector, error, adapter, resolved_model
    return None, f"unsupported-embedding-adapter:{adapter}", adapter, resolved_model
