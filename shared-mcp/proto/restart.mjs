import { restartTimer, setRestartTimer, shuttingDown, ensureInitialized, logError } from './rpc.mjs';

export const DEFAULT_BACKOFF = Object.freeze({
  baseDelay: 500,
  maxDelay: 30000,
  jitter: 250,
  maxAttempts: 8,
});

// Pure: compute the deterministic (pre-jitter) backoff delay for a given attempt.
// attempt=0 → baseDelay, attempt=1 → 2*baseDelay, ..., capped at maxDelay.
export function computeBaseDelay(attempt, opts = DEFAULT_BACKOFF) {
  const a = Math.max(0, Number(attempt) | 0);
  const base = opts.baseDelay;
  const max = opts.maxDelay;
  // 2**a grows fast; guard against absurd attempts by using Math.min with cap.
  const exp = Math.min(base * Math.pow(2, a), max);
  return exp;
}

// Pure: compute the full backoff delay (deterministic + jitter) for a given attempt.
// jitterFn allows tests to inject a deterministic jitter source.
export function computeBackoffDelay(attempt, opts = DEFAULT_BACKOFF, jitterFn = Math.random) {
  const base = computeBaseDelay(attempt, opts);
  const j = Math.max(0, Number(opts.jitter) | 0);
  const jitterAmount = j > 0 ? jitterFn() * j : 0;
  return base + jitterAmount;
}

// Pure: should we attempt another restart, given the attempt count so far?
// attempt is the number of restarts that have ALREADY been scheduled.
export function shouldRestart(attempt, opts = DEFAULT_BACKOFF) {
  return attempt < opts.maxAttempts;
}

let attemptCounter = 0;

export function getAttemptCount() {
  return attemptCounter;
}

export function resetAttemptCount() {
  attemptCounter = 0;
}

export function scheduleRestart(reason) {
  if (shuttingDown || restartTimer) {
    return;
  }

  if (!shouldRestart(attemptCounter, DEFAULT_BACKOFF)) {
    logError(
      `giving up on child restart after ${attemptCounter} attempts (max=${DEFAULT_BACKOFF.maxAttempts}): ${reason}`,
    );
    return;
  }

  const currentAttempt = attemptCounter;
  const delay = computeBackoffDelay(currentAttempt, DEFAULT_BACKOFF);
  attemptCounter += 1;

  setRestartTimer(setTimeout(() => {
    setRestartTimer(null);
    // Reset the counter on a successful (no-throw) ensureInitialized so a
    // long-lived stable child doesn't keep accumulating attempts forever.
    ensureInitialized()
      .then(() => {
        attemptCounter = 0;
      })
      .catch((error) => {
        logError(`automatic restart failed: ${error.message}`);
        scheduleRestart('retry-after-failed-restart');
      });
  }, Math.floor(delay)));

  logError(`scheduled child restart (attempt ${currentAttempt + 1}/${DEFAULT_BACKOFF.maxAttempts}, delay=${Math.floor(delay)}ms): ${reason}`);
}
