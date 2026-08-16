/**
 * Source adapter: ZCode (`~/.zcode/cli/rollout/*.jsonl`).
 *
 * Model-I/O rollouts: one JSON line per request; user turns live in
 * request.body.messages[] with role=="user" (content: string | blocks).
 *
 * ZCode's primary store is a SQLite DB (`cli/db/db.sqlite`) with no
 * dependency-free read path — reported as a note when detected.
 */

import path from "node:path";
import { streamJsonl, walkFiles, textFromContent, exists, toMs } from "../util.js";

export const id = "zcode";
export const label = "ZCode";

export async function* collect({ home, report }) {
  const root = path.join(home, ".zcode", "cli", "rollout");
  if (!exists(root)) return;

  for await (const file of walkFiles(root, /\.jsonl$/i, { maxDepth: 2 })) {
    report.files += 1;
    try {
      for await (const rec of streamJsonl(file)) {
        const messages =
          rec &&
          rec.request &&
          rec.request.body &&
          Array.isArray(rec.request.body.messages)
            ? rec.request.body.messages
            : Array.isArray(rec.messages)
              ? rec.messages
              : null;
        if (!messages) continue;
        for (const m of messages) {
          if (!m || m.role !== "user") continue;
          const text = textFromContent(m.content);
          if (!text.trim()) continue;
          if (/^</.test(text.trim())) continue; // injected XML context
          yield { ts: toMs(rec.timestamp ?? rec.ts), text };
          report.yielded += 1;
        }
      }
    } catch (err) {
      report.errors.push(`${file}: ${err.message}`);
    }
  }
}

export default { id, label, collect };
