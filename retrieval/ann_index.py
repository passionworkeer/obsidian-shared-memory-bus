"""
ANN index module for shared-memory retrieval.

Implements `ANNIndex` - an approximate-nearest-neighbour index over embedding
vectors used to accelerate the dense (cosine) search path.

Design (tech-debt-roadmap.md 5.3 / 5.4, Phase 1):

- Primary backend: ``hnswlib`` (optional dependency). When importable, a
  cosine-space HNSW index is used with ``ef_construction=200`` / ``M=16`` and
  a query-time ``ef=50``.
- Fallback backend: when ``hnswlib`` is not installed, a brute-force cosine
  search implemented with ``numpy`` is used. This has identical correctness to
  the existing full-scan dense scorer (O(N*d)) and exists so that the module is
  always importable and unit-testable without the optional dependency.
- Thread safety: ``add`` and ``search`` are guarded by a single ``threading.RLock``
  so the index can be shared across concurrent search workers.

Distance convention: ``search`` returns ``(id, distance)`` pairs where
``distance = 1 - cosine_similarity`` (lower is better), matching the hnswlib
``space="cosine"`` convention. Callers convert back to a similarity score with
``score = 1.0 - distance``.
"""

from __future__ import annotations

import os
import threading
from typing import List, Optional, Tuple

# numpy is a hard dependency for the fallback path and for vector marshalling.
import numpy as np

# hnswlib is an optional dependency. Import failure is non-fatal - the index
# transparently degrades to the numpy brute-force fallback.
try:
    import hnswlib  # type: ignore[import-not-found]

    _HNSWLIB_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised when hnswlib is absent
    hnswlib = None  # type: ignore[assignment]
    _HNSWLIB_AVAILABLE = False


class ANNIndex:
    """Cosine ANN index backed by hnswlib, with a numpy brute-force fallback.

    Parameters mirror the roadmap 5.4 skeleton. ``max_elements`` is a hint used
    to pre-size the hnswlib index; the fallback path grows dynamically.
    """

    def __init__(
        self,
        dim: int = 384,
        max_elements: int = 100_000,
        ef_construction: int = 200,
        M: int = 16,
    ) -> None:
        if dim <= 0:
            raise ValueError(f"dim must be positive, got {dim}")
        self.dim = int(dim)
        self.max_elements = int(max_elements)
        self.ef_construction = int(ef_construction)
        self.M = int(M)
        self._query_ef = 50  # query-time accuracy knob (roadmap 5.4)

        self._lock = threading.RLock()
        self._use_hnsw = _HNSWLIB_AVAILABLE

        # Fallback-path state (numpy brute force).
        self._vectors: Optional[np.ndarray] = None  # shape (N, dim), float32
        self._ids: List[int] = []

        # hnswlib-path state.
        self._index = None
        if self._use_hnsw:
            self._index = hnswlib.Index(space="cosine", dim=self.dim)
            self._index.init_index(
                max_elements=self.max_elements,
                ef_construction=self.ef_construction,
                M=self.M,
            )
            self._index.set_ef(self._query_ef)

    @staticmethod
    def is_available() -> bool:
        """Return True when the hnswlib backend is importable.

        The numpy brute-force fallback is always available, but it offers no
        asymptotic speedup over the existing dense scorer. Callers should gate
        the ANN acceleration path on this method and fall back to the existing
        full-scan cosine scorer when it returns False.
        """
        return _HNSWLIB_AVAILABLE

    @property
    def backend(self) -> str:
        """Name of the active backend: ``"hnswlib"`` or ``"numpy-brute-force"``."""
        return "hnswlib" if self._use_hnsw else "numpy-brute-force"

    def __len__(self) -> int:
        with self._lock:
            if self._use_hnsw:
                return int(self._index.get_current_count()) if self._index is not None else 0
            return len(self._ids)
    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------
    def add(self, vectors: np.ndarray, ids: List[int]) -> None:
        """Add a batch of vectors with their integer labels.

        ``vectors`` must have shape ``(N, dim)`` and ``ids`` length ``N``.
        """
        arr = np.asarray(vectors, dtype=np.float32)
        if arr.ndim != 2 or arr.shape[1] != self.dim:
            raise ValueError(
                f"vectors must be 2D with dim={self.dim}, got shape {arr.shape}"
            )
        id_list = [int(v) for v in ids]
        if len(id_list) != arr.shape[0]:
            raise ValueError(
                f"ids length {len(id_list)} does not match vectors count {arr.shape[0]}"
            )
        if not id_list:
            return

        with self._lock:
            if self._use_hnsw:
                current = int(self._index.get_current_count()) if self._index is not None else 0
                needed = current + len(id_list)
                if needed > self.max_elements:
                    # Grow the index capacity to fit the new batch.
                    self.max_elements = needed
                    self._index.resize_index(self.max_elements)  # type: ignore[union-attr]
                self._index.add_items(arr, np.asarray(id_list, dtype=np.int64))  # type: ignore[union-attr]
            else:
                if self._vectors is None:
                    self._vectors = arr.copy()
                else:
                    self._vectors = np.concatenate([self._vectors, arr], axis=0)
                self._ids.extend(id_list)

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------
    def search(self, query: np.ndarray, k: int = 10) -> List[Tuple[int, float]]:
        """Return the ``k`` nearest neighbours as ``(id, distance)`` pairs.

        ``distance = 1 - cosine_similarity`` (lower is better). Returns an empty
        list when the index is empty or ``k <= 0``.
        """
        if k <= 0:
            return []
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        if q.shape[0] != self.dim:
            raise ValueError(
                f"query dim {q.shape[0]} does not match index dim {self.dim}"
            )

        with self._lock:
            if self._use_hnsw:
                if self._index is None or self._index.get_current_count() == 0:
                    return []
                effective_k = min(k, int(self._index.get_current_count()))
                labels, distances = self._index.knn_query(q.reshape(1, -1), k=effective_k)  # type: ignore[union-attr]
                return [
                    (int(label), float(dist))
                    for label, dist in zip(labels[0].tolist(), distances[0].tolist())
                ]

            # numpy brute-force cosine search.
            if self._vectors is None or len(self._ids) == 0:
                return []
            effective_k = min(k, len(self._ids))
            sims = self._cosine_to_matrix(q, self._vectors)
            # Partial sort: top-k by similarity descending (distance ascending).
            if effective_k >= len(self._ids):
                top_idx = np.argsort(-sims)[:effective_k]
            else:
                # argpartition for O(N) top-k, then sort the small slice.
                part = np.argpartition(-sims, effective_k - 1)[:effective_k]
                top_idx = part[np.argsort(-sims[part])]
            return [
                (int(self._ids[i]), float(1.0 - float(sims[i])))
                for i in top_idx
            ]

    @staticmethod
    def _cosine_to_matrix(query: np.ndarray, matrix: np.ndarray) -> np.ndarray:
        """Cosine similarity between a single query vector and each row of matrix."""
        q_norm = float(np.linalg.norm(query))
        if q_norm <= 0:
            return np.zeros(matrix.shape[0], dtype=np.float32)
        m_norms = np.linalg.norm(matrix, axis=1)
        denom = m_norms * q_norm
        safe = denom > 0
        sims = np.zeros(matrix.shape[0], dtype=np.float32)
        dots = matrix @ query
        sims[safe] = (dots[safe] / denom[safe]).astype(np.float32)
        return sims
    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def save(self, path: str) -> None:
        """Persist the index to ``path``.

        hnswlib backend: writes a single index file (labels included).
        numpy backend: writes a ``.npz`` archive containing vectors and ids.
        """
        with self._lock:
            if self._use_hnsw:
                if self._index is None:
                    raise RuntimeError("cannot save an uninitialised hnswlib index")
                self._index.save_index(path)  # type: ignore[union-attr]
            else:
                parent = os.path.dirname(os.path.abspath(path))
                if parent and not os.path.isdir(parent):
                    os.makedirs(parent, exist_ok=True)
                vectors = self._vectors if self._vectors is not None else np.zeros(
                    (0, self.dim), dtype=np.float32
                )
                np.savez(
                    path,
                    vectors=vectors,
                    ids=np.asarray(self._ids, dtype=np.int64),
                    dim=np.asarray(self.dim, dtype=np.int64),
                )

    def load(self, path: str) -> None:
        """Load the index from ``path``, replacing any existing state.

        The backend is chosen by availability, not by file format, so a numpy
        archive saved on a machine without hnswlib can still be loaded later on
        one that has it (the vectors are re-added to a fresh hnswlib index).
        """
        with self._lock:
            if self._use_hnsw:
                if self._index is None:
                    self._index = hnswlib.Index(space="cosine", dim=self.dim)  # type: ignore[union-attr]
                self._index.load_index(path)  # type: ignore[union-attr]
                self._index.set_ef(self._query_ef)  # type: ignore[union-attr]
                return

            if not os.path.isfile(path):
                raise FileNotFoundError(f"ANN index file not found: {path}")
            with np.load(path, allow_pickle=False) as data:
                vectors = np.asarray(data["vectors"], dtype=np.float32)
                ids = [int(v) for v in np.asarray(data["ids"]).tolist()]
                stored_dim = int(np.asarray(data["dim"]).tolist())
            if stored_dim != self.dim:
                raise ValueError(
                    f"stored dim {stored_dim} does not match index dim {self.dim}"
                )
            self._vectors = vectors if vectors.shape[0] > 0 else None
            self._ids = ids