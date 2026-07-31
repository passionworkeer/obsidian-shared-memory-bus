import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnlink(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function acquireLock(
  filePath,
  {
    timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
  } = {},
) {
  const lockPath = `${filePath}.lock`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      return { fd, lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > staleLockMs) {
          safeUnlink(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for JSONL lock: ${lockPath}`);
      }
      await sleep(25);
    }
  }
}

async function withFileLock(filePath, callback, options = {}) {
  const lock = await acquireLock(filePath, options);
  try {
    return await callback();
  } finally {
    try {
      closeSync(lock.fd);
    } finally {
      safeUnlink(lock.lockPath);
    }
  }
}

export async function appendTextUnderLock(filePath, text, options = {}) {
  const content = text.endsWith('\n') ? text : `${text}\n`;
  return withFileLock(filePath, async () => {
    const fd = openSync(filePath, 'a');
    try {
      writeSync(fd, content, 'utf8');
      if (options.fsync) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }, options);
}

export async function appendJsonlRecord(filePath, record, options = {}) {
  return appendTextUnderLock(filePath, JSON.stringify(record), options);
}

export async function readJsonlRecords(filePath) {
  if (!existsSync(filePath)) return [];
  const records = [];
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Preserve the queue's availability even if one historical line is bad.
    }
  }
  return records;
}

export async function removeJsonlRecords(filePath, predicate, options = {}) {
  if (!existsSync(filePath)) return 0;
  return withFileLock(filePath, async () => {
    const originalLines = readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim());
    const retained = [];
    let removed = 0;

    for (const line of originalLines) {
      try {
        const record = JSON.parse(line);
        if (predicate(record)) {
          removed += 1;
        } else {
          retained.push(line);
        }
      } catch {
        retained.push(line);
      }
    }

    if (removed === 0) return 0;

    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    const content = retained.length ? `${retained.join('\n')}\n` : '';
    writeFileSync(temporaryPath, content, 'utf8');
    try {
      renameSync(temporaryPath, filePath);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      safeUnlink(filePath);
      renameSync(temporaryPath, filePath);
    } finally {
      if (existsSync(temporaryPath)) safeUnlink(temporaryPath);
    }
    return removed;
  }, options);
}
