"use strict";

const fs = require("fs");
const readline = require("readline");

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

module.exports = {
  createJsonlStream,
  readJsonlStream,
};
