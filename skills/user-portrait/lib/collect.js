/**
 * skills/user-portrait/lib/collect.js
 * -----------------------------------
 * Orchestrates all source adapters into one unified, deduped
 * messages.jsonl under <store>/portrait/.
 *
 * Guarantees:
 *   - a broken/missing source never aborts the run (per-source try/catch)
 *   - global dedup on (day + normalized text) so the same prompt typed once
 *     but logged by two files counts once
 *   - atomic output: write .tmp then rename
 *   - bounded memory: per-source --limit and a global hard cap
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildMessage } from "./schema.js";
import { normalizeForDedup, dayKey, MAX_TOTAL_MESSAGES } from "./util.js";

import claudeCode from "./sources/claude-code.js";
import codex from "./sources/codex.js";
import cursor from "./sources/cursor.js";
import copilotCli from "./sources/copilot-cli.js";
import geminiCli from "./sources/gemini-cli.js";
import opencode from "./sources/opencode.js";
import zcode from "./sources/zcode.js";
import codebuddy from "./sources/codebuddy.js";

export const SOURCES = [claudeCode, codex, cursor, copilotCli, geminiCli, opencode, zcode, codebuddy];

/** Detected-but-unreadable stores worth telling the user about. */
function detectNotes(home) {
  const notes = [];
  const sqliteStores = [
    [path.join(home, ".cursor"), "Cursor 主聊天历史在 app SQLite (globalStorage/state.vscdb),无依赖读取方案;agent-transcripts 已覆盖 agent 会话"],
    [path.join(home, ".codex", "state_5.sqlite"), "Codex threads 索引 (state_5.sqlite) 含 700+ 条首条消息,SQLite 暂不解析;sessions/history 已覆盖正文"],
    [path.join(home, ".zcode", "cli", "db", "db.sqlite"), "ZCode 主库为 SQLite,暂不解析;rollout jsonl 已覆盖"],
  ];
  for (const [p, note] of sqliteStores) {
    try {
      fs.statSync(p);
      notes.push(note);
    } catch { /* absent */ }
  }
  return notes;
}

/**
 * Run collection.
 * @param {{ outDir: string, home?: string, limit?: number, sources?: string[],
 *           redactMode?: "default"|"strict"|"off" }} opts
 * @returns {Promise<{outFile: string, report: object}>}
 */
export async function collectMessages(opts) {
  const {
    outDir,
    home = os.homedir(),
    limit = 10000,
    sources = null,
    redactMode = "default",
  } = opts;

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "messages.jsonl");
  const tmpFile = outFile + ".tmp";

  const wanted = sources
    ? new Set(SOURCES.filter((s) => sources.includes(s.id) || sources.includes("all")).map((s) => s.id))
    : null;

  const report = {
    started_at: new Date().toISOString(),
    home,
    per_source: {},
    notes: detectNotes(home),
    total_kept: 0,
    total_dropped_build: 0,
    total_dropped_dedup: 0,
    total_dropped_limit: 0,
  };

  const seen = new Set();
  const out = fs.createWriteStream(tmpFile, { encoding: "utf-8" });

  for (const adapter of SOURCES) {
    if (wanted && !wanted.has(adapter.id)) continue;
    const srcReport = { label: adapter.label, files: 0, yielded: 0, kept: 0, errors: [] };
    report.per_source[adapter.id] = srcReport;
    let localKept = 0;
    try {
      for await (const cand of adapter.collect({ home, report: srcReport })) {
        if (localKept >= limit || report.total_kept >= MAX_TOTAL_MESSAGES) {
          report.total_dropped_limit += 1;
          continue;
        }
        // Day fallback for records without ts: unknown-day bucket keeps them
        // dedupable without inventing timestamps.
        const day = dayKey(cand.ts) || "no-ts";
        const key = `${day}|${normalizeForDedup(cand.text)}`;
        if (seen.has(key)) {
          report.total_dropped_dedup += 1;
          continue;
        }
        seen.add(key);
        const msg = buildMessage({ ...cand, source: adapter.id }, { redactMode });
        if (!msg) {
          report.total_dropped_build += 1;
          continue;
        }
        out.write(JSON.stringify(msg) + "\n");
        localKept += 1;
        srcReport.kept += 1;
        report.total_kept += 1;
      }
    } catch (err) {
      srcReport.errors.push(`fatal: ${err.message}`);
    }
  }

  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on("error", reject);
  });
  fs.renameSync(tmpFile, outFile);

  report.finished_at = new Date().toISOString();
  const reportFile = path.join(outDir, "scan-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf-8");
  return { outFile, report, reportFile };
}

/**
 * Append imported chat messages (WeChat/QQ exports) to messages.jsonl.
 * Chat records skip the dedup Set (single-shot import) but still pass
 * buildMessage validation and redaction.
 */
export function appendChatImport(outDir, parsed, { redactMode = "default", defaultPeer } = {}) {
  const outFile = path.join(outDir, "messages.jsonl");
  const fsync = fs.createWriteStream(outFile, { flags: "a", encoding: "utf-8" });
  let kept = 0;
  const perFile = {};
  for (const m of parsed.messages) {
    const msg = buildMessage(
      {
        source: "chat-import",
        ts: m.ts,
        text: m.text,
        peer: m.peer || defaultPeer,
        from_user: m.from_user,
      },
      { redactMode }
    );
    if (!msg) continue;
    fsync.write(JSON.stringify(msg) + "\n");
    kept += 1;
    const f = m._file || "?";
    perFile[f] = (perFile[f] || 0) + 1;
  }
  return new Promise((resolve, reject) => {
    fsync.end(() => resolve({ kept, perFile, errors: parsed.errors }));
    fsync.on("error", reject);
  });
}
