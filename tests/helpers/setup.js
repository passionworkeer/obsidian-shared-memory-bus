/**
 * Test setup utilities - mock file system helpers, temp directory creation
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Creates a temporary directory for tests
 * @param {string} prefix - Prefix for the directory name
 * @returns {string} Path to the created temporary directory
 */
function createTempDir(prefix = "test-") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return tmpDir;
}

/**
 * Cleans up a temporary directory recursively
 * @param {string} dirPath - Path to the directory to clean up
 */
function cleanupTempDir(dirPath) {
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
function createTempJsonl(dirPath, filename, records) {
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
function readJsonl(filePath) {
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
function createStubVaultRoot(rootPath) {
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

/**
 * Creates a mock module cache entry
 * @param {string} modulePath - Path to the module
 * @param {object} exports - Module exports
 * @returns {object} Mock cache entry
 */
function createMockCacheEntry(modulePath, exports) {
  return {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exports,
  };
}

/**
 * Mocks the require cache for a specific module
 * @param {string} modulePath - Path to the module
 * @param {object} exports - Module exports to mock
 */
function mockRequireCache(modulePath, exports) {
  delete require.cache[modulePath];
  require.cache[modulePath] = createMockCacheEntry(modulePath, exports);
}

/**
 * Clears mock from require cache
 * @param {string} modulePath - Path to the module
 */
function clearMockCache(modulePath) {
  delete require.cache[modulePath];
}

module.exports = {
  createTempDir,
  cleanupTempDir,
  createTempJsonl,
  readJsonl,
  createStubVaultRoot,
  createMockCacheEntry,
  mockRequireCache,
  clearMockCache,
};
