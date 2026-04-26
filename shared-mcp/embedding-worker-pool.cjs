/**
 * embedding-worker-pool.js
 *
 * Persistent warm Python worker pool for transformer embeddings.
 *
 * Design goals:
 * - Keep N Python processes alive across requests (no per-call spawn overhead)
 * - Circuit breaker: track per-worker failure counts; retire workers that exceed
 *   FAILURE_THRESHOLD within FAILURE_WINDOW_MS
 * - Backpressure: when all workers are busy and the pending queue reaches
 *   POOL_BACKPRESSURE_LIMIT, reject immediately with a clear error
 * - Round-robin load balancing across healthy workers
 * - Lazy initialization: workers are spawned on first use, not at module load
 *
 * Backpressure threshold: 50 concurrent embedding requests across the pool
 * Circuit breaker: 5 failures per worker within 30 seconds → retire worker
 * Pool size: 3 workers by default (configurable via AI_MEMORY_EMBED_POOL_SIZE)
 */

"use strict";

const { spawn } = require("child_process");

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

const DEFAULT_POOL_SIZE = parseInt(process.env.AI_MEMORY_EMBED_POOL_SIZE || "3", 10);
const FAILURE_THRESHOLD = 5;          // retire after this many failures
const FAILURE_WINDOW_MS = 30000;     // ... within this window
const BACKPRESSURE_LIMIT = 50;        // reject when pending >= this
const WORKER_INIT_TIMEOUT_MS = 30000; // wait for "READY" signal
const WORKER_REQUEST_TIMEOUT_MS = 120000; // per-request timeout

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: number, proc: import('child_process').ChildProcess, state: string, failures: number[], lastUsed: number, pending: number, ipcId: number }} Worker
 */

// All pool state lives here — module-level singleton, no global mutation elsewhere
const pool = {
  /** @type {Worker[]} */
  workers: [],
  /** @type {Set<Worker>} */
  healthy: new Set(),
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, createdAt: number }>} */
  pendingRequests: new Map(),
  initialized: false,
  initPromise: null,
  ipcSeq: 0,
};

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

/**
 * Parse a newline-delimited JSON line.
 * @param {string} line
 * @returns {object|null}
 */
function parseIpcResponse(line) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

/**
 * Spawn a new Python worker process and wait for its READY signal.
 *
 * @param {number} id — pool slot index
 * @param {string} pythonCmd — python/pwsh path
 * @param {string[]} pythonArgs — runtime args (e.g. ["-u"] for unbuffered)
 * @param {object} env — extra env vars to merge
 * @returns {Promise<Worker>}
 */
function spawnWorker(id, pythonCmd, pythonArgs, env) {
  return new Promise((resolve, reject) => {
    const initTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker-${id}-init-timeout`));
    }, WORKER_INIT_TIMEOUT_MS);

    /** @type {Worker} */
    const worker = {
      id,
      proc: null,
      state: "starting",
      failures: [],
      lastUsed: 0,
      pending: 0,
      ipcId: pool.ipcSeq++,
    };

    const mergedEnv = {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      TF_CPP_MIN_LOG_LEVEL: "3",
      TF_ENABLE_ONEDNN_OPTS: "0",
      ...env,
    };

    if (process.env.HTTP_PROXY) mergedEnv.HTTP_PROXY = process.env.HTTP_PROXY;
    if (process.env.HTTPS_PROXY) mergedEnv.HTTPS_PROXY = process.env.HTTPS_PROXY;

    const proc = spawn(pythonCmd, pythonArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: mergedEnv,
    });
    worker.proc = proc;

    let stdoutBuf = "";

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      // Drain complete lines
      let newline;
      while ((newline = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, newline);
        stdoutBuf = stdoutBuf.slice(newline + 1);
        handleWorkerLine(worker, line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      // stderr goes to the parent process stderr — never accumulate
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[embedding-pool:${id}]`, text);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(initTimer);
      recordFailure(worker);
      // Wake up any pending requests with the error
      const pending = [...pool.pendingRequests.entries()];
      pool.pendingRequests.clear();
      for (const [, d] of pending) {
        d.reject(Object.assign(new Error(`worker-${id}-process-error: ${err.message}`), { code: "WORKER_PROCESS_ERROR" }));
      }
      removeWorker(worker);
    });

    proc.on("close", (code) => {
      clearTimeout(initTimer);
      worker.state = "dead";
      // Wake pending requests
      const pending = [...pool.pendingRequests.entries()];
      pool.pendingRequests.clear();
      for (const [, d] of pending) {
        d.reject(Object.assign(new Error(`worker-${id}-exit-${code}`), { code: "WORKER_EXITED" }));
      }
      removeWorker(worker);
    });

    /** @param {string} line */
    function handleWorkerLine(w, line) {
      const msg = parseIpcResponse(line);
      if (!msg) return;

      if (msg.type === "READY") {
        clearTimeout(initTimer);
        w.state = "idle";
        w.lastUsed = Date.now();
        pool.healthy.add(w);
        resolve(w);
      } else if (msg.type === "RESULT" || msg.type === "ERROR") {
        const pending = pool.pendingRequests.get(msg.id);
        if (pending) {
          pool.pendingRequests.delete(msg.id);
          w.pending = Math.max(0, w.pending - 1);
          if (msg.type === "RESULT") {
            pending.resolve(msg.data);
          } else {
            pending.reject(Object.assign(new Error(msg.error || "embedding-failed"), { code: "EMBEDDING_FAILED" }));
            recordFailure(w);
          }
        }
      } else if (msg.type === "PING") {
        // Worker heartbeat — respond to keep it alive
        if (w.proc && !w.proc.killed && w.proc.stdin.writable) {
          w.proc.stdin.write(JSON.stringify({ type: "PONG", id: msg.id }) + "\n");
        }
      }
    }
  });
}

/** @param {Worker} worker */
function recordFailure(worker) {
  const now = Date.now();
  worker.failures.push(now);
  // Prune failures outside the window
  worker.failures = worker.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  if (worker.failures.length >= FAILURE_THRESHOLD) {
    retireWorker(worker, "circuit-open");
  }
}

/** @param {Worker} worker @param {string} reason */
function retireWorker(worker, reason) {
  worker.state = "retiring";
  removeWorker(worker);
  console.error(`[embedding-pool] worker-${worker.id} retired: ${reason}`);
}

/** @param {Worker} worker */
function removeWorker(worker) {
  pool.healthy.delete(worker);
  const idx = pool.workers.indexOf(worker);
  if (idx !== -1) pool.workers.splice(idx, 1);
  if (worker.proc && !worker.proc.killed) {
    worker.proc.kill();
  }
}

// ---------------------------------------------------------------------------
// Pool orchestration
// ---------------------------------------------------------------------------

/**
 * Pick the least-loaded healthy worker using round-robin + load hints.
 * @returns {Worker|null}
 */
function pickWorker() {
  if (pool.healthy.size === 0) return null;
  // Sort by pending count ascending (load-balanced)
  const sorted = [...pool.healthy].sort((a, b) => a.pending - b.pending);
  return sorted[0];
}

/**
 * Initialize the pool: spawn pool size workers in parallel.
 *
 * @param {string} pythonCmd
 * @param {string[]} pythonArgs
 * @param {object} env
 * @returns {Promise<void>}
 */
async function initPool(pythonCmd, pythonArgs, env) {
  if (pool.initialized) return;
  if (pool.initPromise) return pool.initPromise;

  pool.initPromise = (async () => {
    const size = Math.max(1, Math.min(DEFAULT_POOL_SIZE, 8));
    const spawns = [];
    for (let i = 0; i < size; i++) {
      pool.workers.push({
        id: i,
        proc: null,
        state: "spawning",
        failures: [],
        lastUsed: 0,
        pending: 0,
        ipcId: pool.ipcSeq++,
      });
      spawns.push(
        spawnWorker(i, pythonCmd, pythonArgs, env).catch((err) => {
          console.error(`[embedding-pool] worker-${i} spawn failed:`, err.message);
          return null;
        })
      );
    }
    const results = await Promise.all(spawns);
    const alive = results.filter(Boolean);
    for (const w of alive) {
      pool.healthy.add(w);
    }
    if (alive.length === 0) {
      throw new Error("embedding-pool: all workers failed to initialize");
    }
    pool.initialized = true;
    console.error(`[embedding-pool] initialized ${alive.length}/${size} workers`);
  })();

  return pool.initPromise;
}

/**
 * Execute an embedding request against the warm pool.
 *
 * @param {{ texts: string[], model: string, pythonCmd: string, pythonArgs: string[], env: object }} options
 * @returns {Promise<number[][]>}
 */
async function embedWithPool(options) {
  const { texts, model, pythonCmd, pythonArgs, env } = options;

  await initPool(pythonCmd, pythonArgs, env);

  // Backpressure check
  const totalPending = [...pool.healthy].reduce((sum, w) => sum + w.pending, 0);
  if (totalPending >= BACKPRESSURE_LIMIT) {
    throw Object.assign(
      new Error(`embedding-pool-backpressure: ${totalPending} pending requests (limit ${BACKPRESSURE_LIMIT})`),
      { code: "EMBEDDING_BACKPRESSURE" }
    );
  }

  const worker = pickWorker();
  if (!worker) {
    throw Object.assign(new Error("embedding-pool-no-workers"), { code: "POOL_EXHAUSTED" });
  }

  const id = pool.ipcSeq++;
  worker.pending += 1;
  worker.lastUsed = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pool.pendingRequests.has(id)) {
        pool.pendingRequests.delete(id);
        worker.pending = Math.max(0, worker.pending - 1);
        recordFailure(worker);
        reject(Object.assign(new Error("embedding-timeout"), { code: "EMBEDDING_TIMEOUT" }));
      }
    }, WORKER_REQUEST_TIMEOUT_MS);

    pool.pendingRequests.set(id, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      createdAt: Date.now(),
    });

    const payload = JSON.stringify({
      type: "EMBED",
      id,
      model,
      texts,
    });

    if (worker.proc && !worker.proc.killed && worker.proc.stdin.writable) {
      worker.proc.stdin.write(payload + "\n");
    } else {
      clearTimeout(timer);
      pool.pendingRequests.delete(id);
      worker.pending = Math.max(0, worker.pending - 1);
      retireWorker(worker, "stdin-closed");
      reject(Object.assign(new Error("worker-stdin-unwritable"), { code: "WORKER_UNAVAILABLE" }));
    }
  });
}

// ---------------------------------------------------------------------------
// Python worker bootstrap script
// ---------------------------------------------------------------------------

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

# Ensure unbuffered output so parent sees results immediately
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Warm up sentence-transformers — this is the expensive part we want to amortize
_model_cache = {}
_pending_pongs = []

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

// ---------------------------------------------------------------------------
// Pool introspection
// ---------------------------------------------------------------------------

/**
 * @returns {{ healthyCount: number, totalCount: number, pendingRequests: number, workers: object[] }}
 */
function getPoolStatus() {
  const workers = pool.workers.map((w) => ({
    id: w.id,
    state: w.state,
    healthy: pool.healthy.has(w),
    pending: w.pending,
    failures: w.failures.length,
    lastUsed: w.lastUsed ? new Date(w.lastUsed).toISOString() : null,
  }));
  const totalPending = workers.reduce((sum, w) => sum + w.pending, 0);
  return {
    healthyCount: pool.healthy.size,
    totalCount: pool.workers.length,
    pendingRequests: totalPending,
    initialized: pool.initialized,
    backpressureLimit: BACKPRESSURE_LIMIT,
    failureThreshold: FAILURE_THRESHOLD,
    failureWindowMs: FAILURE_WINDOW_MS,
    poolSize: DEFAULT_POOL_SIZE,
    workers,
  };
}

/**
 * Gracefully shut down all workers.
 * @returns {Promise<void>}
 */
async function drainPool() {
  for (const w of [...pool.workers]) {
    if (w.proc && !w.proc.killed && w.proc.stdin.writable) {
      try {
        w.proc.stdin.write(JSON.stringify({ type: "SHUTDOWN" }) + "\n");
      } catch {
        // ignore
      }
    }
  }
  // Give them 2 seconds to flush, then kill
  await new Promise((r) => setTimeout(r, 2000));
  for (const w of [...pool.workers]) {
    removeWorker(w);
  }
  pool.initialized = false;
  pool.initPromise = null;
  pool.workers = [];
  pool.healthy.clear();
  pool.pendingRequests.clear();
}

module.exports = {
  initPool,
  embedWithPool,
  buildWorkerScript,
  getPoolStatus,
  drainPool,
  BACKPRESSURE_LIMIT,
  DEFAULT_POOL_SIZE,
};
