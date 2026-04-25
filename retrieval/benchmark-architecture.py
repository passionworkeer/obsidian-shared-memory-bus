"""
Lightweight retrieval benchmark for the shared memory architecture.

The goal is not to prove model quality in isolation. It is to catch regressions
in the local memory stack after schema, adapter, or ranking changes.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List


ROOT = Path(os.environ.get("AI_MEMORY_ROOT", Path(__file__).resolve().parent))
SEARCH_SCRIPT = ROOT / "semantic_search.py"
PYTHON = os.environ.get("AI_MEMORY_PYTHON") or sys.executable or "python"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


DEFAULT_CASES = [
    {
        "name": "openclaw-blackboard",
        "query": "openclaw blackboard task state",
        "expected": ["blackboard", "task", "openclaw"],
    },
    {
        "name": "openclaw-run-ledger",
        "query": "openclaw subagent run model status",
        "expected": ["run", "model", "status"],
    },
    {
        "name": "claude-session-memory",
        "query": "claude session memory snapshot",
        "expected": ["session", "claude"],
    },
    {
        "name": "shared-durable-signals",
        "query": "durable shared inbox preference workflow",
        "expected": ["preference", "workflow", "shared"],
    },
    {
        "name": "watchdog-memory-layers",
        "query": "memory layers watchdog auto dream",
        "expected": ["memory", "dream", "layer"],
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark retrieval regressions for the shared memory stack")
    parser.add_argument("--top-k", type=int, default=5, help="Top K results to inspect")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON only")
    return parser.parse_args()


def run_search(query: str, top_k: int) -> Dict[str, object]:
    command = [PYTHON, str(SEARCH_SCRIPT), "--mode", "hybrid", "--top-k", str(top_k), "--json", query]
    result = subprocess.run(
        command,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        env=os.environ.copy(),
    )
    if result.returncode != 0:
        return {
            "ok": False,
            "stderr": result.stderr,
            "stdout": result.stdout,
            "results": [],
        }
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return {
            "ok": False,
            "stderr": f"invalid-json: {error}",
            "stdout": result.stdout,
            "results": [],
        }
    return {
        "ok": True,
        "payload": payload,
        "results": payload.get("results", []),
    }


def score_case(case: Dict[str, object], top_k: int) -> Dict[str, object]:
    response = run_search(str(case["query"]), top_k)
    results = response.get("results", [])
    combined_text = " ".join(
        f"{row.get('title', '')} {row.get('excerpt', '')}".lower()
        for row in results
    )
    expected = [token.lower() for token in case.get("expected", [])]
    hits = sum(1 for token in expected if token in combined_text)
    score = hits / max(1, len(expected))
    return {
        "name": case["name"],
        "query": case["query"],
        "ok": response["ok"],
        "score": round(score, 3),
        "matched": hits,
        "expectedCount": len(expected),
        "top": [
            {
                "id": row.get("id"),
                "title": row.get("title"),
                "tool": row.get("tool"),
                "scope": row.get("scope"),
                "taskState": row.get("taskState"),
                "sources": row.get("sources"),
            }
            for row in results[:top_k]
        ],
        "error": None if response["ok"] else response.get("stderr") or "search-failed",
    }


def main() -> None:
    args = parse_args()
    reports = [score_case(case, args.top_k) for case in DEFAULT_CASES]
    overall = sum(report["score"] for report in reports) / max(1, len(reports))
    payload = {
        "cases": reports,
        "averageScore": round(overall, 3),
        "caseCount": len(reports),
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    print(f"Average score: {payload['averageScore']}")
    for report in reports:
        print(f"- {report['name']}: {report['score']} ({report['matched']}/{report['expectedCount']})")
        if report["error"]:
            print(f"  error: {report['error']}")
            continue
        for row in report["top"]:
            title = row.get("title") or "(untitled)"
            tool = row.get("tool") or "unknown"
            print(f"  [{tool}] {title}")


if __name__ == "__main__":
    main()
