/**
 * Test setup utilities - mock file system helpers, temp directory creation
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Creates a temporary directory for tests
 * @param {string} prefix - Prefix for the directory name
 * @returns {string} Path to the created temporary directory
 */
export function createTempDir(prefix = "test-") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return tmpDir;
}

/**
 * Cleans up a temporary directory recursively
 * @param {string} dirPath - Path to the directory to clean up
 */
export function cleanupTempDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Failed to clean up temp directory: ${dirPath}`, error.message);
  }
}

/**
 * Creates a temporary JSONL file with test data
 * @param {string} dirPath - Directory to create the file in
 * @param {string} filename - Name of the file
 * @param {object[]} records - Array of records to write
 * @returns {string} Path to the created file
 */
export function createTempJsonl(dirPath, filename, records) {
  const filePath = path.join(dirPath, filename);
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Reads a JSONL file and returns parsed records
 * @param {string} filePath - Path to the JSONL file
 * @returns {object[]} Array of parsed records
 */
export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const records = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

/**
 * Creates a stub vault root for testing
 * @param {string} rootPath - Path to use as vault root
 * @returns {object} Stub vault root functions
 */
export function createStubVaultRoot(rootPath) {
  return {
    resolveVaultRoot() {
      return rootPath;
    },
    getDefaultVaultCandidates() {
      return [rootPath];
    },
    getObsidianConfigCandidates() {
      return [];
    },
  };
}
