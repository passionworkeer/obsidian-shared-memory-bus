import fs from "node:fs";
import path from "node:path";
import { safeRealpathWithin } from "../memory/paths-and-io.js";

function assertNotSymlink(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`appendLineAtomic: refusing symbolic-link target ${filePath}`);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
}

function openAppendFile(filePath) {
  assertNotSymlink(filePath);
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  const flags =
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    fs.constants.O_WRONLY |
    noFollow;

  try {
    return fs.openSync(filePath, flags, 0o600);
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new Error(`appendLineAtomic: refusing symbolic-link target ${filePath}`);
    }
    throw error;
  }
}

/**
 * Append one complete line using the platform's append primitive.
 *
 * When safeRoot is supplied, existing targets are fully realpath-resolved and
 * must stay inside that root. Symbolic-link final components are always denied
 * for writes, and O_NOFOLLOW is used where the platform exposes it.
 */
function appendLineAtomic(filePath, line, opts = {}) {
  const { createDir = true, fsync = false, safeRoot = "" } = opts;
  const serialized = typeof line === "string" ? line : JSON.stringify(line);
  const content = serialized.endsWith("\n") ? serialized : `${serialized}\n`;
  const dir = path.dirname(filePath);

  if (createDir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (safeRoot && !safeRealpathWithin(filePath, safeRoot)) {
    throw new Error(
      `appendLineAtomic: refusing write to ${filePath} (escapes safeRoot ${safeRoot})`,
    );
  }

  const fd = openAppendFile(filePath);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`appendLineAtomic: target is not a regular file: ${filePath}`);
    }
    if (safeRoot && !safeRealpathWithin(filePath, safeRoot)) {
      throw new Error(
        `appendLineAtomic: target changed during open and escapes safeRoot ${safeRoot}`,
      );
    }
    fs.writeSync(fd, content);
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export { appendLineAtomic };
