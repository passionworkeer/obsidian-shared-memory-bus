/**
 * embedding-worker-script.cjs
 * ----------------------------
 * Q-HIGH-1 step 2: 抽出共享 Python worker script template。
 * 这是一个 145 行的模板字面量 (原 embedding-worker-pool.cjs:446-591 buildWorkerScript 函数体),
 * 包含 sentence-transformers 预热 + EMBED / GEMINI_EMBED / PING / SHUTDOWN 四种 IPC。
 *
 * 抽离原因:
 *   1. embedding-worker-pool.cjs 658 → ~510 行
 *   2. Python 脚本与 Node pool 是两个职责 (一个是 IPC loop host, 一个是 Python 协议)
 *   3. per-call fallback (bus/embedding-provider-registry.js PR10 抽的
 *      PER_CALL_SENTENCE_TRANSFORMER_SCRIPT / PER_CALL_GEMINI_SCRIPT) 与本文件
 *      有可对照性,后续 PR11 step 3 可统一 source-of-truth
 *
 * 用法:
 *   const { buildWorkerScript } = require("./embedding-worker-script.cjs");
 *   await pool.initPool(pythonCmd, [..., "-c", buildWorkerScript()], env);
 */

"use strict";

/**
 * Return the Python bootstrap script that each pooled worker runs.
 * This script loads sentence-transformers once and then handles EMBED requests.
 *
 * @returns {string}
 */
function buildWorkerScript() {
  return `
import json
import sys
import os
import time
import re

# Redact API keys / bearer tokens from any string before it reaches stderr,
# which the parent forwards to process logs (project rule: secrets never enter
# memory files / logs). Gemini carries the key in the URL (?key=...).
def _redact(s):
    s = re.sub(r"([?&](?:api[_-]?key|key|access_token|sig)=)[^&\\s\\\"\\']+", r"\\1REDACTED", str(s))
    s = re.sub(r"(Bearer\\s+)[A-Za-z0-9_\\-\\.]{8,}", r"\\1REDACTED", s)
    return s

# Ensure unbuffered output so parent sees results immediately
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Warm up sentence-transformers — this is the expensive part we want to amortize
_model_cache = {}
_pending_pongs = []
import urllib.request
import urllib.error

# Build an explicit proxy opener — urllib auto-detection from env vars is unreliable
# when the Python process is spawned from Node.js on Windows (WinError 10061).
_proxy_opener = None
def get_proxy_opener():
    global _proxy_opener
    if _proxy_opener is not None:
        return _proxy_opener
    proxies = {}
    http_proxy = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or ""
    https_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""
    if http_proxy:
        proxies["http"] = http_proxy
    if https_proxy:
        proxies["https"] = https_proxy
    if proxies:
        _proxy_opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
    else:
        _proxy_opener = urllib.request.build_opener()
    return _proxy_opener

def get_model(name):
    if name not in _model_cache:
        from sentence_transformers import SentenceTransformer
        _model_cache[name] = SentenceTransformer(name)
    return _model_cache[name]

# Signal READY to parent process
sys.stdout.write(json.dumps({"type": "READY", "id": 0}) + "\\n")
sys.stdout.flush()

# IPC loop
_buffer = ""
while True:
    try:
        line = sys.stdin.readline()
    except EOFError:
        break
    if not line:
        break

    _buffer += line
    try:
        msg = json.loads(_buffer)
        _buffer = ""
    except json.JSONDecodeError:
        # Incomplete JSON — wait for more lines
        continue

    msg_type = msg.get("type", "")

    if msg_type == "EMBED":
        model_name = msg.get("model", "all-MiniLM-L6-v2")
        texts = msg.get("texts", [])
        try:
            model = get_model(model_name)
            vectors = model.encode(texts, show_progress_bar=False, convert_to_numpy=True)
            result = json.dumps({"type": "RESULT", "id": msg["id"], "data": [v.tolist() for v in vectors]})
        except Exception as exc:
            result = json.dumps({"type": "ERROR", "id": msg["id"], "error": str(exc)})
        sys.stdout.write(result + "\\n")
        sys.stdout.flush()

    elif msg_type == "GEMINI_EMBED":
        api_key = msg.get("apiKey", "")
        model_id = msg.get("geminiModel", "gemini-embedding-2")
        texts = msg.get("texts", [])
        results = []
        for text in texts:
            try:
                url = "https://generativelanguage.googleapis.com/v1beta/" + model_id + ":embedContent?key=" + api_key
                body_model = model_id.replace("models/", "")
                payload = json.dumps({"model": body_model, "content": {"parts": [{"text": text}]}}).encode("utf-8")
                sys.stderr.write("[gemini] url: " + _redact(url)[:120] + " body: " + _redact(str(payload))[:120] + "\\n")
                sys.stderr.flush()
                req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
                with get_proxy_opener().open(req, timeout=60) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
                parsed = json.loads(body)
                # Support both new format (gemini-embedding-2: {"embeddings":[{"values":[]}])
                # and legacy format (gemini-embedding-001: {"embedding":{"values":[]}})
                emb_list = parsed.get("embeddings") or []
                if emb_list:
                    vals = emb_list[0].get("values", [])
                    results.append(vals)
                else:
                    emb_obj = parsed.get("embedding") or {}
                    vals = emb_obj.get("values", []) if isinstance(emb_obj, dict) else []
                    results.append(vals if vals else None)
            except urllib.error.HTTPError as exc:
                err_body = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
                sys.stderr.write("[gemini] HTTPError " + str(exc.code) + " body: " + _redact(err_body)[:300] + "\\n")
                sys.stderr.flush()
                results.append(None)
            except Exception as exc:
                err_detail = str(exc)
                sys.stderr.write("[gemini] error: " + _redact(err_detail) + "\\n")
                sys.stderr.flush()
                results.append(None)
        ok_results = [r for r in results if r is not None]
        if ok_results:
            result = json.dumps({"type": "RESULT", "id": msg["id"], "data": results})
        else:
            result = json.dumps({"type": "ERROR", "id": msg["id"], "error": "gemini-embed-failed"})
        sys.stdout.write(result + "\\n")
        sys.stdout.flush()

    elif msg_type == "PING":
        pong = json.dumps({"type": "PONG", "id": msg.get("id", 0)})
        sys.stdout.write(pong + "\\n")
        sys.stdout.flush()

    elif msg_type == "SHUTDOWN":
        sys.stdout.write(json.dumps({"type": "BYE"}) + "\\n")
        sys.stdout.flush()
        break

    else:
        # Unknown message — ignore but don't die
        pass
`;
}

module.exports = { buildWorkerScript };
