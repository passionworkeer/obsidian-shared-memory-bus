"""
Embedding provider adapters for shared-memory retrieval.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
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


# ---------------------------------------------------------------------------
# Batch embedding — OpenAI-compatible /v1/embeddings endpoint
# ---------------------------------------------------------------------------

BATCH_MAX_SIZE = 96  # hard cap enforced by most providers (OpenAI, Ollama, etc.)


def _chunked(items: List[str], size: int) -> List[List[str]]:
    """Yield successive ``size``-item chunks from ``items``."""
    for i in range(0, len(items), size):
        yield items[i : i + size]


def batch_embed_openai_compatible(
    queries: List[str],
    runtime: Dict[str, object],
    model_name: str,
) -> List[Tuple[Optional[List[float]], Optional[str]]]:
    """
    Calls the OpenAI-compatible /embeddings endpoint in batch mode.

    Arguments:
        queries: List of text strings to embed (max 96 per call).
        runtime: Runtime config dict with `baseUrl`, `apiKey`, `timeoutSeconds`.
        model_name: Model identifier sent as `model` in the request body.

    Returns:
        List of (vector, error) tuples aligned 1:1 with ``queries``.
        A single failed item returns (None, error_string) for that index;
        all other indices are returned as (vector, None) on success.
        If the entire batch fails after all retries, every slot returns
        (None, aggregated_error).
    """
    if not queries:
        return []

    base_url = str(runtime.get("baseUrl", "")).rstrip("/")
    api_key = str(runtime.get("apiKey", ""))
    timeout_seconds = int(runtime.get("timeoutSeconds", 120) or 120)

    if not base_url:
        return [(None, "missing-openai-base-url")] * len(queries)
    if not api_key:
        return [(None, "missing-openai-api-key")] * len(queries)

    payload = json.dumps(
        {
            "model": model_name,
            "input": queries,
            "encoding_format": "float",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/v1/embeddings",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    result, status_code = _batch_request_with_retries(request, timeout_seconds)
    if result is not None:
        return result
    return [(None, status_code)] * len(queries)


def _batch_request_with_retries(
    request: urllib.request.Request,
    timeout_seconds: int,
    *,
    min_delay_ms: int = 300,
    max_delay_ms: int = 2400,
    jitter: float = 0.2,
    max_attempts: int = 5,
) -> Tuple[Optional[List[Tuple[Optional[List[float]], Optional[str]]]], Optional[str]]:
    """
    Executes the HTTP request with exponential-backoff retry.

    Retries on HTTP 429 (quota/rate-limit) and 5xx errors.
    Returns (parsed_results, None) on success, (None, error_string) on final failure.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                body = response.read().decode("utf-8", errors="replace")
            return _parse_batch_response(body)
        except urllib.error.HTTPError as exc:
            code = exc.code
            detail = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
            if code in (429,) or 500 <= code < 600:
                if attempt >= max_attempts:
                    return None, f"batch-openai-compatible-http-{code}: {detail[:500]}"
                sleep_ms = _backoff_delay(attempt, min_delay_ms, max_delay_ms, jitter)
                time.sleep(sleep_ms / 1000.0)
                continue
            return None, f"batch-openai-compatible-http-{code}: {detail[:500]}"
        except Exception as exc:
            if attempt >= max_attempts:
                return None, f"batch-openai-compatible-request-failed: {exc}"
            sleep_ms = _backoff_delay(attempt, min_delay_ms, max_delay_ms, jitter)
            time.sleep(sleep_ms / 1000.0)
            continue


def _backoff_delay(attempt: int, min_ms: int, max_ms: int, jitter_ratio: float) -> int:
    """Exponential backoff with capped delay and uniform jitter."""
    raw = min_ms * (2 ** (attempt - 1))
    capped = min(raw, max_ms)
    jitter = capped * jitter_ratio * random.random()
    return int(capped + jitter)


def _parse_batch_response(
    body: str,
) -> Tuple[Optional[List[Tuple[Optional[List[float]], Optional[str]]]], Optional[str]]:
    """
    Parses the OpenAI-compatible /embeddings batch response.

    The response may contain fewer entries than requested (partial failure is
    opaque at this layer — caller decides how to fill gaps).

    Returns (results, None) on success, (None, error_string) on parse failure.
    """
    try:
        parsed = json.loads(body)
    except Exception as exc:
        return None, f"batch-openai-compatible-invalid-json: {exc}"

    data: List[dict]
    try:
        data = parsed.get("data") or []
    except Exception:
        return None, "batch-openai-compatible-empty-response"

    if not data:
        return None, "batch-openai-compatible-empty-response"

    result: List[Tuple[Optional[List[float]], Optional[str]]] = []
    for item in data:
        vector = item.get("embedding")
        if not isinstance(vector, list) or not vector:
            result.append((None, "batch-openai-compatible-empty-vector"))
        else:
            try:
                result.append(([float(v) for v in vector], None))
            except (TypeError, ValueError) as exc:
                result.append((None, f"batch-openai-compatible-vector-parse-error: {exc}"))

    return result, None


# ---------------------------------------------------------------------------
# Batch dispatcher — single vs. batch routing
# ---------------------------------------------------------------------------


def batch_embed_with_runtime(
    queries: List[str],
    runtime: Dict[str, object],
    model_name: str = "",
) -> List[Tuple[Optional[List[float]], Optional[str], str, str]]:
    """
    Dispatches to batch or single embedding based on query count.

    Uses ``BATCH_MAX_SIZE`` as the cutoff: ``>= 2`` queries go through the
    batch path (up to 96 per call; larger lists are chunked), while a single
    query uses the existing single-shot path so the four-element return
    signature is preserved.

    Returns a list of (vector, error, adapter, resolved_model) tuples.
    """
    resolved_model = str(model_name or runtime.get("model", DEFAULT_MODEL) or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    adapter = normalize_embedding_adapter(
        runtime.get("adapter") or runtime.get("backend"), resolved_model
    ) or "hash"
    if resolved_model.startswith("hashing-"):
        resolved_model = HASH_MODEL
    if adapter == "hash" or resolved_model == HASH_MODEL:
        return [(build_hash_embedding(q), None, "hash", HASH_MODEL) for q in queries]

    if adapter == "openai-compatible":
        return _batch_dispatch_openai_compatible(queries, runtime, resolved_model)

    if adapter == "transformer":
        return _batch_dispatch_transformer(queries, resolved_model)

    return [(None, f"unsupported-embedding-adapter:{adapter}", adapter, resolved_model)] * len(queries)


def _batch_dispatch_openai_compatible(
    queries: List[str],
    runtime: Dict[str, object],
    resolved_model: str,
) -> List[Tuple[Optional[List[float]], Optional[str], str, str]]:
    """Split ``queries`` into BATCH_MAX_SIZE chunks and call batch API for each."""
    results: List[Tuple[Optional[List[float]], Optional[str], str, str]] = []
    for chunk in _chunked(queries, BATCH_MAX_SIZE):
        batch_results = batch_embed_openai_compatible(chunk, runtime, resolved_model)
        for vector, error in batch_results:
            results.append((vector, error, "openai-compatible", resolved_model))
    return results


def _batch_dispatch_transformer(
    queries: List[str],
    resolved_model: str,
) -> List[Tuple[Optional[List[float]], Optional[str], str, str]]:
    """
    Runs sentence-transformer encoding for a list of queries.

    Unlike the OpenAI path, sentence-transformers has no HTTP overhead and no
    per-request cost, so we batch everything into a single ``model.encode()``
    call for maximum throughput.
    """
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except Exception as exc:
        return [(None, f"sentence-transformers-unavailable: {exc}", "transformer", resolved_model)] * len(queries)

    try:
        cached_name = str(_TRANSFORMER_MODEL_CACHE.get("name", ""))
        model = _TRANSFORMER_MODEL_CACHE.get("model")
        if model is None or cached_name != resolved_model:
            model = SentenceTransformer(resolved_model)
            _TRANSFORMER_MODEL_CACHE["name"] = resolved_model
            _TRANSFORMER_MODEL_CACHE["model"] = model
        encoded = model.encode(queries, show_progress_bar=False, convert_to_numpy=True)
        return [(row.tolist() if hasattr(row, "tolist") else list(row), None, "transformer", resolved_model) for row in encoded]
    except Exception as exc:
        return [(None, f"transformer-batch-embedding-failed: {exc}", "transformer", resolved_model)] * len(queries)


# ---------------------------------------------------------------------------
# BatchBuilder — groups chunks by provider for efficient batch dispatch
# ---------------------------------------------------------------------------


@dataclass
class Chunk:
    """A single text unit waiting to be embedded."""

    text: str
    chunk_id: str = ""          # optional stable identifier
    metadata: dict = field(default_factory=dict)


@dataclass
class ProviderBatch:
    """Chunks that share the same adapter / model / runtime configuration."""

    adapter: str
    model: str
    runtime: Dict[str, object]
    chunks: List[Chunk] = field(default_factory=list)


class BatchBuilder:
    """
    Accumulates chunks during ingestion and groups them by provider.

    Usage::

        builder = BatchBuilder()
        for chunk in documents:
            builder.add(
                text=chunk["text"],
                adapter=detect_adapter(chunk),
                model=resolve_model(chunk),
                runtime=chunk["runtime"],
            )
        # Process every provider batch independently (one API call per batch)
        for pb in builder.batches():
            results = batch_embed_with_runtime(
                [c.text for c in pb.chunks], pb.runtime, pb.model
            )
            # merge results back using pb.chunks indices
    """

    def __init__(self) -> None:
        self._batches: Dict[str, List[Chunk]] = {}  # key -> chunks

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    def add(
        self,
        text: str,
        adapter: str,
        model: str,
        runtime: Dict[str, object],
        chunk_id: str = "",
        metadata: Optional[dict] = None,
    ) -> None:
        """Append a single chunk to the appropriate provider batch."""
        key = self._make_key(adapter, model, runtime)
        if key not in self._batches:
            self._batches[key] = []
        self._batches[key].append(Chunk(text=str(text), chunk_id=str(chunk_id), metadata=metadata or {}))

    def add_batch(
        self,
        texts: List[str],
        adapter: str,
        model: str,
        runtime: Dict[str, object],
        chunk_ids: Optional[List[str]] = None,
        metadatas: Optional[List[dict]] = None,
    ) -> None:
        """Append multiple chunks that share the same provider config."""
        ids = chunk_ids or ["" for _ in texts]
        metas = metadatas or [{} for _ in texts]
        for text, cid, meta in zip(texts, ids, metas):
            self.add(text=text, adapter=adapter, model=model, runtime=runtime, chunk_id=cid, metadata=meta)

    def batches(self) -> List[ProviderBatch]:
        """Return all accumulated provider batches in insertion order."""
        result: List[ProviderBatch] = []
        for key, chunks in self._batches.items():
            adapter, model, runtime = self._split_key(key)
            result.append(ProviderBatch(adapter=adapter, model=model, runtime=runtime, chunks=chunks))
        return result

    def __len__(self) -> int:
        return sum(len(v) for v in self._batches.values())

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _make_key(adapter: str, model: str, runtime: Dict[str, object]) -> str:
        """Deterministic key so identical configs map to the same batch."""
        base_url = str(runtime.get("baseUrl", "")).rstrip("/") if adapter == "openai-compatible" else ""
        return f"{adapter}|{model}|{base_url}"

    @staticmethod
    def _split_key(key: str) -> Tuple[str, str, Dict[str, object]]:
        adapter, model, base_url = key.split("|", 2)
        runtime: Dict[str, object] = {}
        if adapter == "openai-compatible" and base_url:
            runtime["baseUrl"] = base_url
        return adapter, model, runtime


