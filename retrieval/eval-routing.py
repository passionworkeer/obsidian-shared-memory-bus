#!/usr/bin/env python3
"""
Query routing evaluation harness.

Loads frozen query judgments, runs each query through all route profiles,
computes NDCG@K and MRR@K, and outputs recommended weight settings.

Usage:
    python eval-routing.py --judgments eval/judgments.jsonl --output eval/results.json
    python eval-routing.py --judgments eval/judgments.jsonl --recommend
    python eval-routing.py --sweep

Exit codes:
    0 - evaluation completed (results written or recommendations printed)
    1 - no judgments file found or other error
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time as _time_module
from collections import defaultdict
from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

# Resolve script directory for reliable relative imports
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _SCRIPT_DIR)


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def dcg_at_k(relevances: List[float], k: int) -> float:
    return sum(r / math.log2(i + 2) for i, r in enumerate(relevances[:k]))


def ndcg_at_k(relevances: List[float], k: int) -> float:
    ideal = sorted(relevances, reverse=True)
    dcg = dcg_at_k(relevances, k)
    idcg = dcg_at_k(ideal, k)
    if idcg == 0:
        return 0.0
    return dcg / idcg


def mrr_at_k(relevances: List[float], k: int) -> float:
    """Mean Reciprocal Rank: 1/rank of first relevant item, 0 if none in top K."""
    for i, r in enumerate(relevances[:k]):
        if r > 0:
            return 1.0 / (i + 1)
    return 0.0


# ---------------------------------------------------------------------------
# Judgment loading
# ---------------------------------------------------------------------------

def load_judgments(path: str) -> List[Dict[str, Any]]:
    """Load judgment file: list of {query, route, relevant_ids:[], relevance_scores:{}}."""
    if not os.path.exists(path):
        return []
    judgments = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                judgments.append(json.loads(line))
            except json.JSONDecodeError as exc:
                sys.stderr.write(f"[eval-routing] skip line {lineno}: {exc}\n")
    return judgments


def exit_no_judgments(path: str) -> None:
    msg = (
        f"No judgments file found at: {path}\n"
        "\n"
        "Create a judgments file with one JSON object per line:\n"
        "  {\"query\": \"my code style preferences\",\n"
        "   \"route\": \"durable\",\n"
        "   \"relevant_ids\": [\"id1\", \"id2\"],\n"
        "   \"relevance_scores\": {\"id1\": 3, \"id2\": 1}}\n"
        "\n"
        "Fields:\n"
        "  query          (required) natural-language query string\n"
        "  route          (required) ground-truth route hint (\"durable\", \"task\", etc.)\n"
        "  relevant_ids   (optional) set of IDs that are relevant (binary relevance)\n"
        "  relevance_scores (optional) dict of {id: grade} for graded relevance (higher = more relevant)\n"
        "\n"
        "A sample file is provided at: retrieval/eval/judgments-sample.jsonl\n"
    )
    sys.stderr.write(msg + "\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Semantic-search module loading (lazy, cached)
# ---------------------------------------------------------------------------

_semantic_search_module: Optional[Any] = None


def load_semantic_search() -> Any:
    global _semantic_search_module
    if _semantic_search_module is not None:
        return _semantic_search_module

    import importlib.util

    search_path = os.path.join(_SCRIPT_DIR, "semantic_search.py")
    spec = importlib.util.spec_from_file_location("semantic_search", search_path)
    if spec is None or spec.loader is None:
        sys.exit("[eval-routing] error: could not create module spec for semantic_search.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        sys.exit(f"[eval-routing] error loading semantic_search.py: {exc}")
    _semantic_search_module = module
    return module


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

# All route profiles to evaluate
ALL_ROUTES = ["auto", "mixed", "durable", "task", "recent", "reference"]


def build_relevances(
    retrieved: List[Dict[str, Any]],
    relevant_ids: set,
    graded: Dict[str, float],
) -> List[float]:
    """Build a relevance grade list for the first 10 retrieved results."""
    relevances: List[float] = []
    for r in retrieved:
        rid = str(r.get("id") or r.get("record_id", ""))
        if graded and rid in graded:
            relevances.append(float(graded[rid]))
        elif rid in relevant_ids:
            relevances.append(1.0)
        else:
            relevances.append(0.0)
    # Pad to 10 so sweep comparisons stay fair
    while len(relevances) < 10:
        relevances.append(0.0)
    return relevances


def run_evaluation(
    judgments: List[Dict[str, Any]],
    semantic_search_module: Any,
    routes: Optional[List[str]] = None,
    top_k: int = 10,
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Run evaluation across all judgments and routes.

    Returns (summary, errors) where summary maps route -> metric list dict
    and errors is a list of error records.
    """
    sm = semantic_search_module
    routes = routes or ALL_ROUTES

    results: Dict[str, Dict[str, List[float]]] = {
        r: defaultdict(list) for r in routes
    }
    errors: List[Dict[str, Any]] = []

    workspace_root = os.environ.get("AI_MEMORY_OBSIDIAN_VAULT", "")

    for i, j in enumerate(judgments):
        query = j.get("query", "")
        if not query:
            continue

        relevant_ids = set(j.get("relevant_ids", []))
        graded = j.get("relevance_scores", {})

        for route in routes:
            try:
                payload = {
                    "query": query,
                    "route": route,
                    "top_k": top_k,
                    "mode": "hybrid",
                    "workspace_root": workspace_root,
                }

                resp = sm.execute_search(payload)
                retrieved = resp.get("results", [])

                relevances = build_relevances(retrieved, relevant_ids, graded)

                results[route]["ndcg@5"].append(ndcg_at_k(relevances, 5))
                results[route]["ndcg@10"].append(ndcg_at_k(relevances, 10))
                results[route]["mrr@5"].append(mrr_at_k(relevances, 5))
                results[route]["mrr@10"].append(mrr_at_k(relevances, 10))

                hits = sum(1 for r in relevances[:top_k] if r > 0)
                recall = hits / max(len(relevant_ids), 1)
                results[route]["recall@10"].append(min(recall, 1.0))

                # Optional per-query intent correctness
                inferred_intent = resp.get("queryIntent", "")
                ground_route = str(j.get("route", "")).lower()
                intent_correct = 1.0 if inferred_intent == ground_route else 0.0
                results[route]["intent_acc"].append(intent_correct)

            except Exception as exc:
                errors.append({"query": query, "route": route, "error": str(exc)})

    # Aggregate
    summary: Dict[str, Dict[str, Any]] = {}
    for route in routes:
        r = results[route]
        n = len(r.get("ndcg@5", []))
        if n == 0:
            summary[route] = {"error": "no results", "queries": 0}
            continue

        def mean(key: str) -> float:
            vals = r.get(key, [])
            return round(sum(vals) / len(vals), 4) if vals else 0.0

        summary[route] = {
            "queries": n,
            "ndcg@5": mean("ndcg@5"),
            "ndcg@10": mean("ndcg@10"),
            "mrr@5": mean("mrr@5"),
            "mrr@10": mean("mrr@10"),
            "recall@10": mean("recall@10"),
            "intent_acc": mean("intent_acc"),
        }

    return summary, errors


# ---------------------------------------------------------------------------
# Weight sweep
# ---------------------------------------------------------------------------

def _merge_weights(
    base_weights: Dict[str, Dict[str, float]],
    perturbations: Dict[str, Dict[str, float]],
) -> Dict[str, Dict[str, float]]:
    """Return a new weight table with all specified perturbations applied."""
    result = deepcopy(base_weights)
    for table_name, delta in perturbations.items():
        if table_name in result:
            result[table_name] = {k: v + delta.get(k, 0.0) for k, v in result[table_name].items()}
    return result


def _weight_delta(weight: float, pct: float) -> float:
    """Compute a multiplicative delta of ±pct around a weight."""
    return weight * (pct / 100.0)


def sweep_weights(
    judgments: List[Dict[str, Any]],
    semantic_search_module: Any,
    base_weights: Dict[str, Dict[str, Dict[str, float]]],
    sweep_pct: float = 10.0,
) -> Dict[str, Any]:
    """
    Try perturbing each weight table by ±sweep_pct and measure impact on NDCG@5.

    Returns a report of every perturbation that improved the baseline.
    """
    # Baseline evaluation
    sm = semantic_search_module
    baseline_summary, _ = run_evaluation(judgments, sm)
    baseline_ndcg5 = {
        r: m["ndcg@5"] for r, m in baseline_summary.items() if "error" not in m
    }
    overall_baseline = sum(baseline_ndcg5.values()) / max(len(baseline_ndcg5), 1)

    sys.stderr.write(
        f"[sweep] baseline overall NDCG@5: {overall_baseline:.4f}\n"
    )

    improvements: List[Dict[str, Any]] = []
    tables = list(base_weights.keys())
    perturbations = [-sweep_pct, sweep_pct]

    for table_name in tables:
        for pct in perturbations:
            perturbed = _merge_weights(
                base_weights,
                {table_name: {k: _weight_delta(v, pct) for k, v in base_weights[table_name].items()}},
            )
            # Apply to the module's live weight tables via monkey-patch helpers
            # if they are exposed, otherwise fall back to running the query route
            # function with modified weights.  Because execute_search reads the
            # module-level tables directly, we temporarily replace them.
            orig_tables: Dict[str, Any] = {}
            for attr_name, attr in [
                ("layer_weights", sm.layer_weights if hasattr(sm, "layer_weights") else None),
                ("scope_weights", sm.scope_weights if hasattr(sm, "scope_weights") else None),
                ("source_kind_weights", sm.source_kind_weights if hasattr(sm, "source_kind_weights") else None),
                ("freshness_weights", sm.freshness_weights if hasattr(sm, "freshness_weights") else None),
            ]:
                if attr is None:
                    continue
                orig_tables[attr_name] = attr

            # Temporarily patch module-level weight tables
            for attr_name, table in perturbed.items():
                if hasattr(sm, attr_name):
                    orig_tables[attr_name] = getattr(sm, attr_name)
                    setattr(sm, attr_name, table)

            # Evaluate
            summary, _ = run_evaluation(judgments, sm)

            # Restore
            for attr_name, table in orig_tables.items():
                setattr(sm, attr_name, table)

            sweep_ndcg5 = {r: m["ndcg@5"] for r, m in summary.items() if "error" not in m}
            sweep_overall = sum(sweep_ndcg5.values()) / max(len(sweep_ndcg5), 1)
            delta = sweep_overall - overall_baseline

            direction = "+" if pct > 0 else "-"
            label = f"{table_name} {direction}{sweep_pct:.0f}%"
            sys.stderr.write(f"[sweep] {label}: NDCG@5={sweep_overall:.4f} (delta={delta:+.4f})\n")

            if delta > 0:
                improvements.append(
                    {
                        "perturbation": label,
                        "table": table_name,
                        "pct_change": pct,
                        "baseline_ndcg5": overall_baseline,
                        "sweep_ndcg5": sweep_overall,
                        "delta": round(delta, 6),
                        "per_route": {r: round(v, 4) for r, v in sweep_ndcg5.items()},
                    }
                )

    return {
        "baseline_ndcg5": round(overall_baseline, 4),
        "improvements": improvements,
    }


# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------

def recommend_weights(summary: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    Given per-route metrics, recommend the best overall route and
    the best route per individual metric.
    """
    best_by_metric: Dict[str, Dict[str, Any]] = {}
    for metric in ["ndcg@5", "ndcg@10", "mrr@5", "recall@10", "intent_acc"]:
        best_route, best_score = None, -1.0
        for route, metrics in summary.items():
            if "error" in metrics:
                continue
            score = metrics.get(metric, 0.0)
            if score > best_score:
                best_route, best_score = route, score
        if best_route is not None:
            best_by_metric[metric] = {"route": best_route, "score": round(best_score, 4)}

    # Overall composite score (weighted average of key metrics)
    overall_scores: Dict[str, float] = {}
    for route, metrics in summary.items():
        if "error" in metrics:
            continue
        overall_scores[route] = (
            metrics["ndcg@5"] * 0.30
            + metrics["ndcg@10"] * 0.25
            + metrics["mrr@5"] * 0.20
            + metrics["recall@10"] * 0.15
            + metrics["intent_acc"] * 0.10
        )
    if not overall_scores:
        return {"best_overall": {"route": "n/a", "score": 0.0}, "best_by_metric": {}}
    best_overall_route, best_overall_score = max(overall_scores.items(), key=lambda kv: kv[1])

    return {
        "best_overall": {
            "route": best_overall_route,
            "score": round(best_overall_score, 4),
        },
        "best_by_metric": best_by_metric,
    }


def print_summary(summary: Dict[str, Dict[str, Any]], errors: List[Dict[str, Any]]) -> None:
    header = f"{'Route':<12} {'N@5':>6} {'N@10':>6} {'M@5':>6} {'M@10':>6} {'R@10':>6} {'Acc':>6} {'N':>4}"
    sys.stderr.write("\n" + "=" * 62 + "\n")
    sys.stderr.write("QUERY ROUTING EVALUATION SUMMARY\n")
    sys.stderr.write("=" * 62 + "\n")
    sys.stderr.write(header + "\n")
    sys.stderr.write("-" * 62 + "\n")
    for route in ALL_ROUTES:
        m = summary.get(route, {})
        if "error" in m:
            sys.stderr.write(f"{route:<12}  ERROR: {m['error']}\n")
            continue
        sys.stderr.write(
            f"{route:<12} "
            f"{m.get('ndcg@5', 0):>6.4f} "
            f"{m.get('ndcg@10', 0):>6.4f} "
            f"{m.get('mrr@5', 0):>6.4f} "
            f"{m.get('mrr@10', 0):>6.4f} "
            f"{m.get('recall@10', 0):>6.4f} "
            f"{m.get('intent_acc', 0):>6.4f} "
            f"{m.get('queries', 0):>4}\n"
        )
    sys.stderr.write("=" * 62 + "\n")
    if errors:
        sys.stderr.write(f"\n{len(errors)} error(s) occurred during evaluation:\n")
        for e in errors[:5]:
            sys.stderr.write(f"  query={e['query'][:60]!r} route={e['route']} -> {e['error']}\n")
        if len(errors) > 5:
            sys.stderr.write(f"  ... and {len(errors) - 5} more\n")


def print_recommendations(rec: Dict[str, Any]) -> None:
    sys.stderr.write("\n" + "=" * 62 + "\n")
    sys.stderr.write("WEIGHT RECOMMENDATIONS\n")
    sys.stderr.write("=" * 62 + "\n")
    sys.stderr.write(f"  Best overall route: {rec['best_overall']['route']} "
                     f"(score={rec['best_overall']['score']:.4f})\n\n")
    sys.stderr.write("  Best route per metric:\n")
    for metric, info in rec["best_by_metric"].items():
        sys.stderr.write(f"    {metric:<15} -> {info['route']} (score={info['score']:.4f})\n")
    sys.stderr.write("=" * 62 + "\n")


# ---------------------------------------------------------------------------
# Base weight tables (mirrors semantic-search.py)
# ---------------------------------------------------------------------------

BASE_WEIGHTS: Dict[str, Dict[str, Dict[str, float]]] = {
    "layer_weights": {
        "mixed": {"durable": 1.0, "session": 1.0, "event": 0.96, "task": 1.0},
        "durable": {"durable": 1.35, "session": 0.94, "event": 0.82, "task": 0.72},
        "task": {"durable": 0.76, "session": 0.92, "event": 0.84, "task": 1.35},
        "recent": {"durable": 0.8, "session": 1.16, "event": 1.35, "task": 0.96},
        "reference": {"durable": 1.18, "session": 0.92, "event": 0.82, "task": 0.9},
    },
    "scope_weights": {
        "mixed": {"user": 1.06, "feedback": 1.04, "project": 1.03, "reference": 1.03, "summary": 1.0, "task": 0.98, "run": 0.98},
        "durable": {"user": 1.22, "feedback": 1.18, "project": 1.1, "reference": 1.12, "summary": 0.88, "task": 0.76, "run": 0.72},
        "task": {"user": 0.88, "feedback": 0.94, "project": 1.08, "reference": 0.96, "summary": 0.92, "task": 1.2, "run": 1.24},
        "recent": {"user": 0.92, "feedback": 0.96, "project": 1.0, "reference": 0.94, "summary": 1.06, "task": 1.02, "run": 1.04},
        "reference": {"user": 0.92, "feedback": 0.96, "project": 1.14, "reference": 1.28, "summary": 0.9, "task": 0.9, "run": 0.88},
    },
    "source_kind_weights": {
        "mixed": {"writeback": 1.04, "session": 1.0, "hook": 0.98, "blackboard": 1.0, "run": 1.02, "cron": 1.01},
        "durable": {"writeback": 1.12, "session": 1.02, "hook": 0.9, "blackboard": 0.84, "run": 0.82, "cron": 0.8},
        "task": {"writeback": 0.86, "session": 0.96, "hook": 0.88, "blackboard": 1.16, "run": 1.18, "cron": 1.12},
        "recent": {"writeback": 0.96, "session": 1.08, "hook": 1.14, "blackboard": 1.0, "run": 1.02, "cron": 1.04},
        "reference": {"writeback": 1.06, "session": 0.98, "hook": 0.9, "blackboard": 0.9, "run": 0.9, "cron": 0.9},
    },
    "freshness_weights": {
        "mixed": {"hot": 1.02, "warm": 1.0, "cold": 0.98, "unknown": 1.0},
        "durable": {"hot": 1.01, "warm": 1.0, "cold": 1.0, "unknown": 1.0},
        "task": {"hot": 1.1, "warm": 1.04, "cold": 0.96, "unknown": 0.98},
        "recent": {"hot": 1.12, "warm": 1.05, "cold": 0.92, "unknown": 0.96},
        "reference": {"hot": 1.0, "warm": 1.0, "cold": 0.99, "unknown": 1.0},
    },
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Query routing evaluation harness for the shared memory retrieval pipeline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python eval-routing.py --judgments eval/judgments.jsonl --output eval/results.json\n"
            "  python eval-routing.py --judgments eval/judgments.jsonl --recommend\n"
            "  python eval-routing.py --judgments eval/judgments.jsonl --sweep\n"
        ),
    )
    parser.add_argument(
        "--judgments", "-j",
        default="eval/judgments.jsonl",
        help="Path to the JSONL judgments file (default: eval/judgments.jsonl)",
    )
    parser.add_argument(
        "--output", "-o",
        help="Write full JSON results to this file",
    )
    parser.add_argument(
        "--recommend", "-r",
        action="store_true",
        help="Print recommendations after evaluation and exit",
    )
    parser.add_argument(
        "--sweep", "-s",
        action="store_true",
        help="Run weight sweep (try ±10%% perturbations on each weight table)",
    )
    parser.add_argument(
        "--sweep-pct",
        type=float,
        default=10.0,
        help="Perturbation percentage for weight sweep (default: 10.0)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="Number of results to retrieve per query (default: 10)",
    )
    parser.add_argument(
        "--ci",
        action="store_true",
        help=(
            "CI mode: compare NDCG/MRR against last evaluation baseline in results.json. "
            "Exit 1 if regression > 5%% (warning), exit 2 if regression > 10%% (hard failure). "
            "Always writes results to retrieval/eval/results.json."
        ),
    )
    return parser


def load_baseline_results(results_json_path: str) -> Optional[Dict[str, Any]]:
    """Load previous evaluation results to compare against in CI mode."""
    if not os.path.exists(results_json_path):
        return None
    try:
        with open(results_json_path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def compute_regression(
    current: Dict[str, Dict[str, Any]],
    baseline: Dict[str, Dict[str, Any]],
) -> Dict[str, float]:
    """Compute NDCG@5 delta per route (current - baseline)."""
    deltas: Dict[str, float] = {}
    for route, metrics in current.items():
        if "error" in metrics:
            continue
        base_metrics = baseline.get(route, {})
        current_ndcg5 = metrics.get("ndcg@5", 0.0)
        baseline_ndcg5 = base_metrics.get("ndcg@5", 0.0)
        deltas[route] = round(current_ndcg5 - baseline_ndcg5, 6)
    return deltas


def check_ci_regression(
    current_summary: Dict[str, Dict[str, Any]],
    baseline_results: Dict[str, Any],
) -> Tuple[int, List[str]]:
    """
    Check if current results regress from baseline.
    Returns (exit_code, messages).
    exit_code: 0 = no regression, 1 = warning (>5%), 2 = hard failure (>10%)
    """
    baseline_summary = baseline_results.get("summary", {})
    deltas = compute_regression(current_summary, baseline_summary)

    messages: List[str] = []
    worst_delta = 0.0
    worst_route = ""
    has_regression = False
    hard_failure = False

    for route, delta in deltas.items():
        if delta < worst_delta:
            worst_delta = delta
            worst_route = route
        if delta < -0.05:
            has_regression = True
            messages.append(
                f"  WARNING: {route} NDCG@5 regressed by {abs(delta):.4f} "
                f"(baseline={baseline_summary.get(route, {}).get('ndcg@5', 0.0):.4f}, "
                f"current={current_summary[route]['ndcg@5']:.4f})"
            )
        if delta < -0.10:
            hard_failure = True
            messages.append(
                f"  FAILURE: {route} NDCG@5 regressed by {abs(delta):.4f} > 10% "
                f"(baseline={baseline_summary.get(route, {}).get('ndcg@5', 0.0):.4f}, "
                f"current={current_summary[route]['ndcg@5']:.4f})"
            )

    if hard_failure:
        return 2, [
            f"[eval-routing CI] Hard failure: regression > 10% detected on route '{worst_route}'",
            *messages,
        ]
    if has_regression:
        return 1, [
            f"[eval-routing CI] Warning: regression > 5% detected (worst: {worst_route}={worst_delta:+.4f})",
            *messages,
        ]
    return 0, [f"[eval-routing CI] No significant regression. Worst delta: {worst_route}={worst_delta:+.4f}"]


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    # Resolve judgments path relative to this script's directory
    judgments_path = os.path.join(_SCRIPT_DIR, args.judgments)
    if not os.path.exists(judgments_path):
        exit_no_judgments(judgments_path)

    judgments = load_judgments(judgments_path)
    if not judgments:
        exit_no_judgments(judgments_path)

    sys.stderr.write(f"[eval-routing] loaded {len(judgments)} judgments from {judgments_path}\n")

    sm = load_semantic_search()

    start = _time_module.time()
    summary, errors = run_evaluation(judgments, sm, top_k=args.top_k)
    elapsed = _time_module.time() - start

    print_summary(summary, errors)

    sweep_report: Dict[str, Any] = {}
    if args.sweep:
        sys.stderr.write(f"\n[sweep] starting weight perturbation sweep (±{args.sweep_pct}%%)...\n")
        sweep_report = sweep_weights(judgments, sm, BASE_WEIGHTS, sweep_pct=args.sweep_pct)

    rec = recommend_weights(summary)
    if args.recommend or args.sweep:
        print_recommendations(rec)

    sys.stderr.write(f"\n[eval-routing] evaluation complete in {elapsed:.2f}s\n")

    # CI regression check
    ci_exit_code = 0
    if args.ci:
        baseline_path = os.path.join(_SCRIPT_DIR, "eval/results.json")
        baseline_data = load_baseline_results(baseline_path)
        if baseline_data:
            ci_code, ci_messages = check_ci_regression(summary, baseline_data)
            ci_exit_code = ci_code
            for msg in ci_messages:
                sys.stderr.write(msg + "\n")
        else:
            sys.stderr.write(
                f"[eval-routing CI] No baseline results found at {baseline_path} — "
                "skipping regression check (first run or file missing)\n"
            )
        # CI always writes to the canonical path
        args.output = "eval/results.json"

    output: Dict[str, Any] = {
        "generated_at": _time_module.strftime("%Y-%m-%dT%H:%M:%SZ", _time_module.gmtime()),
        "elapsed_seconds": round(elapsed, 2),
        "judgments_file": judgments_path,
        "judgment_count": len(judgments),
        "top_k": args.top_k,
        "summary": summary,
        "recommendations": rec,
    }
    if errors:
        output["errors"] = errors
    if sweep_report:
        output["sweep"] = sweep_report

    if args.output:
        out_path = os.path.join(_SCRIPT_DIR, args.output)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        sys.stderr.write(f"[eval-routing] results written to {out_path}\n")
    else:
        # Default: write to eval/results.jsonl next to the judgments file
        default_out = os.path.join(
            os.path.dirname(judgments_path) or ".", "results.json"
        )
        with open(default_out, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        sys.stderr.write(f"[eval-routing] results written to {default_out}\n")

    if args.ci and ci_exit_code > 0:
        sys.exit(ci_exit_code)


if __name__ == "__main__":
    main()
