#!/usr/bin/env node
/**
 * ops/build-sqlite-index.js
 * Builds SQLite chunk index from ~/.ai-memory/.memory/
 * All DB ops in Python; Node handles file I/O and embedding.
 *
 * Usage: node ops/build-sqlite-index.js [--force] [--verbose]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");

const AI_MEMORY_ROOT = process.env.AI_MEMORY_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE || "", ".ai-memory");
const DB_PATH = path.join(AI_MEMORY_ROOT, ".memory", ".index", "memory.db");
const EMBEDDING_DIM = 384;
const EMBEDDING_PROVIDER = "transformers";
const EMBEDDING_MODEL = "all-MiniLM-L6-v2";
const PROXY = "http://127.0.0.1:7892";

const FORCE = process.argv.includes("--force");
const VERBOSE = process.argv.includes("--verbose");

function getPythonCommand() {
  if (process.platform === "win32" && fs.existsSync("D:/python/python.exe")) return "D:/python/python.exe";
  return process.env.AI_MEMORY_PYTHON || "python";
}

function expandHome(p) {
  const home = (process.env.HOME || process.env.USERPROFILE || "").replace(/\\/g, "/");
  return p.replace(/^~\//, home + "/");
}

function computeContentHash(text) {
  return crypto.createHash("sha256").update(text || "", "utf8").digest("hex");
}

async function runPython(script, payload) {
  const tmpJson = path.join(os.tmpdir(), `smb_d_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  const tmpPy = path.join(os.tmpdir(), `smb_s_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(tmpJson, JSON.stringify(payload ?? null), "utf8");
  fs.writeFileSync(tmpPy, `import json,sys\np=json.load(open(sys.argv[1],encoding="utf-8"))\n` + script, "utf8");
  return new Promise((resolve, reject) => {
    const PY = getPythonCommand();
    const child = spawn(PY, [tmpPy, tmpJson], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, TF_CPP_MIN_LOG_LEVEL: "3", PYTHONUTF8: "1" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => { if (VERBOSE) process.stderr.write("[db] " + c); });
    child.on("error", reject);
    child.on("close", code => {
      try { fs.unlinkSync(tmpJson); } catch (_) {}
      try { fs.unlinkSync(tmpPy); } catch (_) {}
      if (code !== 0) return reject(new Error(stderr.split("\n").slice(-3).join(" ") || `exit-${code}`));
      resolve(stdout.trim());
    });
  });
}

async function embedTexts(texts) {
  if (VERBOSE) process.stdout.write(`  [embed] ${texts.length} texts...`);
  const PY = getPythonCommand();
  const payload = { texts, model: EMBEDDING_MODEL };
  const tmpFile = path.join(os.tmpdir(), `smb_emb_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload), "utf8");
  const script = `
import json, sys, os
os.environ.setdefault("http_proxy", "${PROXY}")
os.environ.setdefault("https_proxy", "${PROXY}")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
p = json.load(open(sys.argv[1], encoding="utf-8"))
texts = [str(t).strip() if t is not None else "" for t in p.get("texts", [])]
from sentence_transformers import SentenceTransformer
model = SentenceTransformer(p.get("model", "${EMBEDDING_MODEL}"))
vectors = model.encode(texts, show_progress_bar=False, convert_to_numpy=True, batch_size=32)
sys.stdout.write(json.dumps([v.tolist() for v in vectors]))
`;
  return new Promise((resolve, reject) => {
    const child = spawn(PY, ["-c", script, tmpFile], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        TF_CPP_MIN_LOG_LEVEL: "3",
        TF_ENABLE_ONEDNN_OPTS: "0",
        PYTHONUTF8: "1",
        http_proxy: PROXY, https_proxy: PROXY,
        HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY,
      },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => { if (VERBOSE) process.stderr.write("[embed] " + c); });
    child.on("error", reject);
    child.on("close", code => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (code !== 0) return reject(new Error(stderr.split("\n").slice(-3).join(" ") || `embed-exit-${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`embed-parse: ${e.message}`)); }
    });
  });
}

// ─── DB operations via Python stdin ─────────────────────────────────────────

async function dbBatchUpsert(items) {
  const script = `
import sqlite3, sqlite_vec, base64, struct, sys
conn = sqlite3.connect(p.get("db_path", ""))
conn.execute("PRAGMA journal_mode=WAL")
conn.enable_load_extension(True)
sqlite_vec.load(conn)
cur = conn.cursor()
EP = "${EMBEDDING_PROVIDER}"
EM = "${EMBEDDING_MODEL}"
for item in p.get("ops", []):
    op = item["op"]
    if op == "chunk":
        vec_bytes = base64.b64decode(item["vector_b64"])
        cur.execute("DELETE FROM chunks WHERE file_path=? AND chunk_id=?", [item["file_path"], item["chunk_id"]])
        cur.execute(
          "INSERT INTO chunks(file_path,chunk_id,content_hash,start_line,end_line,text,token_count,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [item["file_path"], item["chunk_id"], item["content_hash"], item["start_line"], item["end_line"], item["text"], item.get("token_count", 0), item["now"]]
        )
        cur.execute("INSERT INTO chunks_vec(chunk_id,file_path,items) VALUES (?,?,?)", [item["chunk_id"], item["file_path"], vec_bytes])
        cur.execute(
          "INSERT OR REPLACE INTO memory_meta(chunk_id,file_path,memory_type,durable_type,name,promotion_count) VALUES (?,?,?,?,?,?)",
          [item["chunk_id"], item["file_path"], item["memory_type"], item["durable_type"], item["name"], 1]
        )
    elif op == "cache":
        vec_bytes = base64.b64decode(item["vector_b64"])
        cur.execute(
          "INSERT OR REPLACE INTO embedding_cache(provider,model,content_hash,vector,created_at,hit_count) VALUES (?,?,?,?,?,1)",
          [EP, EM, item["content_hash"], vec_bytes, item["now"]]
        )
    elif op == "file":
        cur.execute(
          "INSERT OR REPLACE INTO files(path,content_hash,memory_type,name,mtime,chunk_count) VALUES (?,?,?,?,?,?)",
          [item["path"], item["content_hash"], item.get("memory_type",""), item.get("name",""), item["now"], item.get("chunk_count", 1)]
        )
conn.commit()
print("OK")
`;
  await runPython(script, { db_path: expandHome(DB_PATH), ops: items });
}

async function dbGetCachedVectors(contentHashes) {
  const script = `
import json, sqlite3, struct, sys
conn = sqlite3.connect(p.get("db_path", ""))
conn.row_factory = sqlite3.Row
cur = conn.cursor()
EP = "${EMBEDDING_PROVIDER}"
EM = "${EMBEDDING_MODEL}"
DIM = ${EMBEDDING_DIM}
result = {}
for ch in p.get("hashes", []):
    rows = cur.execute(
      "SELECT content_hash, vector FROM embedding_cache WHERE provider=? AND model=? AND content_hash=?",
      [EP, EM, ch]
    ).fetchall()
    if rows:
        vec = list(struct.unpack("<" + str(DIM) + "f", rows[0][1]))
        result[ch] = vec
sys.stdout.write(json.dumps(result))
`;
  const result = await runPython(script, { db_path: expandHome(DB_PATH), hashes: contentHashes });
  try { return JSON.parse(result); } catch { return {}; }
}

// ─── File processing ─────────────────────────────────────────────────────────

function walkMemoryDir(root) {
  const results = [];
  if (!fs.existsSync(root)) return results;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".index" || entry.name === ".lock" || entry.name === ".config") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...walkMemoryDir(full));
    else if (entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: content };
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  return { fm, body: match[2] };
}

function readChunkManifest(sessionPath) {
  const manifestPath = sessionPath + ".chunks.json";
  if (!fs.existsSync(manifestPath)) return null;
  try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { return null; }
}

function extractChunks(filePath, sessionManifest) {
  const raw = fs.readFileSync(filePath, "utf8");
  const { fm, body } = parseFrontmatter(raw);
  const lines = raw.split(/\r?\n/);
  const memType = fm.durable_type || fm.type || "feedback";

  if (sessionManifest) {
    return sessionManifest.chunks.map(c => {
      const text = lines.slice(c.start_line - 1, c.end_line).join("\n");
      return {
        chunk_id: c.chunk_id,
        content_hash: computeContentHash(text),
        start_line: c.start_line,
        end_line: c.end_line,
        text: text.trim(),
        token_count: c.token_count || Math.ceil(text.length / 4),
        memory_type: memType,
        durable_type: memType,
        name: fm.name || path.basename(filePath),
      };
    });
  }

  return [{
    chunk_id: "c1",
    content_hash: computeContentHash(body),
    start_line: 1,
    end_line: lines.length,
    text: body.trim(),
    token_count: Math.ceil(body.length / 4),
    memory_type: memType,
    durable_type: memType,
    name: fm.name || path.basename(filePath),
  }];
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[build-index] DB: ${DB_PATH}`);

  const memoryRoot = path.join(AI_MEMORY_ROOT, ".memory");
  const files = walkMemoryDir(memoryRoot);
  console.log(`[build-index] Found ${files.length} .md files`);

  const stats = { indexed: 0, chunks: 0, errors: 0 };
  const now = Math.floor(Date.now() / 1000);

  for (const filePath of files) {
    const relPath = path.relative(AI_MEMORY_ROOT, filePath).replace(/\\/g, "/");
    if (VERBOSE) console.log(`\n[file] ${relPath}`);

    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const fileContentHash = computeContentHash(raw);
      const manifest = readChunkManifest(filePath);
      const chunks = extractChunks(filePath, manifest);

      // Batch fetch cached vectors
      const hashes = chunks.map(c => c.content_hash);
      const cache = await dbGetCachedVectors(hashes);

      const dbOps = [];
      const textsToEmbed = [];

      for (const chunk of chunks) {
        if (cache[chunk.content_hash]) {
          chunk.vector = cache[chunk.content_hash];
          chunk.from_cache = true;
        } else {
          textsToEmbed.push(chunk.text);
          chunk.vector = null;
        }
      }

      if (textsToEmbed.length > 0) {
        if (VERBOSE) process.stdout.write(`  [embed] ${textsToEmbed.length} miss...`);
        const vectors = await embedTexts(textsToEmbed);
        let vi = 0;
        for (const chunk of chunks) {
          if (!chunk.from_cache) {
            chunk.vector = vectors[vi++];
          }
        }
        if (VERBOSE) console.log(" done");
      } else {
        if (VERBOSE) console.log("  [embed] all cache hit");
      }

      // Build DB ops — chunk_id must be globally unique across all files
      const fileKey = relPath.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 16);
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const vecB64 = Buffer.from(new Float32Array(chunk.vector).buffer).toString("base64");
        const chunkId = `${fileKey}_${chunk.chunk_id}`;
        dbOps.push({
          op: "chunk",
          chunk_id: chunkId,
          file_path: relPath,
          content_hash: chunk.content_hash,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          text: chunk.text,
          token_count: chunk.token_count,
          memory_type: chunk.memory_type,
          durable_type: chunk.durable_type,
          name: chunk.name,
          vector_b64: vecB64,
          now,
        });
        if (!chunk.from_cache) {
          dbOps.push({
            op: "cache",
            content_hash: chunk.content_hash,
            vector_b64: vecB64,
            now,
          });
        }
      }

      dbOps.push({
        op: "file",
        path: relPath,
        content_hash: fileContentHash,
        memory_type: chunks[0].memory_type,
        name: chunks[0].name,
        chunk_count: chunks.length,
        now,
      });

      await dbBatchUpsert(dbOps);
      stats.indexed++;
      stats.chunks += chunks.length;
      console.log(`[indexed] ${relPath} (${chunks.length} chunks)`);
    } catch (err) {
      stats.errors++;
      console.error(`[error] ${relPath}: ${err.message}`);
    }
  }

  console.log(`\n[build-index] Done. indexed=${stats.indexed} chunks=${stats.chunks} errors=${stats.errors}`);
}

main().catch(err => { console.error("[build-index] FATAL:", err.message); process.exit(1); });
