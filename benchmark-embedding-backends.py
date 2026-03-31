"""
Small, quota-aware benchmark for shared-memory embedding backends.

This script:
1. Builds a tiny canary vault from the current shared structured memory.
2. Rebuilds embeddings with one or more backends.
3. Runs the same search queries against each backend.
4. Prints a compact JSON report.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List


ROOT = Path(os.environ.get("AI_MEMORY_ROOT", Path(__file__).resolve().parent))
GENERATE_SCRIPT = ROOT / "generate-embeddings.js"
SEARCH_SCRIPT = ROOT / "semantic-search.py"
PYTHON = os.environ.get("AI_MEMORY_PYTHON") or sys.executable or "python"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark shared-memory embedding backends on a tiny canary vault")
    parser.add_argument("--sample-size", type=int, default=12, help="Number of structured rows to sample")
    parser.add_argument("--delay-ms", type=int, default=4000, help="Delay between remote embedding requests")
    parser.add_argument("--model", default="Qwen/Qwen3-Embedding-0.6B", help="Remote embedding model to benchmark")
    parser.add_argument("--api-key-env", default="AI_MEMORY_EMBED_API_KEY", help="Environment variable containing the remote embedding API key")
    parser.add_argument(
        "--queries",
        nargs="+",
        default=["shared memory watchdog", "claude mem plugin", "openclaw blackboard"],
        help="Queries to compare across backends",
    )
    return parser.parse_args()


def tokenize(text: str) -> List[str]:
    return re.findall(r"[a-z0-9\u4e00-\u9fff_./:-]{2,}", (text or "").lower())


def resolve_vault_root() -> Path:
    for env_key in ("AI_MEMORY_OBSIDIAN_VAULT", "OBSIDIAN_VAULT_ROOT"):
        candidate = os.environ.get(env_key, "").strip()
        if candidate and Path(candidate).is_dir():
            return Path(candidate)

    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        config_path = Path(appdata) / "obsidian" / "obsidian.json"
        if config_path.is_file():
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
                records = []
                for vault in (config.get("vaults") or {}).values():
                    path = str(vault.get("path", "")).strip()
                    if not path:
                        continue
                    candidate = Path(path)
                    if not candidate.is_dir():
                        continue
                    records.append(
                        {
                            "path": candidate,
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

    desktop_vault = Path.home() / "Desktop" / "Obsidian Vault"
    if desktop_vault.is_dir():
        return desktop_vault
    return Path.home() / "Documents" / "Obsidian Vault"


VAULT_ROOT = resolve_vault_root()


def load_sample_rows(sample_size: int, queries: List[str]) -> List[str]:
    structured_dir = VAULT_ROOT / "00-System" / "ai-memory" / "structured"
    query_tokens = set()
    for query in queries:
        query_tokens.update(tokenize(query))

    candidates: List[tuple[int, str]] = []
    for file_name in ["claude-code.jsonl", "openclaw.jsonl", "shared-inbox.jsonl"]:
        path = structured_dir / file_name
        if not path.exists():
            continue
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                raw = line.rstrip("\n")
                if not raw.strip():
                    continue
                try:
                    payload = json.loads(raw)
                except Exception:
                    payload = {"content": raw}
                haystack = " ".join(
                    str(payload.get(field, ""))
                    for field in ("title", "content", "tool", "project", "agent", "type")
                )
                score = sum(1 for token in tokenize(haystack) if token in query_tokens)
                if "openclaw" in haystack.lower():
                    score += 2
                if "memory" in haystack.lower() or "watchdog" in haystack.lower():
                    score += 1
                candidates.append((score, raw))

    if not candidates:
        return []

    ranked = sorted(candidates, key=lambda item: item[0], reverse=True)
    rows: List[str] = []
    seen = set()
    for _, raw in ranked:
        if raw in seen:
            continue
        rows.append(raw)
        seen.add(raw)
        if len(rows) >= sample_size:
            break
    return rows


def build_canary_vault(rows: List[str]) -> Path:
    (ROOT / "cache").mkdir(parents=True, exist_ok=True)
    canary_root = Path(tempfile.mkdtemp(prefix="ai-memory-bench-", dir=str(ROOT / "cache")))
    structured_dir = canary_root / "00-System" / "ai-memory" / "structured"
    structured_dir.mkdir(parents=True, exist_ok=True)
    (structured_dir / "canary.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    return canary_root


def run_command(command: List[str], env: Dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def benchmark_backend(
    canary_root: Path,
    backend: str,
    model: str,
    delay_ms: int,
    queries: List[str],
    api_key_env: str,
) -> Dict[str, object]:
    env = os.environ.copy()
    env["AI_MEMORY_OBSIDIAN_VAULT"] = str(canary_root)
    env["AI_MEMORY_EMBED_BACKEND"] = backend
    if backend in {"openai", "openai-compatible"}:
        api_key = env.get(api_key_env, "").strip()
        if not api_key:
            return {
                "backend": backend,
                "generateExitCode": -1,
                "generateStdout": "",
                "generateStderr": f"missing api key env: {api_key_env}",
                "queries": [],
            }
        env["AI_MEMORY_EMBED_BASE_URL"] = "https://api-inference.modelscope.cn/v1"
        env["AI_MEMORY_EMBED_API_KEY"] = api_key
        env["AI_MEMORY_EMBED_MODEL"] = model
        env["AI_MEMORY_EMBED_REQUEST_DELAY_MS"] = str(delay_ms)
        env["AI_MEMORY_EMBED_BATCH_SIZE"] = "8"
    else:
        env.pop("AI_MEMORY_EMBED_BASE_URL", None)
        env.pop("AI_MEMORY_EMBED_API_KEY", None)
        env.pop("AI_MEMORY_EMBED_MODEL", None)
        env.pop("AI_MEMORY_EMBED_REQUEST_DELAY_MS", None)
        env.pop("AI_MEMORY_EMBED_BATCH_SIZE", None)

    generate = run_command(["node", str(GENERATE_SCRIPT), "--force"], env)
    result: Dict[str, object] = {
        "backend": backend,
        "generateExitCode": generate.returncode,
        "generateStdout": generate.stdout,
        "generateStderr": generate.stderr,
        "queries": [],
    }
    if generate.returncode != 0:
        return result

    query_results = []
    for query in queries:
        search = run_command(
            [PYTHON, str(SEARCH_SCRIPT), "--mode", "hybrid", "--top-k", "3", "--json", query],
            env,
        )
        payload = None
        if search.returncode == 0:
            try:
                payload = json.loads(search.stdout)
            except Exception:
                payload = None
        query_results.append(
            {
                "query": query,
                "exitCode": search.returncode,
                "payload": payload,
                "stderr": search.stderr,
            }
        )
    result["queries"] = query_results
    return result


def compact_summary(report: Dict[str, object]) -> Dict[str, object]:
    queries = []
    for item in report.get("queries", []):
        payload = item.get("payload") or {}
        top = []
        for row in payload.get("results", [])[:3]:
            top.append(
                {
                    "id": row.get("id"),
                    "title": row.get("title"),
                    "sources": row.get("sources"),
                }
            )
        queries.append(
            {
                "query": item.get("query"),
                "effectiveMode": payload.get("effectiveMode"),
                "fallbackReason": payload.get("fallbackReason"),
                "top": top,
            }
        )
    return {
        "backend": report.get("backend"),
        "generateExitCode": report.get("generateExitCode"),
        "queries": queries,
    }


def main() -> None:
    args = parse_args()
    rows = load_sample_rows(args.sample_size, args.queries)
    if not rows:
        raise SystemExit("No structured rows available for benchmarking.")

    canary_root = build_canary_vault(rows)
    try:
        raw_reports = [
            benchmark_backend(canary_root, "hash", args.model, args.delay_ms, args.queries, args.api_key_env),
            benchmark_backend(canary_root, "openai", args.model, args.delay_ms, args.queries, args.api_key_env),
        ]
        summaries = [compact_summary(report) for report in raw_reports]
        print(
            json.dumps(
                {
                    "sampleSize": len(rows),
                    "queries": args.queries,
                    "reports": summaries,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    finally:
        shutil.rmtree(canary_root, ignore_errors=True)


if __name__ == "__main__":
    main()
