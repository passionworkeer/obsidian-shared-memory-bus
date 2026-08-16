/**
 * Source adapter: Codex CLI (`~/.codex`).
 *
 *   sessions/YYYY/MM/DD/rollout-*.jsonl + archived_sessions/*.jsonl
 *     First line: session_meta (cwd). User turns: type=="response_item",
 *     payload.type=="message", payload.role=="user", text in
 *     payload.content[].input_text. Environment/instruction wrappers
 *     (<user_instructions>, <environment_context>, …) are dropped.
 *   history.jsonl — {session_id, ts, text} typed-prompt firehose.
 */

import path from "node:path";
import { streamJsonl, walkFiles, exists, toMs } from "../util.js";

export const id = "codex";
export const label = "Codex CLI";

const META_PREFIXES = /^<(user_instructions|environment_context|turn-context|system|credits|ENVIRONMENT)/i;

function textFromPayload(payload) {
  if (!payload || payload.type !== "message" || payload.role !== "user") return "";
  const parts = [];
  for (const c of Array.isArray(payload.content) ? payload.content : []) {
    if (c && (c.type === "input_text" || typeof c.text === "string")) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n");
}

export async function* collect({ home, report }) {
  const root = path.join(home, ".codex");
  if (!exists(root)) return;

  for (const dirName of ["sessions", "archived_sessions"]) {
    const dir = path.join(root, dirName);
    if (!exists(dir)) continue;
    for await (const file of walkFiles(dir, /\.jsonl$/i, { maxDepth: 5 })) {
      report.files += 1;
      let cwdProject;
      try {
        for await (const rec of streamJsonl(file)) {
          if (rec && rec.type === "session_meta") {
            const cwd = rec.payload && (rec.payload.cwd || rec.payload.working_directory);
            cwdProject = cwd ? path.basename(cwd) : undefined;
            continue;
          }
          if (!rec || rec.type !== "response_item") continue;
          const text = textFromPayload(rec.payload);
          if (!text.trim() || META_PREFIXES.test(text.trim())) continue;
          yield {
            ts: toMs(rec.timestamp),
            text,
            project: cwdProject,
            session: rec.payload && rec.payload.session_id,
          };
          report.yielded += 1;
        }
      } catch (err) {
        report.errors.push(`${file}: ${err.message}`);
      }
    }
  }

  const hist = path.join(root, "history.jsonl");
  if (exists(hist)) {
    report.files += 1;
    for await (const rec of streamJsonl(hist)) {
      const text = typeof rec.text === "string" ? rec.text : "";
      if (!text.trim() || META_PREFIXES.test(text.trim())) continue;
      yield { ts: toMs(rec.ts), text, session: rec.session_id };
      report.yielded += 1;
    }
  }
}

export default { id, label, collect };
