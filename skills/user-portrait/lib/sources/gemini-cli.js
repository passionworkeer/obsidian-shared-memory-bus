/**
 * Source adapter: Gemini CLI (`~/.gemini/tmp/<proj>/chats/session-*.json`).
 *
 * Single-JSON session files: {messages:[{type:"user", content:[{text}] | string}]}.
 * Timestamps are frequently absent — file mtime is used as the day fallback.
 */

import path from "node:path";
import fs from "node:fs";
import { walkFiles, readJsonSafe, textFromContent, exists, toMs } from "../util.js";

export const id = "gemini-cli";
export const label = "Gemini CLI";

export async function* collect({ home, report }) {
  const root = path.join(home, ".gemini", "tmp");
  if (!exists(root)) return;

  for await (const file of walkFiles(root, /^session-.*\.json$/i, { maxDepth: 4 })) {
    if (!file.includes(`${path.sep}chats${path.sep}`)) continue;
    report.files += 1;
    const data = readJsonSafe(file);
    if (!data || !Array.isArray(data.messages)) continue;
    let mtime = null;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch { /* ignore */ }
    for (const m of data.messages) {
      const isUser = m && (m.type === "user" || m.role === "user");
      if (!isUser) continue;
      const text = textFromContent(m.content);
      if (!text.trim()) continue;
      yield { ts: toMs(m.timestamp) ?? mtime, text };
      report.yielded += 1;
    }
  }
}

export default { id, label, collect };
