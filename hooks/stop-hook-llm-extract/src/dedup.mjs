import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { removeJsonlRecords } from './jsonl-queue.mjs';

/**
 * Stream a JSONL file and check whether a session_id already exists.
 */
export async function isSessionProcessed(jsonlPath, sessionId) {
  if (!existsSync(jsonlPath)) return false;

  return new Promise((resolve) => {
    const reader = createInterface(createReadStream(jsonlPath, { encoding: 'utf8' }));
    let found = false;

    reader.on('line', (line) => {
      if (found) return;
      try {
        if (JSON.parse(line).session_id === sessionId) {
          found = true;
          reader.close();
        }
      } catch {
      }
    });
    reader.on('close', () => resolve(found));
    reader.on('error', () => resolve(false));
  });
}

/**
 * Remove all queued records for one session using the shared queue lock.
 */
export async function removePending(pendingPath, sessionId) {
  return removeJsonlRecords(
    pendingPath,
    (record) => record?.session_id === sessionId,
  );
}
