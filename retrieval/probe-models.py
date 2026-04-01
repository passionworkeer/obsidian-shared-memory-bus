"""
Slow, low-cost probe for OpenAI-compatible embedding models.

Example:
  set AI_MEMORY_EMBED_API_KEY=...
  python probe-embedding-models.py ^
      --base-url https://api-inference.modelscope.cn/v1 ^
      --models Qwen/Qwen3-Embedding-0.6B Qwen/Qwen3-Embedding-4B ^
      --delay-seconds 6
"""

from __future__ import annotations

import argparse
import json
import os
import time
from typing import List

from openai import OpenAI


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe embedding models slowly via an OpenAI-compatible API")
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible base URL, e.g. https://api-inference.modelscope.cn/v1")
    parser.add_argument("--api-key-env", default="AI_MEMORY_EMBED_API_KEY", help="Environment variable name holding the API key")
    parser.add_argument("--delay-seconds", type=float, default=3.0, help="Sleep between requests to avoid burning quota too quickly")
    parser.add_argument("--text", default="hello shared memory probe", help="Short input text used for the probe")
    parser.add_argument("--models", nargs="+", required=True, help="One or more model IDs to probe")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise SystemExit(f"Missing API key in env var: {args.api_key_env}")

    client = OpenAI(base_url=args.base_url, api_key=api_key)
    results: List[dict] = []

    for index, model in enumerate(args.models):
        started = time.time()
        try:
            response = client.embeddings.create(
                model=model,
                input=args.text,
                encoding_format="float",
            )
            vector = response.data[0].embedding if response.data else []
            results.append(
                {
                    "model": model,
                    "ok": True,
                    "dim": len(vector),
                    "latencySec": round(time.time() - started, 2),
                }
            )
        except Exception as exc:
            results.append(
                {
                    "model": model,
                    "ok": False,
                    "error": str(exc),
                    "latencySec": round(time.time() - started, 2),
                }
            )

        if index < len(args.models) - 1 and args.delay_seconds > 0:
            time.sleep(args.delay_seconds)

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
