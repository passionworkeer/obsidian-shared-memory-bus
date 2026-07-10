#!/usr/bin/env python3
"""
NDCG / Recall / MRR benchmark for the shared-memory retrieval pipeline.

This is the canonical retrieval-quality benchmark. It runs each query in the
judgments file through the CURRENT retrieval stack (semantic_search.execute_search
with weighted-sum fusion under the `auto` route — the production default), then
scores the top-K results against ground-truth relevance from the judgments file.

Outputs:
  - Per-query metrics (NDCG@5, Recall@10, MRR, plus system diagnostics)
  - Aggregate means
  - Data-coverage / limitation report (how many judgments have ground truth,
    how many system results came back, etc.)
  - Machine-readable JSON written to retrieval/eval/ndcg-baseline.json

Usage:
    D:\\python\\python.exe retrieval/eval/ndcg_benchmark.py
    D:\\python\\python.exe retrieval/eval/ndcg_benchmark.py --judgments judgments.jsonl --route auto --top-k 10
    D:\\python\\python.exe retrieval/eval/ndcg_benchmark.py --csv  # also emit per-query CSV

Design notes
------------
- Reads `judgments.jsonl` (one JSON object per line):
    {"query": "...", "route": "<ground_truth_route>",
     "relevant_ids": ["id1", ...],         # binary relevance
     "relevance_scores": {"id1": 3, ...}}  # graded relevance (optional override)
- Ground truth is sparse. When `relevant_ids` is empty but `route` is present,
  we fall back to a *route-as-weak-label*: an entry is considered weakly-relevant
  (grade 1) if the entry's derived layer matches the ground-truth route. This is
  an explicitly documented limitation, not a fabricated gold standard.
- The script only reads retrieval/ files (semantic_search.py, search_ranking.py,
  search_index.py); it never starts the search server.

Exit codes:
    0 - benchmark completed (results written)
    1 - fatal error (judgments missing, semantic_search import failed, etc.)
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import os
import sys
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_RETRIEVAL_DIR = os.path.dirname(_SCRIPT_DIR)
_PROJECT_ROOT = os.path.dirname(_RETRIEVAL_DIR)

for p in (_RETRIEVAL_DIR, _PROJECT_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)


# ---------------------------------------------------------------------------
# Metrics — pure functions, no external deps
# ---------------------------------------------------------------------------

def dcg_at_k(relevances: List[float], k: int) -> float:
    """Discounted Cumulative Gain at K."""
    return sum(rel / math.log2(i + 2) for i, rel in enumerate(relevances[:k]))


def ndcg_at_k(relevances: List[float], k: int) -> float:
    """Normalized DCG at K. Returns 0.0 when ideal DCG is 0 (no relevant in top-K)."""
    ideal = sorted(relevances, reverse=True)
    idcg = dcg_at_k(ideal, k)
    if idcg <= 0:
        return 0.0
    return dcg_at_k(relevances, k) / idcg


def recall_at_k(relevances: List[float], k: int, total_relevant: int) -> float:
    """Recall @ K = (# relevant in top-K) / min(total_relevant, K).

    Uses min(total_relevant, K) so that judgments with more relevant items than K
    are not penalized for the truncation, and empty judgments yield 0 (not div-0).
    """
    if total_relevant <= 0:
        return 0.0
    hits = sum(1 for r in relevances[:k] if r > 0)
    denom = max(1, min(total_relevant, k))
    return min(hits / denom, 1.0)


def mrr_at_k(relevances: List[float], k: int) -> float:
    """Mean Reciprocal Rank at K: 1/rank of first relevant item within top-K."""
    for i, rel in enumerate(relevances[:k]):
        if rel > 0:
            return 1.0 / (i + 1)
    return 0.0


# ---------------------------------------------------------------------------
# Relevance construction
# ---------------------------------------------------------------------------

# Map from ground-truth route name -> the entry "layer" values that should be
# considered weakly-relevant when no explicit relevant_ids are provided.
# Mirrors derive_entry_layer() semantics in search_ranking.py.
ROUTE_TO_LAYER: Dict[str, set] = {
    "durable":  {"durable"},
    "session":  {"session"},
    "recent":   {"session", "event"},
    "task":     {"task", "session"},
    "reference": {"reference", "durable"},
    "mixed":    {"durable", "session", "event", "task", "reference"},
}


def _entry_layer(entry: Dict[str, Any]) -> str:
    """Best-effort layer name for an entry. Uses derived field if present."""
    layer = entry.get("layer")
    if layer:
        return str(layer)
    ml = entry.get("memory_level")
    if ml:
        return str(ml)
    # Fall back to inferring from scope (rough)
    scope = str(entry.get("scope", "")).lower()
    if scope in {"user", "feedback", "project"}:
        return "durable"
    if scope in {"run"}:
        return "task"
    if scope in {"reference", "summary"}:
        return "reference"
    return "session"


def build_relevances(
    retrieved: List[Dict[str, Any]],
    relevant_ids: set,
    graded: Dict[str, float],
    weak_route: Optional[str] = None,
) -> Tuple[List[float], int]:
    """Return (relevance_grades_for_top_results, total_relevant_count).

    Grade resolution per retrieved result id (highest precedence wins):
      1. relevance_scores[id]           (graded ground truth)
      2. id in relevant_ids              (binary relevance, grade 1.0)
      3. weak-route layer match          (grade 1.0, only if relevant_ids empty)
      4. otherwise                       (0.0)

    total_relevant_count is the size of the effective relevant set:
      - len(relevant_ids) | len(graded) if explicit truth exists
      - else 0 (weak labels are not counted in the denominator — they are
        diagnostic only, to avoid inflating Recall with our own guesses).
    """
    weak_layers = ROUTE_TO_LAYER.get(weak_route or "", set()) if weak_route else set()
    use_weak = (not relevant_ids) and (not graded) and bool(weak_layers)

    relevances: List[float] = []
    for r in retrieved:
        rid = str(r.get("id") or r.get("record_id") or "")
        if graded and rid in graded:
            relevances.append(float(graded[rid]))
        elif rid in relevant_ids:
            relevances.append(1.0)
        elif use_weak and _entry_layer(r) in weak_layers:
            relevances.append(1.0)
        else:
            relevances.append(0.0)

    total_relevant = len(relevant_ids) if relevant_ids else len(graded)
    return relevances, total_relevant


# ---------------------------------------------------------------------------
# Judgment loading
# ---------------------------------------------------------------------------

def load_judgments(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    out: List[Dict[str, Any]] = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as exc:
                sys.stderr.write(f"[ndcg-bench] skip line {lineno}: {exc}\n")
    return out


# ---------------------------------------------------------------------------
# semantic_search loader (lazy, cached)
# ---------------------------------------------------------------------------

_semantic_search_module: Optional[Any] = None


def load_semantic_search() -> Any:
    global _semantic_search_module
    if _semantic_search_module is not None:
        return _semantic_search_module
    search_path = os.path.join(_RETRIEVAL_DIR, "semantic_search.py")
    spec = importlib.util.spec_from_file_location("semantic_search", search_path)
    if spec is None or spec.loader is None:
        sys.exit("[ndcg-bench] error: could not create module spec for semantic_search.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        sys.exit(f"[ndcg-bench] error loading semantic_search.py: {exc}")
    _semantic_search_module = module
    return module


# ---------------------------------------------------------------------------
# Benchmark runner
# ---------------------------------------------------------------------------

def run_single(
    sm: Any,
    query: str,
    route: str,
    top_k: int,
    mode: str,
    workspace_root: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any], Optional[str]]:
    """Run one query. Returns (retrieved_results, diagnostics, error_or_None)."""
    payload = {
        "query": query,
        "route": route,
        "top_k": top_k,
        "mode": mode,
        "workspace_root": workspace_root,
    }
    try:
        resp = sm.execute_search(payload)
    except Exception as exc:
        return [], {}, str(exc)
    retrieved = resp.get("results", []) or []
    diag = {
        "entryCount":      resp.get("entryCount"),
        "candidateCount":  resp.get("candidateCount"),
        "queryIntent":     resp.get("queryIntent"),
        "effectiveMode":   resp.get("effectiveMode"),
        "requestedMode":   resp.get("requestedMode"),
        "fallbackReason":  resp.get("fallbackReason"),
        "hasEmbeddings":   resp.get("hasEmbeddings"),
        "embeddingBackend": resp.get("embeddingBackend"),
    }
    return retrieved, diag, None


def run_benchmark(
    judgments: List[Dict[str, Any]],
    sm: Any,
    route: str,
    top_k: int,
    mode: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    workspace_root = os.environ.get("AI_MEMORY_OBSIDIAN_VAULT", "")
    per_query: List[Dict[str, Any]] = []
    routes_used = defaultdict(int)
    weak_label_used = 0
    explicit_truth = 0
    total_entries_seen: List[int] = []

    for idx, j in enumerate(judgments, 1):
        query = j.get("query", "") or ""
        if not query:
            continue
        gt_route = str(j.get("route") or route).lower()
        # The system route we ask for is the script-level `route` (default: auto),
        # but the ground-truth route is used for weak-label layering only.
        retrieved, diag, err = run_single(
            sm, query, route, top_k, mode, workspace_root
        )

        relevant_ids = set(str(x) for x in j.get("relevant_ids", []) or [])
        graded_raw = j.get("relevance_scores", {}) or {}
        graded = {str(k): float(v) for k, v in graded_raw.items()}
        has_explicit = bool(relevant_ids) or bool(graded)
        if has_explicit:
            explicit_truth += 1
        weak_route = gt_route if not has_explicit else None

        relevances, total_relevant = build_relevances(
            retrieved, relevant_ids, graded, weak_route=weak_route
        )
        if not has_explicit and weak_route:
            weak_label_used += 1

        # Pad relevances for fair metric comparison
        padded = list(relevances) + [0.0] * max(0, top_k - len(relevances))

        ndcg5 = ndcg_at_k(padded, 5)
        ndcg10 = ndcg_at_k(padded, 10)
        mrr5 = mrr_at_k(padded, 5)
        mrr10 = mrr_at_k(padded, 10)
        rec10 = recall_at_k(padded, 10, total_relevant)

        sys.stderr.write(
            f"  [{idx:>2}/{len(judgments)}] "
            f"intent={diag.get('queryIntent','?'):<8} "
            f"n_ret={len(retrieved):>3} "
            f"N@5={ndcg5:.3f} R@10={rec10:.3f} MRR@5={mrr5:.3f} "
            f"| {query[:42]}\n"
        )

        per_query.append({
            "query":           query,
            "ground_truth_route": gt_route,
            "system_route":    route,
            "system_intent":   diag.get("queryIntent"),
            "has_explicit_truth": has_explicit,
            "weak_label_used": (not has_explicit) and weak_route is not None,
            "relevant_id_count":   len(relevant_ids),
            "graded_count":        len(graded),
            "retrieved_count":     len(retrieved),
            "entryCount":      diag.get("entryCount"),
            "candidateCount":  diag.get("candidateCount"),
            "effectiveMode":   diag.get("effectiveMode"),
            "fallbackReason":  diag.get("fallbackReason"),
            "hasEmbeddings":   diag.get("hasEmbeddings"),
            "embeddingBackend": diag.get("embeddingBackend"),
            "metrics": {
                "ndcg@5":   round(ndcg5, 4),
                "ndcg@10":  round(ndcg10, 4),
                "mrr@5":    round(mrr5, 4),
                "mrr@10":   round(mrr10, 4),
                "recall@10": round(rec10, 4),
            },
            "error": err,
        })
        routes_used[gt_route] += 1
        if isinstance(diag.get("entryCount"), int):
            total_entries_seen.append(diag["entryCount"])

    # Aggregate
    def mean(key_path: str) -> float:
        vals: List[float] = []
        for q in per_query:
            v = q.get("metrics", {}).get(key_path)
            if isinstance(v, (int, float)):
                vals.append(float(v))
        return round(sum(vals) / len(vals), 4) if vals else 0.0

    n = len(per_query)
    aggregate = {
        "query_count":     n,
        "ndcg@5":          mean("ndcg@5"),
        "ndcg@10":         mean("ndcg@10"),
        "mrr@5":           mean("mrr@5"),
        "mrr@10":          mean("mrr@10"),
        "recall@10":       mean("recall@10"),
    }

    diagnostics = {
        "judgment_count":       len(judgments),
        "queries_evaluated":    n,
        "explicit_truth_count": explicit_truth,
        "weak_label_count":     weak_label_used,
        "routes_in_judgments":  dict(routes_used),
        "entry_count_distinct": sorted(set(total_entries_seen)),
        "entry_count_max":      max(total_entries_seen) if total_entries_seen else 0,
        "retrieval_nonempty_rate": round(
            sum(1 for q in per_query if q["retrieved_count"] > 0) / max(n, 1), 4
        ),
    }

    return per_query, {"aggregate": aggregate, "diagnostics": diagnostics}


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

LIMITATION_NOTE = (
    "LIMITATIONS: The bundled judgments.jsonl ships with empty relevant_ids "
    "and relevance_scores (seed queries only, no human-annotated ground truth). "
    "Metrics reported here therefore rely on (a) actual system retrieval behavior "
    "and (b) a route-as-weak-label fallback: when no explicit truth is present, "
    "an entry is treated as weakly relevant (grade 1) if its derived layer matches "
    "the judgment's ground-truth route. Recall@10 denominators use only explicit "
    "truth; weak-label hits are diagnostic and do not inflate Recall. Treat these "
    "numbers as a baseline under sparse truth, NOT a validated gold-standard score. "
    "To get publishable numbers, populate relevant_ids/relevance_scores via "
    "judgments-generator.js + human annotation."
)


def print_report(per_query: List[Dict[str, Any]], meta: Dict[str, Any], route: str, top_k: int, mode: str) -> None:
    agg = meta["aggregate"]
    dia = meta["diagnostics"]
    sys.stderr.write("\n" + "=" * 68 + "\n")
    sys.stderr.write("RETRIEVAL QUALITY BENCHMARK — NDCG / Recall / MRR\n")
    sys.stderr.write("=" * 68 + "\n")
    sys.stderr.write(f"  route={route}  mode={mode}  top_k={top_k}\n")
    sys.stderr.write(f"  queries_evaluated={agg['query_count']}\n")
    sys.stderr.write("-" * 68 + "\n")
    sys.stderr.write(f"  NDCG@5     : {agg['ndcg@5']:.4f}\n")
    sys.stderr.write(f"  NDCG@10    : {agg['ndcg@10']:.4f}\n")
    sys.stderr.write(f"  MRR@5      : {agg['mrr@5']:.4f}\n")
    sys.stderr.write(f"  MRR@10     : {agg['mrr@10']:.4f}\n")
    sys.stderr.write(f"  Recall@10  : {agg['recall@10']:.4f}\n")
    sys.stderr.write("-" * 68 + "\n")
    sys.stderr.write("DATA COVERAGE\n")
    sys.stderr.write(f"  explicit_truth_count : {dia['explicit_truth_count']} / {dia['queries_evaluated']}\n")
    sys.stderr.write(f"  weak_label_count     : {dia['weak_label_count']}\n")
    sys.stderr.write(f"  retrieval_nonempty_rate: {dia['retrieval_nonempty_rate']}\n")
    sys.stderr.write(f"  entry_count_distinct : {dia['entry_count_distinct']}\n")
    sys.stderr.write(f"  routes_in_judgments  : {dia['routes_in_judgments']}\n")
    sys.stderr.write("=" * 68 + "\n")
    sys.stderr.write(LIMITATION_NOTE + "\n")
    sys.stderr.write("=" * 68 + "\n")


def write_json_report(out_path: str, per_query: List[Dict[str, Any]], meta: Dict[str, Any],
                      route: str, top_k: int, mode: str, judgments_path: str,
                      elapsed_seconds: float) -> None:
    payload = {
        "generated_at":   time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool":           "retrieval/eval/ndcg_benchmark.py",
        "elapsed_seconds": round(elapsed_seconds, 2),
        "config": {
            "route":   route,
            "top_k":   top_k,
            "mode":    mode,
            "judgments_file": judgments_path,
        },
        "aggregate":   meta["aggregate"],
        "diagnostics": meta["diagnostics"],
        "limitation_note": LIMITATION_NOTE,
        "per_query":   per_query,
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    sys.stderr.write(f"[ndcg-bench] report written to {out_path}\n")


def write_csv_report(out_path: str, per_query: List[Dict[str, Any]]) -> None:
    fieldnames = [
        "query", "ground_truth_route", "system_route", "system_intent",
        "has_explicit_truth", "weak_label_used",
        "relevant_id_count", "graded_count", "retrieved_count",
        "entryCount", "candidateCount", "effectiveMode", "hasEmbeddings",
        "ndcg@5", "ndcg@10", "mrr@5", "mrr@10", "recall@10", "error",
    ]
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for q in per_query:
            row = {k: q.get(k, "") for k in fieldnames if k in q}
            m = q.get("metrics", {})
            for k in ("ndcg@5", "ndcg@10", "mrr@5", "mrr@10", "recall@10"):
                row[k] = m.get(k, "")
            w.writerow(row)
    sys.stderr.write(f"[ndcg-bench] csv written to {out_path}\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="NDCG/Recall/MRR benchmark for the shared-memory retrieval pipeline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python retrieval/eval/ndcg_benchmark.py\n"
            "  python retrieval/eval/ndcg_benchmark.py --route auto --top-k 10\n"
            "  python retrieval/eval/ndcg_benchmark.py --csv\n"
        ),
    )
    p.add_argument("--judgments", "-j", default="judgments.jsonl",
                   help="JSONL judgments filename (under retrieval/eval/). Default: judgments.jsonl")
    p.add_argument("--route", default="auto",
                   help="System route to benchmark (default: auto — weighted fusion)")
    p.add_argument("--top-k", type=int, default=10)
    p.add_argument("--mode", default="hybrid", choices=("bm25", "dense", "hybrid", "auto"))
    p.add_argument("--output", "-o", default="ndcg-baseline.json",
                   help="Output JSON filename (under retrieval/eval/). Default: ndcg-baseline.json")
    p.add_argument("--csv", action="store_true",
                   help="Also emit per-query CSV (ndcg-per-query.csv)")
    return p


def main() -> None:
    args = build_arg_parser().parse_args()

    judgments_path = os.path.join(_SCRIPT_DIR, args.judgments)
    if not os.path.exists(judgments_path):
        sys.stderr.write(f"[ndcg-bench] judgments file not found: {judgments_path}\n")
        sys.exit(1)

    judgments = load_judgments(judgments_path)
    if not judgments:
        sys.stderr.write(f"[ndcg-bench] no judgments loaded from {judgments_path}\n")
        sys.exit(1)

    sys.stderr.write(f"[ndcg-bench] loaded {len(judgments)} judgments from {judgments_path}\n")
    sys.stderr.write(f"[ndcg-bench] route={args.route} mode={args.mode} top_k={args.top_k}\n")
    sys.stderr.write("[ndcg-bench] loading semantic_search module...\n")
    sm = load_semantic_search()

    start = time.time()
    per_query, meta = run_benchmark(judgments, sm, args.route, args.top_k, args.mode)
    elapsed = time.time() - start

    print_report(per_query, meta, args.route, args.top_k, args.mode)
    sys.stderr.write(f"\n[ndcg-bench] benchmark complete in {elapsed:.2f}s\n")

    out_path = os.path.join(_SCRIPT_DIR, args.output)
    write_json_report(out_path, per_query, meta, args.route, args.top_k, args.mode,
                      judgments_path, elapsed)

    if args.csv:
        write_csv_report(os.path.join(_SCRIPT_DIR, "ndcg-per-query.csv"), per_query)


if __name__ == "__main__":
    main()
