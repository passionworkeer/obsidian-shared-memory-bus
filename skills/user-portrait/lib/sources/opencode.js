/**
 * Source adapter: opencode (`~/.local/share/opencode`, same path on all
 * platforms when present).
 *
 * Storage layout (JSON-per-record, verified against real installs):
 *   storage/message/<sessionId>/<messageId>.json
 *     → {id, sessionID, role:"user", time:{created: ms}}
 *   storage/part/<messageId>/<partId>.json
 *     → {messageID, type:"text", text}   ← keyed by message id only
 *
 * Message bodies live in part files keyed by messageId, so we index parts
 * first, then join while streaming messages.
 */

import path from "node:path";
import { walkFiles, readJsonSafe, exists, toMs } from "../util.js";

export const id = "opencode";
export const label = "opencode";

export async function* collect({ home, report }) {
  const root = path.join(home, ".local", "share", "opencode", "storage");
  if (!exists(root)) return;

  // Index text parts by messageId (part/<messageId>/<partId>.json).
  const partText = new Map();
  for await (const file of walkFiles(path.join(root, "part"), /\.json$/i, { maxDepth: 4 })) {
    const part = readJsonSafe(file);
    if (!part || part.type !== "text" || typeof part.text !== "string") continue;
    const key = part.messageID || path.basename(path.dirname(file));
    const cur = partText.get(key);
    partText.set(key, cur ? cur + "\n" + part.text : part.text);
  }
  if (partText.size === 0) return;

  for await (const file of walkFiles(path.join(root, "message"), /\.json$/i, { maxDepth: 4 })) {
    const msg = readJsonSafe(file);
    if (!msg || msg.role !== "user") continue;
    const key = msg.id || path.basename(file, ".json");
    const text = partText.get(key) || "";
    if (!text.trim()) continue;
    yield {
      ts: toMs(msg.time && msg.time.created ? msg.time.created : msg.time ?? msg.createdAt),
      text,
      session: msg.sessionID,
    };
    report.yielded += 1;
  }
}

export default { id, label, collect };
