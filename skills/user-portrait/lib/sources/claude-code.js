/**
 * Source adapter: Claude Code (`~/.claude`).
 *
 * Two harvest paths, both jsonl:
 *   1. history.jsonl  — every typed prompt as {display, timestamp(ms), project,
 *                        sessionId}. Longest timeline, lowest friction.
 *   2. projects/<munged-cwd>/<sessionId>.jsonl — full session transcripts.
 *      User turns: type=="user", isMeta!=true, text from message.content.
 *      Subagent transcripts live here too; orchestrator-injected prompts are
 *      kept (they mirror user intent) and global day+text dedup removes
 *      double counting against history.jsonl.
 */

import path from "node:path";
import { streamJsonl, walkFiles, textFromContent, exists, toMs } from "../util.js";

export const id = "claude-code";
export const label = "Claude Code";

export async function* collect({ home, report }) {
  const root = path.join(home, ".claude");
  if (!exists(root)) return;

  // 1) history.jsonl — typed-prompt firehose
  const hist = path.join(root, "history.jsonl");
  if (exists(hist)) {
    report.files += 1;
    for await (const rec of streamJsonl(hist)) {
      const text = typeof rec.display === "string" ? rec.display : "";
      if (!text.trim()) continue;
      yield {
        ts: toMs(rec.timestamp),
        text,
        project: rec.project ? path.basename(rec.project) : undefined,
        session: rec.sessionId,
      };
      report.yielded += 1;
    }
  }

  // 2) session transcripts under projects/
  for await (const file of walkFiles(path.join(root, "projects"), /\.jsonl$/i, { maxDepth: 3 })) {
    report.files += 1;
    try {
      for await (const rec of streamJsonl(file)) {
        if (!rec || rec.type !== "user" || rec.isMeta === true) continue;
        const text = textFromContent(rec.message && rec.message.content);
        if (!text.trim()) continue;
        yield {
          ts: toMs(rec.timestamp),
          text,
          project: rec.cwd ? path.basename(rec.cwd) : undefined,
          session: rec.sessionId,
        };
        report.yielded += 1;
      }
    } catch (err) {
      report.errors.push(`${file}: ${err.message}`);
    }
  }
}

export default { id, label, collect };
