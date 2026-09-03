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
const MAX_STDOUT_BUFFER = 16 * 1024 * 1024; // bound per-worker stdout buffer (OOM guard)

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
  // F2.3 (perf audit HIGH #2): cursor for round-robin selection over the
  // sorted-by-pending list. Avoids re-allocating a fresh sorted array on
  // every request; instead we sort once when the pending distribution
  // changes and rotate the cursor here.
  roundRobinCursor: 0,
  spawnArgs: null,   // last spawn params, used to respawn retired workers
  _respawning: false,
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
    /** @type {Worker | null} */
    let worker = null;

    const cleanup = () => {
      if (worker && worker.proc && !worker.proc.killed) {
        try {
          worker.proc.kill("SIGKILL");
        } catch {
          // Process may have already exited; ignore.
        }
      }
    };

    const initTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker-${id}-init-timeout`));
    }, WORKER_INIT_TIMEOUT_MS);

    /** @type {Worker} */
    worker = {
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
      // Bound the buffer: a runaway worker emitting output without newlines
      // must not OOM the parent process.
      if (stdoutBuf.length > MAX_STDOUT_BUFFER) {
        console.error(`[embedding-pool:${id}] stdout buffer overflow (${stdoutBuf.length} bytes), killing worker`);
        stdoutBuf = "";
        cleanup();
        return;
      }
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
      // Reject only this worker's pending requests — pool.pendingRequests is
      // shared, so clearing it all would reject sibling workers' in-flight work.
      rejectPendingForWorker(worker, `worker-${id}-process-error: ${err.message}`, "WORKER_PROCESS_ERROR");
      removeWorker(worker);
    });

    proc.on("close", (code) => {
      clearTimeout(initTimer);
      worker.state = "dead";
      rejectPendingForWorker(worker, `worker-${id}-exit-${code}`, "WORKER_EXITED");
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

/**
 * Reject only the pending requests owned by `worker` (not the whole pool).
 * pool.pendingRequests is shared across workers, so a single worker dying
 * must not reject sibling workers' in-flight requests.
 */
function rejectPendingForWorker(worker, message, code) {
  for (const [reqId, d] of [...pool.pendingRequests.entries()]) {
    if (d.worker === worker) {
      pool.pendingRequests.delete(reqId);
      worker.pending = Math.max(0, worker.pending - 1);
      d.reject(Object.assign(new Error(message), { code }));
    }
  }
}

/**
 * Top up the pool after a worker is removed, so the healthy set does not
 * monotonically shrink to zero over long runs. No-op during initialization
 * or when already at target size. Fire-and-forget; respawn failures are logged.
 */
function maybeRespawn() {
  if (!pool.spawnArgs || !pool.initialized || pool._respawning) return;
  const target = Math.max(1, Math.min(DEFAULT_POOL_SIZE, 8));
  if (pool.workers.length >= target) return;
  pool._respawning = true;
  const { pythonCmd, pythonArgs, env } = pool.spawnArgs;
  const slot = pool.ipcSeq++;
  pool.workers.push({
    id: slot, proc: null, state: "spawning",
    failures: [], lastUsed: 0, pending: 0, ipcId: pool.ipcSeq++,
  });
  spawnWorker(slot, pythonCmd, pythonArgs, env)
    .then((w) => {
      pool.healthy.add(w);
      console.error(`[embedding-pool] worker-${slot} respawned`);
    })
    .catch((err) => {
      console.error(`[embedding-pool] worker-${slot} respawn failed:`, err.message);
      const idx = pool.workers.findIndex((x) => x.id === slot && x.state === "spawning");
      if (idx !== -1) pool.workers.splice(idx, 1);
    })
    .finally(() => { pool._respawning = false; });
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
  // Top up the pool so the healthy set does not shrink to zero over time.
  maybeRespawn();
}

// ---------------------------------------------------------------------------
// Pool orchestration
// ---------------------------------------------------------------------------

/**
 * Pick the least-loaded healthy worker, then round-robin among ties.
 *
 * @returns {Worker|null}
 */
function pickWorker() {
  if (pool.healthy.size === 0) return null;
  // Sort once per call — the healthy set is bounded (3-8 workers) so this
  // is microseconds. To prevent starvation of workers that have just
  // picked up an inflight request, rotate the cursor so the second-best
  // worker is selected when the best one matches the cursor position.
  const sorted = [...pool.healthy].sort((a, b) => a.pending - b.pending);
  const minPending = sorted[0].pending;
  // Among ties at minPending, round-robin so load is shared across workers
  // that just freed up.
  const tied = [];
  for (const w of sorted) {
    if (w.pending === minPending) tied.push(w);
    else break;
  }
  const cursor = pool.roundRobinCursor % tied.length;
  pool.roundRobinCursor = (pool.roundRobinCursor + 1) | 0;
  return tied[cursor];
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

  pool.spawnArgs = { pythonCmd, pythonArgs, env };
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

  // On failure, reset state so a later call can retry instead of returning
  // the same rejected promise forever (e.g. after a transient Python env issue).
  pool.initPromise = pool.initPromise.catch((err) => {
    pool.initialized = false;
    pool.initPromise = null;
    pool.workers = [];
    pool.healthy = new Set();
    throw err;
  });

  return pool.initPromise;
}

/**
 * Execute an embedding request against the warm pool.
 *
 * @param {{ texts: string[], model: string, pythonCmd: string, pythonArgs: string[], env: object, msgType?: string, apiKey?: string, geminiModel?: string }} options
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
      worker,
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

    const msgType = options.msgType || "EMBED";
    const apiKey = options.apiKey || "";
    const geminiModel = options.geminiModel || "gemini-embedding-2";
    const payload = JSON.stringify(Object.assign(
      { type: msgType, id, model, texts },
      msgType === "GEMINI_EMBED" ? { apiKey, geminiModel } : {}
    ));

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

// Q-HIGH-1 step 2: buildWorkerScript 抽到 ./embedding-worker-script.cjs.
// Pool host 只关心 worker 生命周期 + IPC routing;
// Python script 模板与 Python IPC protocol 是独立职责。
const { buildWorkerScript } = require("./embedding-worker-script.cjs");

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
