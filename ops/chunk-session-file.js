#!/usr/bin/env node
/**
 * ops/chunk-session-file.js
 *
 * Reads a session file, splits content into chunks, and writes a sidecar
 * .chunks.json manifest alongside the file.
 *
 * Hybrid chunking strategy (ADR-002):
 *   - Turn boundaries: detect Claude Code turn patterns (human/assistant turns)
 *   - Markdown headers: split on ## and ### boundaries
 *   - Max chunk size: 800 tokens (~3200 chars), overlap: 80 tokens (~320 chars)
 *
 * Manifest format (sidecar .chunks.json):
 *   {
 *     "file": "sessions/2026-04-03/abc.md",
 *     "version": 1,
 *     "chunks": [
 *       {
 *         "chunk_id": "c1",
 *         "content_hash": "sha256:abc123...",
 *         "start_line": 1,
 *         "end_line": 25,
 *         "token_count": 342
 *       }
 *     ]
 *   }
 *
 * Usage:
 *   node ops/chunk-session-file.js sessions/2026-04-03/abc.md
 *   node ops/chunk-session-file.js --verify sessions/2026-04-03/abc.md
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE || "", ".ai-memory");

const MANIFEST_SUFFIX = ".chunks.json";
const MAX_TOKENS = 800;
const OVERLAP_TOKENS = 80;
const CHARS_PER_TOKEN = 4; // approximate

// Patterns for turn boundary detection
const TURN_PATTERNS = [
  // Human turn
  /^(##?\s*Human|##?\s*User|##?\s*Prompt|> .*\(user\))/gim,
  // Assistant turn
  /^(##?\s*Assistant|##?\s*Claude|##?\s*Model|\[Assistant\]|\[Claude\])/gim,
  // System markers
  /^---\r?\n/s,
];

const CONTENT_LINE_PATTERNS = [
  /^#{1,3}\s+/m,           // Markdown H1-H3
  /^\*{3,}$/m,             // Horizontal rule
  /^={3,}\s*$/m,           // Underline headings
];

function tokenCount(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitIntoChunks(text, startLine) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let currentChunk = [];
  let currentLineNum = startLine;
  let currentTokens = 0;
  let chunkIndex = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = tokenCount(line) + 1; // +1 for newline

    // Check for hard boundary (H2/H3 header in Markdown context)
    const isHardBoundary = /^#{2,3}\s+/.test(line);

    // Check for soft boundary (blank line after significant content)
    const isSoftBoundary = line.trim() === "" && currentTokens > 200;

    if (isHardBoundary || (isSoftBoundary && currentTokens > MAX_TOKENS / 2)) {
      if (currentChunk.length > 0) {
        chunks.push({
          lines: currentChunk,
          startLine: currentLineNum,
          tokens: currentTokens,
          isHardBoundary,
        });
        currentChunk = [];
        currentLineNum = i + 1;
        currentTokens = 0;
      }
      continue;
    }

    currentChunk.push(line);
    currentTokens += lineTokens;

    if (currentTokens >= MAX_TOKENS) {
      // Overlap: keep last N tokens for context continuity
      let overlapLines = [];
      let overlapTokens = 0;
      const reversed = [...currentChunk].reverse();
      for (const ol of reversed) {
        const olTokens = tokenCount(ol) + 1;
        if (overlapTokens + olTokens > OVERLAP_TOKENS) break;
        overlapLines.unshift(ol);
        overlapTokens += olTokens;
      }

      const actualChunkLines = currentChunk.slice(0, currentChunk.length - overlapLines.length);
      chunks.push({
        lines: actualChunkLines,
        startLine: currentLineNum,
        tokens: currentTokens - overlapTokens,
        isHardBoundary,
      });

      // Start next chunk with overlap
      currentChunk = [...overlapLines, line];
      currentLineNum = i + 1 - overlapLines.length;
      currentTokens = overlapTokens + lineTokens;
    }
  }

  // Last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      lines: currentChunk,
      startLine: currentLineNum,
      tokens: currentTokens,
      isHardBoundary: false,
    });
  }

  return chunks.map((c, i) => ({
    chunk_id: `c${chunkIndex++}`,
    start_line: c.startLine,
    end_line: c.startLine + c.lines.length - 1,
    token_count: c.tokens,
    text: c.lines.join("\n"),
    content_hash: "", // filled below
  }));
}

function computeChunkHash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readManifest(sessionPath) {
  const manifestPath = sessionPath + MANIFEST_SUFFIX;
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function writeManifest(sessionPath, manifest) {
  const manifestPath = sessionPath + MANIFEST_SUFFIX;
  // Atomic write: write to temp, then rename
  const tmpPath = manifestPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmpPath, manifestPath);
}

function chunkFile(sessionPath, options = {}) {
  const { force = false, dryRun = false } = options;

  const rawContent = fs.readFileSync(sessionPath, "utf8");
  const lines = rawContent.split(/\r?\n/);

  // Skip frontmatter
  let contentStartLine = 1;
  let bodyStartOffset = 0;
  if (rawContent.startsWith("---")) {
    const fmEnd = rawContent.indexOf("\n---\n", 3);
    if (fmEnd !== -1) {
      bodyStartOffset = fmEnd + 5;
      contentStartLine = rawContent.slice(0, fmEnd + 5).split(/\r?\n/).length;
    }
  }

  const body = rawContent.slice(bodyStartOffset);
  const existingManifest = readManifest(sessionPath);

  // Build new chunks
  const newChunks = splitIntoChunks(body, contentStartLine);

  // Compute hashes
  for (const chunk of newChunks) {
    chunk.content_hash = "sha256:" + computeChunkHash(chunk.text);
  }

  // Compare with existing manifest to detect changes
  const existingByLine = {};
  if (existingManifest && !force) {
    for (const c of existingManifest.chunks) {
      existingByLine[`${c.start_line}-${c.end_line}`] = c;
    }
  }

  const result = { new: [], unchanged: [], removed: [] };

  for (const chunk of newChunks) {
    const key = `${chunk.start_line}-${chunk.end_line}`;
    const existing = existingByLine[key];
    if (existing && existing.content_hash === chunk.content_hash) {
      result.unchanged.push({
        chunk_id: chunk.chunk_id,
        content_hash: chunk.content_hash,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
      });
    } else {
      result.new.push(chunk);
    }
  }

  // Build new manifest
  const manifest = {
    version: 1,
    file: path.relative(AI_MEMORY_ROOT, sessionPath).replace(/\\/g, "/"),
    updated_at: new Date().toISOString(),
    total_chunks: newChunks.length,
    chunks: newChunks.map(({ chunk_id, content_hash, start_line, end_line, token_count }) => ({
      chunk_id,
      content_hash,
      start_line,
      end_line,
      token_count,
    })),
  };

  if (!dryRun) {
    writeManifest(sessionPath, manifest);
  }

  return {
    manifest,
    result,
    total: newChunks.length,
    changed: result.new.length,
    unchanged: result.unchanged.length,
  };
}

function verifyChunkIntegrity(sessionPath) {
  const manifest = readManifest(sessionPath);
  if (!manifest) {
    return { ok: false, error: "No manifest found" };
  }

  const rawContent = fs.readFileSync(sessionPath, "utf8");
  const lines = rawContent.split(/\r?\n/);
  const allLines = manifest.chunks.map(c =>
    lines.slice(c.start_line - 1, c.end_line).join("\n")
  );

  const errors = [];
  for (const c of manifest.chunks) {
    const extractedText = lines.slice(c.start_line - 1, c.end_line).join("\n");
    const computedHash = "sha256:" + computeChunkHash(extractedText);
    if (computedHash !== c.content_hash) {
      errors.push(`Chunk ${c.chunk_id}: hash mismatch (expected ${c.content_hash}, got ${computedHash})`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    total: manifest.total_chunks,
    verified: manifest.total_chunks - errors.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const verifyMode = args.includes("--verify");
  const dryRun = args.includes("--dry-run");
  const files = args.filter(a => !a.startsWith("--"));

  if (files.length === 0) {
    console.log("Usage: node ops/chunk-session-file.js [--verify] [--dry-run] <file.md> [<file2.md>...]");
    process.exit(1);
  }

  for (const file of files) {
    const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    if (verifyMode) {
      const result = verifyChunkIntegrity(resolved);
      console.log(`[verify] ${file}: ok=${result.ok} verified=${result.verified}/${result.total}`);
      if (result.errors.length > 0) {
        result.errors.forEach(e => console.error(`  ERROR: ${e}`));
      }
    } else {
      const { manifest, result, total, changed } = chunkFile(resolved, { dryRun });
      const label = dryRun ? "[dry-run]" : "";
      console.log(`${label}[chunk] ${file}: total=${total} changed=${changed} unchanged=${result.unchanged.length}`);
      if (dryRun && changed > 0) {
        result.new.forEach(c => console.log(`  new: c${c.chunk_id} L${c.start_line}-${c.end_line}`));
      }
    }
  }
}

main().catch(err => { console.error("[chunk] ERROR:", err.message); process.exit(1); });
