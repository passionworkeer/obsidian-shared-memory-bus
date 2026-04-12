"""
Streaming index reader for embeddings index.

This module provides memory-efficient iteration over large JSONL index files
without loading the entire file into memory. Two classes are offered:

1. StreamingIndexReader — pure iterator, zero memory overhead per call.
2. StreamingIndex — maintains a bounded LRU cache for hot entries while
   streaming through cold entries.
"""

from __future__ import annotations

import json
import os
import time
from collections import OrderedDict
from pathlib import Path
from typing import Dict, Generator, Iterator, List, Optional, Tuple


class StreamingIndexReader:
    """
    One-pass, zero-caching reader for JSONL index files.

    Usage:
        reader = StreamingIndexReader('/path/to/index.jsonl')
        for record in reader:
            process(record)

    The iterator is a generator — it yields records one at a time from disk
    and never materializes the full file in memory.
    """

    def __init__(self, file_path: str | Path) -> None:
        self.file_path = Path(file_path)
        self._lines: Iterator[str] = iter([])
        self._file_handle = None
        self._started = False

    def __iter__(self) -> "StreamingIndexReader":
        """Return self as an iterator (implements the iterator protocol)."""
        # Close previous file handle if still open from a prior pass
        if self._file_handle is not None:
            try:
                self._file_handle.close()
            except Exception:
                pass
            self._file_handle = None

        if self.file_path.exists():
            self._file_handle = open(self.file_path, "r", encoding="utf-8", errors="replace")
            self._lines = (line.strip() for line in self._file_handle)
        else:
            self._lines = iter([])
        self._started = True
        return self

    def __next__(self) -> Dict:
        """Return the next record. Raises StopIteration when exhausted."""
        # Lazily initialize on first next() call (supports next(reader) without iter())
        if not self._started:
            if self.file_path.exists():
                self._file_handle = open(self.file_path, "r", encoding="utf-8", errors="replace")
                self._lines = (line.strip() for line in self._file_handle)
            else:
                self._lines = iter([])
            self._started = True

        while True:
            try:
                line = next(self._lines)
            except StopIteration:
                if self._file_handle is not None:
                    try:
                        self._file_handle.close()
                    except Exception:
                        pass
                    self._file_handle = None
                raise
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                # Skip malformed lines without crashing
                pass

    def iterate(self) -> Generator[Dict, None, None]:
        """Return a standalone generator (each call = independent pass)."""
        if not self.file_path.exists():
            return
        with open(self.file_path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    pass


class StreamingIndex:
    """
    Streaming index with bounded LRU cache for hot entries.

    Design goals:
    - Memory is bounded: cache size is capped at _MAX_CACHED_ENTRIES (default 5000)
    - Hot entries (frequently accessed) stay in cache
    - Cold entries are streamed from disk on each access
    - Thread-unsafe (do not share across threads without external locking)

    Usage:
        index = StreamingIndex('/path/to/index.jsonl')
        embedding = index.get_embedding('rec-id-123')
        matches = list(index.find_by_prefix('rec-00'))
    """

    _DEFAULT_MAX_CACHED = 5000
    _CACHE_TTL_SECONDS = 30.0

    def __init__(self, file_path: str | Path, max_cached: int = 5000) -> None:
        self.file_path = Path(file_path)
        self._MAX_CACHED_ENTRIES = max_cached
        self._cache: OrderedDict[str, Tuple[Dict, float]] = OrderedDict()
        self._miss_count = 0
        self._hit_count = 0
        self._stream_count = 0

    def _evict_if_needed(self) -> None:
        """Evict oldest (least-recently-used) entry if cache exceeds max size."""
        while len(self._cache) >= self._MAX_CACHED_ENTRIES:
            self._cache.popitem(last=False)

    def _is_stale(self, timestamp: float) -> bool:
        """Check if a cache entry has expired based on TTL."""
        return (time.time() - timestamp) >= self._CACHE_TTL_SECONDS

    def get(self, record_id: str) -> Optional[Dict]:
        """
        Get a single record by ID.

        First checks the bounded LRU cache; on a miss, streams through the file.
        Returns None if the record is not found.
        """
        now = time.time()

        # Cache hit — check TTL freshness
        if record_id in self._cache:
            entry, cached_at = self._cache[record_id]
            if not self._is_stale(cached_at):
                self._cache.move_to_end(record_id)  # promote to most-recently-used
                self._hit_count += 1
                return entry
            else:
                # Stale entry — remove it and treat as a miss
                del self._cache[record_id]

        # Cache miss — stream through file to find the record
        self._miss_count += 1
        for record in StreamingIndexReader(self.file_path):
            rid = str(record.get("id", "")).strip()
            if rid == record_id:
                self._evict_if_needed()
                self._cache[record_id] = (record, now)
                return record

        return None

    def get_embedding(self, record_id: str) -> Optional[List[float]]:
        """Get just the embedding vector for a record (most memory-efficient path)."""
        record = self.get(record_id)
        if record and isinstance(record.get("embedding"), list):
            return record["embedding"]
        return None

    def find_by_prefix(self, prefix: str) -> Generator[Dict, None, None]:
        """Stream-iterate all records whose id starts with the given prefix."""
        for record in StreamingIndexReader(self.file_path):
            rid = str(record.get("id", "")).strip()
            if rid.startswith(prefix):
                yield record

    def scan(self) -> Generator[Dict, None, None]:
        """Stream all records without caching. Full file pass each call."""
        self._stream_count += 1
        yield from StreamingIndexReader(self.file_path)

    def scan_batched(self, batch_size: int = 100) -> Generator[List[Dict], None, None]:
        """
        Yield records in batches of the specified size.

        Memory-efficient: only one batch is held in memory at a time.
        """
        batch: List[Dict] = []
        for record in StreamingIndexReader(self.file_path):
            batch.append(record)
            if len(batch) >= batch_size:
                yield batch
                batch = []
        if batch:
            yield batch

    def stats(self) -> Dict:
        """Return cache statistics for monitoring and debugging."""
        total = self._hit_count + self._miss_count
        hit_rate = self._hit_count / total if total > 0 else 0.0
        return {
            "cached_entries": len(self._cache),
            "max_cached": self._MAX_CACHED_ENTRIES,
            "hits": self._hit_count,
            "misses": self._miss_count,
            "hit_rate": round(hit_rate, 4),
            "full_scans": self._stream_count,
        }
