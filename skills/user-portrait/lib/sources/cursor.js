/**
 * Source adapter: Cursor agent transcripts (`~/.cursor/projects/...`).
 *
 *   <project>/agent-transcripts/<uuid>/<uuid>.jsonl
 *     User turns: {role:"user", message:{content:[{type:"text",
 *     text:"<user_query>…</user_query>"}]}}. The <user_query> wrapper is
 *     unwrapped by buildMessage().
 *
 * Note: Cursor's main chat history lives in an app SQLite DB
 * (globalStorage/state.vscdb, bubbleId:* keys) which has no stable
 * cross-platform read path without native deps — the adapter reports it as a
 * "detected, needs manual export" note when present.
 */

import path from "node:path";
import { streamJsonl, walkFiles, textFromContent, exists } from "../util.js";

export const id = "cursor";
export const label = "Cursor";

export async function* collect({ home, report }) {
  const root = path.join(home, ".cursor", "projects");
  if (!exists(root)) return;

  for await (const file of walkFiles(root, /\.jsonl$/i, { maxDepth: 4 })) {
    if (!file.includes("agent-transcripts")) continue;
    report.files += 1;
    try {
      for await (const rec of streamJsonl(file)) {
        if (!rec || rec.role !== "user") continue;
        const text = textFromContent(rec.message && rec.message.content);
        if (!text.trim()) continue;
        const projectDir = file.split(path.sep + "agent-transcripts")[0];
        yield {
          ts: null, // transcripts carry no per-record timestamp; day comes from file mtime in collect
          text,
          project: path.basename(projectDir),
        };
        report.yielded += 1;
      }
    } catch (err) {
      report.errors.push(`${file}: ${err.message}`);
    }
  }
}

export default { id, label, collect };
