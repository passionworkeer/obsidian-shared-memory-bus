/**
 * skills/user-portrait/lib/util.js
 * ---------------------------------
 * Shared helpers for the user-portrait skill: safe fs walking, JSONL
 * streaming, and text normalization. Every helper is failure-tolerant —
 * a malformed file must degrade to "zero messages", never crash a scan.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/** Max characters retained per harvested user message. */
export const MAX_MESSAGE_CHARS = 4000;

/** Hard cap on messages kept per collection run (memory guard). */
export const MAX_TOTAL_MESSAGES = 300000;

/**
 * Walk a directory recursively, yielding file paths whose basename matches
 * `filter` (RegExp). Missing root or permission errors yield nothing.
 * Symlink cycles are avoided by never following symlinks.
 *
 * @param {string} root absolute directory path
 * @param {RegExp} filter test against basename
 * @param {{ maxDepth?: number }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* walkFiles(root, filter, opts = {}) {
  const { maxDepth = 6 } = opts;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // missing / unreadable — treated as absent source
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (maxDepth <= 0) continue;
      yield* walkFiles(full, filter, { maxDepth: maxDepth - 1 });
    } else if (entry.isFile() && filter.test(entry.name)) {
      yield full;
    }
  }
}

/**
 * Stream a (possibly huge) JSONL file line by line, yielding each parsed
 * object. Invalid JSON lines are skipped silently — real-world agent logs
 * contain truncated writes.
 *
 * @param {string} file
 * @returns {AsyncGenerator<object>}
 */
export async function* streamJsonl(file) {
  let rl;
  try {
    rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
  } catch {
    return;
  }
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* stream error (e.g. ENOENT on a missing file) — degrade to empty */
  }
}

/** Read and parse a small JSON file; returns null on any failure. */
export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** True when path exists and is readable (stats succeed). */
export function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Human-readable byte size. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Normalize message text for dedup keys: collapse whitespace, lowercase,
 * truncate. Keeps CJK intact.
 */
export function normalizeForDedup(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/**
 * Extract the first human-readable string from Claude-style content values
 * (string | [{type:"text",text}] | [{type:"tool_result",...}]).
 * Tool results and images are dropped — we only want typed input.
 */
export function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** CJK char ratio in 0..1 (used for language-mix stats). */
export function cjkRatio(text) {
  const s = String(text || "");
  if (!s) return 0;
  const letters = s.replace(/[\s\d\p{P}]/gu, "");
  if (!letters) return 0;
  const cjk = letters.match(/[一-鿿㐀-䶿]/g) || [];
  return cjk.length / letters.length;
}

/** yyyy-mm-dd (local) from a Date or ms epoch. */
export function dayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse flexible timestamps (ISO | ms epoch | s epoch) → ms, or null. */
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") {
    if (v > 1e12) return v; // ms
    if (v > 1e9) return v * 1000; // s
    return null;
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "" && n > 1e9) {
      return n > 1e12 ? n : n * 1000;
    }
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
