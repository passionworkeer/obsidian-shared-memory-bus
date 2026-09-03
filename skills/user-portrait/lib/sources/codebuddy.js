/**
 * Source adapter: CodeBuddy (`~/.codebuddy/history.jsonl`).
 *
 * {display, timestamp(ms), project} — same shape as Claude Code's
 * history.jsonl.
 */

import path from "node:path";
import { streamJsonl, exists, toMs } from "../util.js";

export const id = "codebuddy";
export const label = "CodeBuddy";

export async function* collect({ home, report }) {
  const hist = path.join(home, ".codebuddy", "history.jsonl");
  if (!exists(hist)) return;

  report.files += 1;
  for await (const rec of streamJsonl(hist)) {
    const text = typeof rec.display === "string" ? rec.display : "";
    if (!text.trim()) continue;
    yield {
      ts: toMs(rec.timestamp),
      text,
      project: rec.project ? path.basename(rec.project) : undefined,
    };
    report.yielded += 1;
  }
}

export default { id, label, collect };
