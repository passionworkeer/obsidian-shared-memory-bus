/**
 * Source adapter: GitHub Copilot CLI (`~/.copilot/session-state`).
 *
 *   <uuid>/events.jsonl — {type:"user.message", data:{content,
 *   transformedContent}}. `content` is the user's original wording
 *   (transformedContent has injected context) so we take content.
 */

import path from "node:path";
import { streamJsonl, walkFiles, exists, toMs } from "../util.js";

export const id = "copilot-cli";
export const label = "Copilot CLI";

export async function* collect({ home, report }) {
  const root = path.join(home, ".copilot", "session-state");
  if (!exists(root)) return;

  for await (const file of walkFiles(root, /events\.jsonl$/i, { maxDepth: 3 })) {
    report.files += 1;
    try {
      for await (const rec of streamJsonl(file)) {
        if (!rec || rec.type !== "user.message") continue;
        const data = rec.data || {};
        const text = typeof data.content === "string" ? data.content : "";
        if (!text.trim()) continue;
        yield { ts: toMs(data.timestamp || rec.timestamp), text };
        report.yielded += 1;
      }
    } catch (err) {
      report.errors.push(`${file}: ${err.message}`);
    }
  }
}

export default { id, label, collect };
