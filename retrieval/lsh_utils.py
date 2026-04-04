"""
Canonical FNV-1a32 LSH feature extraction for the shared memory bus.

This module is the single source of truth for both the feature extraction
logic and the hash embedding build. The same algorithm is mirrored in
bus/lsh-hash.js — any change here must be synced to that file.

VECTOR_SCHEMA_VERSION tracks the feature generation algorithm.
When the algorithm changes, increment this version and trigger a
full embeddings rebuild so all stored vectors use the same fingerprint.
"""

from __future__ import annotations

import re
from typing import List

VECTOR_SCHEMA_VERSION = 1
HASH_DIM = 384


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def fnv1a32(value: str) -> int:
    """FNV-1a32 hash — returns an unsigned 32-bit integer."""
    hash_value = 0x811C9DC5
    for character in value:
        hash_value ^= ord(character)
        hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
    return hash_value


def build_hash_features(text: str) -> List[str]:
    """
    Extract LSH features from text using the 'hashing-v1' scheme.

    Feature types
    -------------
    w:<token>   Alphanumeric word/URL token (lowercased).
    c:<chars>   CJK 2+-character run.
    c2:<bigram> 2-char CJK bigram.
    c3:<trigram> 3-char CJK trigram.
    g3:<ngram>  3-char sliding ngram over compact (non-whitespace) text.
    raw:<text>  Fallback raw compact text when no other features fire.

    Returns a new list on every call — no mutation of inputs or shared state.
    """
    source = normalize_spaces(text).lower()
    compact = re.sub(r"\s+", "", source)
    features: List[str] = []

    for token in re.findall(r"[a-z0-9][a-z0-9_\-./:]{1,}", source):
        features.append(f"w:{token}")

    for chunk in re.findall(r"[\u4e00-\u9fff]{2,}", source):
        features.append(f"c:{chunk}")
        for index in range(len(chunk) - 1):
            features.append(f"c2:{chunk[index:index + 2]}")
        for index in range(len(chunk) - 2):
            features.append(f"c3:{chunk[index:index + 3]}")

    max_gram_count = max(0, min(len(compact) - 2, 400))
    for index in range(max_gram_count):
        features.append(f"g3:{compact[index:index + 3]}")

    if not features and compact:
        features.append(f"raw:{compact}")
    return features


def build_hash_embedding(text: str, dimension: int = HASH_DIM) -> List[float]:
    """
    Build a dense hash embedding vector from raw text.

    Uses the FNV-1a32 LSH scheme: each feature is hashed, the hash
    determines the vector slot, and the sign of the top hash bit
    determines the contribution (+1 / -1).  The result is L2-normalized.

    Returns a new list on every call — no mutation of inputs or shared state.
    """
    vector = [0.0] * dimension
    for feature in build_hash_features(text):
        hash_value = fnv1a32(feature)
        slot = hash_value % dimension
        sign = 1.0 if ((hash_value >> 1) & 1) == 0 else -1.0
        vector[slot] += sign

    norm = sum(value * value for value in vector) ** 0.5
    if norm > 0:
        return [round(value / norm, 8) for value in vector]
    return vector
