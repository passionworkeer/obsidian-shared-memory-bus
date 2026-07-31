import { spawn } from 'node:child_process';
import { resolveProjectPath } from './omni-store.js';
import { probeHttp } from './health-check.js';

const DEFAULT_HEALTH_PATH = '/healthz';
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_RESTART_BACKOFF_MS = 1000;
const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_CIRCUIT_WINDOW_MS = 300000;
const DEFAULT_PROBE_FAILURE_THRESHOLD = 3;

export function buildSpawnCommand(server) {
  if (!server?.command) {
    throw new Error(`mcp-process-manager: server has no command: ${server?.id}`);
  }
  return { file: server.command, args: [...(server.args || [])] };
}

export function spawnServer(server, options = {}) {
  const { file, args } = buildSpawnCommand(server);
  const spawnOptions = {
    env: { ...(options.env || {}) },
    cwd: options.cwd || resolveProjectPath(''),
    inheritStdio: options.inheritStdio !== false,
  };
  const env = { ...process.env, ...spawnOptions.env, ...(server.env || {}) };
  const child = spawn(file, args, {
    cwd: spawnOptions.cwd,
    env,
    stdio: spawnOptions.inheritStdio ? 'inherit' : 'pipe',
    windowsHide: true,
  });

  child.on('error', (error) => {
    console.error(`[mcp-process-manager] spawn failed for ${server.id}: ${error.message}`);
  });

  return {
    server,
    child,
    spawnOptions,
    restartCount: 0,
    startedAt: Date.now(),
    lastCrashAt: 0,
  };
}

export function restartPolicyFor(server) {
  const policy = server?.restartPolicy || server?.isolatedSubprocess?.restartPolicy;
  if (policy === 'on-failure' || policy === 'never') return policy;
  return 'always';
}

export function probeServer(server, options = {}) {
  const host = options.host || '127.0.0.1';
  const healthPath = options.path || server?.healthPath || DEFAULT_HEALTH_PATH;
  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;
  const port = options.port ?? server?.port;
  if (typeof port !== 'number') {
    return Promise.resolve({ ok: false, error: 'missing-port' });
  }
  return probeHttp(host, port, healthPath, timeoutMs);
}

/**
 * Monitor one process and preserve its original spawn options across restarts.
 * Probe failures trigger a controlled restart after a configurable threshold.
 */
export function monitorServer(proc, options = {}) {
  const intervalMs = options.intervalMs || 30000;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const circuitWindowMs = options.circuitWindowMs ?? DEFAULT_CIRCUIT_WINDOW_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
  const probeFailureThreshold = options.probeFailureThreshold ?? DEFAULT_PROBE_FAILURE_THRESHOLD;
  const onRestart = options.onRestart || (() => {});
  const probe = options.probe || probeServer;
  const policy = restartPolicyFor(proc.server);

  let stopped = false;
  let circuitOpen = false;
  let restartTimer = null;
  let restartWindowStartedAt = Date.now();
  let consecutiveProbeFailures = 0;

  const resetRestartWindowIfNeeded = (now) => {
    if (now - restartWindowStartedAt >= circuitWindowMs) {
      restartWindowStartedAt = now;
      proc.restartCount = 0;
      circuitOpen = false;
    }
  };

  const canRestartForExit = (code, signal) => {
    if (policy === 'never') return false;
    const expected = code === 0 || signal === 'SIGTERM';
    return policy === 'always' || (policy === 'on-failure' && !expected);
  };

  const bindChild = (managedChild) => {
    if (!managedChild) return;
    managedChild.once('exit', (code, signal) => {
      if (stopped || !canRestartForExit(code, signal)) return;
      attemptRestart(`exit code=${code} signal=${signal}`);
    });
  };

  const attemptRestart = (reason) => {
    if (stopped || restartTimer) return false;
    const now = Date.now();
    resetRestartWindowIfNeeded(now);

    if (proc.restartCount >= maxRestarts) {
      if (!circuitOpen) {
        circuitOpen = true;
        console.error(
          `[mcp-process-manager] circuit OPEN for ${proc.server.id}: ${proc.restartCount} restarts within ${circuitWindowMs}ms`,
        );
      }
      return false;
    }

    proc.restartCount += 1;
    proc.lastCrashAt = now;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped) return;
      try {
        const next = spawnServer(proc.server, proc.spawnOptions || {});
        proc.child = next.child;
        proc.spawnOptions = next.spawnOptions;
        proc.startedAt = next.startedAt;
        consecutiveProbeFailures = 0;
        bindChild(proc.child);
        onRestart(proc, reason);
      } catch (error) {
        console.error(`[mcp-process-manager] restart failed for ${proc.server.id}: ${error.message}`);
        attemptRestart(`restart-error: ${error.message}`);
      }
    }, backoffMs);
    if (typeof restartTimer.unref === 'function') restartTimer.unref();
    return true;
  };

  bindChild(proc.child);

  const timer = setInterval(async () => {
    if (stopped || restartTimer) return;
    if (!proc.child || proc.child.exitCode !== null) {
      attemptRestart('child-exited-without-handler');
      return;
    }

    let result;
    try {
      result = await probe(proc.server, options.probeOptions || {});
    } catch (error) {
      result = { ok: false, error: error.message };
    }

    if (result.ok) {
      consecutiveProbeFailures = 0;
      return;
    }

    consecutiveProbeFailures += 1;
    console.warn(
      `[mcp-process-manager] probe failed for ${proc.server.id} (${consecutiveProbeFailures}/${probeFailureThreshold}): ${result.error || result.status}`,
    );
    if (consecutiveProbeFailures < probeFailureThreshold || policy === 'never') return;

    consecutiveProbeFailures = 0;
    try {
      if (proc.child.exitCode === null) proc.child.kill('SIGTERM');
    } catch {
    }
    attemptRestart('health-probe-threshold');
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      try {
        if (proc.child && proc.child.exitCode === null) {
          proc.child.kill('SIGTERM');
        }
      } catch {
      }
    },
  };
}
