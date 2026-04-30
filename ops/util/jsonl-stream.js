import fs from "fs";
import readline from "readline";

/**
 * Async generator that yields parsed JSON objects from a JSONL file,
 * one line at a time. Prevents unbounded memory growth for large files.
 *
 * @param {string} filePath - Path to the .jsonl file
 * @yields {object} Parsed JSON object for each line
 */
async function* createJsonlStream(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Skip malformed lines
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Consume a JSONL stream and collect all records into an array.
 * Provided for backwards compatibility with code that needs the full array.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function readJsonlStream(filePath) {
  const records = [];
  for await (const record of createJsonlStream(filePath)) {
    records.push(record);
  }
  return records;
}

/**
 * Stream JSONL records in batches for memory-efficient processing.
 *
 * @param {string} filePath
 * @param {{ batchSize?: number }} opts
 * @yields {object[]} Batch of records (last batch may be smaller)
 */
async function* createJsonlBatcher(filePath, opts = {}) {
  const { batchSize = 100 } = opts;
  let batch = [];

  for await (const record of createJsonlStream(filePath)) {
    batch.push(record);
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

export {
  createJsonlStream,
  readJsonlStream,
  createJsonlBatcher,
};
