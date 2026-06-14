import { restartTimer, setRestartTimer, shuttingDown, ensureInitialized, logError } from './rpc.mjs';

export function scheduleRestart(reason) {
  if (shuttingDown || restartTimer) {
    return;
  }

  setRestartTimer(setTimeout(() => {
    setRestartTimer(null);
    ensureInitialized().catch((error) => {
      logError(`automatic restart failed: ${error.message}`);
      scheduleRestart('retry-after-failed-restart');
    });
  }, 1000));

  logError(`scheduled child restart: ${reason}`);
}